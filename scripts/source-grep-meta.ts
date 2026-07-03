#!/usr/bin/env tsx
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CRITICAL_TEST_FILES = [
  "__tests__/public-entrypoints.test.ts",
  "__tests__/command-registry.test.ts",
  "__tests__/evidence-ledger.test.ts",
  "__tests__/evidence-report.test.ts",
  "__tests__/acceptance-report.test.ts",
  "__tests__/execution-baselines.test.ts",
  "__tests__/run-lifecycle-startup.test.ts",
  "__tests__/run-lifecycle-finalize.test.ts",
  "__tests__/worktree-session.test.ts",
  "__tests__/fixture-harness.test.ts",
  "__tests__/package-install-smoke.test.ts",
  "__tests__/no-source-grep-meta.test.ts",
];

export const SOURCE_ONLY_ALLOWLIST = [
  {
    file: "__tests__/public-entrypoints.test.ts",
    title: "converted bins call src CLI modules instead of legacy script spawner",
    pairedWith: [
      "bin ${binName} exists and parses",
      "root yolo help keeps ordinary users on the public mainline",
      "yolo run uses PI by default and runner remains available as engine-only",
    ],
  },
];

const RUNTIME_SIGNALS = [
  "spawnSync(",
  "execFileSync(",
  "runYoloCli(",
  "buildYoloCommandRegistry(",
  "listYoloCommands(",
  "getYoloCommand(",
  "appendJsonlRecord(",
  "appendStateEvent(",
  "buildRunReport(",
  "writeRunReport(",
  "buildAcceptanceReport(",
  "captureExecutionBaselines(",
  "initializeMissingBaselines(",
  "cleanupRunArtifacts(",
  "createTaskWorktree(",
  "cleanupTaskWorktree(",
  "runFixtureHarness(",
  "runPackageInstallSmoke(",
  "inspectPackedPackage(",
  "scanSourceGrepMeta(",
];

function read(root: string, relativePath: string) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

export function extractNamedTests(root: string, relativePath: string) {
  const source = read(root, relativePath);
  const matches = [...source.matchAll(/test\((["`])([^"`]+)\1,/g)];
  return matches.map((match, index) => ({
    file: relativePath,
    title: match[2],
    body: source.slice(match.index, matches[index + 1]?.index ?? source.length),
  }));
}

export function isSourceGrepOnly(block: { body: string }) {
  const readsSource = /\breadFileSync\(/.test(block.body) || /\bread\(["`'][^)]+["`']\)/.test(block.body);
  const grepsSource = /assert\.(?:match|doesNotMatch)\(\s*(?:source|read\(|readFileSync|text|content)\s*,/.test(block.body) ||
    /assert\.ok\(\s*(?:source|text|content)\.includes\(/.test(block.body);
  const executesRuntime = RUNTIME_SIGNALS.some((signal) => block.body.includes(signal));
  return readsSource && grepsSource && !executesRuntime;
}

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_FILE);
const TOOLCHAIN_DRIFT_ALLOW = "source-grep-allow toolchain-drift";
const TOOLCHAIN_DRIFT_EXCLUDED_FILES = new Set([
  "src/lib/toolchain.ts",
]);

type ToolchainDriftFinding = {
  file: string;
  line: number;
  pattern: string;
  detail: string;
};

function walkFiles(root: string, relativeDir: string): string[] {
  const dir = resolve(root, relativeDir);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const rel = `${relativeDir}/${entry}`;
    if (rel.includes("/node_modules/") || rel.includes("/dist/") || rel.includes("/.git/")) continue;
    if (rel.startsWith("__tests__/fixtures/")) continue;
    const abs = resolve(root, rel);
    const stat = statSync(abs);
    if (stat.isDirectory()) out.push(...walkFiles(root, rel));
    else if (/\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/.test(entry)) out.push(rel);
  }
  return out;
}

function hasToolchainDriftAllow(lines: string[], index: number): boolean {
  return lines[index]?.includes(TOOLCHAIN_DRIFT_ALLOW) || lines[index - 1]?.includes(TOOLCHAIN_DRIFT_ALLOW);
}

function scanToolchainDrift(root: string): ToolchainDriftFinding[] {
  const findings: ToolchainDriftFinding[] = [];
  const files = walkFiles(root, "src")
    .filter((file) => !TOOLCHAIN_DRIFT_EXCLUDED_FILES.has(file) && !file.startsWith("__tests__/fixtures/"));
  for (const file of files) {
    const lines = read(root, file).split("\n");
    lines.forEach((line, index) => {
      if (hasToolchainDriftAllow(lines, index)) return;
      const checks: Array<{ pattern: string; detail: string; matched: boolean }> = [
        { pattern: "npm test", detail: "use resolveBuildCommand('test', config, projectRoot)", matched: line.includes('"npm test"') || line.includes("'npm test'") || line.includes("`npm test`") },
        { pattern: "npm run ", detail: "use resolveBuildCommand(kind, config, projectRoot)", matched: line.includes('"npm run ') || line.includes("'npm run ") || line.includes("`npm run ") },
        { pattern: "pnpm exec", detail: "use resolveBuildCommand(kind, config, projectRoot)", matched: line.includes("pnpm exec") || /["']pnpm["']\s*,\s*\[\s*["']exec["']/.test(line) || /\[\s*["']pnpm["']\s*,\s*["']exec["']/.test(line) },
        { pattern: "execFileSync direct tool", detail: "route tsc/eslint/vitest through src/lib/toolchain.ts", matched: /\bexecFileSync\(\s*["'](?:tsc|eslint|vitest)["']/.test(line) },
        { pattern: "execArgv direct tool", detail: "route tsc/eslint/vitest through src/lib/toolchain.ts", matched: /\bexecArgv\(\s*\[\s*["'](?:tsc|eslint|vitest)["']/.test(line) },
      ];
      for (const check of checks) {
        if (check.matched) findings.push({ file, line: index + 1, pattern: check.pattern, detail: check.detail });
      }
    });
  }
  return findings;
}

export function scanSourceGrepMeta(root = resolve(SCRIPT_DIR, "..")) {
  const missing = CRITICAL_TEST_FILES.filter((file) => !existsSync(resolve(root, file)));
  const sourceOnly = CRITICAL_TEST_FILES
    .filter((file) => existsSync(resolve(root, file)))
    .flatMap((file) => extractNamedTests(root, file))
    .filter(isSourceGrepOnly)
    .map(({ file, title }) => ({ file, title }));
  const allowlist = SOURCE_ONLY_ALLOWLIST.map(({ file, title }) => ({ file, title }));
  const unexpected = sourceOnly.filter((item) => !allowlist.some((allowed) => allowed.file === item.file && allowed.title === item.title));
  const staleAllowlist = allowlist.filter((allowed) => !sourceOnly.some((item) => item.file === allowed.file && item.title === allowed.title));
  const missingPairedTests = [];
  for (const item of SOURCE_ONLY_ALLOWLIST) {
    const titles = existsSync(resolve(root, item.file))
      ? extractNamedTests(root, item.file).map((block) => block.title)
      : [];
    for (const pairedTitle of item.pairedWith || []) {
      if (!titles.includes(pairedTitle)) {
        missingPairedTests.push({ file: item.file, title: item.title, paired_title: pairedTitle });
      }
    }
  }
  const toolchainDrift = scanToolchainDrift(root);
  const status = missing.length || unexpected.length || staleAllowlist.length || missingPairedTests.length || toolchainDrift.length ? "fail" : "pass";
  return {
    status,
    critical_test_files: CRITICAL_TEST_FILES,
    source_only: sourceOnly,
    allowlist,
    missing,
    unexpected,
    stale_allowlist: staleAllowlist,
    missing_paired_tests: missingPairedTests,
    toolchain_drift: toolchainDrift,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_FILE)) {
  const result = scanSourceGrepMeta();
  if (result.status !== "pass") {
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write("source-grep meta: pass\n");
}
