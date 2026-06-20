import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  appendBlockedTaskFailures,
  estimateRunTimeoutMs,
  runTaskPipeline,
} from "../src/runtime/run-lifecycle/run-orchestrator.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const RUN_ORCHESTRATOR_URL = pathToFileURL(join(YOLO_DIR, "src/runtime/run-lifecycle/run-orchestrator.ts")).href;

function emptyTaskResults(overrides = Object()) {
  return {
    completed: [],
    failed: [],
    skipped: [],
    blocked: [],
    contractReview: [],
    ...overrides,
  };
}

function cleanReviewScan(file = "src/app.js") {
  return JSON.stringify({
    scanner_version: "test-review-scanner@1",
    scanned_files: [file],
    rules: ["R-test"],
    expected_scope: [file],
    coverage_status: "complete",
    findings: [],
  });
}

function runChild(
  scriptPath: string,
  { timeoutMs = 5000 }: { timeoutMs?: number } = Object(),
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath], {
      cwd: YOLO_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr, timedOut });
    });
  });
}

test("estimateRunTimeoutMs keeps the configured minimum and scales with task count", () => {
  assert.equal(estimateRunTimeoutMs({ taskCount: 10, sessionTimeoutHours: 4 }), 4 * 3600000);
  assert.equal(estimateRunTimeoutMs({ taskCount: 100, sessionTimeoutHours: 4 }), 72_000_000);
});

test("appendBlockedTaskFailures excludes contract review blockers", () => {
  const taskResults = {
    completed: [],
    failed: ["OLD"],
    skipped: [],
    blocked: ["BLOCKED-TASK", "CONTRACT-REVIEW"],
    contractReview: ["CONTRACT-REVIEW"],
  };

  appendBlockedTaskFailures({ taskResults });

  assert.deepEqual(taskResults.failed, ["OLD", "BLOCKED-TASK"]);
});

test("runTaskPipeline wires main, retry, review, and finalize phases in order", async () => {
  const calls = [];
  const progress = { total: 0, done: 0, failed: 0 };
  const taskResults = {
    completed: [],
    failed: [],
    skipped: [],
    blocked: ["BLOCKED-TASK", "CONTRACT-REVIEW"],
    contractReview: ["CONTRACT-REVIEW"],
  };

  const result = await runTaskPipeline({
    prdPath: "/repo/.yolo/data/prd.json",
    runId: "run-test",
    resumeCompleted: new Set(["DONE"]),
    exitOnComplete: false,
    sessionTimeoutHours: 4,
    projectRoot: "/repo",
    stateRoot: "/repo/.yolo",
    toolsRoot: "/repo/scripts/yolo",
    stateDir: "/repo/.yolo/state",
    runtimeDir: "/repo/.yolo/state/runtime",
    expandedTasksFile: "/repo/.yolo/state/expanded-tasks.json",
    progress,
    startTimeMs: 100,
    progressServerProc: null,
    loadPRD: () => ({ id: "PRD", tasks: [{ id: "A" }, { id: "B" }] }),
    mainLoop: async (prdPath, completed) => {
      calls.push(["main", prdPath, completed.has("DONE")]);
      return taskResults;
    },
    updateTaskStatus: () => {},
    normalizeRepoPath: (value) => value,
    setGlobalTimeout: (ms, options) => calls.push(["timeout", ms, options]),
    logRun: (event, payload) => calls.push(["logRun", event, payload.tasks]),
    logProgress: (id, phase) => calls.push(["logProgress", id, phase]),
    writeStateSnapshot: (phase, prdPath) => calls.push(["snapshot", phase, prdPath]),
    retryPhase: async ({ taskResults: retryResults }) => {
      calls.push(["retry", [...retryResults.failed]]);
    },
    reviewLoop: async ({ taskResults: reviewResults }) => {
      calls.push(["review", [...reviewResults.failed]]);
    },
    finalize: (input) => {
      calls.push(["finalize", input.progressTotal, [...input.taskResults.failed]]);
      return { status: "success", failed: input.taskResults.failed };
    },
  });

  assert.equal(progress.total, 2);
  assert.deepEqual(result, { status: "success", failed: ["BLOCKED-TASK"] });
  assert.deepEqual(calls, [
    ["logProgress", "RESUME", ""],
    ["timeout", 14_400_000, { exitOnTimeout: false }],
    ["logRun", "run_start", 2],
    ["snapshot", "run_start", "/repo/.yolo/data/prd.json"],
    ["main", "/repo/.yolo/data/prd.json", true],
    ["retry", ["BLOCKED-TASK"]],
    ["review", ["BLOCKED-TASK"]],
    ["timeout", 0, { exitOnTimeout: false }],
    ["finalize", 2, ["BLOCKED-TASK"]],
  ]);
});

test("runTaskPipeline skips retry and review after repeated failure fuse", async () => {
  const calls = [];
  const progress = { total: 0, done: 0, failed: 0 };
  const taskResults = {
    completed: [],
    failed: ["FIX-1", "FIX-2"],
    skipped: [],
    blocked: [],
    contractReview: [],
    stop_reason: "repeated_failure_fuse",
    stop_fail_key: "failed:claude 超时",
  };

  const result = await runTaskPipeline({
    prdPath: "/repo/.yolo/data/prd.json",
    runId: "run-test",
    resumeCompleted: new Set(),
    exitOnComplete: false,
    sessionTimeoutHours: 4,
    projectRoot: "/repo",
    stateRoot: "/repo/.yolo",
    toolsRoot: "/repo/scripts/yolo",
    stateDir: "/repo/.yolo/state",
    runtimeDir: "/repo/.yolo/state/runtime",
    expandedTasksFile: "/repo/.yolo/state/expanded-tasks.json",
    progress,
    startTimeMs: 100,
    progressServerProc: null,
    loadPRD: () => ({ id: "PRD", tasks: [{ id: "FIX-1" }, { id: "FIX-2" }] }),
    mainLoop: async () => {
      calls.push(["main"]);
      return taskResults;
    },
    taskPostconditionsPass: () => ({ passed: false, failed: ["not reached"] }),
    updateTaskStatus: () => {},
    normalizeRepoPath: (value) => value,
    setGlobalTimeout: (ms, options) => calls.push(["timeout", ms, options]),
    logRun: (event, payload) => calls.push(["logRun", event, payload.tasks]),
    logProgress: (id, phase, detail) => calls.push(["logProgress", id, phase, detail]),
    writeStateSnapshot: (phase, prdPath) => calls.push(["snapshot", phase, prdPath]),
    retryPhase: async () => calls.push(["retry"]),
    reviewLoop: async () => calls.push(["review"]),
    finalize: (input) => {
      calls.push(["finalize", [...input.taskResults.failed]]);
      return { status: "failed", failed: input.taskResults.failed };
    },
  });

  assert.deepEqual(result, { status: "failed", failed: ["FIX-1", "FIX-2"] });
  assert.deepEqual(calls, [
    ["timeout", 14_400_000, { exitOnTimeout: false }],
    ["logRun", "run_start", 2],
    ["snapshot", "run_start", "/repo/.yolo/data/prd.json"],
    ["main"],
    ["logProgress", "RETRY", "SKIP", "全局熔断已触发，跳过自动重试和 review loop"],
    ["timeout", 0, { exitOnTimeout: false }],
    ["finalize", ["FIX-1", "FIX-2"]],
  ]);
});

test("runTaskPipeline defaults to the imported review loop function", async () => {
  const reviewEvents = [];
  const progress = { total: 0, done: 0, failed: 0 };
  let scannerCalls = 0;
  const prd = {
    id: "PRD-DEFAULT-REVIEW",
    tasks: [{
      id: "FIX-1",
      type: "bugfix",
      task_kind: "bugfix",
      scope: { targets: [{ file: "src/app.js" }] },
    }],
  };

  const result = await runTaskPipeline({
    prdPath: "/repo/.yolo/data/prd-default-review.json",
    runId: "run-default-review",
    resumeCompleted: new Set(),
    exitOnComplete: false,
    sessionTimeoutHours: 4,
    projectRoot: "/repo",
    stateRoot: "/repo/.yolo",
    toolsRoot: YOLO_DIR,
    stateDir: "/repo/.yolo/state",
    runtimeDir: "/repo/.yolo/state/runtime",
    expandedTasksFile: "/repo/.yolo/state/expanded-tasks.json",
    progress,
    startTimeMs: Date.now(),
    progressServerProc: null,
    loadPRD: () => prd,
    mainLoop: async () => emptyTaskResults({ completed: ["FIX-1"] }),
    retryPhase: async () => {},
    execFileSync: () => {
      scannerCalls++;
      return cleanReviewScan();
    },
    normalizeRepoPath: (value) => value,
    setGlobalTimeout: () => {},
    logProgress: (id, phase) => reviewEvents.push([id, phase]),
    logReviewStart: () => reviewEvents.push(["review", "start"]),
    logReviewDone: (status) => reviewEvents.push(["review", status]),
    finalize: (input) => ({
      status: "success",
      exit_code: 0,
      completed: input.taskResults.completed,
      failed: input.taskResults.failed,
    }),
  });

  assert.equal(scannerCalls, 1);
  assert.deepEqual(result.completed, ["FIX-1"]);
  assert.equal(reviewEvents.some(([id, phase]) => id === "review" && phase === "pass"), true);
});

test("runTaskPipeline exits nonzero and closes the progress server when a run phase throws", async () => {
  const root = mkdtempSync(join(tmpdir(), "yolo-run-phase-error-"));
  const scriptPath = join(root, "phase-error.mjs");
  const closeMarker = join(root, "progress-server-closed.txt");

  try {
    writeFileSync(scriptPath, `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { runTaskPipeline } from ${JSON.stringify(RUN_ORCHESTRATOR_URL)};

const closeMarker = ${JSON.stringify(closeMarker)};
const server = createServer((_req, res) => res.end("ok"));
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const progressServerProc = {
  close: () => new Promise((resolveClose, rejectClose) => {
    writeFileSync(closeMarker, "closed", "utf8");
    server.close((error) => error ? rejectClose(error) : resolveClose());
  }),
};

try {
  await runTaskPipeline({
    prdPath: "/tmp/phase-error-prd.json",
    runId: "run-phase-error",
    projectRoot: "/tmp/project",
    stateRoot: "/tmp/project/.yolo",
    toolsRoot: ${JSON.stringify(YOLO_DIR)},
    stateDir: "/tmp/project/.yolo/state",
    runtimeDir: "/tmp/project/.yolo/state/runtime",
    expandedTasksFile: "/tmp/project/.yolo/state/expanded-tasks.json",
    progress: { total: 0, done: 0, failed: 0 },
    startTimeMs: Date.now(),
    progressServerProc,
    loadPRD: () => ({ id: "PRD-PHASE-ERROR", tasks: [{ id: "FIX-1" }] }),
    mainLoop: async () => {
      throw Object.assign(new Error("boom-run-stage"), { exitCode: 7 });
    },
    retryPhase: async () => {},
    setGlobalTimeout: () => {},
    finalize: () => {
      throw new Error("finalize should not run");
    },
  });
  process.exitCode = 99;
} catch (error) {
  console.error("caught", error.message);
  process.exitCode = 1;
}
`, "utf8");

    const result = await runChild(scriptPath, { timeoutMs: 5000 });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.timedOut, false, output);
    assert.equal(result.code, 7, output);
    assert.equal(existsSync(closeMarker), true);
    assert.doesNotMatch(output, /reviewLoop is not a function/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runTaskPipeline end-to-end enters review loop and exits cleanly", async () => {
  const root = mkdtempSync(join(tmpdir(), "yolo-run-review-e2e-"));
  const scriptPath = join(root, "review-e2e.mjs");
  const closeMarker = join(root, "progress-server-closed.txt");
  const reviewMarker = join(root, "review-entered.txt");

  try {
    writeFileSync(scriptPath, `
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTaskPipeline } from ${JSON.stringify(RUN_ORCHESTRATOR_URL)};

const root = ${JSON.stringify(root)};
const closeMarker = ${JSON.stringify(closeMarker)};
const reviewMarker = ${JSON.stringify(reviewMarker)};
const stateRoot = join(root, ".yolo");
const stateDir = join(stateRoot, "state");
const runtimeDir = join(stateDir, "runtime");
const prdPath = join(stateRoot, "data/prd/current/minimal-review.json");
mkdirSync(join(stateRoot, "data/prd/current"), { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
writeFileSync(join(root, "src-app-placeholder.txt"), "ok\\n", "utf8");
writeFileSync(prdPath, JSON.stringify({
  id: "PRD-MINIMAL-REVIEW",
  tasks: [{
    id: "FIX-E2E-001",
    type: "bugfix",
    task_kind: "bugfix",
    scope: { targets: [{ file: "src/app.js" }] },
  }],
}, null, 2), "utf8");

const server = createServer((_req, res) => res.end("ok"));
await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const progressServerProc = {
  close: () => new Promise((resolveClose, rejectClose) => {
    writeFileSync(closeMarker, "closed", "utf8");
    server.close((error) => error ? rejectClose(error) : resolveClose());
  }),
};

await runTaskPipeline({
  prdPath,
  runId: "run-review-e2e",
  exitOnComplete: true,
  sessionTimeoutHours: 4,
  projectRoot: root,
  stateRoot,
  toolsRoot: ${JSON.stringify(YOLO_DIR)},
  stateDir,
  runtimeDir,
  expandedTasksFile: join(stateDir, "expanded-tasks.json"),
  progress: { total: 0, done: 0, failed: 0 },
  startTimeMs: Date.now(),
  progressServerProc,
  loadPRD: (file) => JSON.parse(readFileSync(file, "utf8")),
  mainLoop: async () => ({
    completed: ["FIX-E2E-001"],
    failed: [],
    skipped: [],
    blocked: [],
    contractReview: [],
  }),
  retryPhase: async () => {},
  execFileSync: () => ${JSON.stringify(cleanReviewScan())},
  normalizeRepoPath: (value) => value,
  setGlobalTimeout: () => {},
  logProgress: (id, phase, detail = "") => {
    if (id === "REVIEW") writeFileSync(reviewMarker, \`\${phase} \${detail}\\n\`, { flag: "a" });
  },
  writeStateSnapshot: () => {},
  logRun: () => {},
  archiveCurrentRun: () => {},
  writeRunReport: ({ stateDir, runId }) => {
    const reportDir = join(stateDir, "reports", runId);
    mkdirSync(reportDir, { recursive: true });
    const json_path = join(reportDir, "run-report.json");
    const markdown_path = join(reportDir, "run-report.md");
    const final_answer_json_path = join(reportDir, "final-answer.json");
    const final_answer_markdown_path = join(reportDir, "final-answer.md");
    const report = { status: "success", summary: { task_success_rate: 100, run_success_rate: 100 } };
    const final_answer = { status: "success", outcome: "success", checks: [{ status: "pass" }] };
    writeFileSync(json_path, JSON.stringify(report), "utf8");
    writeFileSync(markdown_path, "# ok\\n", "utf8");
    writeFileSync(final_answer_json_path, JSON.stringify(final_answer), "utf8");
    writeFileSync(final_answer_markdown_path, "# ok\\n", "utf8");
    return { json_path, markdown_path, final_answer_json_path, final_answer_markdown_path, report, final_answer };
  },
});
`, "utf8");

    const result = await runChild(scriptPath, { timeoutMs: 7000 });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.timedOut, false, output);
    assert.equal(result.code, 0, output);
    assert.equal(existsSync(closeMarker), true);
    assert.match(readFileSync(reviewMarker, "utf8"), /Round 1\/5/);
    assert.doesNotMatch(output, /reviewLoop is not a function/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
