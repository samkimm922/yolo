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

export function runCiGuard(mode = "all") {
  const checks = [];
  if (mode === "all" || mode === "actionlint" || mode === "workflow") checks.push({ name: "workflow", ...inspectWorkflowGuards() });
  if (mode === "all" || mode === "security" || mode === "secrets") checks.push({ name: "security", ...inspectSecretGuards() });
  if (mode === "all" || mode === "assertions" || mode === "source-assertions") checks.push({ name: "source-assertions", ...inspectSourceAssertionGuard() });
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
