import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildChangeArtifact,
  buildDesignArtifact,
  buildRequirementArtifact,
  buildSpecLifecyclePackage,
  buildTaskArtifact,
  inspectSpecLifecyclePackage,
  specLifecycleToPrd,
} from "../src/spec/lifecycle.js";
import { createYoloSdk } from "../sdk.js";

describe("spec lifecycle artifacts", () => {
  test("builders create normalized requirement design task and change artifacts", () => {
    assert.deepEqual(buildRequirementArtifact({
      id: "REQ-1",
      text: "Ship a bootstrap flow",
      success_criteria: ["init creates specs"],
    }), {
      schema_version: "1.0",
      schema: "yolo.spec.requirement.v1",
      artifact_type: "requirement",
      id: "REQ-1",
      title: "Requirement",
      text: "Ship a bootstrap flow",
      success_criteria: ["init creates specs"],
      constraints: [],
      non_goals: [],
      status: "draft",
    });

    assert.equal(buildDesignArtifact({ id: "DES-1", requirement_ids: "REQ-1", approach: "Use a pure helper" }).requirement_ids[0], "REQ-1");
    assert.equal(buildTaskArtifact({ id: "TASK-1", requirement_ids: ["REQ-1"], design_ids: ["DES-1"] }).status, "pending");
    assert.equal(buildChangeArtifact({ id: "CHG-1", task_ids: ["TASK-1"], reason: "Template update" }).status, "proposed");
  });

  test("buildSpecLifecyclePackage and inspector pass a linked lifecycle", () => {
    const spec = buildSpecLifecyclePackage({
      id: "SPEC-PKG-1",
      title: "Bootstrap lifecycle",
      requirements: [{ id: "REQ-1", text: "Create project structure" }],
      designs: [{ id: "DES-1", requirement_ids: ["REQ-1"], approach: "Use generated files" }],
      tasks: [{
        id: "TASK-1",
        title: "Create init helper",
        requirement_ids: ["REQ-1"],
        design_ids: ["DES-1"],
        scope: { targets: [{ file: "src/core/bootstrap.js" }] },
      }],
      changes: [{ id: "CHG-1", task_ids: ["TASK-1"], reason: "Add public bootstrap" }],
    });

    const result = inspectSpecLifecyclePackage(spec);

    assert.equal(result.status, "pass");
    assert.equal(result.blocks_execution, false);
    assert.deepEqual(result.summary, {
      requirement_count: 1,
      design_count: 1,
      task_count: 1,
      change_count: 1,
      blocker_count: 0,
      warning_count: 0,
    });
  });

  test("inspectSpecLifecyclePackage blocks missing cross references", () => {
    const result = inspectSpecLifecyclePackage(buildSpecLifecyclePackage({
      requirements: [{ id: "REQ-1", text: "Create project structure" }],
      designs: [{ id: "DES-1", requirement_ids: ["REQ-MISSING"], approach: "Use generated files" }],
      tasks: [{ id: "TASK-1", requirement_ids: [], design_ids: ["DES-MISSING"] }],
      changes: [{ id: "CHG-1", task_ids: ["TASK-MISSING"] }],
    }));

    assert.equal(result.status, "blocked");
    assert.deepEqual(result.blockers.map((blocker) => blocker.code), [
      "DESIGN_REQUIREMENT_REF_MISSING",
      "TASK_REQUIREMENT_REF_MISSING",
      "TASK_DESIGN_REF_MISSING",
      "CHANGE_TASK_REF_MISSING",
    ]);
  });

  test("specLifecycleToPrd preserves trace links for runner preflight", () => {
    const spec = buildSpecLifecyclePackage({
      id: "SPEC-PKG-2",
      requirements: [{ id: "REQ-2", text: "Create a task" }],
      designs: [{ id: "DES-2", requirement_ids: ["REQ-2"], approach: "Trace it" }],
      tasks: [{
        id: "TASK-2",
        title: "Trace task",
        type: "feature",
        priority: "P2",
        requirement_ids: ["REQ-2"],
        design_ids: ["DES-2"],
        scope: { targets: [{ file: "src/spec/lifecycle.js" }] },
        post_conditions: [{ id: "POST-FILE", type: "file_exists", severity: "FAIL", params: { file: "src/spec/lifecycle.js" } }],
      }],
    });
    const prd = specLifecycleToPrd(spec, {
      id: "PRD-SPEC-PKG-2",
      generated_at: "2026-05-24T00:00:00.000Z",
    });

    assert.equal(prd.id, "PRD-SPEC-PKG-2");
    assert.deepEqual(prd.tasks[0].requirement_ids, ["REQ-2"]);
    assert.deepEqual(prd.tasks[0].design_ids, ["DES-2"]);
    assert.deepEqual(prd.requirements, [{ id: "REQ-2", text: "Create a task" }]);
  });

  test("createYoloSdk exposes spec lifecycle helpers", () => {
    const sdk = createYoloSdk();

    assert.equal(typeof sdk.spec.buildSpecLifecyclePackage, "function");
    assert.equal(typeof sdk.spec.inspectSpecLifecyclePackage, "function");
    assert.equal(typeof sdk.spec.specLifecycleToPrd, "function");
  });
});
