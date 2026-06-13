import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTaskDependencyGraph,
  detectParallelConflicts,
  inspectParallelMergeGate,
  inspectParallelWaveStartGate,
  planControlledParallelWaves,
} from "../src/runtime/parallel/wave-planner.js";

describe("parallel adversarial suite — bypass and edge case blocking", () => {
  // ── A1: self-dependency cycle ──
  test("A1: task depending on itself is blocked as unschedulable", () => {
    const plan = planControlledParallelWaves({
      tasks: [
        { id: "self-loop", depends_on: ["self-loop"], files: ["src/a.ts"] },
      ],
    });

    assert.equal(plan.status, "blocked");
    assert.ok(
      plan.blockers.some((b) => b.task_id === "self-loop"),
      "self-dependency must produce a blocker for the task"
    );
  });

  // ── A2: mutual dependency cycle ──
  test("A2: A→B→A cycle prevents scheduling any cycle member", () => {
    const plan = planControlledParallelWaves({
      tasks: [
        { id: "task-a", depends_on: ["task-b"], files: ["src/a.ts"] },
        { id: "task-b", depends_on: ["task-a"], files: ["src/b.ts"] },
      ],
    });

    assert.equal(plan.status, "blocked");
    assert.ok(
      plan.blockers.some((b) => b.code === "TASK_DEPENDENCY_CYCLE_OR_BLOCKED"),
      "mutual dependency cycle must be detected"
    );
  });

  // ── A3: three-node cycle ──
  test("A3: A→B→C→A cycle blocks all three tasks", () => {
    const plan = planControlledParallelWaves({
      tasks: [
        { id: "task-a", depends_on: ["task-c"], files: ["src/a.ts"] },
        { id: "task-b", depends_on: ["task-a"], files: ["src/b.ts"] },
        { id: "task-c", depends_on: ["task-b"], files: ["src/c.ts"] },
      ],
    });

    assert.equal(plan.status, "blocked");
    const unscheduled = plan.blockers.filter((b) => b.code === "TASK_DEPENDENCY_CYCLE_OR_BLOCKED");
    assert.equal(unscheduled.length, 3, "all three cycle members must be unscheduled");
  });

  // ── A4: missing dependency with valid sibling ──
  test("A4: missing dependency blocks dependent but not independent sibling", () => {
    const plan = planControlledParallelWaves({
      tasks: [
        { id: "independent", files: ["src/free.ts"] },
        { id: "orphan", depends_on: ["ghost"], files: ["src/orphan.ts"] },
      ],
    });

    assert.equal(plan.status, "blocked");
    assert.ok(plan.waves.some((w) => w.task_ids.includes("independent")), "independent task should be scheduled");
    assert.ok(!plan.waves.some((w) => w.task_ids.includes("orphan")), "orphan task must not be scheduled");
    assert.ok(
      plan.blockers.some((b) => b.code === "TASK_DEPENDENCY_MISSING" && b.task_id === "orphan"),
      "missing dependency blocker must reference orphan task"
    );
  });

  // ── A5: exclusive task cannot share wave even without file overlap ──
  test("A5: serial/exclusive task refuses to join wave with other tasks", () => {
    const plan = planControlledParallelWaves({
      tasks: [
        { id: "serial", files: ["src/a.ts"], parallel: false },
        { id: "normal", files: ["src/b.ts"] },
      ],
    });

    assert.equal(plan.wave_count, 2, "exclusive task must be isolated in its own wave");
    assert.ok(plan.waves[0].task_ids.includes("serial") || plan.waves[1].task_ids.includes("serial"));
    assert.ok(
      !plan.waves.some((w) => w.task_ids.includes("serial") && w.task_ids.includes("normal")),
      "serial and normal must never share a wave"
    );
  });

  // ── A6: unscoped task is treated as exclusive ──
  test("A6: task without scope targets is exclusive and isolated", () => {
    const plan = planControlledParallelWaves({
      tasks: [
        { id: "unscoped", title: "Review only" },
        { id: "scoped", files: ["src/a.ts"] },
      ],
    });

    assert.equal(plan.wave_count, 2, "unscoped task must be in its own wave");
  });

  // ── A7: wave start gate blocks even with fake wave IDs if task deps missing ──
  test("A7: wave start gate blocks when task dependencies lack pass evidence", () => {
    const gate = inspectParallelWaveStartGate({
      wave: { id: "wave-02", task_ids: ["feature"] },
      waves: [
        { id: "wave-01", index: 1 },
        { id: "wave-02", index: 2 },
      ],
      tasks: [
        { id: "setup", files: ["src/setup.ts"] },
        { id: "feature", depends_on: ["setup"], files: ["src/feature.ts"] },
      ],
      passedWaveIds: ["wave-01"],
      completedTaskIds: [],
    });

    assert.equal(gate.status, "blocked");
    assert.ok(
      gate.blockers.some((b) => b.code === "PARALLEL_DEPENDENCY_NOT_PASSED"),
      "task dependency without pass evidence must block wave start"
    );
  });

  // ── A8: wave start gate blocks tampered previous-wave skip ──
  test("A8: wave start gate blocks when previous wave lacks pass evidence", () => {
    const gate = inspectParallelWaveStartGate({
      wave: { id: "wave-02", index: 2, task_ids: ["task-b"] },
      waves: [
        { id: "wave-01", index: 1 },
        { id: "wave-02", index: 2 },
      ],
      tasks: [
        { id: "task-a", files: ["src/a.ts"] },
        { id: "task-b", files: ["src/b.ts"] },
      ],
      passedWaveIds: [],
    });

    assert.equal(gate.status, "blocked");
    assert.ok(
      gate.blockers.some((b) => b.code === "PARALLEL_PREVIOUS_WAVE_NOT_PASSED"),
      "previous wave without pass evidence must block later wave start"
    );
  });

  // ── A9: merge gate blocks tampered pass without evidence ──
  test("A9: merge gate blocks task report missing evidence references", () => {
    const gate = inspectParallelMergeGate({
      wave: { id: "wave-01", task_ids: ["task-a"] },
      taskReports: [
        {
          task_id: "task-a",
          status: "pass",
          gate_status: "pass",
          review_status: "pass",
          scope_merge_clean: true,
        },
      ],
    });

    assert.equal(gate.status, "blocked");
    assert.ok(
      gate.blockers.some((b) => b.code === "PARALLEL_EVIDENCE_MISSING"),
      "task report without evidence must be blocked at merge gate"
    );
  });

  // ── A10: merge gate blocks tampered pass with failed gate status ──
  test("A10: merge gate blocks when gate_status is not pass", () => {
    const gate = inspectParallelMergeGate({
      wave: { id: "wave-01", task_ids: ["task-a"] },
      taskReports: [
        {
          task_id: "task-a",
          status: "pass",
          gate_status: "warn",
          review_status: "pass",
          scope_merge_clean: true,
          evidence_refs: ["evidence/a.json"],
        },
      ],
    });

    assert.equal(gate.status, "blocked");
    assert.ok(
      gate.blockers.some((b) => b.code === "PARALLEL_GATE_NOT_PASS"),
      "gate_status !== pass must block merge"
    );
  });

  // ── A11: merge gate blocks tampered pass with dirty scope ──
  test("A11: merge gate blocks when out_of_scope_files present", () => {
    const gate = inspectParallelMergeGate({
      wave: { id: "wave-01", task_ids: ["task-a"] },
      taskReports: [
        {
          task_id: "task-a",
          status: "pass",
          gate_status: "pass",
          review_status: "pass",
          evidence_refs: ["evidence/a.json"],
          out_of_scope_files: ["src/sneaky.ts"],
        },
      ],
    });

    assert.equal(gate.status, "blocked");
    assert.ok(
      gate.blockers.some((b) => b.code === "PARALLEL_SCOPE_MERGE_DIRTY"),
      "out-of-scope files must block merge"
    );
  });

  // ── A12: dependency graph detects missing deps even for unscheduled tasks ──
  test("A12: dependency graph reports missing dependencies for all tasks", () => {
    const graph = buildTaskDependencyGraph({
      tasks: [
        { id: "a", depends_on: ["missing-a"], files: ["src/a.ts"] },
        { id: "b", depends_on: ["missing-b"], files: ["src/b.ts"] },
      ],
    });

    assert.equal(graph.blockers.length, 2);
    assert.ok(graph.blockers.some((b) => b.dependency_id === "missing-a"));
    assert.ok(graph.blockers.some((b) => b.dependency_id === "missing-b"));
  });

  // ── A13: conflict detection ignores already-completed tasks ──
  test("A13: completed tasks are not included in conflict detection", () => {
    const conflicts = detectParallelConflicts([
      { id: "done-a", status: "completed", files: ["src/a.ts"] },
      { id: "pending-b", status: "pending", files: ["src/a.ts"] },
    ]);

    // detectParallelConflicts doesn't filter by status, but the planner does via taskCanRun
    // This test documents that conflict detection itself is raw; scheduling filters completed
    assert.ok(
      conflicts.some((c) => c.task_ids.includes("done-a") && c.task_ids.includes("pending-b")),
      "raw conflict detection includes all tasks regardless of status"
    );

    const plan = planControlledParallelWaves({
      tasks: [
        { id: "done-a", status: "completed", files: ["src/a.ts"] },
        { id: "pending-b", status: "pending", files: ["src/a.ts"] },
      ],
      completedTaskIds: ["done-a"],
    });

    assert.equal(plan.wave_count, 1);
    assert.deepEqual(plan.waves[0].task_ids, ["pending-b"]);
  });

  // ── A14: empty task list produces pass with zero waves ──
  test("A14: empty task list produces zero-wave plan without crashing", () => {
    const plan = planControlledParallelWaves({ tasks: [] });

    assert.equal(plan.status, "pass");
    assert.equal(plan.wave_count, 0);
    assert.equal(plan.task_count, 0);
    assert.equal(plan.blockers.length, 0);
  });

  // ── A15: task with empty ID is ignored ──
  test("A15: task with empty or missing ID is ignored by planner", () => {
    const plan = planControlledParallelWaves({
      tasks: [
        { id: "", files: ["src/a.ts"] },
        { files: ["src/b.ts"] },
        { id: "valid", files: ["src/c.ts"] },
      ],
    });

    assert.equal(plan.task_count, 1);
    assert.deepEqual(plan.waves[0].task_ids, ["valid"]);
  });
});
