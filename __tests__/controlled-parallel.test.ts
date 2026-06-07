import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskDependencyGraph,
  detectParallelConflicts,
  formatControlledParallelPlanText,
  inspectParallelMergeGate,
  inspectParallelWaveStartGate,
  mergeParallelEvidence,
  planControlledParallelWaves,
} from "../src/runtime/parallel/wave-planner.js";

describe("controlled parallel execution planner", () => {
  test("detects overlapping file scopes and unscoped exclusive tasks", () => {
    const conflicts = detectParallelConflicts([
      { id: "task-a", files: ["src/a.ts"] },
      { id: "task-b", files: ["src/a.ts"] },
      { id: "task-c", files: ["src/c.ts"] },
      { id: "task-d", description: "No target scope" },
    ]);

    assert.ok(conflicts.some((conflict) => conflict.code === "PARALLEL_FILE_SCOPE_CONFLICT"));
    assert.ok(conflicts.some((conflict) => conflict.code === "PARALLEL_EXCLUSIVE_TASK"));
  });

  test("plans non-conflicting tasks in the same wave and separates file conflicts", () => {
    const plan = planControlledParallelWaves({
      projectRoot: "/tmp/project",
      worktreeRoot: "/tmp/worktrees",
      tasks: [
        { id: "task-a", files: ["src/a.ts"] },
        { id: "task-b", files: ["src/a.ts"] },
        { id: "task-c", files: ["src/c.ts"] },
      ],
    });

    assert.equal(plan.status, "pass");
    assert.deepEqual(plan.waves.map((wave) => wave.task_ids), [
      ["task-a", "task-c"],
      ["task-b"],
    ]);
    assert.equal(plan.execution_status, "blocked");
    assert.equal(plan.waves[0].start_gate.status, "pass");
    assert.equal(plan.waves[1].start_gate.status, "blocked");
    assert.ok(plan.execution_blockers.some((blocker) => blocker.code === "PARALLEL_PREVIOUS_WAVE_NOT_PASSED"));
    assert.equal(plan.waves[0].worktrees[0].path, "/tmp/worktrees/task-a");
    assert.equal(plan.waves[0].merge_gate.fail_closed, true);
    assert.match(formatControlledParallelPlanText(plan), /wave-01: task-a, task-c/);
  });

  test("does not schedule dependency successors without prior pass evidence", () => {
    const plan = planControlledParallelWaves({
      tasks: [
        { id: "setup", files: ["src/setup.ts"] },
        { id: "feature", depends_on: ["setup"], files: ["src/feature.ts"] },
        { id: "docs", files: ["docs/feature.md"] },
      ],
    });

    assert.equal(plan.status, "blocked");
    assert.equal(plan.waves.some((wave) => wave.task_ids.includes("feature")), false);
    assert.ok(plan.blockers.some((blocker) => blocker.code === "TASK_DEPENDENCY_CYCLE_OR_BLOCKED" && blocker.task_id === "feature"));
    assert.equal(plan.graph.edges.some((edge) => edge.from === "setup" && edge.to === "feature"), true);
  });

  test("schedules dependency successors only after dependency pass evidence", () => {
    const plan = planControlledParallelWaves({
      tasks: [
        { id: "setup", status: "completed", files: ["src/setup.ts"] },
        { id: "feature", depends_on: ["setup"], files: ["src/feature.ts"] },
      ],
      completedTaskIds: ["setup"],
    });

    assert.equal(plan.status, "pass");
    assert.equal(plan.execution_status, "pass");
    assert.deepEqual(plan.waves.map((wave) => wave.task_ids), [["feature"]]);
    assert.equal(plan.waves[0].start_gate.status, "pass");
  });

  test("wave start gate blocks later waves until previous merge evidence passes", () => {
    const plan = planControlledParallelWaves({
      tasks: [
        { id: "task-a", files: ["src/a.ts"] },
        { id: "task-b", files: ["src/a.ts"] },
      ],
    });

    const blocked = inspectParallelWaveStartGate({ plan, wave: plan.waves[1], tasks: [
      { id: "task-a", files: ["src/a.ts"] },
      { id: "task-b", files: ["src/a.ts"] },
    ] });
    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.blockers.some((blocker) => blocker.code === "PARALLEL_PREVIOUS_WAVE_NOT_PASSED"));

    const passed = inspectParallelWaveStartGate({
      plan,
      wave: plan.waves[1],
      tasks: [
        { id: "task-a", files: ["src/a.ts"] },
        { id: "task-b", files: ["src/a.ts"] },
      ],
      passedWaveIds: ["wave-01"],
    });
    assert.equal(passed.status, "pass");
  });

  test("fails closed on missing dependencies", () => {
    const graph = buildTaskDependencyGraph({
      tasks: [{ id: "feature", depends_on: ["missing-task"], files: ["src/feature.ts"] }],
    });
    const plan = planControlledParallelWaves({
      tasks: [{ id: "feature", depends_on: ["missing-task"], files: ["src/feature.ts"] }],
    });

    assert.equal(graph.blockers[0].code, "TASK_DEPENDENCY_MISSING");
    assert.equal(plan.status, "blocked");
    assert.ok(plan.blockers.some((blocker) => blocker.code === "TASK_DEPENDENCY_MISSING"));
  });

  test("merge gate requires task pass, post gate pass, review/skip, clean scope, and evidence", () => {
    const wave = { id: "wave-01", task_ids: ["task-a", "task-b"] };
    const blocked = inspectParallelMergeGate({
      wave,
      taskReports: [
        {
          task_id: "task-a",
          status: "pass",
          gate_status: "pass",
          review_skipped: true,
          evidence_refs: ["evidence/a.json"],
        },
        {
          task_id: "task-b",
          status: "pass",
          gate_status: "pass",
          review_status: "pass",
          out_of_scope_files: ["src/unplanned.ts"],
          evidence_refs: ["evidence/b.json"],
        },
      ],
    });

    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.blockers.some((blocker) => blocker.code === "PARALLEL_SCOPE_MERGE_DIRTY"));

    const passed = inspectParallelMergeGate({
      wave,
      taskReports: [
        {
          task_id: "task-a",
          status: "pass",
          gate_status: "pass",
          review_skipped: true,
          evidence_refs: ["evidence/a.json"],
        },
        {
          task_id: "task-b",
          status: "pass",
          gate_status: "pass",
          review_status: "pass",
          scope_merge_clean: true,
          evidence_refs: ["evidence/b.json"],
        },
      ],
    });

    assert.equal(passed.status, "pass");
    assert.equal(passed.task_checks.every((check) => check.passed), true);
  });

  test("evidence merge aggregates wave reports and artifact references", () => {
    const report = mergeParallelEvidence({
      waves: [
        { id: "wave-01", task_ids: ["task-a"] },
        { id: "wave-02", task_ids: ["task-b"] },
      ],
      taskReports: [
        {
          task_id: "task-a",
          status: "pass",
          gate_status: "pass",
          review_status: "pass",
          evidence_refs: ["evidence/a.json"],
        },
        {
          task_id: "task-b",
          status: "pass",
          gate_status: "pass",
          review_status: "pass",
          artifacts: ["evidence/b.json"],
        },
      ],
    });

    assert.equal(report.status, "pass");
    assert.equal(report.summary.waves_passed, 2);
    assert.deepEqual(report.artifacts, ["evidence/a.json", "evidence/b.json"]);
  });
});
