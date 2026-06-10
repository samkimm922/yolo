import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectLifecycleGuard } from "../src/lifecycle/guard.js";
import { createLifecycleStateSnapshot } from "../src/lifecycle/schema.js";

function makeStatus(stageOverrides: Record<string, string>) {
  const snapshot = createLifecycleStateSnapshot({ projectName: "test", currentStage: "idea" });
  return {
    ...snapshot,
    stages: snapshot.stages.map((s: { id: string; status: string }) =>
      stageOverrides[s.id] ? { ...s, status: stageOverrides[s.id] } : s
    ),
  };
}

function writeStatus(root: string, stageOverrides: Record<string, string>) {
  const status = makeStatus(stageOverrides);
  writeFileSync(join(root, ".yolo/lifecycle/status.json"), JSON.stringify(status));
}

describe("task-graph prerequisite for yolo-prd", () => {
  test("yolo-prd is blocked when task-graph stage is not completed", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-guard-tg-"));
    mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
    writeStatus(root, { discovery: "completed", roadmap: "completed", "task-graph": "pending" });
    writeFileSync(join(root, ".yolo/lifecycle/roadmap.json"), JSON.stringify({ status: "completed", summary: "roadmap done" }));
    const result = inspectLifecycleGuard({ command: "yolo-prd", projectRoot: root });
    assert.notEqual(result.status, "pass", "yolo-prd must be blocked when task-graph is pending");
    assert.equal(result.status, "blocked");
  });

  test("yolo-prd passes when both roadmap and task-graph are completed with artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-guard-tg-"));
    mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
    writeStatus(root, { discovery: "completed", roadmap: "completed", "task-graph": "completed" });
    writeFileSync(join(root, ".yolo/lifecycle/roadmap.json"), JSON.stringify({ status: "completed", summary: "roadmap done" }));
    writeFileSync(join(root, ".yolo/lifecycle/task-graph.json"), JSON.stringify({ status: "completed", summary: "tasks decomposed" }));
    const result = inspectLifecycleGuard({ command: "yolo-prd", projectRoot: root });
    assert.equal(result.status, "pass", "yolo-prd must pass when task-graph is completed");
  });

  test("yolo-prd is blocked when task-graph artifact is missing even if status says completed", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-guard-tg-"));
    mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
    writeStatus(root, { discovery: "completed", roadmap: "completed", "task-graph": "completed" });
    writeFileSync(join(root, ".yolo/lifecycle/roadmap.json"), JSON.stringify({ status: "completed", summary: "roadmap done" }));
    // No task-graph.json artifact
    const result = inspectLifecycleGuard({ command: "yolo-prd", projectRoot: root });
    assert.equal(result.status, "blocked", "yolo-prd must be blocked when task-graph artifact is missing");
  });
});
