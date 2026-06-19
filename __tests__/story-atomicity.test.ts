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
  test("blocks Trello create-list plus create-card slices", () => {
    const result = inspectStoryAtomicityText("Trello 用户可以新增列表 + 新增卡片。", {
      kind: "requirement",
      id: "REQ-TRELLO-1",
    });

    assert.equal(result.status, "blocked");
    assert.deepEqual(signatureIds(result), ["create_list", "create_card"]);
    assert.equal(result.finding.code, "STORY_ATOMICITY_MULTI_STORY");
  });

  test("blocks Trello edit plus move slices", () => {
    const result = inspectStoryAtomicityText("编辑卡片标题，并移动卡片到另一个列表。", {
      kind: "scenario",
      id: "SCN-TRELLO-EDIT-MOVE",
    });

    assert.equal(result.status, "blocked");
    assert.deepEqual(signatureIds(result), ["edit_item", "move_item"]);
  });

  test("blocks Trello archive plus refresh or persistence recovery slices", () => {
    const result = inspectStoryAtomicityText("归档卡片，并在刷新后从持久化状态恢复。", {
      kind: "task",
      id: "TASK-TRELLO-ARCHIVE",
    });

    assert.equal(result.status, "blocked");
    assert.deepEqual(signatureIds(result), ["archive_item", "persistence_or_restore"]);
  });

  test("passes a single first-open display story", () => {
    const result = inspectStoryAtomicityText("首次打开看板时显示 To do、Doing、Done 三列。", {
      kind: "scenario",
      id: "SCN-TRELLO-FIRST-OPEN",
    });

    assert.equal(result.status, "pass");
    assert.equal(result.finding, null);
  });

  test("does not treat displaying card counts as creating cards", () => {
    const result = inspectStoryAtomicityText("用户新增列表后显示该列表中的卡片数量。", {
      kind: "scenario",
      id: "SCN-TRELLO-LIST-COUNT",
    });

    assert.equal(result.status, "pass");
    assert.deepEqual(signatureIds(result), ["create_list"]);
    assert.equal(result.finding, null);
  });

  test("ignores current behavior when checking scenario and task story atomicity", () => {
    const result = inspectStoryAtomicityFromDemand({
      requirements: {
        active: [{
          id: "REQ-CLI-ADD",
          text: "TaskCLI should add a todo and print the new item id.",
        }],
      },
      scenario_matrix: {
        scenarios: [{
          id: "SCN-CLI-ADD",
          current_behavior: "Today the operator manually edits a scratch file and counts open items.",
          desired_behavior: "TaskCLI adds one todo item and prints its id.",
          proof: "Run taskcli add and see the new item id.",
          surfaces: [{
            id: "SFC-CLI",
            kind: "code",
            target_files: ["src/taskcli.ts"],
          }],
        }],
      },
    }, {
      tasks: [{
        id: "TASK-CLI-ADD",
        title: "Add todo command",
        description: "TaskCLI adds one todo item and prints its id.",
        handoff: {
          current_behavior: "Today the operator manually edits a scratch file.",
          desired_behavior: "TaskCLI adds one todo item and prints its id.",
        },
        scope: { targets: [{ file: "src/taskcli.ts" }] },
      }],
    });

    assert.equal(result.status, "pass");
    assert.deepEqual(result.blockers, []);
  });

  test("inspects demand requirements, scenarios, and generated tasks without using file count", () => {
    const result = inspectStoryAtomicityFromDemand({
      requirements: {
        active: [{
          id: "REQ-TRELLO-SINGLE",
          text: "首次打开看板时显示三列。",
        }],
      },
      scenario_matrix: {
        scenarios: [{
          id: "SCN-TRELLO-MIXED",
          proof: "编辑卡片标题，并移动卡片到 Done 列。",
        }],
      },
    }, {
      tasks: [{
        id: "TASK-TRELLO-SINGLE",
        title: "First open board",
        description: "首次打开看板时显示三列。",
        scope: {
          targets: [
            { file: "src/pages/board.tsx" },
            { file: "src/components/board-columns.tsx" },
          ],
        },
      }],
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blockers.length, 1);
    assert.equal(result.blockers[0].scenario_id, "SCN-TRELLO-MIXED");
    assert.equal(result.inspected.find((item) => item.id === "TASK-TRELLO-SINGLE").status, "pass");
  });

  test("inspects PRD requirements and tasks", () => {
    const result = inspectStoryAtomicityFromPrd({
      requirements: [{
        id: "REQ-TRELLO-CREATE",
        text: "用户可以新增列表并新增卡片。",
      }],
      tasks: [{
        id: "TASK-TRELLO-FIRST-OPEN",
        title: "首次打开显示三列",
        description: "首次打开看板时显示三列。",
      }],
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blockers[0].requirement_id, "REQ-TRELLO-CREATE");
    assert.equal(result.inspected.find((item) => item.id === "TASK-TRELLO-FIRST-OPEN").status, "pass");
  });
});
