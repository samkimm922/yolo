#!/usr/bin/env tsx
// CI guard rails — custom workflow and secret checks, not actionlint.
// Renaming from generic "ci-guard" to clarify this is a project-specific guard
// (tab indent detection, pull_request_target ban, secret scanning, prompt-injection phrases).
// actionlint is not wired here; this script provides equivalent YAML/security guards.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = resolve(ROOT, ".github", "workflows");
const SOURCE_ROOTS = ["src", "lib", "bin", "scripts", ".github/workflows"];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".yolo", ".yolo-worktrees"]);

function walk(relativeDir: string, files: string[] = []) {
  const absolute = resolve(ROOT, relativeDir);
  if (!existsSync(absolute)) return files;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const relative = join(relativeDir, entry.name);
    const full = resolve(ROOT, relative);
    if (entry.isDirectory()) walk(relative, files);
    else if (statSync(full).isFile()) files.push(relative);
  }
  return files;
}

function workflowFiles() {
  if (!existsSync(WORKFLOW_DIR)) return [];
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => /\.(ya?ml)$/.test(file))
    .map((file) => join(".github/workflows", file));
}

function readRepoTextIfPresent(file: string): string | null {
  try {
    return readFileSync(resolve(ROOT, file), "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function inspectWorkflowGuards() {
  const findings = [];
  for (const file of workflowFiles()) {
    const text = readRepoTextIfPresent(file);
    if (text === null) continue;
    if (/\tpull_request|\tpush|\t-\s+run:/.test(text)) {
      findings.push({ file, code: "WORKFLOW_TAB_INDENT", message: "Workflow YAML should not use tab indentation." });
    }
    if (/pull_request_target\s*:/.test(text)) {
      findings.push({ file, code: "PULL_REQUEST_TARGET_DISABLED", message: "pull_request_target is not allowed in this repo CI." });
    }
    if (/--no-verify\b|SKIP[_-]?TESTS\s*=\s*1|npm\s+test\s+--\s*--runInBand\s+--passWithNoTests/.test(text)) {
      findings.push({ file, code: "CI_BYPASS_FLAG", message: "CI workflow contains a bypass-like flag." });
    }
  }
  return {
    status: findings.length === 0 ? "pass" : "fail",
    findings,
  };
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["OPENAI_API_KEY_LITERAL", /\bsk-[A-Za-z0-9_-]{32,}\b/g],
  ["GITHUB_TOKEN_LITERAL", /\bgh[pousr]_[A-Za-z0-9_]{32,}\b/g],
  ["PRIVATE_KEY_BLOCK", /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g],
  ["AWS_SECRET_ACCESS_KEY_LITERAL", /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?[A-Za-z0-9/+=]{35,}["']?/g],
];

export function inspectSecretGuards() {
  const findings = [];
  for (const file of SOURCE_ROOTS.flatMap((root) => walk(root))) {
    if (/\.(png|jpe?g|gif|webp|ico|tgz|zip|lock)$/.test(file)) continue;
    const text = readRepoTextIfPresent(file);
    if (text === null) continue;
    for (const [code, pattern] of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        findings.push({ file, code, message: "Potential literal secret detected." });
      }
    }
    const longBase64 = text.match(/[A-Za-z0-9+/]{240,}={0,2}/g) || [];
    if (longBase64.some((value) => value.length >= 320)) {
      findings.push({ file, code: "LONG_BASE64_LITERAL", message: "Long base64-like literal should be reviewed." });
    }
    if (/ignore (?:all )?(?:previous|above) instructions/i.test(text) && !file.includes("__tests__")) {
      findings.push({ file, code: "PROMPT_INJECTION_PHRASE", message: "Prompt-injection phrase should not ship outside tests." });
    }
  }
  return {
    status: findings.length === 0 ? "pass" : "fail",
    findings,
  };
}

// ── Source-string assertion guard ──────────────────────────────
// Bans new assert.match(*Source, ...) patterns in test files.
// These assert against source-code text read from files, which is
// brittle (any refactor breaks the test). Existing occurrences are
// allowlisted via baseline counts; the guard fails if counts grow.
const SOURCE_ASSERTION_BASELINE: Record<string, number> = {
  "__tests__/runner-review-flow.test.ts": 138,
  "__tests__/prompt-r9-contract.test.ts": 10,
  // This test intentionally embeds the pattern in a string literal to verify the guard catches it.
  "__tests__/ci-guard-source-assertions.test.ts": 1,
};

const SOURCE_ASSERTION_PATTERN = /assert\.match\(\s*\w*Source[\s,]/g;

export function inspectSourceAssertionGuard() {
  const findings = [];
  const testFiles = walk("__tests__").filter((f) => /\.test\.ts$/.test(f));
  for (const file of testFiles) {
    const text = readRepoTextIfPresent(file);
    if (text === null) continue;
    SOURCE_ASSERTION_PATTERN.lastIndex = 0;
    const matches = text.match(SOURCE_ASSERTION_PATTERN) || [];
    const count = matches.length;
    const baseline = SOURCE_ASSERTION_BASELINE[file] ?? 0;
    if (count > baseline) {
      findings.push({
        file,
        code: "NEW_SOURCE_STRING_ASSERTION",
        message: `Found ${count} assert.match(*Source, ...) assertions (baseline: ${baseline}). New source-code string assertions are banned — convert to behavioral tests that drive real exported functions.`,
      });
    }
  }
  return {
    status: findings.length === 0 ? "pass" : "fail",
    findings,
  };
}

// ── Shell-injection guard (P12.I1) ─────────────────────────────
// Bans new shell-injection surface: `shell: true`, `"sh", ["-c", ...]`,
// `execSync(...)` with template/var command, except where explicitly
// allowlisted with an audit reason. The咽喉 is src/lib/security/safe-exec.ts;
// all untrusted command execution must route through it.
//
// What this gate does NOT flag (safe by construction):
//   - execFileSync/spawnSync with an argv array (e.g. execFileSync("git", [...]))
//     even if an argv element uses ${} — the result is a single arg, no shell.
//   - execSync("literal command") with no ${} interpolation.
//
// What this gate DOES flag:
//   - shell: true
//   - "sh"/'sh' followed by ["-c"/,'-c',  (explicit shell opt-in)
//   - execSync(`template literal ${var}`)  — shell form with substitution
//   - execSync("literal ${var}")           — double-quoted with interpolation
type ShellFinding = { file: string; line: number; code: string; message: string };

const SHELL_SH_C_RE = /["']sh["']\s*,\s*\[\s*["']-c["']/;
const SHELL_TRUE_RE = /shell\s*:\s*true\b/;
// execSync(`...`) with template literal — only execSync (which takes a string command),
// not execFileSync/spawnSync (which take argv arrays and are safe even with ${}).
const EXEC_SYNC_TEMPLATE_RE = /\bexecSync\s*\(\s*`/;
// execSync("...") with ${} interpolation in the double-quoted string.
const EXEC_SYNC_INTERP_RE = /\bexecSync\s*\(\s*"[^"]*\$\{/;

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("#");
}

// Each entry: `relative/path` -> audit reason (file-level) OR `relative/path:line` (line-level).
// Add ONLY with a written audit explaining why argv form is impossible AND
// why the call cannot reach untrusted input.
const SHELL_INJECTION_ALLOWLIST: Record<string, string> = {
  // src/lib/security/safe-exec.ts itself uses spawnSync (the咽喉). argv-only
  // (shell:false) — no untrusted string reaches a shell. Self-scan would
  // false-positive on its own detection regex too.
  "src/lib/security/safe-exec.ts": "咽喉: spawnSync(argv, { shell: false }). argv-only executor.",
  // shutdown/startup git worktree cleanup with quoted paths from session state.
  "src/runtime/run-lifecycle/shutdown.ts": "git worktree/branch cleanup with double-quoted paths from session state (activeWorktree/activeBranch). No untrusted input.",
  "src/runtime/run-lifecycle/startup.ts": "git worktree/branch cleanup with double-quoted paths from session state (wtPath/branch). No untrusted input.",
  // progress/server pgrep literal.
  "src/runtime/progress/server.ts": "literal pgrep -f 'runner.js' (no var substitution).",
  // finalize/recovery-checkpoints spawnSync node with argv array.
  "src/runtime/run-lifecycle/finalize.ts": "spawnSync('node', argv) — no shell, literal node invocations.",
  "src/runtime/run-lifecycle/recovery-checkpoints.ts": "spawnSync(processExecPath, argv) — no shell, internal process exec.",
  // runner-core-helpers spawnSync('node', ...) and pgrep with numeric pid.
  "src/runtime/runner-core-helpers.ts": "execFileSync('node', argv) and pgrep -P with numeric pid (Number-cast). No untrusted string.",
  // artifacts git rev-parse HEAD literal.
  "src/discovery/artifacts.ts": "literal 'git rev-parse HEAD' (no var substitution).",
  // baselines execSync DI defaults to safeExecSync (P12.I1). Template literal
  // `git stash apply ${stashRef}` is parsed to argv by safeExecSync internally;
  // stashRef is a git-generated SHA (alphanumeric only).
  "src/runtime/execution/baselines.ts": "execSync DI defaults to safeExecSync (P12.I1 咽喉). `git stash apply ${stashRef}` parsed to argv internally; stashRef is git-generated SHA (alphanumeric).",
  // review-loop orchestrator execFileSync with explicit argv — injected by caller.
  "src/runtime/review-loop/orchestrator.ts": "execFileSync(argv) — injected by caller, no shell:true.",
  // auto-fix uses execFileSync with argv arrays.
  "src/lib/auto-fix.ts": "execFileSync(argv) — injected by callers with argv arrays; no shell.",
  // test harness — fixture-only.
  "src/fixtures/harness.ts": "test harness: spawnSync('sh', ['-c', ...]) for fixture command-existence/script checks. Fixture-only; never runs in production runtime.",
};

const SHELL_GUARD_ROOTS = ["src", "lib", "bin", "tools", "hooks"];

// ── P12.I2 path-guard: ban unguarded resolve(<root>, <var>) reads in path-sensitive dirs ──
// Externally-influenced paths must go through resolveWithinRoot (the chokepoint) or be
// guarded by an adjacent isWithin(...) check. A raw resolve(<root>, <var>) that feeds an
// fs read without a nearby guard is a path-traversal surface.
const PATH_GUARD_ROOTS = ["src/lib/evaluators", "src/runtime/adapters", "src/runtime/logging", "src/runtime/evidence"];
const RAW_ROOT_RESOLVE_RE = /(?:^|[^A-Za-z.])resolve\(\s*(?:ROOT|projectRoot|root|stateRoot|rootDir|projectDir)\s*,\s*[A-Za-z_$]/;
const PATH_GUARD_NEARBY_RE = /isWithin\(|resolveWithinRoot\(/;
const PATH_GUARD_WINDOW = 3;
// `relative/path` or `relative/path:line` -> audit reason. Add ONLY with a written audit
// explaining why the path cannot reach untrusted content or stays within root.
const PATH_GUARD_ALLOWLIST: Record<string, string> = {
  "src/runtime/adapters/evidence-collector.ts:180": "resolve(projectRoot, stateRoot, 'state/evidence/adapters', fileName) — internal output path under stateRoot from fixed segments; not an external-content read.",
};

export function inspectShellInjectionGuard() {
  const findings: ShellFinding[] = [];
  const files = SHELL_GUARD_ROOTS.flatMap((root) => walk(root)).filter((f) => /\.tsx?$/.test(f));
  for (const file of files) {
    // File-level allowlist.
    if (SHELL_INJECTION_ALLOWLIST[file]) continue;
    const text = readRepoTextIfPresent(file);
    if (text === null) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;
      const lineKey = `${file}:${lineNumber}`;
      if (SHELL_INJECTION_ALLOWLIST[lineKey]) continue;
      // Skip comments — detection patterns mentioned in comments would false-positive.
      if (isCommentLine(line)) continue;
      let code: string | null = null;
      if (SHELL_TRUE_RE.test(line)) code = "SHELL_TRUE_BANNED";
      else if (SHELL_SH_C_RE.test(line)) code = "SH_C_TEMPLATE_BANNED";
      else if (EXEC_SYNC_TEMPLATE_RE.test(line)) code = "EXEC_SYNC_TEMPLATE_BANNED";
      else if (EXEC_SYNC_INTERP_RE.test(line)) code = "EXEC_SYNC_INTERP_BANNED";
      if (code) {
        findings.push({
          file,
          line: lineNumber,
          code,
          message: `Shell-injection surface (${code}). Route untrusted commands through src/lib/security/safe-exec.ts (execCommand/execArgv). If legitimate, add an audit entry to SHELL_INJECTION_ALLOWLIST in scripts/ci-guard.ts.`,
        });
      }
    }
  }
  return {
    status: findings.length === 0 ? "pass" : "fail",
    findings,
  };
}

export function inspectPathGuard() {
  const findings: ShellFinding[] = [];
  const files = PATH_GUARD_ROOTS.flatMap((root) => walk(root)).filter((f) => /\.tsx?$/.test(f));
  for (const file of files) {
    if (PATH_GUARD_ALLOWLIST[file]) continue;
    const text = readRepoTextIfPresent(file);
    if (text === null) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;
      if (PATH_GUARD_ALLOWLIST[`${file}:${lineNumber}`]) continue;
      if (isCommentLine(line)) continue;
      if (!RAW_ROOT_RESOLVE_RE.test(line)) continue;
      const start = Math.max(0, i - PATH_GUARD_WINDOW);
      const end = Math.min(lines.length, i + PATH_GUARD_WINDOW + 1);
      if (PATH_GUARD_NEARBY_RE.test(lines.slice(start, end).join("\n"))) continue;
      findings.push({
        file,
        line: lineNumber,
        code: "UNGUARDED_PATH_RESOLVE",
        message: `Unguarded resolve(<root>, <var>) path surface. Route externally-influenced paths through resolveWithinRoot (src/lib/security/path-guard.ts) or guard with an adjacent isWithin(...). If legitimate, add an audit entry to PATH_GUARD_ALLOWLIST in scripts/ci-guard.ts.`,
      });
    }
  }
  return { status: findings.length === 0 ? "pass" : "fail", findings };
}

// ── Business-file hardcoding guard ─────────────────────────────
// Business-file classification must route through
// src/runtime/execution/change-set.ts:isBusinessFile so project layout can be
// configured with build.business_globs. New local prefix allowlists silently
// undercount/overcount non-src layouts.
const BUSINESS_FILE_HARDCODING_ROOTS = ["src/runtime", "src/lib/evaluators"];
const BUSINESS_FUNCTION_START_RE = /(?:export\s+)?function\s+([A-Za-z_$][\w$]*Business[\w$]*)\b|(?:const|let|var)\s+([A-Za-z_$][\w$]*Business[\w$]*)\s*=/;
const BUSINESS_HARDCODED_PREFIX_RE = /(?:\.startsWith\(\s*["'](?:src|cloudfunctions)\/["']\s*\)|["'](?:src|cloudfunctions)\/["']\s*,?)/;
const BUSINESS_HARDCODING_ALLOWLIST: Record<string, string> = {
  "src/runtime/execution/change-set.ts:isBusinessFileLegacyDirectoryOnly": "legacy isolated helper kept for compatibility; runtime business gates use isBusinessFile.",
};

function braceDelta(line: string): number {
  return (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
}

function businessFunctionRanges(text: string) {
  const ranges: { name: string; start: number; end: number }[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(BUSINESS_FUNCTION_START_RE);
    if (!match) continue;
    const name = match[1] || match[2];
    let depth = braceDelta(lines[i]);
    let end = i;
    if (depth <= 0 && !lines[i].includes("{")) {
      ranges.push({ name, start: i, end: i });
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      end = j;
      depth += braceDelta(lines[j]);
      if (depth <= 0) break;
    }
    ranges.push({ name, start: i, end });
    i = end;
  }
  return ranges;
}

export function inspectBusinessFileHardcodingGuard() {
  const findings: ShellFinding[] = [];
  const files = BUSINESS_FILE_HARDCODING_ROOTS.flatMap((root) => walk(root)).filter((f) => /\.tsx?$/.test(f));
  for (const file of files) {
    const text = readRepoTextIfPresent(file);
    if (text === null) continue;
    const lines = text.split("\n");
    for (const range of businessFunctionRanges(text)) {
      if (BUSINESS_HARDCODING_ALLOWLIST[`${file}:${range.name}`]) continue;
      for (let i = range.start; i <= range.end; i++) {
        const line = lines[i];
        if (isCommentLine(line)) continue;
        if (!BUSINESS_HARDCODED_PREFIX_RE.test(line)) continue;
        findings.push({
          file,
          line: i + 1,
          code: "BUSINESS_FILE_HARDCODED_PREFIX",
          message: `Business-file classification must use src/runtime/execution/change-set.ts:isBusinessFile with config-driven build.business_globs instead of a hardcoded src/cloudfunctions prefix allowlist.`,
        });
      }
    }
  }
  return { status: findings.length === 0 ? "pass" : "fail", findings };
}

// ── BUG-C4: lifecycle-hook install guard ───────────────────────
// Asserts tools/install-agent-bridge.ts still emits the project-scoped
// .claude/settings.json wiring the PreToolUse lifecycle-gate hook.
// The hook is the machine-enforcement layer for BUG-C (yolo check blocked
// must MACHINE-BLOCK source writes). Removing the emit silently breaks the
// enforcement boundary; this guard fail-closes the regression at CI time.
const LIFECYCLE_HOOK_INSTALL_FILE = "tools/install-agent-bridge.ts";
const LIFECYCLE_HOOK_REQUIRED_TOKENS = [
  { token: "pre-tool-lifecycle-gate", why: "must reference the PreToolUse hook script" },
  { token: "PreToolUse", why: "must register under the PreToolUse hook type" },
  { token: "Write|Edit|MultiEdit|Bash", why: "matcher must cover Write/Edit/MultiEdit/Bash source-write surface" },
  { token: ".claude/settings.json", why: "must emit project-scoped .claude/settings.json" },
];

export function inspectLifecycleHookInstallGuard(options: { text?: string } = {}) {
  const findings: { file: string; code: string; message: string }[] = [];
  let text = options.text;
  if (text === undefined) {
    const path = resolve(ROOT, LIFECYCLE_HOOK_INSTALL_FILE);
    if (!existsSync(path)) {
      findings.push({
        file: LIFECYCLE_HOOK_INSTALL_FILE,
        code: "LIFECYCLE_HOOK_INSTALL_FILE_MISSING",
        message: `${LIFECYCLE_HOOK_INSTALL_FILE} not found; lifecycle-gate hook emit guard cannot run.`,
      });
      return { status: "fail", findings };
    }
    text = readFileSync(path, "utf8");
  }
  for (const requirement of LIFECYCLE_HOOK_REQUIRED_TOKENS) {
    if (!text.includes(requirement.token)) {
      findings.push({
        file: LIFECYCLE_HOOK_INSTALL_FILE,
        code: "LIFECYCLE_HOOK_INSTALL_TOKEN_MISSING",
        message: `Missing required token "${requirement.token}" (${requirement.why}). BUG-C enforcement depends on install emitting this; do not remove without replacing the enforcement layer.`,
      });
    }
  }
  return { status: findings.length === 0 ? "pass" : "fail", findings };
}

export function runCiGuard(mode = "all") {
  const checks = [];
  if (mode === "all" || mode === "actionlint" || mode === "workflow") checks.push({ name: "workflow", ...inspectWorkflowGuards() });
  if (mode === "all" || mode === "security" || mode === "secrets") checks.push({ name: "security", ...inspectSecretGuards() });
  if (mode === "all" || mode === "assertions" || mode === "source-assertions") checks.push({ name: "source-assertions", ...inspectSourceAssertionGuard() });
  if (mode === "all" || mode === "shell-injection" || mode === "shell") checks.push({ name: "shell-injection", ...inspectShellInjectionGuard() });
  if (mode === "all" || mode === "path-guard" || mode === "path") checks.push({ name: "path-guard", ...inspectPathGuard() });
  if (mode === "all" || mode === "business-file-hardcoding" || mode === "business-files") checks.push({ name: "business-file-hardcoding", ...inspectBusinessFileHardcodingGuard() });
  if (mode === "all" || mode === "lifecycle-hook" || mode === "lifecycle") checks.push({ name: "lifecycle-hook", ...inspectLifecycleHookInstallGuard() });
  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    checks,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const mode = process.argv[2] || "all";
  const result = runCiGuard(mode);
  if (result.status !== "pass") {
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`ci guard ${mode}: pass\n`);
}
