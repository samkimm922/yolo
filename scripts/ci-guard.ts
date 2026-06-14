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

export function inspectWorkflowGuards() {
  const findings = [];
  for (const file of workflowFiles()) {
    const text = readFileSync(resolve(ROOT, file), "utf8");
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
    const text = readFileSync(resolve(ROOT, file), "utf8");
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
    const text = readFileSync(resolve(ROOT, file), "utf8");
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
  // Worktree git ops use shellQuote'd args on project-controlled paths.
  // No untrusted input — paths/branches generated internally from taskId/sessionId.
  "src/runtime/execution/worktree-session.ts": "git/ln/cp/rm ops with shellQuote'd args on project-controlled paths (wtPath/wtBranch/rootNodeModules). Args quoted; no untrusted command surface. macOS git worktree needs shell for `2>/dev/null` fallback suppression — audited P12.I1.",
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

export function inspectShellInjectionGuard() {
  const findings: ShellFinding[] = [];
  const files = SHELL_GUARD_ROOTS.flatMap((root) => walk(root)).filter((f) => /\.tsx?$/.test(f));
  for (const file of files) {
    // File-level allowlist.
    if (SHELL_INJECTION_ALLOWLIST[file]) continue;
    const text = readFileSync(resolve(ROOT, file), "utf8");
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

export function runCiGuard(mode = "all") {
  const checks = [];
  if (mode === "all" || mode === "actionlint" || mode === "workflow") checks.push({ name: "workflow", ...inspectWorkflowGuards() });
  if (mode === "all" || mode === "security" || mode === "secrets") checks.push({ name: "security", ...inspectSecretGuards() });
  if (mode === "all" || mode === "assertions" || mode === "source-assertions") checks.push({ name: "source-assertions", ...inspectSourceAssertionGuard() });
  if (mode === "all" || mode === "shell-injection" || mode === "shell") checks.push({ name: "shell-injection", ...inspectShellInjectionGuard() });
  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    checks,
  };
}

const mode = process.argv[2] || "all";
const result = runCiGuard(mode);
if (result.status !== "pass") {
  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(1);
}
process.stdout.write(`ci guard ${mode}: pass\n`);
