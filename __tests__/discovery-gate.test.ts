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

describe("discovery external evidence fail-closed", () => {
  const localIdea = "For store managers, add an inventory alerts API in src/inventory/alerts.js so an alert appears when stock is below threshold.";
  const urlIdea = "For store managers, add an inventory alerts API modeled on https://example.com/alerts-guide so an alert appears when stock is below threshold.";

  const baseInput = {
    idea: urlIdea,
    problem: "stockouts are found too late",
    success_criteria: ["alert appears below threshold"],
    target_files: ["src/inventory/alerts.js"],
    constraints: ["keep imports unchanged"],
  };

  test("idea with URL but no external evidence blocks PRD readiness", () => {
    const result = inspectDiscoveryReadiness(baseInput);
    assert.equal(result.ready_for_prd, false);
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED"));
  });

  test("idea with URL and matching scope=external evidence passes", () => {
    const result = inspectDiscoveryReadiness({
      ...baseInput,
      evidence: [{
        scope: "external",
        url: "https://example.com/alerts-guide",
        source: "external_web",
        summary: "Reference alert schema.",
      }],
    });
    assert.equal(result.ready_for_prd, true);
    assert.equal(result.blockers.some((blocker) => blocker.code === "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED"), false);
  });

  test("unrelated external evidence does not satisfy the URL requirement", () => {
    const result = inspectDiscoveryReadiness({
      ...baseInput,
      evidence: [{
        scope: "external",
        url: "https://example.com/unrelated",
        source: "external_web",
        summary: "Fetched a different page.",
      }],
    });

    assert.equal(result.ready_for_prd, false);
    assert.ok(result.blockers.some((blocker) => blocker.code === "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED"));
  });

  test("pure local idea is not blocked by the external evidence gate", () => {
    const result = inspectDiscoveryReadiness({ ...baseInput, idea: localIdea });
    assert.equal(
      result.blockers.some((blocker) => blocker.code === "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED"),
      false,
      "local idea must not trigger the external-evidence gate",
    );
  });

  test("attempted-but-missing external research reports tool-unavailable reason", () => {
    const result = inspectDiscoveryReadiness({ ...baseInput, external_research_attempted: true });
    const blocker = result.blockers.find((item) => item.code === "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED");
    assert.ok(blocker);
    assert.match(blocker.message, /unavailable/);
  });

  test("not-attempted missing external research reports not-triggered reason", () => {
    const result = inspectDiscoveryReadiness(baseInput);
    const blocker = result.blockers.find((item) => item.code === "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED");
    assert.ok(blocker);
    assert.match(blocker.message, /not triggered/);
  });

  test("next_actions expose the specific EVREQ id, topic, and demand dispatch command", () => {
    const result = inspectDiscoveryReadiness(baseInput);
    assert.equal(result.status, "blocked");

    const blocker = result.blockers.find((item) => item.code === "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED");
    assert.ok(blocker, "external evidence blocker should exist");
    assert.ok(blocker.evidence_requirement_id, "blocker should carry the EVREQ id in extra fields");
    assert.ok(blocker.topic, "blocker should carry the topic in extra fields");

    const requirementId = String(blocker.evidence_requirement_id);
    const topic = String(blocker.topic);

    const evidenceAction = result.next_actions.find((action) => action.includes(requirementId));
    assert.ok(
      evidenceAction,
      `next_actions should mention the evidence_requirement_id ${requirementId}; got ${JSON.stringify(result.next_actions)}`,
    );
    assert.ok(
      evidenceAction.includes(topic),
      `next_actions should mention the topic "${topic}"; got ${JSON.stringify(result.next_actions)}`,
    );
    assert.ok(
      evidenceAction.includes("yolo demand dispatch"),
      `next_actions should surface the dispatch command; got ${JSON.stringify(result.next_actions)}`,
    );
  });
});
