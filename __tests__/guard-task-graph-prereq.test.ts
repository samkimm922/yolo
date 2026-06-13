import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectLifecycleGuard } from "../src/lifecycle/guard.js";
import { createLifecycleStateSnapshot } from "../src/lifecycle/schema.js";

function makeStatus(stageOverrides) {
  const snapshot = createLifecycleStateSnapshot({ projectName: "test", currentStage: "idea" });
  return {
    ...snapshot,
    stages: snapshot.stages.map((s) =>
      stageOverrides[s.id] ? { ...s, status: stageOverrides[s.id] } : s
    ),
  };
}

function writeStatus(root, stageOverrides) {
  const status = makeStatus(stageOverrides);
  writeFileSync(join(root, ".yolo/lifecycle/status.json"), JSON.stringify(status));
}

describe("yolo-prd prerequisite after task-graph removal", () => {
  test("yolo-prd is blocked when roadmap stage is not completed", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-guard-prd-"));
    mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
    writeStatus(root, { discovery: "completed", roadmap: "pending" });
    const result = inspectLifecycleGuard({ command: "yolo-prd", projectRoot: root });
    assert.notEqual(result.status, "pass", "yolo-prd must be blocked when roadmap is pending");
    assert.equal(result.status, "blocked");
  });

  test("yolo-prd passes when roadmap is completed with artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-guard-prd-"));
    mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
    writeStatus(root, { discovery: "completed", roadmap: "completed" });
    writeFileSync(join(root, ".yolo/lifecycle/discovery.json"), JSON.stringify({ status: "completed", summary: "discovery done" }));
    writeFileSync(join(root, ".yolo/lifecycle/roadmap.json"), JSON.stringify({ status: "completed", summary: "roadmap done" }));
    const result = inspectLifecycleGuard({ command: "yolo-prd", projectRoot: root });
    assert.equal(result.status, "pass", "yolo-prd must pass when roadmap is completed");
  });

  test("yolo-prd is blocked when roadmap artifact is missing even if status says completed", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-guard-prd-"));
    mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
    writeStatus(root, { discovery: "completed", roadmap: "completed" });
    // No roadmap.json artifact
    const result = inspectLifecycleGuard({ command: "yolo-prd", projectRoot: root });
    assert.equal(result.status, "blocked", "yolo-prd must be blocked when roadmap artifact is missing");
  });
});
