import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEMAND_INTERVIEW_QUESTION_BANK,
  DEMAND_INTERVIEW_SCHEMA,
  DEMAND_INTERVIEW_SCHEMA_VERSION,
  answerDemandInterviewQuestion,
  createDemandInterviewSession,
  demandInterviewToDemandInput,
  inspectDemandInterviewCoverage,
} from "../src/demand/interview.js";
import { buildDemandSession } from "../src/demand/artifacts.js";

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "yolo-demand-interview-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function newSession(root) {
  return createDemandInterviewSession({
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    idea: "Build inventory stockout prevention for store managers.",
  }, {
    now: "2026-05-29T12:00:00.000Z",
  });
}

function answer(session, questionId, value) {
  return answerDemandInterviewQuestion(session, {
    questionId,
    answer: value,
    now: "2026-05-29T12:30:00.000Z",
  });
}

function answerAllRequired(session) {
  answer(session, "target_users", "Store managers who review inventory every morning.");
  answer(session, "status_quo", "They export inventory counts and manually scan for risky SKUs.");
  answer(session, "pain_points", "Stockouts are discovered after customers complain.");
  answer(session, "desired_outcome", "Managers see low-stock risks before the item sells out.");
  answer(session, "success_criteria", "Low-stock SKUs show a clear badge in the inventory list.");
  answer(session, "success_proof", "Create a SKU below threshold and confirm the list shows the badge.");
  answer(session, "scope_boundaries", "Do not build supplier ordering; do not change order import.");
  answer(session, "exceptions", "New SKUs without sales history should not be marked high risk by default.");
  answer(session, "mvp_priority", "MVP is threshold alert plus inventory badge; forecasting can come later.");
  return session;
}

describe("demand interview", () => {
  test("initializes a non-technical interview session from idea", () => withRoot((root) => {
    const session = newSession(root);

    assert.equal(DEMAND_INTERVIEW_SCHEMA_VERSION, "1.0");
    assert.equal(session.schema, DEMAND_INTERVIEW_SCHEMA);
    assert.equal(session.id.startsWith("DINT-20260529-"), true);
    assert.equal(session.demand_id.startsWith("DEMAND-20260529-"), true);
    assert.equal(session.projectRoot, root);
    assert.equal(session.stateRoot, join(root, ".yolo"));
    assert.equal(session.objective, "Build inventory stockout prevention for store managers.");
    assert.deepEqual(session.answers, {});
    assert.equal(session.next_question.id, "target_users");
    assert.equal(session.coverage.ready_for_discuss, false);
    assert.equal(session.coverage.ready_for_prd_intake, false);
    assert.ok(session.ledgers.project_memory.path.endsWith(join(".yolo", "memory", "project.jsonl")));
    assert.ok(session.ledgers.interview_answers.path.includes(join(".yolo", "demand", "interviews", session.id)));

    for (const question of DEMAND_INTERVIEW_QUESTION_BANK) {
      assert.equal(typeof question.plain_language_prompt, "string");
      assert.equal(question.plain_language_prompt.length > 0, true);
      assert.equal(typeof question.why_it_matters, "string");
      assert.equal(question.why_it_matters.length > 0, true);
      assert.equal(question.accepts.free_text, true);
      assert.equal(question.accepts.examples.length >= 2, true);
    }
  }));

  test("answers questions in order and advances coverage", () => withRoot((root) => {
    const session = newSession(root);

    answer(session, "target_users", "Store managers.");
    assert.equal(session.answers.target_users.normalized.items[0], "Store managers.");
    assert.equal(session.questions.find((question) => question.id === "target_users").answered, true);
    assert.equal(session.next_question.id, "status_quo");

    answer(session, "status_quo", "They use a spreadsheet export.");
    answer(session, "pain_points", "They learn about stockouts too late.");
    answer(session, "desired_outcome", "They see a warning before stockout.");

    const coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.ready_for_discuss, true);
    assert.equal(coverage.ready_for_prd_intake, false);
    assert.ok(coverage.answered_slots.includes("desired_outcome"));
    assert.ok(coverage.missing_slots.includes("success_criteria"));
    assert.equal(session.next_question.id, "success_criteria");
  }));

  test("gates PRD intake on critical slots plus explicit approval", () => withRoot((root) => {
    const session = answerAllRequired(newSession(root));

    let coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.ready_for_discuss, true);
    assert.equal(coverage.ready_for_prd_intake, false);
    assert.ok(coverage.missing_slots.includes("execution_approval"));
    assert.ok(coverage.readiness.blockers.some((blocker) => blocker.code === "APPROVAL_REQUIRED"));

    answer(session, "execution_approval", "暂不批准，还要确认运营流程。");
    coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.approval.answered, true);
    assert.equal(coverage.approval.approved, false);
    assert.equal(coverage.ready_for_prd_intake, false);

    answer(session, "execution_approval", "批准，按这个范围进入 PRD。");
    coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.approval.approved, true);
    assert.equal(coverage.ready_for_prd_intake, true);
    assert.deepEqual(coverage.missing_slots, []);
  }));

  test("converts interview answers into demand runtime input", () => withRoot((root) => {
    const session = answerAllRequired(newSession(root));
    answer(session, "execution_approval", true);

    const input = demandInterviewToDemandInput(session);
    assert.equal(input.demand_id, session.demand_id);
    assert.deepEqual(input.target_users, ["Store managers who review inventory every morning."]);
    assert.deepEqual(input.status_quo, ["They export inventory counts and manually scan for risky SKUs."]);
    assert.ok(input.success_criteria.includes("Managers see low-stock risks before the item sells out."));
    assert.ok(input.success_criteria.includes("Low-stock SKUs show a clear badge in the inventory list."));
    assert.deepEqual(input.proof, ["Create a SKU below threshold and confirm the list shows the badge."]);
    assert.deepEqual(input.non_goals, ["Do not build supplier ordering", "do not change order import."]);
    assert.deepEqual(input.exceptions, ["New SKUs without sales history should not be marked high risk by default."]);
    assert.deepEqual(input.roadmap, ["MVP is threshold alert plus inventory badge", "forecasting can come later."]);
    assert.equal(input.approve, true);
    assert.equal(input.questions.length, 10);
    assert.equal(input.open_questions.length, 0);

    const demandSession = buildDemandSession(input, { now: "2026-05-29T13:00:00.000Z" });
    assert.equal(demandSession.id, session.demand_id);
    assert.deepEqual(demandSession.project.target_users, input.target_users);
    assert.equal(demandSession.approval.approved, true);
    assert.equal(demandSession.discussion.rounds.length, 10);
  }));
});
