import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLifecycleArtifact,
  createLifecycleStateSnapshot,
  getLifecycleStage,
  lifecycleStageForCommand,
  lifecycleStageIds,
  listLifecycleStages,
  validateLifecycleState,
} from "../src/lifecycle/schema.js";
import {
  buildLifecycleStateFiles,
  initLifecycleState,
  lifecycleArtifactPath,
  readLifecycleState,
} from "../src/lifecycle/state.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-lifecycle-"));
}

describe("lifecycle state", () => {
  test("schema exposes the full idea to learn lifecycle", () => {
    assert.deepEqual(lifecycleStageIds(), [
      "idea",
      "discovery",
      "setup",
      "roadmap",
      "task-graph",
      "prd",
      "check",
      "run",
      "review-fix",
      "acceptance",
      "delivery",
      "learn",
    ]);
    assert.equal(listLifecycleStages().length, 12);
    assert.equal(getLifecycleStage("run").writes_code, true);
    assert.equal(lifecycleStageForCommand("/yolo-prd").id, "prd");
  });

  test("creates valid lifecycle state and stage artifacts", () => {
    const snapshot = createLifecycleStateSnapshot({
      projectName: "demo",
      now: "2026-05-25T00:00:00.000Z",
    });
    const artifact = createLifecycleArtifact("discovery", {
      projectName: "demo",
      now: "2026-05-25T00:00:00.000Z",
    });

    assert.equal(validateLifecycleState(snapshot).status, "pass");
    assert.equal(snapshot.current_stage, "idea");
    assert.equal(artifact.stage.id, "discovery");
    assert.equal(artifact.status, "pending");
  });

  test("buildLifecycleStateFiles returns status plus every stage artifact", () => {
    const plan = buildLifecycleStateFiles({
      projectName: "demo",
      now: "2026-05-25T00:00:00.000Z",
    });

    assert.equal(plan.validation.status, "pass");
    assert.equal(plan.files.length, 13);
    assert.equal(plan.files[0].path, ".yolo/lifecycle/status.json");
    assert.equal(plan.files.some((file) => file.path === ".yolo/lifecycle/retrospective.json"), true);
  });

  test("initLifecycleState writes without overwriting existing files by default", () => {
    const root = tempProject();
    try {
      const first = initLifecycleState({
        projectRoot: root,
        projectName: "demo",
        now: "2026-05-25T00:00:00.000Z",
      });

      assert.equal(first.status, "success");
      assert.equal(first.created.length, 13);
      assert.equal(existsSync(join(root, ".yolo/lifecycle/status.json")), true);
      assert.equal(existsSync(lifecycleArtifactPath("acceptance", { projectRoot: root })), true);

      const state = readLifecycleState({ projectRoot: root });
      assert.equal(state.validation.status, "pass");

      const second = initLifecycleState({ projectRoot: root, projectName: "demo" });
      assert.equal(second.skipped.includes(".yolo/lifecycle/status.json"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
