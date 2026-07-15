#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const YOLO_SOURCE_BIN = join(REPO_ROOT, "bin", "yolo.ts");
const YOLO_DIST_BIN = join(REPO_ROOT, "dist", "bin", "yolo.js");
const DIST_HELPERS = ["prompt.js", "gate.js", "learn.js"].map((file) => join(REPO_ROOT, "dist", file));
const STUB_PATH = join(REPO_ROOT, "scripts", "e2e-smoke", "provider-stub.mjs");
const TARGET_MARKER = "YOLO_PACKED_EXTERNAL_SMOKE_MARKER";
const FIXED_NOW = "2026-06-20T00:00:00.000Z";
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const RUN_COMMAND_TIMEOUT_MS = 180_000;
const TOTAL_TIMEOUT_MS = 600_000;

const MATRIX_CELLS = [
  { id: "L1/help", layer: "L1", domain: "smoke", expected: "yolo --help exits 0 and lists public commands" },
  { id: "L1/init", layer: "L1", domain: "smoke", expected: "yolo init exits 0 and writes .yolo/config.json plus lifecycle status" },
  { id: "L1/install", layer: "L1", domain: "smoke", expected: "yolo install exits 0 and writes project-scoped Codex bridge files" },
  { id: "L1/status", layer: "L1", domain: "smoke", expected: "yolo status exits 0 and returns a recommended command" },
  { id: "L2/setup-demand", layer: "L2", domain: "single-stage setup", expected: "fixed interview answers create an approved demand handoff" },
  { id: "L2/spec-demand", layer: "L2", domain: "single-stage", expected: "yolo spec --demand exits 0 and writes prd.json" },
  { id: "L2/check-prd", layer: "L2", domain: "single-stage", expected: "yolo check --prd exits 0 and writes check-report.json" },
  { id: "L3/cli-clean", layer: "L3", domain: "node-basic clean CLI", expected: "stub-provider run through learn exits 0 and writes target, run, review, acceptance, delivery, learn artifacts" },
  { id: "L3/http-api", layer: "L3", domain: "backend-api HTTP fixture", expected: "stub-provider run through learn exits 0 and verifies backend fixture signals" },
  { id: "L3/monorepo", layer: "L3", domain: "monorepo fixture", expected: "stub-provider run through learn exits 0 and verifies workspace fixture signals" },
];

type CellResult = {
  id: string;
  status: "pass" | "fail";
  duration_ms: number;
  detail?: string;
};

type CommandRun = {
  command: string;
  args: string[];
  display: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

type Failure = {
  cell: string;
  command: string;
  expectedExit?: number[];
  actualExit?: number | string;
  missingArtifacts?: string[];
  detail?: string;
  stdout?: string;
  stderr?: string;
};

const results: CellResult[] = [];
const failures: Failure[] = [];
const suiteStarted = performance.now();

function log(message: string) {
  process.stdout.write(`${message}\n`);
}

function tail(value = "", max = 12_000) {
  const text = String(value || "");
  return text.length > max ? text.slice(-max) : text;
}

function quoteArg(value: string) {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function displayCommand(command: string, args: string[]) {
  return [command, ...args].map(quoteArg).join(" ");
}

function fail(failure: Failure): never {
  const message = [
    `[matrix-ci] FAIL ${failure.cell}`,
    `command: ${failure.command}`,
    failure.expectedExit ? `expected exit: ${failure.expectedExit.join(",")}` : "",
    failure.actualExit != null ? `actual exit: ${failure.actualExit}` : "",
    failure.missingArtifacts?.length ? `missing artifacts: ${failure.missingArtifacts.join(", ")}` : "",
    failure.detail || "",
  ].filter(Boolean).join("\n");
  const error = new Error(message) as Error & { matrixFailure?: Failure };
  error.matrixFailure = failure;
  throw error;
}

function assertCondition(condition: unknown, failure: Failure): asserts condition {
  if (!condition) fail(failure);
}

function assertArtifacts(cell: string, command: string, paths: string[]) {
  const missing = paths.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    fail({
      cell,
      command,
      missingArtifacts: missing,
      detail: "Expected matrix artifact(s) were not written.",
    });
  }
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeText(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

function writeJson(path: string, value: unknown) {
  return writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonOutput(text: string) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  for (let index = trimmed.lastIndexOf("{"); index >= 0;) {
    try {
      return JSON.parse(trimmed.slice(index));
    } catch {}
    index = index === 0 ? -1 : trimmed.lastIndexOf("{", index - 1);
  }
  throw new Error(`No JSON object found in command output:\n${tail(trimmed)}`);
}

function jsonDiagnostic(text: string) {
  try {
    const json = parseJsonOutput(text);
    return [
      json.status ? `status=${json.status}` : "",
      json.code ? `code=${json.code}` : "",
      json.summary ? `summary=${json.summary}` : "",
      json.reason ? `reason=${json.reason}` : "",
    ].filter(Boolean).join(" ");
  } catch {
    return "";
  }
}

function runProcess(
  cell: string,
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    expectedExit?: number[];
  } = {},
): CommandRun {
  const expectedExit = options.expectedExit || [0];
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      ...(options.env || {}),
    },
    encoding: "utf8",
    timeout: options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const durationMs = Math.round(performance.now() - started);
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const exitCode = timedOut ? 124 : result.status ?? (result.signal ? 1 : 1);
  const run = {
    command,
    args,
    display: displayCommand(command, args),
    cwd: options.cwd || REPO_ROOT,
    exitCode,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    durationMs,
    timedOut,
  };
  log(`[cmd] ${cell} exit=${timedOut ? "timeout" : exitCode} ${durationMs}ms ${run.display}`);
  if (!expectedExit.includes(exitCode)) {
    const diagnostic = jsonDiagnostic(run.stdout);
    fail({
      cell,
      command: run.display,
      expectedExit,
      actualExit: timedOut ? "timeout" : exitCode,
      detail: [
        result.error ? `spawn error: ${result.error.message}` : "Command exit did not match.",
        diagnostic,
      ].filter(Boolean).join(" "),
      stdout: tail(run.stdout),
      stderr: tail(run.stderr),
    });
  }
  return run;
}

function runYolo(
  cell: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    expectedExit?: number[];
    expectedStatus?: string[];
    runtime?: "source" | "dist";
  } = {},
) {
  const runtime = options.runtime || "source";
  const yoloArgs = runtime === "dist"
    ? [YOLO_DIST_BIN, ...args]
    : ["--import", "tsx", YOLO_SOURCE_BIN, ...args];
  const run = runProcess(cell, process.execPath, yoloArgs, {
    cwd: REPO_ROOT,
    env: options.env,
    timeoutMs: options.timeoutMs,
    expectedExit: options.expectedExit,
  });
  const json = args.includes("--json") ? parseJsonOutput(run.stdout) : null;
  if (json && options.expectedStatus?.length) {
    const status = String(json.status || json.code || "").trim();
    assertCondition(options.expectedStatus.includes(status), {
      cell,
      command: run.display,
      expectedExit: options.expectedExit || [0],
      actualExit: run.exitCode,
      detail: `Expected JSON status ${options.expectedStatus.join(",")} but got ${status || "(missing)"}.`,
      stdout: tail(run.stdout),
      stderr: tail(run.stderr),
    });
  }
  return { run, json };
}

function runGit(cell: string, cwd: string, args: string[]) {
  return runProcess(cell, "git", args, { cwd, timeoutMs: 30_000 });
}

function copyFixture(name: string, destination: string) {
  const source = join(REPO_ROOT, "fixtures", name);
  assertCondition(existsSync(source) && statSync(source).isDirectory(), {
    cell: "setup",
    command: `copy fixture ${name}`,
    detail: `Fixture not found: ${source}`,
  });
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true });
}

function initGitRepository(cell: string, projectRoot: string) {
  runGit(cell, projectRoot, ["init"]);
  runGit(cell, projectRoot, ["config", "user.email", "matrix-ci@example.invalid"]);
  runGit(cell, projectRoot, ["config", "user.name", "Matrix CI"]);
  runGit(cell, projectRoot, ["add", "."]);
  runGit(cell, projectRoot, ["commit", "-m", "chore: matrix fixture baseline"]);
  return runGit(cell, projectRoot, ["rev-parse", "HEAD"]).stdout.trim();
}

function matrixConfig(projectName: string, businessGlobs: string[], typeCheckCommand = "") {
  return {
    version: "2.0",
    project: {
      name: projectName,
      root: ".",
      framework: "matrix-ci",
      source_roots: ["src", "packages"],
      source_extensions: [".ts", ".tsx", ".js", ".jsx"],
      exclude: ["node_modules", "dist", ".git", ".yolo"],
    },
    build: {
      business_globs: businessGlobs,
      type_check: typeCheckCommand,
      lint: "",
      test: "",
      build: "",
    },
    ai: {
      executor: "claude",
      model: "stub",
      timeout_ms: 30_000,
      settings: "",
      claude_permission_mode: "acceptEdits",
    },
    gate: {
      timeout: { type_check: 30_000, lint: 30_000, test: 30_000, build: 30_000 },
      max_files: 5,
      max_lines_per_file: 160,
    },
    runner: {
      max_retries: { "1": 0, "2": 0 },
      circuit_breaker: 1,
      session_timeout_h: 1,
      task_timeout_m: 1,
      task_timeout_floor_s: 5,
      stash_prefix: "matrix-ci-stash-",
      deterministic_dry_run_artifacts: false,
    },
    state: {
      dir: "state",
      max_events: 500,
      max_changes: 500,
      max_runs: 100,
    },
    progress_server: { port: 0 },
  };
}

function writeVerifierScript(projectRoot: string, options: {
  targetFile: string;
  requiredFiles: string[];
  requiredText?: Record<string, string>;
}) {
  const requiredText = options.requiredText || {};
  return writeText(join(projectRoot, "scripts", "matrix-ci-verify.mjs"), [
    "import { existsSync, readFileSync } from 'node:fs';",
    "",
    `const targetFile = ${JSON.stringify(options.targetFile)};`,
    `const marker = ${JSON.stringify(TARGET_MARKER)};`,
    `const requiredFiles = ${JSON.stringify(options.requiredFiles)};`,
    `const requiredText = ${JSON.stringify(requiredText, null, 2)};`,
    "",
    "function fail(message) {",
    "  throw new Error(message);",
    "}",
    "",
    "for (const file of [targetFile, ...requiredFiles]) {",
    "  if (!existsSync(file)) fail(`missing required file: ${file}`);",
    "}",
    "",
    "const targetText = readFileSync(targetFile, 'utf8');",
    "if (!targetText.includes(marker)) fail(`target marker missing from ${targetFile}`);",
    "",
    "for (const [file, text] of Object.entries(requiredText)) {",
    "  const content = readFileSync(file, 'utf8');",
    "  if (!content.includes(text)) fail(`expected ${file} to contain ${text}`);",
    "}",
    "",
    "console.log(`matrix-ci verifier pass: ${targetFile}`);",
    "",
  ].join("\n"));
}

function buildApprovedPrd(input: {
  idSuffix: string;
  title: string;
  projectName: string;
  framework: string;
  targetFile: string;
  baseCommit: string;
}) {
  const reqId = `REQ-MATRIX-${input.idSuffix}`;
  const taskId = `TASK-MATRIX-${input.idSuffix}-001`;
  const qualityReport = {
    schema_version: "1.0",
    schema: "yolo.demand.quality.v1",
    status: "pass",
    total_score: 100,
    dimensions: [],
    blockers: [],
    warnings: [],
  };
  return {
    $schema: "https://yolo.dev/schemas/prd-v2.schema.json",
    version: "2.0",
    id: `PRD-20260620-MATRIX-${input.idSuffix}`,
    title: input.title,
    project: {
      name: input.projectName,
      language: "javascript",
      package_manager: "npm",
      framework: input.framework,
    },
    generated_by: "other",
    generated_at: FIXED_NOW,
    base_commit: input.baseCommit,
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: `DEMAND-MATRIX-${input.idSuffix}`,
      approval: {
        approved: true,
        approved_by: "matrix-ci",
        approved_at: FIXED_NOW,
        effective_for_prd: true,
      },
      project_facts: {
        target_files: [{ file: input.targetFile, status: "verified", source: "matrix-ci fixture" }],
        assumptions: [],
      },
      quality_report: qualityReport,
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: qualityReport,
    },
    requirements: [{
      id: reqId,
      text: `Create the deterministic matrix CI marker at ${input.targetFile}.`,
      demand_trace: { evidence: [`DEMAND-MATRIX-${input.idSuffix}`] },
    }],
    designs: [{
      id: `DES-MATRIX-${input.idSuffix}`,
      text: "Use the local provider stub to write one small TypeScript marker file.",
    }],
    tasks: [{
      id: taskId,
      title: `Write matrix marker for ${input.title}`,
      description: "Provider stub writes one deterministic source marker, then a local verifier checks fixture-specific signals.",
      type: "feature",
      task_kind: "code_change",
      priority: "P3",
      status: "pending",
      requirement_ids: [reqId],
      design_ids: [`DES-MATRIX-${input.idSuffix}`],
      scope: {
        targets: [{ file: input.targetFile }],
        allow_new_files: true,
        max_files: 1,
        max_lines_per_file: 120,
      },
      post_conditions: [
        { id: "POST-FILE", type: "file_exists", severity: "FAIL", params: { file: input.targetFile } },
        { id: "POST-MARKER", type: "code_contains", severity: "FAIL", params: { file: input.targetFile, text: TARGET_MARKER } },
        { id: "POST-VERIFY", type: "tests_pass", severity: "FAIL", params: { command: "node scripts/matrix-ci-verify.mjs", timeout_ms: 30_000 } },
      ],
      acceptance_criteria: [
        "The provider stub marker file exists.",
        "The local matrix verifier passes without network, provider, or package install.",
      ],
      state_matrix: [
        { state: "marker-present", surface: input.targetFile, expected: "Matrix CI marker exists in the selected fixture domain." },
      ],
      evidence_plan: [
        { type: "run_report", required: true },
        { type: "local_verifier", command: "node scripts/matrix-ci-verify.mjs", required: true },
      ],
      trace: { evidence: [`DEMAND-MATRIX-${input.idSuffix}`] },
    }],
  };
}

function seedLifecycle(projectRoot: string, prdPath: string) {
  const stateRoot = join(projectRoot, ".yolo");
  writeLifecycleStageReport("discovery", { status: "success", summary: "matrix fixture discovery seeded" }, {
    projectRoot,
    stateRoot,
    source: "matrix-ci",
    skipSequenceCheck: true,
    now: FIXED_NOW,
  });
  writeLifecycleStageReport("roadmap", { status: "success", summary: "matrix fixture roadmap seeded" }, {
    projectRoot,
    stateRoot,
    source: "matrix-ci",
    skipSequenceCheck: true,
    now: FIXED_NOW,
  });
  writeLifecycleStageReport("prd", { status: "success", summary: "matrix fixture PRD seeded", prd_path: prdPath, artifacts: [prdPath] }, {
    projectRoot,
    stateRoot,
    source: "matrix-ci",
    skipSequenceCheck: true,
    now: FIXED_NOW,
  });
}

async function runCell(id: string, fn: () => Promise<void> | void) {
  const started = performance.now();
  log(`[cell] START ${id}`);
  try {
    if (performance.now() - suiteStarted > TOTAL_TIMEOUT_MS) {
      fail({
        cell: id,
        command: "matrix total timeout guard",
        actualExit: "timeout",
        detail: `Matrix exceeded total timeout of ${TOTAL_TIMEOUT_MS}ms before starting this cell.`,
      });
    }
    await fn();
    const duration = Math.round(performance.now() - started);
    results.push({ id, status: "pass", duration_ms: duration });
    log(`[cell] PASS ${id} ${duration}ms`);
  } catch (error) {
    const duration = Math.round(performance.now() - started);
    const matrixFailure = (error as Error & { matrixFailure?: Failure }).matrixFailure;
    const failure = matrixFailure || {
      cell: id,
      command: "cell",
      detail: error instanceof Error ? error.message : String(error),
    };
    failures.push(failure);
    results.push({ id, status: "fail", duration_ms: duration, detail: failure.detail });
    log(`[cell] FAIL ${id} ${duration}ms`);
  }
}

async function runL1(tempRoot: string) {
  const projectRoot = join(tempRoot, "l1-smoke");
  mkdirSync(projectRoot, { recursive: true });
  writeJson(join(projectRoot, "package.json"), {
    name: "matrix-l1-smoke",
    version: "0.0.0",
    private: true,
    type: "module",
  });

  await runCell("L1/help", () => {
    const { run } = runYolo("L1/help", ["--help"]);
    assertCondition(run.stdout.includes("yolo status") && run.stdout.includes("yolo spec"), {
      cell: "L1/help",
      command: run.display,
      expectedExit: [0],
      actualExit: run.exitCode,
      detail: "Help output did not list expected public commands.",
      stdout: tail(run.stdout),
      stderr: tail(run.stderr),
    });
  });

  await runCell("L1/init", () => {
    const { json, run } = runYolo("L1/init", ["init", projectRoot, "--name", "matrix-l1-smoke", "--json"], {
      expectedStatus: ["success"],
    });
    assertCondition(json?.project_root === projectRoot, {
      cell: "L1/init",
      command: run.display,
      expectedExit: [0],
      actualExit: run.exitCode,
      detail: "init JSON project_root did not match temp project.",
      stdout: tail(run.stdout),
    });
    assertArtifacts("L1/init", run.display, [
      join(projectRoot, ".yolo", "config.json"),
      join(projectRoot, ".yolo", "lifecycle", "status.json"),
    ]);
  });

  await runCell("L1/install", () => {
    const { json, run } = runYolo("L1/install", [
      "install",
      projectRoot,
      "--target",
      "codex",
      "--scope",
      "project",
      "--json",
    ], { expectedStatus: ["success"] });
    assertCondition(json?.writes_workspace === true && json?.writes_user_home === false, {
      cell: "L1/install",
      command: run.display,
      expectedExit: [0],
      actualExit: run.exitCode,
      detail: "install was expected to write only project-scoped bridge files.",
      stdout: tail(run.stdout),
    });
    assertArtifacts("L1/install", run.display, [
      join(projectRoot, "AGENTS.md"),
      join(projectRoot, ".codex", "skills", "yolo", "SKILL.md"),
    ]);
  });

  await runCell("L1/status", () => {
    const { json, run } = runYolo("L1/status", ["status", "--cwd", projectRoot, "--json"], {
      expectedStatus: ["success"],
    });
    assertCondition(Boolean(json?.recommended_command), {
      cell: "L1/status",
      command: run.display,
      expectedExit: [0],
      actualExit: run.exitCode,
      detail: "status JSON did not include recommended_command.",
      stdout: tail(run.stdout),
    });
  });
}

function interviewAnswers(title: string, targetFile: string) {
  return [
    ["premise_current_solution", `Release maintainers manually run the matrix check for ${title} and inspect its generated artifacts before every merge.`],
    ["premise_consequence", "Without the deterministic path, a CLI or fixture regression can reach main while ordinary unit tests still pass."],
    ["premise_minimum", `The minimum useful version runs one deterministic demand-to-check path for ${targetFile} and fails closed when an artifact is missing.`],
    ["premise_decision", "Continue."],
    ["target_users", `A release operations manager uses ${title} daily on every pull request and is responsible for the merge/no-merge decision, failed-cell triage, and review signoff.`],
    ["status_quo", "The coverage matrix is currently checked manually with `npm run soak` once per week, so regressions can be missed between manual runs."],
    ["pain_points", "Manual soak takes about 20 minutes of release-maintainer time, is skipped under deadline pressure, and lets a CLI, HTTP, or monorepo fixture regression reach main while ordinary unit tests still pass."],
    ["layer_1_confirmation", "Confirmed, the role, current flow, and pain are complete."],
    ["day_in_life", `On every pull request, the release manager starts the ${title} matrix cell, reviews its generated PRD and check report, and blocks the merge if either artifact is missing or blocked.`],
    ["desired_outcome", `CI produces a fixed executable PRD for ${targetFile} and fails when the readiness check regresses.`],
    ["layer_2_confirmation", "Confirmed, this is the complete day-in-the-life flow."],
    ["exceptions", "If the fixture target is missing or the check blocks, the matrix cell must fail closed instead of creating success evidence."],
    ["scope_boundaries", `Only generated .yolo artifacts and ${targetFile} are in scope; no business source edits are part of L2.`],
    ["layer_3_confirmation", "Confirmed, the exceptions and boundaries are complete."],
    ["success_criteria", `The CI log shows exit 0, a concrete prd.json path, and a check-report.json whose JSON status is pass for ${targetFile}; any missing artifact or non-pass status turns the PR red.`],
    ["success_proof", "Run yolo spec --demand and yolo check --prd, then verify both JSON artifacts exist and report pass/success."],
    ["layer_4_confirmation", "Confirmed, the requirement has observable acceptance evidence."],
    ["requirements_confirmation", "Confirmed, R-001 is accurate and complete."],
    ["execution_approval", "Approved for deterministic matrix CI PRD and check generation."],
  ];
}

function createApprovedDemand(projectRoot: string, id: string, title: string, targetFile: string) {
  const idea = [
    `Verify ${title} through a deterministic CI matrix cell.`,
    `The deterministic fixture file is ${targetFile}.`,
    "This stage uses only local fixture files, with no provider, network, or package install.",
  ].join("\n");

  const start = runYolo("L2/setup-demand", [
    "interview",
    "start",
    idea,
    "--cwd",
    projectRoot,
    "--id",
    id,
    "--title",
    title,
    "--json",
  ], { expectedStatus: ["success"] });
  const sessionPath = start.json?.session_path;
  assertCondition(Boolean(sessionPath), {
    cell: "L2/setup-demand",
    command: start.run.display,
    expectedExit: [0],
    actualExit: start.run.exitCode,
    detail: "interview start did not return session_path.",
    stdout: tail(start.run.stdout),
  });

  const confirmPlayback = () => {
    const playback = runYolo("L2/setup-demand", [
      "interview",
      "playback",
      "--session",
      sessionPath,
      "--json",
    ], { expectedStatus: ["ready"] });
    const playbackHash = String(playback.json?.outputs?.[0]?.playback?.content_hash || "");
    assertCondition(Boolean(playbackHash), {
      cell: "L2/setup-demand",
      command: playback.run.display,
      actualExit: playback.run.exitCode,
      detail: "interview playback did not return a content_hash.",
      stdout: tail(playback.run.stdout),
    });

    runYolo("L2/setup-demand", [
      "interview",
      "playback",
      "--session",
      sessionPath,
      "--confirm",
      playbackHash,
      "--json",
    ], { expectedStatus: ["success"] });
  };

  for (const [question, answer] of interviewAnswers(title, targetFile)) {
    runYolo("L2/setup-demand", [
      "interview",
      "answer",
      "--session",
      sessionPath,
      "--question",
      question,
      "--answer",
      answer,
      "--json",
    ], { expectedStatus: ["success"] });
    if (question === "premise_decision") confirmPlayback();
  }

  confirmPlayback();

  const demand = runYolo("L2/setup-demand", [
    "interview",
    "to-demand",
    "--session",
    sessionPath,
    "--cwd",
    projectRoot,
    "--json",
  ], { expectedStatus: ["success"] });

  const demandDir = demand.json?.demand_dir;
  assertCondition(Boolean(demandDir), {
    cell: "L2/setup-demand",
    command: demand.run.display,
    expectedExit: [0],
    actualExit: demand.run.exitCode,
    detail: "interview to-demand did not return demand_dir.",
    stdout: tail(demand.run.stdout),
  });
  assertArtifacts("L2/setup-demand", demand.run.display, [join(demandDir, "session.json")]);
  return demandDir;
}

async function runL2(tempRoot: string) {
  const projectRoot = join(tempRoot, "l2-single-stage");
  const targetFile = "src/index.ts";
  let demandDir = "";
  let prdPath = "";

  await runCell("L2/setup-demand", () => {
    copyFixture("dirty-tree", projectRoot);
    runYolo("L2/setup-demand", ["init", projectRoot, "--name", "matrix-l2-single-stage", "--force", "--json"], {
      expectedStatus: ["success"],
    });
    demandDir = createApprovedDemand(projectRoot, "matrix-l2-single-stage", "Matrix L2 single-stage", targetFile);
  });

  await runCell("L2/spec-demand", () => {
    assertCondition(Boolean(demandDir), {
      cell: "L2/spec-demand",
      command: "precondition",
      detail: "L2 setup did not produce a demand directory.",
    });
    const { json, run } = runYolo("L2/spec-demand", [
      "spec",
      "--demand",
      demandDir,
      "--cwd",
      projectRoot,
      "--target",
      targetFile,
      "--json",
    ], { expectedStatus: ["success"] });
    prdPath = json?.prd_path || json?.output_path || "";
    assertCondition(Boolean(prdPath), {
      cell: "L2/spec-demand",
      command: run.display,
      expectedExit: [0],
      actualExit: run.exitCode,
      detail: "spec did not return prd_path/output_path.",
      stdout: tail(run.stdout),
    });
    assertArtifacts("L2/spec-demand", run.display, [prdPath, join(projectRoot, ".yolo", "lifecycle", "prd.json")]);
  });

  await runCell("L2/check-prd", () => {
    assertCondition(Boolean(prdPath), {
      cell: "L2/check-prd",
      command: "precondition",
      detail: "L2 spec did not produce a PRD path.",
    });
    const { json, run } = runYolo("L2/check-prd", [
      "check",
      prdPath,
      "--cwd",
      projectRoot,
      "--json",
    ], { expectedStatus: ["pass"] });
    assertCondition(json?.status === "pass", {
      cell: "L2/check-prd",
      command: run.display,
      expectedExit: [0],
      actualExit: run.exitCode,
      detail: "check JSON status was not pass.",
      stdout: tail(run.stdout),
    });
    assertArtifacts("L2/check-prd", run.display, [join(projectRoot, ".yolo", "lifecycle", "check-report.json")]);
  });
}

type L3Domain = {
  id: string;
  fixture: string;
  title: string;
  projectName: string;
  framework: string;
  targetFile: string;
  typeCheckCommand: string;
  businessGlobs: string[];
  requiredFiles: string[];
  requiredText?: Record<string, string>;
};

const L3_DOMAINS: L3Domain[] = [
  {
    id: "cli-clean",
    fixture: "node-basic",
    title: "Matrix CLI clean fixture",
    projectName: "matrix-cli-clean",
    framework: "node-cli",
    targetFile: "src/matrix-ci-stub.ts",
    typeCheckCommand: "node --experimental-strip-types --check src/index.ts",
    businessGlobs: ["src/**/*.ts"],
    requiredFiles: ["src/index.ts", "package.json"],
    requiredText: { "src/index.ts": "export function add" },
  },
  {
    id: "http-api",
    fixture: "backend-api",
    title: "Matrix HTTP API fixture",
    projectName: "matrix-http-api",
    framework: "node-http",
    targetFile: "src/matrix-ci-stub.ts",
    typeCheckCommand: "node --experimental-strip-types --check src/server.ts",
    businessGlobs: ["src/**/*.ts"],
    requiredFiles: ["src/server.ts", "test/server.test.ts"],
    requiredText: { "src/server.ts": "routeApiRequest" },
  },
  {
    id: "monorepo",
    fixture: "monorepo",
    title: "Matrix monorepo fixture",
    projectName: "matrix-monorepo",
    framework: "monorepo",
    targetFile: "packages/app/src/matrix-ci-stub.ts",
    typeCheckCommand: "node --experimental-strip-types --check packages/app/src/index.ts",
    businessGlobs: ["packages/**/*.ts"],
    requiredFiles: ["packages/app/src/index.ts", "packages/utils/src/math.ts", "packages/app/test.ts"],
    requiredText: { "packages/utils/src/math.ts": "export function add" },
  },
];

async function runL3Domain(tempRoot: string, domain: L3Domain) {
  const cell = `L3/${domain.id}`;
  await runCell(cell, () => {
    const projectRoot = join(tempRoot, `l3-${domain.id}`);
    copyFixture(domain.fixture, projectRoot);
    runYolo(cell, ["init", projectRoot, "--name", domain.projectName, "--force", "--json"], {
      expectedStatus: ["success"],
      runtime: "dist",
    });
    writeJson(join(projectRoot, ".yolo", "config.json"), matrixConfig(domain.projectName, domain.businessGlobs, domain.typeCheckCommand));
    writeVerifierScript(projectRoot, {
      targetFile: domain.targetFile,
      requiredFiles: domain.requiredFiles,
      requiredText: domain.requiredText,
    });
    const baseCommit = initGitRepository(cell, projectRoot);
    const prdPath = join(projectRoot, ".yolo", "data", "prd", "current", `matrix-${domain.id}.json`);
    writeJson(prdPath, buildApprovedPrd({
      idSuffix: domain.id.toUpperCase().replace(/[^A-Z0-9]+/g, "-"),
      title: domain.title,
      projectName: domain.projectName,
      framework: domain.framework,
      targetFile: domain.targetFile,
      baseCommit,
    }));
    seedLifecycle(projectRoot, prdPath);

    const check = runYolo(cell, ["check", prdPath, "--cwd", projectRoot, "--json"], {
      expectedStatus: ["pass"],
      runtime: "dist",
    });
    assertArtifacts(cell, check.run.display, [join(projectRoot, ".yolo", "lifecycle", "check-report.json")]);

    const run = runYolo(cell, [
      "run",
      prdPath,
      "--cwd",
      projectRoot,
      "--engine-only",
      "--no-progress-server",
      "--no-review-loop",
      "--json",
    ], {
      timeoutMs: RUN_COMMAND_TIMEOUT_MS,
      expectedStatus: ["success"],
      runtime: "dist",
      env: {
        YOLO_PROVIDER_STUB: STUB_PATH,
        YOLO_PROVIDER_STUB_TARGET: domain.targetFile,
      },
    });
    const runId = run.json?.run_id;
    assertCondition(Boolean(runId), {
      cell,
      command: run.run.display,
      expectedExit: [0],
      actualExit: run.run.exitCode,
      detail: "run did not return run_id.",
      stdout: tail(run.run.stdout),
      stderr: tail(run.run.stderr),
    });
    const runReportPath = join(projectRoot, ".yolo", "state", "reports", runId, "run-report.json");
    assertArtifacts(cell, run.run.display, [
      join(projectRoot, domain.targetFile),
      runReportPath,
      join(projectRoot, ".yolo", "lifecycle", "run-report.json"),
    ]);
    assertCondition(readFileSync(join(projectRoot, domain.targetFile), "utf8").includes(TARGET_MARKER), {
      cell,
      command: run.run.display,
      expectedExit: [0],
      actualExit: run.run.exitCode,
      detail: `Stub marker missing from ${domain.targetFile}.`,
    });

    const review = runYolo(cell, ["review", domain.targetFile, "--cwd", projectRoot, "--json"], {
      expectedStatus: ["success"],
      runtime: "dist",
    });
    assertArtifacts(cell, review.run.display, [join(projectRoot, ".yolo", "lifecycle", "review-report.json")]);

    const acceptance = runYolo(cell, [
      "release",
      "accept",
      prdPath,
      "--cwd",
      projectRoot,
      "--run-report",
      runReportPath,
      "--json",
    ], { expectedStatus: ["pass"], runtime: "dist" });
    assertArtifacts(cell, acceptance.run.display, [join(projectRoot, ".yolo", "lifecycle", "acceptance-report.json")]);

    const ship = runYolo(cell, ["release", "ship", prdPath, "--cwd", projectRoot, "--json"], {
      expectedStatus: ["success"],
      runtime: "dist",
    });
    assertArtifacts(cell, ship.run.display, [join(projectRoot, ".yolo", "lifecycle", "delivery-report.json")]);

    const learn = runYolo(cell, [
      "learn",
      prdPath,
      "--cwd",
      projectRoot,
      "--lesson",
      `Matrix CI ${domain.id} completed with stub provider.`,
      "--json",
    ], { expectedStatus: ["success"], runtime: "dist" });
    assertArtifacts(cell, learn.run.display, [
      join(projectRoot, ".yolo", "lifecycle", "retrospective.json"),
      join(projectRoot, ".yolo", "state", "learning.jsonl"),
    ]);
  });
}

async function main() {
  log("[matrix-ci] deterministic coverage matrix");
  for (const cell of MATRIX_CELLS) {
    log(`[matrix-ci] cell=${cell.id} layer=${cell.layer} domain=${cell.domain} expected=${cell.expected}`);
  }

  assertCondition(existsSync(STUB_PATH), {
    cell: "setup",
    command: `provider stub ${STUB_PATH}`,
    missingArtifacts: [STUB_PATH],
    detail: "Provider stub is required for deterministic L3 cells.",
  });
  assertArtifacts("setup", "dist runner helpers", [YOLO_DIST_BIN, ...DIST_HELPERS]);

  const tempRoot = mkdtempSync(join(tmpdir(), "yolo-matrix-ci-"));
  try {
    await runL1(tempRoot);
    await runL2(tempRoot);
    for (const domain of L3_DOMAINS) {
      await runL3Domain(tempRoot, domain);
    }
  } finally {
    if (process.env.MATRIX_CI_KEEP === "1") {
      log(`[matrix-ci] keep=${tempRoot}`);
    } else {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  const durationMs = Math.round(performance.now() - suiteStarted);
  const summary = {
    status: failures.length > 0 ? "fail" : "pass",
    duration_ms: durationMs,
    cells: results,
    failures,
  };
  log(JSON.stringify(summary, null, 2));

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write([
        `[matrix-ci] FAIL ${failure.cell}`,
        `command: ${failure.command}`,
        failure.expectedExit ? `expected exit: ${failure.expectedExit.join(",")}` : "",
        failure.actualExit != null ? `actual exit: ${failure.actualExit}` : "",
        failure.missingArtifacts?.length ? `missing artifacts: ${failure.missingArtifacts.join(", ")}` : "",
        failure.detail || "",
        failure.stdout ? `stdout:\n${failure.stdout}` : "",
        failure.stderr ? `stderr:\n${failure.stderr}` : "",
      ].filter(Boolean).join("\n") + "\n");
    }
    return 1;
  }

  log(`[matrix-ci] pass duration_ms=${durationMs}`);
  return 0;
}

process.exitCode = await main();
