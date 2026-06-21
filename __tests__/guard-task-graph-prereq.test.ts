import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function writeDemand(root) {
  const demandPath = join(root, ".yolo/demand/approved/session.json");
  mkdirSync(join(root, ".yolo/demand/approved"), { recursive: true });
  writeFileSync(demandPath, JSON.stringify({
    schema_version: "1.0",
    schema: "yolo.demand.session.v1",
    id: "DEMAND-APPROVED",
  }));
  return demandPath;
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

  test("yolo-prd can bootstrap from an existing demand session before lifecycle init", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-guard-prd-"));
    try {
      const demandPath = writeDemand(root);
      const result = inspectLifecycleGuard({ command: "yolo-prd", projectRoot: root, demandPath });
      assert.equal(result.status, "pass", "existing demand session should allow PRD bootstrap");
      assert.equal(result.code, "LIFECYCLE_GUARD_PASS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo-prd accepts an existing demand session as roadmap evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-guard-prd-"));
    try {
      mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
      writeStatus(root, { roadmap: "pending" });
      const demandPath = writeDemand(root);
      const result = inspectLifecycleGuard({ command: "yolo-prd", projectRoot: root, demandPath });
      assert.equal(result.status, "pass", "existing demand session should satisfy roadmap prerequisite for spec");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo-prd still blocks fake demand paths when lifecycle is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-guard-prd-"));
    try {
      const result = inspectLifecycleGuard({
        command: "yolo-prd",
        projectRoot: root,
        demandPath: join(root, ".yolo/demand/missing/session.json"),
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.code, "LIFECYCLE_NOT_INITIALIZED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
