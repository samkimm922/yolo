import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildImportGraph,
  expandTasksForMainLoop,
  groupByDependency,
  mergeOverlappingTasks,
  orderTasksByDependencies,
  splitTask,
} from "../src/runtime/task-loop/expansion.js";

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "yolo-expansion-"));
  tempDirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  return root;
}

function writeProjectFile(root, file, content = "") {
  const fullPath = join(root, file);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf8");
}

function baseTask(overrides = {}) {
  return {
    id: "T1",
    title: "Fix task",
    description: "Fix task",
    priority: "P1",
    scope: { targets: [{ file: "src/a.ts" }] },
    pre_conditions: [],
    post_conditions: [],
    acceptance_criteria: [],
    ...overrides,
  };
}

describe("task loop expansion", () => {
  test("completed ids are marked completed before split logic runs", () => {
    const root = tempProject();
    writeProjectFile(root, "src/existing.ts", "export const existing = true;\n");
    const { expanded } = expandTasksForMainLoop({
      tasks: [
        baseTask({
          id: "DONE",
          scope: { targets: [{ file: "src/new.ts" }] },
          description: "Create src/new.ts and update src/existing.ts",
        }),
      ],
      completedIds: new Set(["DONE"]),
      rootDir: root,
    });

    assert.deepEqual(expanded.map((task) => task.id), ["DONE"]);
    assert.equal(expanded[0].status, "completed");
  });

  test("split-like existing-target work gets scoped new-file permission", () => {
    const root = tempProject();
    writeProjectFile(root, "src/large.ts", "export const large = true;\n");
    const { expanded } = expandTasksForMainLoop({
      tasks: [
        baseTask({
          id: "SPLIT",
          title: "拆分超过 300 行文件",
          description: "拆分 src/large.ts，超过 300 行",
          scope: { targets: [{ file: "src/large.ts" }] },
        }),
      ],
      rootDir: root,
    });

    assert.equal(expanded.length, 1);
    assert.equal(expanded[0].scope.allow_new_files, true);
    assert.equal(expanded[0].scope.expected_zero_business_code, true);
  });

  test("new target plus existing mentioned file is split into create and caller tasks", () => {
    const root = tempProject();
    writeProjectFile(root, "src/caller.ts", "export const caller = true;\n");
    const logs = [];
    const parts = splitTask(
      baseTask({
        id: "NEW",
        title: "Add service",
        description: "Create src/new-service.ts and update src/caller.ts",
        scope: { targets: [{ file: "src/new-service.ts" }] },
      }),
      { rootDir: root, log: (...entry) => logs.push(entry) },
    );

    assert.deepEqual(parts.map((task) => task.id), ["NEW-A", "NEW-B"]);
    assert.equal(parts[0].scope.allow_new_files, true);
    assert.deepEqual(parts[1].scope.targets, [{ file: "src/caller.ts" }]);
    assert.deepEqual(parts[1].depends_on, ["NEW-A"]);
    assert.equal(logs[0][1], "原子拆分");
  });

  test("more than four mentioned files are grouped by direct dependency", () => {
    const root = tempProject();
    writeProjectFile(root, "src/a.ts", 'import "./b";\nexport const a = true;\n');
    writeProjectFile(root, "src/b.ts", "export const b = true;\n");
    writeProjectFile(root, "src/c.ts", "export const c = true;\n");
    writeProjectFile(root, "src/d.ts", "export const d = true;\n");
    writeProjectFile(root, "src/e.ts", "export const e = true;\n");

    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
    const graph = buildImportGraph(files, { rootDir: root });
    assert.deepEqual([...graph.get("src/a.ts")], ["src/b.ts"]);
    assert.deepEqual(groupByDependency(files, graph), [
      ["src/a.ts", "src/b.ts"],
      ["src/c.ts"],
      ["src/d.ts"],
      ["src/e.ts"],
    ]);

    const parts = splitTask(
      baseTask({
        id: "MANY",
        description: `Fix ${files.join(" ")}`,
      }),
      { rootDir: root },
    );

    assert.deepEqual(parts.map((task) => task.id), ["MANY-P1", "MANY-P2", "MANY-P3", "MANY-P4"]);
    assert.deepEqual(parts[0].scope.targets, [{ file: "src/a.ts" }, { file: "src/b.ts" }]);
    assert.deepEqual(parts[1].depends_on, ["MANY-P1"]);
  });

  test("overlapping same-file precondition tasks are merged with deduped post checks", () => {
    const merged = mergeOverlappingTasks([
      baseTask({
        id: "A",
        description: "Fix foo",
        pre_conditions: [{ type: "code_contains", params: { text: "foo" } }],
        post_conditions: [{ type: "code_not_contains", params: { text: "foo", line: 10 } }],
        acceptance_criteria: ["foo removed"],
        depends_on: ["PRE"],
      }),
      baseTask({
        id: "B",
        description: "Fix foo bar",
        pre_conditions: [{ type: "code_contains", params: { text: "foo bar" } }],
        post_conditions: [{ type: "code_not_contains", params: { text: "foo", line: 20 } }],
        acceptance_criteria: ["foo still removed"],
        depends_on: ["OTHER"],
      }),
    ]);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "A+B");
    assert.deepEqual(merged[0].merged_from, ["A", "B"]);
    assert.deepEqual(merged[0].post_conditions, [
      { type: "code_not_contains", params: { text: "foo" } },
    ]);
    assert.deepEqual(merged[0].depends_on, ["PRE", "OTHER"]);
  });

  test("orders dependencies before higher-priority dependents", () => {
    const ordered = orderTasksByDependencies([
      baseTask({ id: "B", priority: "P0", depends_on: ["A"] }),
      baseTask({ id: "A", priority: "P3", depends_on: [] }),
      baseTask({ id: "C", priority: "P1", depends_on: [] }),
    ], {
      priorityOrder: { P0: 0, P1: 1, P2: 2, P3: 3 },
    });

    assert.equal(ordered.preflight.blocks_execution, false);
    assert.deepEqual(ordered.tasks.map((task) => task.id), ["C", "A", "B"]);
  });

  test("blocks circular task dependencies during expansion preflight", () => {
    const { preflight } = expandTasksForMainLoop({
      tasks: [
        baseTask({ id: "A", priority: "P1", depends_on: ["B"] }),
        baseTask({ id: "B", priority: "P1", depends_on: ["A"] }),
      ],
      priorityOrder: { P0: 0, P1: 1, P2: 2, P3: 3 },
    });

    assert.equal(preflight.blocks_execution, true);
    assert.deepEqual(preflight.blockers.map((blocker) => blocker.code), [
      "TASK_DEPENDENCY_NO_ROOT",
      "TASK_DEPENDENCY_CYCLE",
    ]);
    assert.equal(preflight.blockers[0].invariant_code, "RUNTIME_INVARIANT_VIOLATED:task_graph_no_root");
    assert.deepEqual(preflight.blockers[1].task_ids, ["A", "B"]);
  });

  test("blocks demand-generated same-output mutual dependencies instead of hiding the cycle", () => {
    const ordered = orderTasksByDependencies([
      baseTask({
        id: "A",
        task_kind: "demand_atomic_task",
        depends_on: ["B"],
        inputs: ["src/tool.ts"],
        expected_output: ["src/tool.ts"],
      }),
      baseTask({
        id: "B",
        task_kind: "demand_atomic_task",
        depends_on: ["A"],
        inputs: ["src/tool.ts"],
        expected_output: ["src/tool.ts"],
      }),
    ]);

    assert.equal(ordered.preflight.blocks_execution, true);
    assert.deepEqual(ordered.preflight.blockers.map((blocker) => blocker.code), [
      "TASK_DEPENDENCY_NO_ROOT",
      "TASK_DEPENDENCY_CYCLE",
    ]);
    assert.equal(ordered.preflight.blockers[0].invariant_code, "RUNTIME_INVARIANT_VIOLATED:task_graph_no_root");
    assert.deepEqual(ordered.tasks.map((task) => task.id), ["A", "B"]);
  });

  test("blocks fully connected dependency graphs with no executable root", () => {
    const ordered = orderTasksByDependencies([
      baseTask({ id: "A", depends_on: ["B", "C"] }),
      baseTask({ id: "B", depends_on: ["A", "C"] }),
      baseTask({ id: "C", depends_on: ["A", "B"] }),
    ]);

    assert.equal(ordered.preflight.blocks_execution, true);
    assert.equal(ordered.preflight.blockers.some((blocker) => blocker.code === "TASK_DEPENDENCY_NO_ROOT"), true);
    assert.equal(ordered.preflight.blockers.some((blocker) => blocker.invariant_code === "RUNTIME_INVARIANT_VIOLATED:task_graph_no_root"), true);
    assert.equal(ordered.preflight.blockers.some((blocker) => blocker.code === "TASK_DEPENDENCY_CYCLE"), true);
    assert.deepEqual(ordered.preflight.blockers[0].task_ids, ["A", "B", "C"]);
  });

  test("skips null / non-object task entries instead of crashing during expansion", () => {
    // PRD with null / string / number siblings (manual edits, migration residue,
    // retry PRDs built from already-corrupt state). Same YB family as #104.
    const { expanded, preflight } = expandTasksForMainLoop({
      tasks: [
        null,
        "not-a-task",
        42,
        baseTask({ id: "VALID", depends_on: [] }),
      ],
      priorityOrder: { P0: 0, P1: 1, P2: 2, P3: 3 },
    });

    assert.equal(preflight.blocks_execution, false);
    assert.deepEqual(expanded.map((task) => task.id), ["VALID"]);
  });

  test("skips null / non-object condition entries when merging overlapping tasks", () => {
    // pre_conditions / post_conditions with null/non-object entries must not
    // crash the merge — they are filtered out before reading .params / .type.
    const merged = mergeOverlappingTasks([
      baseTask({
        id: "A",
        pre_conditions: [
          null,
          { type: "code_contains", params: { text: "foo" } },
          "not-a-condition",
        ],
        post_conditions: [
          null,
          { type: "code_not_contains", params: { text: "foo", line: 10 } },
        ],
      }),
      baseTask({
        id: "B",
        pre_conditions: [{ type: "code_contains", params: { text: "foo bar" } }],
        post_conditions: [{ type: "code_not_contains", params: { text: "foo", line: 20 } }],
      }),
    ]);

    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "A+B");
    // Null / non-object entries are dropped during the dedupe merge.
    assert.deepEqual(merged[0].pre_conditions, [
      { type: "code_contains", params: { text: "foo" } },
      { type: "code_contains", params: { text: "foo bar" } },
    ]);
    assert.deepEqual(merged[0].post_conditions, [
      { type: "code_not_contains", params: { text: "foo" } },
    ]);
  });

  test("single task with null condition entries is preserved unchanged", () => {
    // No merge partner: the task still has null entries in its arrays, but the
    // expansion must not crash reading them.
    const { expanded } = expandTasksForMainLoop({
      tasks: [
        baseTask({
          id: "SOLO",
          pre_conditions: [null],
          post_conditions: [null],
        }),
      ],
    });

    assert.deepEqual(expanded.map((task) => task.id), ["SOLO"]);
  });

  test("non-array pre/post_conditions / acceptance_criteria / depends_on does not crash or corrupt merge", () => {
    // Same family as #59/#63/#64 but on the merge path of mergeOverlappingTasks:
    // a non-array truthy value (string/object/number) for any of these fields
    // either crashed `.map` (pre_conditions) or silently iterated characters
    // (post_conditions / acceptance_criteria / depends_on via for...of).
    // PRD migration residue or hand-edited state can produce these shapes.
    const merged = mergeOverlappingTasks([
      baseTask({
        id: "A",
        pre_conditions: "must not crash",
        post_conditions: "abcd",
        acceptance_criteria: "should pass",
        depends_on: "XYZ",
      }),
      baseTask({
        id: "B",
        pre_conditions: [{ type: "code_contains", params: { text: "foo" } }],
        post_conditions: [{ type: "code_contains", params: { text: "baz" } }],
        acceptance_criteria: ["c1"],
        depends_on: ["D1"],
      }),
    ]);

    // Both tasks survive; A's invalid fields are treated as empty, so it does
    // not merge into B (no overlapping pre-text). No crash, no char pollution.
    assert.ok(merged.length === 1 || merged.length === 2);

    // Force an overlapping merge on A while keeping its other fields non-array.
    // The merge must not let character iteration leak into merged output.
    const mergedOverlap = mergeOverlappingTasks([
      baseTask({
        id: "A",
        pre_conditions: [{ type: "code_contains", params: { text: "foo" } }],
        post_conditions: "abcd",
        acceptance_criteria: "should pass",
        depends_on: "XYZ",
      }),
      baseTask({
        id: "B",
        pre_conditions: [{ type: "code_contains", params: { text: "foo bar" } }],
        post_conditions: [{ type: "code_contains", params: { text: "baz" } }],
        acceptance_criteria: ["c1"],
        depends_on: ["D1"],
      }),
    ]);

    assert.equal(mergedOverlap.length, 1);
    assert.equal(mergedOverlap[0].id, "A+B");
    // Invalid string fields yield empty — no char leaks into merged output.
    assert.deepEqual(mergedOverlap[0].post_conditions,
      [{ type: "code_contains", params: { text: "baz" } }]);
    assert.deepEqual(mergedOverlap[0].acceptance_criteria, ["c1"]);
    assert.deepEqual(mergedOverlap[0].depends_on, ["D1"]);
  });
});
