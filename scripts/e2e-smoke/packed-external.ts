#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STUB_PATH = join(REPO_ROOT, "scripts", "e2e-smoke", "provider-stub.mjs");
const TARGET_FILE = "components/ExternalSmokeBadge.tsx";
const TARGET_MARKER = "YOLO_PACKED_EXTERNAL_SMOKE_MARKER";

const LIFECYCLE_STAGES = [
  ["idea", 1, "Idea intake", "idea.json", false],
  ["discovery", 2, "Discovery", "discovery.json", false],
  ["setup", 3, "Project setup", "setup.json", false],
  ["roadmap", 4, "Roadmap and plan", "roadmap.json", false],
  ["prd", 5, "PRD and executable spec", "prd.json", false],
  ["check", 6, "Readiness check", "check-report.json", false],
  ["run", 7, "Gated execution", "run-report.json", true],
  ["review-fix", 8, "Review and fix loop", "review-report.json", true],
  ["acceptance", 9, "Acceptance", "acceptance-report.json", false],
  ["delivery", 10, "Delivery", "delivery-report.json", false],
  ["learn", 11, "Learning and retrospective", "retrospective.json", false],
].map(([id, sequence, label, artifact, writesCode]) => ({
  id: String(id),
  sequence: Number(sequence),
  label: String(label),
  artifact: String(artifact),
  writes_code: Boolean(writesCode),
}));

function usage() {
  return [
    "Usage:",
    "  npm run smoke:packed-external -- [--keep] [--mutate-business-src-only]",
    "",
    "--mutate-business-src-only changes the external fixture business_globs to src/** and must fail.",
  ].join("\n");
}

function parseArgs(argv: string[]) {
  const options = {
    keep: process.env.YOLO_PACKED_EXTERNAL_KEEP === "1",
    mutateBusinessSrcOnly: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--keep") options.keep = true;
    else if (arg === "--mutate-business-src-only") options.mutateBusinessSrcOnly = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown packed-external smoke option: ${arg}`);
  }
  return options;
}

function log(message: string) {
  process.stdout.write(`${message}\n`);
}

function stage(name: string, detail = "") {
  log(`[packed-external] ${name}${detail ? `: ${detail}` : ""}`);
}

function pass(message: string) {
  log(`[assert] PASS ${message}`);
}

function fail(message: string): never {
  throw new Error(message);
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
  pass(message);
}

function writeText(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function writeJson(path: string, value: unknown) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path: string) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function isInside(parent: string, child: string) {
  const rel = relative(resolve(parent), resolve(child));
  return Boolean(rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function runChecked(label: string, command: string, args: string[], {
  cwd,
  env,
  timeout = 120000,
  expected = [0],
}: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  expected?: number[];
}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...(env || {}) },
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const exitCode = result.status ?? (result.signal ? 1 : 1);
  log(`[cmd] ${label} exit=${exitCode}`);
  if (!expected.includes(exitCode)) {
    const diagnosticLines = `${result.stdout || ""}\n${result.stderr || ""}`
      .split("\n")
      .filter((line) => /worktree node_modules diagnostic|worktree:|provider|gate|POST-|node_modules realpath/i.test(line))
      .slice(-80)
      .join("\n");
    throw new Error([
      `${label} failed with exit ${exitCode}; expected ${expected.join(",")}`,
      `command: ${command} ${args.join(" ")}`,
      diagnosticLines ? `diagnostics:\n${diagnosticLines}` : "",
      result.stdout ? `stdout:\n${result.stdout.slice(-8000)}` : "",
      result.stderr ? `stderr:\n${result.stderr.slice(-8000)}` : "",
      result.error ? `error: ${result.error.message}` : "",
    ].filter(Boolean).join("\n"));
  }
  return { ...result, exitCode };
}

function parseJsonOutput(text: string) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  for (let index = trimmed.lastIndexOf("{"); index >= 0; index = trimmed.lastIndexOf("{", index - 1)) {
    try {
      return JSON.parse(trimmed.slice(index));
    } catch {}
  }
  throw new Error(`No JSON object found in command output:\n${trimmed.slice(-4000)}`);
}

function npmPack(packDir: string) {
  stage("pack", "npm pack real tarball");
  mkdirSync(packDir, { recursive: true });
  const result = runChecked("npm pack", "npm", ["pack", "--silent", "--pack-destination", packDir], {
    cwd: REPO_ROOT,
    timeout: 300000,
  });
  const packedName = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!packedName) fail("npm pack did not print a tarball name");
  const tgzPath = resolve(packDir, basename(packedName));
  assertCondition(existsSync(tgzPath), `packed tarball exists: ${tgzPath}`);
  assertCondition(statSync(tgzPath).size > 0, "packed tarball is non-empty");
  return tgzPath;
}

function localTypescriptDependency() {
  const packagePath = require.resolve("typescript/package.json");
  return pathToFileURL(realpathSync(dirname(packagePath))).href;
}

function scaffoldProject(projectRoot: string, tgzPath: string) {
  stage("scaffold", projectRoot);
  mkdirSync(projectRoot, { recursive: true });
  writeText(join(projectRoot, ".gitignore"), [
    "node_modules/",
    ".yolo/",
    ".next/",
    "dist/",
    "",
  ].join("\n"));
  writeJson(join(projectRoot, "package.json"), {
    name: "packed-external-next-shape",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      typecheck: "npx tsc --noEmit",
      build: "node scripts/assert-worktree-node-modules.mjs",
    },
    dependencies: {
      yolo: pathToFileURL(tgzPath).href,
    },
    devDependencies: {
      typescript: localTypescriptDependency(),
    },
  });
  writeJson(join(projectRoot, "tsconfig.json"), {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      jsx: "preserve",
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: [
      "app/**/*.ts",
      "app/**/*.tsx",
      "components/**/*.ts",
      "components/**/*.tsx",
      "lib/**/*.ts",
      "lib/**/*.tsx",
    ],
  });
  writeText(join(projectRoot, "app", "page.tsx"), [
    "import { ExistingCard } from \"../components/ExistingCard.js\";",
    "import { formatTitle } from \"../lib/format.js\";",
    "",
    "export function renderPageTitle(): string {",
    "  return formatTitle(ExistingCard(\"ready\"));",
    "}",
    "",
    "export default renderPageTitle;",
    "",
  ].join("\n"));
  writeText(join(projectRoot, "components", "ExistingCard.tsx"), [
    "export function ExistingCard(label: string): string {",
    "  return `Existing ${label}`;",
    "}",
    "",
  ].join("\n"));
  writeText(join(projectRoot, "lib", "format.ts"), [
    "export function formatTitle(value: string): string {",
    "  return value.trim().toUpperCase();",
    "}",
    "",
  ].join("\n"));
  writeText(join(projectRoot, "scripts", "assert-worktree-node-modules.mjs"), [
    "import { lstatSync, realpathSync } from 'node:fs';",
    "import { isAbsolute, join, relative } from 'node:path';",
    "",
    "const root = process.cwd();",
    "const nodeModules = join(root, 'node_modules');",
    "const stat = lstatSync(nodeModules);",
    "if (!stat.isDirectory() || stat.isSymbolicLink()) {",
    "  throw new Error('node_modules must be a real directory inside the worktree');",
    "}",
    "const rootReal = realpathSync(root);",
    "const real = realpathSync(nodeModules);",
    "const rel = relative(rootReal, real);",
    "if (!rel || rel.startsWith('..') || isAbsolute(rel)) {",
    "  throw new Error(`node_modules points outside the worktree: ${real}`);",
    "}",
    "console.log(`[packed-external] node_modules realpath=${real}`);",
    "",
  ].join("\n"));
  assertCondition(!existsSync(join(projectRoot, "src")), "fixture has no src/ directory");
  assertCondition(existsSync(join(projectRoot, "app", "page.tsx")), "fixture app/ source exists");
  assertCondition(existsSync(join(projectRoot, "components", "ExistingCard.tsx")), "fixture components/ source exists");
  assertCondition(existsSync(join(projectRoot, "lib", "format.ts")), "fixture lib/ source exists");
  assertCondition(existsSync(join(projectRoot, "scripts", "assert-worktree-node-modules.mjs")), "fixture worktree node_modules build assertion exists");
}

function installedYoloBin(projectRoot: string) {
  return join(projectRoot, "node_modules", ".bin", "yolo");
}

function assertInstalledPackage(projectRoot: string) {
  const packageRoot = join(projectRoot, "node_modules", "yolo");
  const required = [
    join(projectRoot, "node_modules", ".bin", "yolo"),
    join(packageRoot, "dist", "bin", "yolo.js"),
    join(packageRoot, "dist", "gate.js"),
    join(packageRoot, "dist", "prompt.js"),
    join(packageRoot, "dist", "learn.js"),
    join(packageRoot, "dist", "src", "runtime", "execution", "provider-adapter.js"),
  ];
  for (const file of required) {
    assertCondition(existsSync(file), `installed package asset exists: ${relative(projectRoot, file)}`);
  }
}

function initGitRepository(projectRoot: string) {
  stage("git", "initial commit");
  runChecked("git init", "git", ["init"], { cwd: projectRoot });
  runChecked("git config user.email", "git", ["config", "user.email", "packed-smoke@example.invalid"], { cwd: projectRoot });
  runChecked("git config user.name", "git", ["config", "user.name", "Packed Smoke"], { cwd: projectRoot });
  runChecked("git add", "git", ["add", "."], { cwd: projectRoot });
  runChecked("git commit", "git", ["commit", "-m", "chore: initial external fixture"], { cwd: projectRoot });
  const head = runChecked("git rev-parse HEAD", "git", ["rev-parse", "HEAD"], { cwd: projectRoot }).stdout.trim();
  assertCondition(Boolean(head), `initial git commit exists: ${head.slice(0, 12)}`);
  return head;
}

function writeExternalConfig(projectRoot: string, options: { mutateBusinessSrcOnly: boolean }) {
  const businessGlobs = options.mutateBusinessSrcOnly
    ? ["src/**/*.ts", "src/**/*.tsx"]
    : ["app/**/*.ts", "app/**/*.tsx", "components/**/*.ts", "components/**/*.tsx", "lib/**/*.ts", "lib/**/*.tsx"];
  writeJson(join(projectRoot, ".yolo", "config.json"), {
    version: "2.0",
    project: {
      name: "packed-external-next-shape",
      root: ".",
      framework: "next",
      source_roots: ["app", "components", "lib"],
      source_extensions: [".ts", ".tsx"],
      exclude: ["node_modules", "dist", ".git", ".yolo"],
    },
    build: {
      business_globs: businessGlobs,
      type_check: "npx tsc --noEmit",
      lint: "",
      test: "",
      build: "npm run build",
    },
    ai: {
      executor: "claude",
      model: "stub",
      timeout_ms: 60000,
      settings: "",
      claude_permission_mode: "acceptEdits",
    },
    gate: {
      timeout: { type_check: 120000, lint: 90000, test: 120000, build: 240000 },
      max_files: 5,
      max_lines_per_file: 150,
    },
    runner: {
      max_retries: { "1": 0, "2": 0 },
      circuit_breaker: 1,
      session_timeout_h: 1,
      task_timeout_m: 2,
      stash_prefix: "temp-stash-for-",
      deterministic_dry_run_artifacts: false,
    },
    state: {
      dir: "state",
      max_events: 500,
      max_changes: 500,
      max_runs: 100,
    },
    progress_server: { port: 0 },
  });
  assertCondition(existsSync(join(projectRoot, ".yolo", "config.json")), "external .yolo/config.json exists");
  assertCondition(readJson(join(projectRoot, ".yolo", "config.json")).build.type_check === "npx tsc --noEmit", "external config uses JSON type_check=npx tsc --noEmit");
}

function qualityReport() {
  return {
    schema_version: "1.0",
    schema: "yolo.demand.quality.v1",
    status: "pass",
    total_score: 100,
    dimensions: [],
  };
}

function buildApprovedPrd(projectRoot: string, baseCommit: string) {
  const qr = qualityReport();
  return {
    version: "2.0",
    id: "PRD-20260615-PACKED-EXTERNAL-SMOKE",
    title: "Packed external lifecycle smoke",
    project: {
      name: "packed-external-next-shape",
      language: "typescript",
      framework: "next",
    },
    generated_by: "yolo-demand",
    generated_at: "2026-06-15T00:00:00.000Z",
    base_commit: baseCommit,
    review_policy: { mode: "deterministic" },
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-PACKED-EXTERNAL-SMOKE",
      approval: {
        approved: true,
        approved_by: "packed-external-smoke",
        approved_at: "2026-06-15T00:00:00.000Z",
        effective_for_prd: true,
      },
      project_facts: {
        target_files: [{ file: TARGET_FILE, status: "verified" }],
        assumptions: [],
      },
      quality_report: qr,
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: qr,
    },
    requirements: [{
      id: "REQ-PACKED-EXTERNAL-1",
      text: "A deterministic external smoke marker is available under the components directory.",
      demand_trace: { evidence: ["DEMAND-PACKED-EXTERNAL-SMOKE"] },
    }],
    designs: [{
      id: "DES-PACKED-EXTERNAL-1",
      text: "Use one small TypeScript source file in the existing components directory.",
    }],
    tasks: [{
      id: "TASK-PACKED-EXTERNAL-1",
      title: "Write external smoke source marker",
      description: "Place a deterministic smoke marker in one target TypeScript source file.",
      type: "feature",
      task_kind: "code_change",
      ui: false,
      interface: false,
      priority: "P3",
      status: "pending",
      requirement_ids: ["REQ-PACKED-EXTERNAL-1"],
      design_ids: ["DES-PACKED-EXTERNAL-1"],
      scope: {
        targets: [{ file: TARGET_FILE }],
        allow_new_files: true,
        max_files: 1,
        max_lines_per_file: 80,
      },
      post_conditions: [
        { id: "POST-FILE", type: "file_exists", severity: "FAIL", params: { file: TARGET_FILE } },
        { id: "POST-MARKER", type: "code_contains", severity: "FAIL", params: { files: [TARGET_FILE], text: TARGET_MARKER } },
        { id: "POST-TYPECHECK", type: "no_new_type_errors", severity: "FAIL", params: { command: "npx tsc --noEmit" } },
        { id: "POST-BUILD", type: "build_pass", severity: "FAIL", params: { command: "npm run build", timeout_ms: 120000 } },
      ],
      evidence_plan: [
        { type: "run_report", required: true },
        { type: "typecheck", command: "npx tsc --noEmit", required: true },
        { type: "build", command: "npm run build", required: true },
        { type: "acceptance_report", required: true },
      ],
      trace: {
        evidence: ["DEMAND-PACKED-EXTERNAL-SMOKE"],
      },
    }],
  };
}

function writeApprovedPrd(projectRoot: string, baseCommit: string) {
  const prdPath = join(projectRoot, ".yolo", "data", "prd", "current", "packed-external-prd.json");
  writeJson(prdPath, buildApprovedPrd(projectRoot, baseCommit));
  const prd = readJson(prdPath);
  assertCondition(prd.demand.approval.effective_for_prd === true, "PRD demand.approval.effective_for_prd is true");
  return prdPath;
}

function lifecycleArtifact(stageId: string, projectName: string, report: object) {
  const stageInfo = LIFECYCLE_STAGES.find((stage) => stage.id === stageId);
  if (!stageInfo) fail(`unknown lifecycle stage: ${stageId}`);
  const now = new Date().toISOString();
  return {
    schema_version: "1.0",
    schema: "yolo.lifecycle.stage_report.v1",
    lifecycle_schema: "yolo.lifecycle.artifact.v1",
    project: { name: projectName },
    stage: {
      id: stageInfo.id,
      sequence: stageInfo.sequence,
      label: stageInfo.label,
      writes_code: stageInfo.writes_code,
    },
    status: "completed",
    created_at: now,
    updated_at: now,
    inputs: [],
    outputs: [],
    decisions: [],
    evidence: [],
    blockers: [],
    next_actions: [],
    report,
  };
}

function seedLifecycleStage(projectRoot: string, stageId: string, report: object) {
  const stateRoot = join(projectRoot, ".yolo");
  const lifecycleRoot = join(stateRoot, "lifecycle");
  const stageInfo = LIFECYCLE_STAGES.find((stage) => stage.id === stageId);
  if (!stageInfo) fail(`unknown lifecycle stage: ${stageId}`);
  writeJson(join(lifecycleRoot, stageInfo.artifact), lifecycleArtifact(stageId, "packed-external-next-shape", report));
  const statusPath = join(lifecycleRoot, "status.json");
  const status = readJson(statusPath);
  const nextStage = LIFECYCLE_STAGES.find((stage) => stage.sequence === stageInfo.sequence + 1)?.id || stageId;
  status.current_stage = nextStage;
  status.updated_at = new Date().toISOString();
  status.stages = status.stages.map((stage) => {
    if (stage.id === stageId) return { ...stage, status: "completed" };
    if (stage.id === nextStage) return { ...stage, status: "active" };
    if (stage.status === "active") return { ...stage, status: "pending" };
    return stage;
  });
  writeJson(statusPath, status);
  pass(`seeded lifecycle ${stageId}`);
}

function runYoloJson(projectRoot: string, label: string, args: string[], expected = [0]) {
  const yolo = installedYoloBin(projectRoot);
  const result = runChecked(label, yolo, args, {
    cwd: projectRoot,
    expected,
    timeout: label === "yolo run" ? 300000 : 120000,
    env: {
      YOLO_PROVIDER_STUB: STUB_PATH,
      YOLO_PROVIDER_STUB_TARGET: TARGET_FILE,
      ...(label === "yolo run" ? { YOLO_DEBUG_WORKTREE_NODE_MODULES: "1" } : {}),
    },
  });
  const json = parseJsonOutput(result.stdout);
  const status = json.status || json.code || "unknown";
  log(`[transition] ${label} -> ${status}`);
  return json;
}

function assertLedgerProgress(projectRoot: string, runId: string) {
  const runsPath = join(projectRoot, ".yolo", "state", "runs.jsonl");
  const artifactsPath = join(projectRoot, ".yolo", "state", "artifacts.jsonl");
  const runs = readJsonl(runsPath);
  const artifacts = readJsonl(artifactsPath);
  assertCondition(runs.length > 0, "runs.jsonl has real ledger entries");
  assertCondition(runs.some((record) => record.run_id === runId), "runs.jsonl contains the packed smoke run_id");
  assertCondition(artifacts.length > 0, "artifacts.jsonl has real ledger entries");
  assertCondition(artifacts.some((record) => record.event === "artifact.write"), "artifacts.jsonl records run-report artifacts");
}

function findTscBaseline(projectRoot: string) {
  const current = join(projectRoot, ".yolo", "state", "runtime", "tsc-baseline.json");
  if (existsSync(current)) return current;
  const archiveRoot = join(projectRoot, ".yolo", "state", "archive", "raw-runtime");
  if (!existsSync(archiveRoot)) return null;
  const archiveNames = readdirSync(archiveRoot).sort().reverse();
  for (const name of archiveNames) {
    const candidate = join(archiveRoot, name, "runtime", "tsc-baseline.json");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findGateArtifact(projectRoot: string, taskId: string) {
  const filePrefix = `gate-${taskId}-`;
  const runtimeRoots = [join(projectRoot, ".yolo", "state", "runtime")];
  const archiveRoot = join(projectRoot, ".yolo", "state", "archive", "raw-runtime");
  if (existsSync(archiveRoot)) {
    for (const name of readdirSync(archiveRoot).sort().reverse()) {
      runtimeRoots.push(join(archiveRoot, name, "runtime"));
    }
  }
  for (const runtimeRoot of runtimeRoots) {
    if (!existsSync(runtimeRoot)) continue;
    const candidate = readdirSync(runtimeRoot)
      .filter((name) => name.startsWith(filePrefix) && name.endsWith(".json"))
      .sort()
      .reverse()[0];
    if (candidate) return join(runtimeRoot, candidate);
  }
  return null;
}

function assertWorktreeNodeModulesBuildGate(projectRoot: string) {
  const gatePath = findGateArtifact(projectRoot, "TASK-PACKED-EXTERNAL-1");
  assertCondition(gatePath && existsSync(gatePath), "gate artifact exists for packed external task");
  const gate = readJson(gatePath);
  const buildGate = (gate.gates || []).find((entry) => entry.name === "POST-BUILD");
  assertCondition(buildGate?.status === "pass", "POST-BUILD gate passed in the real worktree");
  assertCondition(String(buildGate.detail || "").includes("npm run build"), "POST-BUILD gate ran npm run build");
}

function assertAcceptanceUsedRunReport(acceptance: any, runReportPath: string) {
  const resolved = resolve(runReportPath);
  const artifacts = acceptance.artifact_integrity?.artifacts || [];
  const found = artifacts.some((artifact) => resolve(artifact.absolute_path || artifact.path || "") === resolved);
  assertCondition(found, "acceptance artifact_integrity used the runner's real run-report path");
}

function assertDeliveryComplete(projectRoot: string, ship: any) {
  assertCondition(ship.status === "success", "delivery command returned success");
  assertCondition(ship.ship?.status === "success", "delivery ship gate status is success");
  const deliveryReport = readJson(join(projectRoot, ".yolo", "lifecycle", "delivery-report.json"));
  assertCondition(deliveryReport.status === "completed", "delivery lifecycle report is completed");
  assertCondition(deliveryReport.report?.status === "success", "delivery lifecycle report is not pending or fake green");
}

async function runSmoke(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    log(usage());
    return 0;
  }
  assertCondition(existsSync(STUB_PATH), `provider stub exists: ${STUB_PATH}`);
  const tempRoot = mkdtempSync(join(tmpdir(), "yolo-packed-external-"));
  const packDir = join(tempRoot, "pack");
  const projectRoot = join(tempRoot, "external-next-shape");
  try {
    assertCondition(!isInside(REPO_ROOT, projectRoot), "external fixture lives outside the yolo repository");
    const tgzPath = npmPack(packDir);
    scaffoldProject(projectRoot, tgzPath);

    stage("install", "npm install tarball dependency");
    runChecked("npm install", "npm", ["install", "--no-audit", "--no-fund"], {
      cwd: projectRoot,
      timeout: 180000,
    });
    assertInstalledPackage(projectRoot);

    const yolo = installedYoloBin(projectRoot);
    const init = runChecked("yolo init", yolo, ["init", projectRoot, "--name", "packed-external-next-shape", "--force", "--json"], {
      cwd: projectRoot,
      timeout: 120000,
    });
    const initJson = parseJsonOutput(init.stdout);
    assertCondition(initJson.status === "success", "installed yolo init succeeds outside the repository");

    const baseCommit = initGitRepository(projectRoot);
    writeExternalConfig(projectRoot, options);
    const prdPath = writeApprovedPrd(projectRoot, baseCommit);
    seedLifecycleStage(projectRoot, "discovery", { status: "success", summary: "approved demand seeded for packed smoke" });
    seedLifecycleStage(projectRoot, "roadmap", { status: "success", summary: "single-task plan seeded for packed smoke" });
    seedLifecycleStage(projectRoot, "prd", { status: "success", prd_path: prdPath, artifacts: [prdPath] });

    const check = runYoloJson(projectRoot, "yolo check", ["check", prdPath, "--cwd", projectRoot, "--json"]);
    assertCondition(check.status === "pass", "check passed on approved external PRD");

    const run = runYoloJson(projectRoot, "yolo run", [
      "run",
      prdPath,
      "--cwd",
      projectRoot,
      "--engine-only",
      "--no-progress-server",
      "--no-review-loop",
      "--json",
    ]);
    assertCondition(run.status === "success", "run completed through real runner");
    assertCondition(Boolean(run.run_id), "run returned a run_id");
    const runReportPath = join(projectRoot, ".yolo", "state", "reports", run.run_id, "run-report.json");
    assertCondition(existsSync(runReportPath), "runner wrote the real state/reports/<run_id>/run-report.json");
    const runReport = readJson(runReportPath);
    assertCondition(runReport.status === "success", "real run-report status is success");

    const targetPath = join(projectRoot, TARGET_FILE);
    assertCondition(existsSync(targetPath), "provider stub wrote source under components/");
    assertCondition(readFileSync(targetPath, "utf8").includes(TARGET_MARKER), "components/ source contains stub marker");
    assertLedgerProgress(projectRoot, run.run_id);

    const baselinePath = findTscBaseline(projectRoot);
    assertCondition(baselinePath && existsSync(baselinePath), "tsc baseline exists after runner startup/finalize archive");
    assertCondition(readJson(baselinePath).meta?.status === "pass", "tsc baseline status is pass, not silent ENOENT");
    assertWorktreeNodeModulesBuildGate(projectRoot);

    const review = runYoloJson(projectRoot, "yolo review", ["review", TARGET_FILE, "--cwd", projectRoot, "--json"]);
    assertCondition(review.status === "success", "review completed for changed source file");

    const acceptance = runYoloJson(projectRoot, "yolo release accept", [
      "release",
      "accept",
      prdPath,
      "--cwd",
      projectRoot,
      "--run-report",
      runReportPath,
      "--json",
    ]);
    assertCondition(acceptance.status === "pass", "acceptance passed using explicit run-report");
    assertAcceptanceUsedRunReport(acceptance, runReportPath);

    const prdAfter = readJson(prdPath);
    assertCondition(prdAfter.demand?.approval?.effective_for_prd === true, "approval contract remains effective_for_prd=true after run");

    const ship = runYoloJson(projectRoot, "yolo release ship", ["release", "ship", prdPath, "--cwd", projectRoot, "--json"]);
    assertDeliveryComplete(projectRoot, ship);

    stage("done", `project=${projectRoot}`);
    log(JSON.stringify({
      status: "pass",
      mutation: options.mutateBusinessSrcOnly ? "business-src-only" : null,
      project_root: projectRoot,
      prd_path: prdPath,
      run_id: run.run_id,
      run_report_path: runReportPath,
    }, null, 2));
    return 0;
  } finally {
    if (options.keep) {
      stage("keep", tempRoot);
    } else {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

try {
  process.exitCode = await runSmoke();
} catch (error) {
  process.stderr.write(`[packed-external] FAIL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
