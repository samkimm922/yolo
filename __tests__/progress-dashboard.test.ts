import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { readLifecycleDashboard } from "../src/runtime/progress/lifecycle-dashboard.js";
import { startEmbeddedProgressServer } from "../src/runtime/progress/embedded-server.js";
import { HTML, PROGRESS_SERVER_HOST, server, _setSseMaxOverrideForTest, getSseClientCount, resetSseClientsForTest, MAX_SSE_CLIENTS } from "../src/runtime/progress/server.js";

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

async function waitFor(condition, message) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("progress server uses safeExecSync (P12.I1 chokepoint) not raw child_process execSync", () => {
  const content = readFileSync(resolve(REPO_ROOT, "src/runtime/progress/server.ts"), "utf8");
  assert.equal(content.includes('from "child_process"'), false,
    "server.ts must not import from raw child_process — use safe-exec chokepoint");
  assert.ok(content.includes("safeExecSync") && content.includes("safe-exec.js"),
    "server.ts must use safeExecSync from safe-exec.js (P12.I1)");
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

test("tolerates null/non-object entries in status.stages without crashing", () => {
  const projectRoot = tempRoot();
  const lifecycleDir = join(projectRoot, ".yolo", "lifecycle");
  mkdirSync(lifecycleDir, { recursive: true });

  writeJson(join(lifecycleDir, "status.json"), {
    current_stage: "check",
    stages: [
      { id: "idea", status: "completed" },
      null,
      "garbage",
      42,
      { id: "check", status: "active" },
    ],
  });

  const dashboard = readLifecycleDashboard({ projectRoot });

  assert.equal(dashboard.exists, true);
  assert.equal(dashboard.current_stage, "check");
  // Null/string/number entries are skipped; only the two valid stage objects count.
  assert.deepEqual(dashboard.stage_counts, {
    total: 2,
    pending: 0,
    active: 1,
    completed: 1,
    blocked: 0,
    warning: 0,
  });
});

test("tolerates null/non-object entries in stage report blockers/issues/checks without crashing", () => {
  const projectRoot = tempRoot();
  const lifecycleDir = join(projectRoot, ".yolo", "lifecycle");
  const stateDir = join(projectRoot, ".yolo", "state");
  mkdirSync(join(stateDir, "reports"), { recursive: true });
  mkdirSync(lifecycleDir, { recursive: true });

  writeJson(join(lifecycleDir, "status.json"), {
    current_stage: "check",
    stages: [{ id: "check", status: "active" }],
  });
  // Corrupted/hand-edited stage report: blockers, blocked_reasons, issues, and
  // checks all contain null / string / number entries mixed with real objects.
  // Without the guard, reportBlockers crashes on `null.status` or `null.code`.
  writeJson(join(stateDir, "reports", "check.json"), {
    schema: "yolo.lifecycle.stage_report.v1",
    stage_id: "check",
    status: "blocked",
    updated_at: "2026-01-02T00:00:00.000Z",
    blockers: [null, "string blocker", 42, { code: "GATE", message: "gate failed" }],
    blocked_reasons: [null, { code: "DEP", message: "missing dependency" }],
    issues: [null, { status: "blocked", code: "FAIL" }, { status: "pass" }, "garbage", 7],
    checks: [null, { status: "blocked", code: "CHECK" }],
  });

  const dashboard = readLifecycleDashboard({ projectRoot });

  assert.equal(dashboard.exists, true);
  assert.equal(dashboard.latest_reports.length, 1);
  const report = dashboard.latest_reports[0];
  assert.equal(report.stage_id, "check");
  // Only valid entries survive: string "string blocker" is kept as code=BLOCKER
  // (existing string→object mapping), and the four real blocked objects
  // (GATE/DEP/FAIL/CHECK). Null/number/non-blocked entries are dropped.
  assert.deepEqual(
    report.blockers.map((b) => b.code).sort(),
    ["BLOCKER", "CHECK", "DEP", "FAIL", "GATE"],
  );
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

test("embedded progress server binds to the loopback interface", async () => {
  const logs = [];
  const handle = startEmbeddedProgressServer(0, { log: (message) => logs.push(String(message)), error: () => {} });
  try {
    await waitFor(() => server.listening, "embedded progress server did not start");
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.equal(PROGRESS_SERVER_HOST, "127.0.0.1");
    assert.equal((address as { address: string }).address, "127.0.0.1");
    assert.match(logs.join("\n"), /http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    await handle.close();
  }
});

test("progress server restricts SSE CORS to local origins", async () => {
  await new Promise<void>((resolve) => server.listen(0, PROGRESS_SERVER_HOST, resolve));
  try {
    const addr = server.address();
    const port = typeof addr === "string" ? 0 : (addr as { port: number }).port;
    const endpoint = `http://${PROGRESS_SERVER_HOST}:${port}/events`;
    const blocked = await fetch(endpoint, { headers: { Origin: "https://attacker.example" } });
    const blockedCors = blocked.headers.get("access-control-allow-origin");
    assert.equal(blocked.status, 200);
    await blocked.body?.cancel().catch(() => {});
    assert.equal(blockedCors, null);

    const otherLocalPort = `http://127.0.0.1:${port === 65535 ? port - 1 : port + 1}`;
    const otherLocalPortResponse = await fetch(endpoint, { headers: { Origin: otherLocalPort } });
    const otherLocalPortCors = otherLocalPortResponse.headers.get("access-control-allow-origin");
    assert.equal(otherLocalPortResponse.status, 200);
    await otherLocalPortResponse.body?.cancel().catch(() => {});
    assert.equal(otherLocalPortCors, null);

    const localOrigin = `http://127.0.0.1:${port}`;
    const allowed = await fetch(endpoint, { headers: { Origin: localOrigin } });
    const allowedCors = allowed.headers.get("access-control-allow-origin");
    const allowedVary = allowed.headers.get("vary");
    assert.equal(allowed.status, 200);
    await allowed.body?.cancel().catch(() => {});
    assert.equal(allowedCors, localOrigin);
    assert.equal(allowedVary, "Origin");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("progress server returns 400 for malformed task log URLs without crashing", async () => {
  await new Promise<void>((resolve) => server.listen(0, PROGRESS_SERVER_HOST, resolve));
  try {
    const addr = server.address();
    const port = typeof addr === "string" ? 0 : (addr as { port: number }).port;
    const malformed = await fetch(`http://${PROGRESS_SERVER_HOST}:${port}/api/task-logs/%E0%A4%A`);
    const malformedBody = await malformed.json();
    assert.equal(malformed.status, 400);
    assert.equal(malformedBody.error, "Bad Request");

    const alive = await fetch(`http://${PROGRESS_SERVER_HOST}:${port}/lifecycle.json`);
    assert.equal(alive.status, 200);
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

test("P10.S7: SSE connection limit blocks excess clients (CWE-770)", async () => {
  _setSseMaxOverrideForTest(2);
  await new Promise<void>((resolve) => server.listen(0, PROGRESS_SERVER_HOST, resolve));
  try {
    const addr = server.address();
    const port = typeof addr === "string" ? 0 : (addr as { port: number }).port;
    const endpoint = `http://${PROGRESS_SERVER_HOST}:${port}/events`;

    const conns = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(endpoint);
      conns.push(res);
    }
    assert.equal(conns[0].status, 200);
    assert.equal(conns[1].status, 200);
    assert.equal(conns[2].status, 503);
    const body = await conns[2].json();
    assert.equal(body.error, "SSE connection limit reached");
    assert.equal(body.max, 2);

    for (const c of conns) {
      try { await c.body?.cancel().catch(() => {}); } catch {}
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    _setSseMaxOverrideForTest(undefined);
    resetSseClientsForTest();
  }
});
