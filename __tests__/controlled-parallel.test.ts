import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskDependencyGraph,
  detectParallelConflicts,
  formatControlledParallelPlanText,
  inspectParallelMergeGate,
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
    assert.equal(plan.waves[0].worktrees[0].path, "/tmp/worktrees/task-a");
    assert.equal(plan.waves[0].merge_gate.fail_closed, true);
    assert.match(formatControlledParallelPlanText(plan), /wave-01: task-a, task-c/);
  });

  test("keeps dependency successors out of the predecessor wave", () => {
    const plan = planControlledParallelWaves({
      tasks: [
        { id: "setup", files: ["src/setup.ts"] },
        { id: "feature", depends_on: ["setup"], files: ["src/feature.ts"] },
        { id: "docs", files: ["docs/feature.md"] },
      ],
    });

    assert.equal(plan.status, "pass");
    const setupWave = plan.waves.find((wave) => wave.task_ids.includes("setup"));
    const featureWave = plan.waves.find((wave) => wave.task_ids.includes("feature"));
    assert.ok(setupWave.index < featureWave.index);
    assert.equal(plan.graph.edges.some((edge) => edge.from === "setup" && edge.to === "feature"), true);
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
