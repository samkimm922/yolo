import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  readLifecycleDashboard,
  setReportFileSizeMax,
  resetReportFileSizeMax,
} from "../src/runtime/progress/lifecycle-dashboard.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-reports-oom-"));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      resetReportFileSizeMax();
    } catch {
      // ignore
    }
  }
});

test("P10.S8: readLifecycleDashboard skips oversized lifecycle status.json content", () => {
  const projectRoot = tempRoot();
  const lifecycleDir = join(projectRoot, ".yolo", "lifecycle");
  mkdirSync(lifecycleDir, { recursive: true });

  // Write a valid status.json — small, baseline
  writeJson(join(lifecycleDir, "status.json"), {
    current_stage: "test",
    stages: [{ id: "S1", status: "completed" }],
  });

  // Set a very small limit (1 byte) so status.json exceeds it
  setReportFileSizeMax(1);

  const dashboard = readLifecycleDashboard({ projectRoot });
  // exists is true because the file physically exists; but readJson returned null
  // due to size limit, so current_stage is null and stages are empty
  assert.equal(dashboard.current_stage, null, "oversized status.json -> null current_stage");
  assert.equal(dashboard.stage_counts?.total, 0, "oversized status.json -> zero stages");
});

test("P10.S8: readLifecycleDashboard reads small files normally", () => {
  const projectRoot = tempRoot();
  const lifecycleDir = join(projectRoot, ".yolo", "lifecycle");
  mkdirSync(lifecycleDir, { recursive: true });

  writeJson(join(lifecycleDir, "status.json"), {
    current_stage: "dev",
    stages: [{ id: "S1", status: "completed" }],
  });

  // Set a generous limit (1MB), so the small file passes
  setReportFileSizeMax(1024 * 1024);

  const dashboard = readLifecycleDashboard({ projectRoot });
  assert.equal(dashboard.exists, true);
  assert.equal(dashboard.current_stage, "dev");
  assert.equal(dashboard.stage_counts?.completed, 1);
});

test("P10.S8: setReportFileSizeMax(null) resets to production default", () => {
  const projectRoot = tempRoot();
  const lifecycleDir = join(projectRoot, ".yolo", "lifecycle");
  mkdirSync(lifecycleDir, { recursive: true });

  writeJson(join(lifecycleDir, "status.json"), {
    current_stage: "prod",
    stages: [{ id: "S1", status: "completed" }],
  });

  setReportFileSizeMax(1); // tiny limit — should skip
  resetReportFileSizeMax(); // reset to production default (50MB)
  // Production default (50MB) should easily pass the small file
  // We can't stat the file after reset, but we can verify it's read correctly

  const dashboard = readLifecycleDashboard({ projectRoot });
  assert.equal(dashboard.exists, true);
  assert.equal(dashboard.current_stage, "prod");
});
