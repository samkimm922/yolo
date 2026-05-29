import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorkflowPlan,
  getWorkflow,
  listWorkflowSkillDescriptors,
  listWorkflows,
  workflowToSkillDescriptor,
} from "../src/workflows/registry.js";

describe("workflow registry", () => {
  test("listWorkflows exposes the composable lifecycle workflow set", () => {
    const ids = listWorkflows().map((workflow) => workflow.id).sort();
    assert.deepEqual(ids, ["accept", "brainstorm", "check", "discover", "discuss", "doctor", "eval", "fix", "learn", "pi", "plan", "prd", "review", "ship"]);
  });

  test("getWorkflow returns cloned workflow definitions", () => {
    const workflow = getWorkflow("review");
    workflow.phases.push("mutated");

    assert.equal(getWorkflow("review").phases.includes("mutated"), false);
    assert.throws(() => getWorkflow("unknown"), /Unknown YOLO workflow/);
  });

  test("createWorkflowPlan builds pending steps with verification hooks", () => {
    const plan = createWorkflowPlan({
      workflow: "ship",
      objective: "Block release if evidence is missing",
    });

    assert.equal(plan.workflow, "ship");
    assert.equal(plan.preset, "gatekeeper");
    assert.deepEqual(plan.sdk_namespaces, ["spec", "contract", "review", "evidence"]);
    assert.deepEqual(plan.steps.map((step) => step.phase), [
      "spec_gate",
      "contract_gate",
      "review_gate",
      "evidence_gate",
      "verdict",
    ]);
    assert.equal(plan.steps[0].verification, "spec.governance");
  });

  test("workflowToSkillDescriptor turns a workflow into an installable skill shape", () => {
    assert.deepEqual(workflowToSkillDescriptor("fix", { agent: "codex" }), {
      schema_version: "1.0",
      schema: "yolo.workflow.skill_descriptor.v1",
      id: "yolo.fix",
      name: "Fix workflow",
      workflow: "fix",
      agent: "codex",
      purpose: "Execute scoped PRD tasks with gates, retries, and evidence.",
      trigger: ["task.pending", "review.fix.pending"],
      inputs: ["prdPath", "taskId?"],
      outputs: ["task result", "gate evidence", "updated PRD"],
      sdk_namespaces: ["task", "contract", "runtime", "evidence"],
      phases: ["load_task", "pre_gate", "execute", "post_gate", "record"],
      verification: ["contract.pre_conditions", "contract.post_conditions", "diff.quality", "evidence.append"],
      entrypoints: {
        sdk: "sdk.runtime.runRunner",
        cli: "yolo --prd <prd>",
        skill: "yolo.fix",
      },
    });
  });

  test("listWorkflowSkillDescriptors maps every workflow", () => {
    const descriptors = listWorkflowSkillDescriptors({ agent: "claude" });
    assert.equal(descriptors.length, 14);
    assert.ok(descriptors.every((descriptor) => descriptor.agent === "claude"));
  });
});
