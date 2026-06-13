import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectPreExecutionGates } from "../src/runtime/gates/pre-execution-gates.js";
import { planControlledParallelWaves } from "../src/runtime/parallel/wave-planner.js";
import { inspectLifecycleGuard } from "../src/lifecycle/guard.js";
import { inspectDemandReadiness } from "../src/demand/gate.js";

// ── Soak Test Scaffold ──
// These tests exercise core gate/planner functions repeatedly to verify
// stability and deterministic output. Iteration counts are kept small
// for CI speed; the scaffold supports scaling up for real soak runs.
// No real model calls or external API requests are made.

function strictPrd(overrides = {}) {
  return {
    version: "2.0",
    id: "PRD-SOAK",
    title: "Soak fixture",
    project: { name: "test", language: "javascript" },
    generated_by: "yolo-demand",
    generated_at: "2026-05-24T00:00:00.000Z",
    base_commit: "abcdef0",
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-SOAK",
      approval: { approved: true, effective_for_prd: true },
      project_facts: { target_files: [{ file: "src/a.js", status: "verified" }], assumptions: [] },
      quality_report: { schema_version: "1.0", schema: "yolo.demand.quality.v1", status: "pass", total_score: 100, dimensions: [] },
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: { schema_version: "1.0", schema: "yolo.demand.quality.v1", status: "pass", total_score: 100, dimensions: [] },
    },
    requirements: [{ id: "REQ-1", text: "Keep gates strict", demand_trace: { evidence: ["EVID-1"] } }],
    designs: [{ id: "DES-1", text: "Use file-exists smoke target" }],
    tasks: [{
      id: "FIX-SOAK-001",
      title: "Strict task",
      priority: "P1",
      type: "bugfix",
      task_kind: "atomic_fix",
      status: "pending",
      requirement_ids: ["REQ-1"],
      design_ids: ["DES-1"],
      scope: { targets: [{ file: "src/a.js" }] },
      post_conditions: [
        { id: "POST-FILE", type: "file_exists", severity: "FAIL", params: { file: "src/a.js" } },
        { id: "POST-TYPECHECK", type: "no_new_type_errors", severity: "FAIL", params: { command: "npm run typecheck" } },
      ],
    }],
    ...overrides,
  };
}

describe("soak scaffold — deterministic repeated execution", () => {
  test("pre-execution gates produce identical results across 20 iterations", () => {
    const prd = strictPrd();
    const results = [];
    for (let i = 0; i < 20; i += 1) {
      results.push(inspectPreExecutionGates({
        prd,
        prdPath: "/fake/prd.json",
        stateDir: "/fake/state",
        projectRoot: "/fake/project",
        config: { ai: { executor: "claude" } },
      }));
    }

    const first = results[0];
    assert.equal(first.status, "pass");
    assert.equal(first.stage, "ready");
    for (let i = 1; i < results.length; i += 1) {
      assert.equal(results[i].status, first.status);
      assert.equal(results[i].stage, first.stage);
      assert.equal(results[i].code, first.code);
    }
  });

  test("parallel planner produces identical wave structure across 20 iterations", () => {
    const tasks = [
      { id: "t1", files: ["src/a.ts"] },
      { id: "t2", files: ["src/b.ts"] },
      { id: "t3", depends_on: ["t1"], files: ["src/c.ts"] },
    ];
    const results = [];
    for (let i = 0; i < 20; i += 1) {
      results.push(planControlledParallelWaves({ tasks, completedTaskIds: ["t1"] }));
    }

    const first = results[0];
    assert.equal(first.status, "pass");
    assert.ok(first.wave_count > 0);
    for (let i = 1; i < results.length; i += 1) {
      assert.equal(results[i].wave_count, first.wave_count);
      assert.deepEqual(
        results[i].waves.map((w) => w.task_ids),
        first.waves.map((w) => w.task_ids)
      );
    }
  });

  test("lifecycle guard produces identical results across 20 iterations", () => {
    const results = [];
    for (let i = 0; i < 20; i += 1) {
      results.push(inspectLifecycleGuard({
        command: "yolo-check",
        projectRoot: "/fake/project",
      }));
    }

    const first = results[0];
    for (let i = 1; i < results.length; i += 1) {
      assert.equal(results[i].status, first.status);
      assert.equal(results[i].blockers.length, first.blockers.length);
    }
  });

  test("demand readiness produces identical results across 20 iterations", () => {
    const results = [];
    for (let i = 0; i < 20; i += 1) {
      results.push(inspectDemandReadiness({
        playback: { confirmed: true, confirmed_by: "user" },
        approval: { approved: true },
        requirements: { active: [{ text: "User can do X." }] },
      }, { phase: "discuss" }));
    }

    const first = results[0];
    for (let i = 1; i < results.length; i += 1) {
      assert.equal(results[i].status, first.status);
      assert.equal(results[i].blockers.length, first.blockers.length);
    }
  });

  test("parallel planner scales to 50 independent tasks without crashing", () => {
    const tasks = [];
    for (let i = 0; i < 50; i += 1) {
      tasks.push({
        id: `task-${i}`,
        files: [`src/${i}.ts`],
      });
    }

    const plan = planControlledParallelWaves({ tasks });
    assert.equal(plan.status, "pass");
    assert.equal(plan.task_count, 50);
    assert.equal(plan.wave_count, 1, "50 independent tasks fit in one wave");
  });
});
