import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiscoveryBrief,
  inspectDiscoveryReadiness,
} from "../src/discovery/gate.js";

describe("discovery readiness gate", () => {
  test("buildDiscoveryBrief normalizes human discovery fields", () => {
    const brief = buildDiscoveryBrief({
      idea: "Add inventory alerts",
      users: ["store manager", "store manager"],
      success_criteria: ["alert appears below threshold"],
      files: ["src/inventory/alerts.js"],
    });

    assert.equal(brief.schema, "yolo.discovery.brief.v1");
    assert.deepEqual(brief.target_users, ["store manager"]);
    assert.deepEqual(brief.target_files, ["src/inventory/alerts.js"]);
  });

  test("buildDiscoveryBrief extracts labeled demand fields from plain text", () => {
    const brief = buildDiscoveryBrief("Add inventory alerts. Problem: stockouts are found too late. Target User: store manager. Success: alert appears below threshold. Scope: src/inventory/alerts.js. Constraint: keep imports unchanged.");

    assert.equal(brief.problem, "stockouts are found too late");
    assert.deepEqual(brief.target_users, ["store manager"]);
    assert.deepEqual(brief.success_criteria, ["alert appears below threshold"]);
    assert.deepEqual(brief.target_files, ["src/inventory/alerts.js"]);
    assert.deepEqual(brief.constraints, ["keep imports unchanged."]);
  });

  test("keeps Chinese punctuation inside acceptance phrases", () => {
    const brief = buildDiscoveryBrief({
      idea: "为运营人员改进看板页面，范围是 src/board.tsx。",
      users: "运营人员",
      success_criteria: [
        "看板包含 Todo、Doing、Done 三列。",
        "- 新增列表、新增卡片、编辑、移动、归档、刷新持久化在一次验收中完成。",
      ],
      files: "src/board.tsx",
    });

    assert.deepEqual(brief.success_criteria, [
      "看板包含 Todo、Doing、Done 三列。",
      "新增列表、新增卡片、编辑、移动、归档、刷新持久化在一次验收中完成。",
    ]);
  });

  test("blocks vague ideas before PI creates PRD or runner actions", () => {
    const result = inspectDiscoveryReadiness("Build inventory alerts");

    assert.equal(result.status, "blocked");
    assert.equal(result.ready_for_plan, false);
    assert.ok(result.blockers.some((blocker) => blocker.code === "DISCOVERY_SUCCESS_CRITERIA_PRESENT"));
    assert.ok(result.next_actions[0].includes("/yolo-discover"));
  });

  test("passes clear requirements and keeps warnings nonfatal", () => {
    const result = inspectDiscoveryReadiness({
      idea: "For store managers, add an inventory alerts API in src/inventory/alerts.js so an alert appears when stock is below threshold.",
      success_criteria: ["alert appears below threshold"],
      target_files: ["src/inventory/alerts.js"],
    });

    assert.equal(result.ready_for_plan, true);
    assert.equal(result.status, "warning");
    assert.ok(result.warnings.some((warning) => warning.code === "DISCOVERY_CONSTRAINTS_RECORDED"));
  });
});
