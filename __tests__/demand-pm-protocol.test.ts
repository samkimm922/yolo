import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  answerDemandInterviewQuestion,
  createDemandInterviewSession,
  inspectDemandInterviewCoverage,
  selectDemandInterviewNextQuestion,
} from "../src/demand/interview.js";

function withSession(run: (session: ReturnType<typeof createDemandInterviewSession>) => void) {
  const root = mkdtempSync(join(tmpdir(), "yolo-pm-protocol-"));
  try {
    const session = createDemandInterviewSession({
      projectRoot: root,
      stateRoot: join(root, ".yolo"),
      idea: "让团队成员给待办分类，并在到期前收到提醒。",
    }, { now: "2026-07-13T12:00:00.000Z" });
    run(session);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function answer(session: ReturnType<typeof createDemandInterviewSession>, questionId: string, value: string) {
  return answerDemandInterviewQuestion(session, {
    questionId,
    answer: value,
    now: "2026-07-13T12:30:00.000Z",
  });
}

describe("PM protocol interview stages", () => {
  test("starts with a lightweight premise challenge before the four business layers", () => withSession((session) => {
    assert.equal(session.next_question?.id, "premise_current_solution");
    assert.deepEqual(
      session.questions?.slice(0, 4).map((question) => question.id),
      ["premise_current_solution", "premise_consequence", "premise_minimum", "premise_decision"],
    );
    assert.equal(session.next_question?.stage, "premise");

    answer(session, "premise_current_solution", "现在用标题前缀写标签，每天下班前人工翻看日期。");
    answer(session, "premise_consequence", "不做会继续漏掉本周到期的任务，负责人至少每周补救两次。");
    answer(session, "premise_minimum", "最小版本也要能创建标签、按标签筛选、设置到期时间并在到期前提醒。");

    assert.equal(session.next_question?.id, "premise_decision");
    assert.equal(session.next_question?.confirmation_gate, true);
    assert.equal(session.next_question?.recommended_answer, "继续");
    assert.match(session.next_question?.plain_language_prompt || "", /继续|不继续/);

    answer(session, "premise_decision", "继续");
    const coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.awaiting_initial_playback, true);
    assert.equal(session.next_question, null);
    assert.equal(coverage.ready_for_discuss, false);
  }));

  test("a do-not-continue premise judgment stops instead of leaking into layer one", () => withSession((session) => {
    answer(session, "premise_current_solution", "现在偶尔手工看一眼，没有固定流程。");
    answer(session, "premise_consequence", "不做没有业务影响，也没有人会因此多花时间。");
    answer(session, "premise_minimum", "目前没有一个值得交付的最小版本。");
    answer(session, "premise_decision", "不继续");

    const coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.stopped, true);
    assert.equal(coverage.premise_judgment?.decision, "do_not_continue");
    assert.equal(session.next_question, null);
    assert.equal(coverage.ready_for_prd_intake, false);
  }));

  test("each layer confirmation gates the next layer and is invalidated by corrections", () => withSession((session) => {
    answer(session, "premise_current_solution", "现在用标题前缀分类，每天人工检查日期。");
    answer(session, "premise_consequence", "每周都会漏掉到期任务，团队需要临时追赶。");
    answer(session, "premise_minimum", "最小版本包含标签、筛选、到期时间和站内提醒。");
    answer(session, "premise_decision", "继续");

    session.initial_playback = {
      confirmed: true,
      confirmed_content_hash: "sha256:initial",
    };
    let next = selectDemandInterviewNextQuestion(session, inspectDemandInterviewCoverage(session));
    assert.equal(next?.id, "target_users");
    assert.equal(next?.stage, "layer_1");
    assert.match(next?.recommended_answer || "", /待办|团队/);

    answer(session, "target_users", "每天维护待办并负责按时交付的团队成员和项目负责人。");
    answer(session, "status_quo", "团队成员用标题前缀分类，负责人每天人工翻看日期。");
    answer(session, "pain_points", "标签写法不一致导致筛选困难，人工查看日期每周至少漏掉两次到期任务。");

    assert.equal(session.next_question?.id, "layer_1_confirmation");
    assert.equal(session.next_question?.confirmation_gate, true);
    assert.match(session.next_question?.plain_language_prompt || "", /角色|现状|痛点/);
    assert.notEqual(session.next_question?.id, "day_in_life");

    answer(session, "layer_1_confirmation", "确认，这一层理解无误。");
    assert.equal(session.next_question?.id, "day_in_life");
    assert.equal(session.next_question?.stage, "layer_2");

    answer(session, "pain_points", "更正：筛选困难，而且每周会漏掉三次到期任务。影响项目负责人和执行成员。");
    assert.equal(session.next_question?.id, "layer_1_confirmation");
    assert.equal(session.coverage?.layer_gates?.layer_1?.confirmed, false);
  }));

  test("keeps all four layers in protocol order and ends with an R-001 replay gate", () => withSession((session) => {
    const orderedStages = session.questions?.map((question) => [question.id, question.stage]);
    const ids = orderedStages?.map(([id]) => id) || [];
    assert.ok(ids.indexOf("layer_1_confirmation") < ids.indexOf("day_in_life"));
    assert.ok(ids.indexOf("layer_2_confirmation") < ids.indexOf("exceptions"));
    assert.ok(ids.indexOf("layer_3_confirmation") < ids.indexOf("success_criteria"));
    assert.ok(ids.indexOf("layer_4_confirmation") < ids.indexOf("requirements_confirmation"));

    const requirementGate = session.questions?.find((question) => question.id === "requirements_confirmation");
    assert.equal(requirementGate?.stage, "requirements_replay");
    assert.equal(requirementGate?.confirmation_gate, true);
    assert.match(requirementGate?.plain_language_prompt || "", /R-001/);
  }));
});
