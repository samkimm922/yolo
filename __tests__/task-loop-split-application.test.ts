import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySplitSuggestionsToPrd,
  makeSplitChildId,
  splitSuggestionToTask,
} from "../src/runtime/task-loop/split-application.js";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "yolo-split-application-"));
}

test("split suggestion helpers preserve schema-compatible ids and scoped conditions", () => {
  const parent = {
    id: "FIX-P36-003",
    title: "Parent",
    priority: "P1",
    type: "bugfix",
    task_kind: "review_fix",
    depends_on: [],
    scope: { targets: [{ file: "src/old.ts" }] },
    pre_conditions: [
      { id: "PRE-KEEP", params: { file: "src/new.ts" } },
      { id: "PRE-DROP", params: { file: "src/old.ts" } },
      { id: "PRE-GLOBAL" },
    ],
    post_conditions: [],
  };

  assert.equal(makeSplitChildId(parent.id, { id: "FIX-P36-003A" }, 0), "FIX-P36-003A");
  const child = splitSuggestionToTask(parent, { files: ["src/new.ts"], goal: "Extract helper" }, 0);

  assert.equal(child.id, "FIX-P36-0031");
  assert.deepEqual(child.scope.targets, [{ file: "src/new.ts", description: "Extract helper" }]);
  assert.deepEqual(child.pre_conditions.map((condition) => condition.id), ["PRE-KEEP", "PRE-GLOBAL"]);
});

test("applySplitSuggestionsToPrd mutates PRD atomically and writes split evidence", () => {
  const root = makeTempDir();
  try {
    const prdPath = join(root, "prd.json");
    const parentTask = {
      id: "FIX-P36-003",
      title: "Parent",
      priority: "P1",
      type: "bugfix",
      task_kind: "review_fix",
      status: "pending",
      depends_on: [],
      scope: { targets: [{ file: "src/old.ts" }] },
      pre_conditions: [],
      post_conditions: [],
    };
    writeFileSync(prdPath, JSON.stringify({ version: "2.0", tasks: [parentTask] }, null, 2), "utf8");

    const checkpoints = [];
    const result = applySplitSuggestionsToPrd({
      prdPath,
      parentTask,
      doctor: {
        mode: "strict",
        score: 92,
        evidence_file: "state/evidence/doctor.json",
        next_action: "split",
        split_suggestions: [{ files: ["src/new.ts"], goal: "Extract helper" }],
      },
      yoloRoot: root,
      projectRoot: root,
      writeRecoveryCheckpoint: (...args) => checkpoints.push(args),
    });

    assert.equal(result.applied, true);
    assert.equal(result.reason, "split_applied");
    assert.deepEqual(result.childIds, ["FIX-P36-0031"]);
    assert.equal(existsSync(join(root, "state", "evidence", "FIX-P36-003", "split-applied.json")), true);

    const prd = JSON.parse(readFileSync(prdPath, "utf8"));
    assert.equal(prd.tasks[0].status, "split");
    assert.equal(prd.tasks[0].split_into[0], "FIX-P36-0031");
    assert.equal(prd.tasks[1].split_from, "FIX-P36-003");
    assert.deepEqual(checkpoints[0].slice(0, 3), [
      "task_split_FIX-P36-003",
      prdPath,
      "FIX-P36-003",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
