import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { readLifecycleDashboard } from "../src/runtime/progress/lifecycle-dashboard.js";
import { HTML, server } from "../src/runtime/progress/server.js";

const roots = [];
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "progress-dashboard-"));
  roots.push(root);
  return root;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function snapshotFiles(dir) {
  return Object.fromEntries(walk(dir).map((path) => [path, readFileSync(path, "utf8")]));
}

function restoreFileLater(path) {
  const existed = existsSync(path);
  const previous = existed ? readFileSync(path, "utf8") : "";
  return () => {
    if (existed) writeFileSync(path, previous, "utf8");
    else rmSync(path, { force: true });
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("returns a plain next action when lifecycle files are missing", () => {
  const projectRoot = tempRoot();
  const dashboard = readLifecycleDashboard({ projectRoot });

  assert.equal(dashboard.exists, false);
  assert.equal(dashboard.current_stage, null);
  assert.equal(dashboard.blocker_count, 0);
  assert.equal(dashboard.evidence_count, 0);
  assert.deepEqual(dashboard.latest_reports, []);
  assert.match(dashboard.next_action, /yolo-init/);
});

test("returns stage counts, latest reports, evidence, blockers, and recent events", () => {
  const projectRoot = tempRoot();
  const lifecycleDir = join(projectRoot, ".yolo", "lifecycle");
  const stateDir = join(projectRoot, ".yolo", "state");
  mkdirSync(join(stateDir, "reports"), { recursive: true });
  mkdirSync(lifecycleDir, { recursive: true });

  writeJson(join(lifecycleDir, "status.json"), {
    current_stage: "check",
    stages: [{ id: "idea", status: "completed" }, { id: "check", status: "active" }, { id: "run", status: "blocked" }, { id: "delivery", status: "pending" }],
  });
  writeJson(join(stateDir, "reports", "check.json"), {
    schema: "yolo.lifecycle.stage_report.v1",
    stage_id: "check",
    status: "blocked",
    updated_at: "2026-01-02T00:00:00.000Z",
    blockers: ["missing acceptance", { code: "GATE", message: "gate failed" }],
    evidence: [{ path: "logs/check.txt" }],
    artifacts: ["artifacts/check.md"],
    report_json: "reports/check.json",
  });
  writeFileSync(
    join(stateDir, "events.jsonl"),
    [
      JSON.stringify({ type: "stage_started", stage_id: "check", created_at: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ type: "stage_blocked", stage_id: "check", created_at: "2026-01-03T00:00:00.000Z" }),
      "",
    ].join("\n"),
    "utf8",
  );

  const before = snapshotFiles(join(projectRoot, ".yolo"));
  const dashboard = readLifecycleDashboard({ projectRoot });
  const after = snapshotFiles(join(projectRoot, ".yolo"));

  assert.equal(dashboard.exists, true);
  assert.equal(dashboard.current_stage, "check");
  assert.deepEqual(dashboard.stage_counts, {
    total: 4,
    pending: 1,
    active: 1,
    completed: 1,
    blocked: 1,
    warning: 0,
  });
  assert.equal(dashboard.blocker_count, 2);
  assert.equal(dashboard.evidence_count, 3);
  assert.equal(dashboard.latest_reports[0].stage_id, "check");
  assert.equal(dashboard.latest_reports[0].blockers.length, 2);
  assert.equal(dashboard.recent_events[0].type, "stage_blocked");
  assert.deepEqual(after, before);
});

test("idle HTML renders lifecycle summary when no run is active", () => {
  const html = HTML({
    currentRun: null,
    lifecycle: { exists: true, current_stage: "check", stage_counts: { completed: 2 }, blocker_count: 1, evidence_count: 3, next_action: "Continue lifecycle work." },
  }, {});

  assert.match(html, /Lifecycle: check/);
  assert.match(html, /阻塞 <strong>1<\/strong>/);
  assert.match(html, /证据 <strong>3<\/strong>/);
});

test("active HTML escapes dangerous task data and renders uiEvidencePanel", () => {
  const html = HTML({
    currentRun: { run_id: "test-run", prd: "test.json", started_at: "2026-01-01T00:00:00.000Z" },
    lifecycle: { exists: true, current_stage: "run", stage_counts: {}, blocker_count: 0, evidence_count: 0, latest_reports: [], recent_events: [], next_action: "Continue." },
    tasks: [{ id: "TASK-<img src=x onerror=alert(1)>", status: "pending", priority: "P1", description: "Test", phase: "", retry: 0, elapsed: null }],
    done: 0, failed: 0, total: 1,
  }, { "gate-<svg/onload=alert(1)>": 1 });

  assert.match(html, /id="uiEvidencePanel"/);
  assert.equal(html.includes("<img src=x onerror=alert(1)>"), false);
  assert.equal(html.includes("TASK-&lt;img src=x onerror=alert(1)&gt;"), true);
});

test("progress server exposes lifecycle json endpoint", async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    const port = typeof addr === "string" ? 0 : (addr as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/lifecycle.json`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(typeof payload.exists, "boolean");
    assert.equal(typeof payload.stage_counts, "object");
    assert.ok("next_action" in payload);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("progress server rejects traversing task log ids and still returns valid logs", async () => {
  const nonce = `sec2-${process.pid}-${Date.now()}`;
  const stateDir = join(REPO_ROOT, "state");
  const taskLogsDir = join(stateDir, "runtime", "task-logs");
  const outsideLog = join(stateDir, `${nonce}.jsonl`);
  const safeTaskId = `${nonce}-task`;
  const safeLog = join(taskLogsDir, `${safeTaskId}.jsonl`);
  const restoreOutside = restoreFileLater(outsideLog);
  const restoreSafe = restoreFileLater(safeLog);

  mkdirSync(taskLogsDir, { recursive: true });
  writeFileSync(outsideLog, `${JSON.stringify({ type: "LEAK", secret: "outside-task-logs" })}\n`, "utf8");
  writeFileSync(safeLog, `${JSON.stringify({ type: "TASK_START", title: "safe task" })}\n`, "utf8");

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address();
    const port = typeof addr === "string" ? 0 : (addr as { port: number }).port;
    const traversal = encodeURIComponent(`../../${nonce}`);
    const traversalResponse = await fetch(`http://127.0.0.1:${port}/api/task-logs/${traversal}`);
    const traversalBody = await traversalResponse.text();

    assert.ok([400, 404].includes(traversalResponse.status), `expected traversal rejection, got ${traversalResponse.status}`);
    assert.equal(traversalBody.includes("outside-task-logs"), false);

    const validResponse = await fetch(`http://127.0.0.1:${port}/api/task-logs/${encodeURIComponent(safeTaskId)}`);
    const validBody = await validResponse.json();
    assert.equal(validResponse.status, 200);
    assert.equal(validBody[0].title, "safe task");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreSafe();
    restoreOutside();
  }
});
