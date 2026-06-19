import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  inspectStoryAtomicityFromDemand,
  inspectStoryAtomicityFromPrd,
  inspectStoryAtomicityText,
} from "../src/demand/story-atomicity.js";

function signatureIds(result) {
  return result.story_signatures.map((signature) => signature.id);
}

describe("story atomicity gate", () => {
  test("blocks plus-separated visible action slices with generic signatures", () => {
    const result = inspectStoryAtomicityText("用户可以新增分组 + 新增条目。", {
      kind: "requirement",
      id: "REQ-GENERIC-1",
    });

    assert.equal(result.status, "blocked");
    assert.deepEqual(signatureIds(result), ["generic_story_1", "generic_story_2"]);
    assert.equal(result.finding.code, "STORY_ATOMICITY_MULTI_STORY");
  });

  test("blocks comma-separated independent action slices", () => {
    const result = inspectStoryAtomicityText("编辑条目标题，并发送确认通知。", {
      kind: "scenario",
      id: "SCN-EDIT-NOTIFY",
    });

    assert.equal(result.status, "blocked");
    assert.deepEqual(signatureIds(result), ["generic_story_1", "generic_story_2"]);
  });

  test("blocks compact command-style action sequences", () => {
    const result = inspectStoryAtomicityText("Operator can delete/restore item state.", {
      kind: "task",
      id: "TASK-COMPACT-SEQUENCE",
    });

    assert.equal(result.status, "blocked");
    assert.deepEqual(signatureIds(result), ["generic_story_1", "generic_story_2"]);
  });

  test("passes a single first-open display story", () => {
    const result = inspectStoryAtomicityText("首次打开工作区时显示 To do、Doing、Done 三个状态列。", {
      kind: "scenario",
      id: "SCN-WORKSPACE-FIRST-OPEN",
    });

    assert.equal(result.status, "pass");
    assert.equal(result.finding, null);
  });

  test("does not treat displaying item counts as creating items", () => {
    const result = inspectStoryAtomicityText("用户新增分组后显示该分组中的条目数量。", {
      kind: "scenario",
      id: "SCN-GROUP-ITEM-COUNT",
    });

    assert.equal(result.status, "pass");
    assert.deepEqual(signatureIds(result), []);
    assert.equal(result.finding, null);
  });

  test("ignores current behavior when checking scenario and task story atomicity", () => {
    const result = inspectStoryAtomicityFromDemand({
      requirements: {
        active: [{
          id: "REQ-CLI-ADD",
          text: "The local tool should add a todo and print the new item id.",
        }],
      },
      scenario_matrix: {
        scenarios: [{
          id: "SCN-CLI-ADD",
          current_behavior: "Today the operator manually edits a scratch file and counts open items.",
          desired_behavior: "The local tool adds one todo item and prints its id.",
          proof: "Run the add command and see the new item id.",
          surfaces: [{
            id: "SFC-CLI",
            kind: "code",
            target_files: ["src/local-tool.ts"],
          }],
        }],
      },
    }, {
      tasks: [{
        id: "TASK-CLI-ADD",
        title: "Add todo command",
        description: "The local tool adds one todo item and prints its id.",
        handoff: {
          current_behavior: "Today the operator manually edits a scratch file.",
          desired_behavior: "The local tool adds one todo item and prints its id.",
        },
        scope: { targets: [{ file: "src/local-tool.ts" }] },
      }],
    });

    assert.equal(result.status, "pass");
    assert.deepEqual(result.blockers, []);
  });

  test("inspects demand requirements, scenarios, and generated tasks without using file count", () => {
    const result = inspectStoryAtomicityFromDemand({
      requirements: {
        active: [{
          id: "REQ-BOARD-SINGLE",
          text: "首次打开工作区时显示三列。",
        }],
      },
      scenario_matrix: {
        scenarios: [{
          id: "SCN-BOARD-MIXED",
          desired_behavior: "编辑条目标题，并发送确认通知。",
        }],
      },
    }, {
      tasks: [{
        id: "TASK-BOARD-SINGLE",
        title: "First open workspace",
        description: "首次打开工作区时显示三列。",
        scope: {
          targets: [
            { file: "src/pages/workspace.tsx" },
            { file: "src/components/workspace-columns.tsx" },
          ],
        },
      }],
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].scenario_id, "SCN-BOARD-MIXED");
    assert.equal(result.inspected.find((item) => item.id === "TASK-BOARD-SINGLE").status, "pass");
  });

  test("inspects PRD requirements and tasks", () => {
    const result = inspectStoryAtomicityFromPrd({
      requirements: [{
        id: "REQ-BOARD-CREATE",
        text: "用户可以新增分组 + 新增条目。",
      }],
      tasks: [{
        id: "TASK-BOARD-FIRST-OPEN",
        title: "首次打开显示三列",
        description: "首次打开工作区时显示三列。",
      }],
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blockers[0].requirement_id, "REQ-BOARD-CREATE");
    assert.equal(result.inspected.find((item) => item.id === "TASK-BOARD-FIRST-OPEN").status, "pass");
  });
});
