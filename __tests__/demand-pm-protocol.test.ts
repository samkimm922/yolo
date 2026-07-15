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
import { PM_PROTOCOL_STAGES, renderPMProtocolMarkdown } from "../src/workflows/pm-protocol.js";

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

function answerAllLayerContent(session: ReturnType<typeof createDemandInterviewSession>) {
  answer(session, "premise_consequence", "不做会继续漏掉本周到期的任务，负责人至少每周补救两次。");
  answer(session, "premise_minimum", "最小版本也要能创建标签、按标签筛选、设置到期时间并在到期前提醒。");
  answer(session, "premise_decision", "继续");
  answer(session, "target_users", "每天维护待办并负责按时交付的团队成员，以及每天查看延期风险的项目负责人。");
  answer(session, "status_quo", "团队成员用标题前缀分类，负责人每天下班前人工翻看所有任务日期。");
  answer(session, "pain_points", "标签写法不一致导致筛选困难，人工查看日期每周至少漏掉两次到期任务。");
  answer(session, "day_in_life", "每天早上成员创建标签并整理待办，工作中按标签筛选，下午更新到期时间，负责人下班前查看到期提醒。");
  answer(session, "desired_outcome", "成员能按标签找到任务并更新到期时间，负责人能在到期前看到包含任务名称的提醒。");
  answer(session, "exceptions", "没有到期时间的待办不提醒，已完成待办取消提醒，重复修改日期只保留最新提醒。");
  answer(session, "scope_boundaries", "保留现有待办创建和完成流程；本次不做邮件、短信和移动推送。");
  answer(session, "success_criteria", "验收时创建一个标签并绑定到明天到期的待办；按该标签筛选后列表只显示这一个待办，负责人在到期前能看到任务名称和日期。");
}

describe("PM protocol interview stages", () => {
  test("starts with a lightweight premise challenge before the four business layers", () => withSession((session) => {
    assert.equal(session.next_question?.id, "premise_consequence");
    assert.deepEqual(
      session.questions?.slice(0, 3).map((question) => question.id),
      ["premise_consequence", "premise_minimum", "premise_decision"],
    );
    assert.equal(session.next_question?.stage, "premise");

    answer(session, "premise_consequence", "不做会继续漏掉本周到期的任务，负责人至少每周补救两次。");
    answer(session, "premise_minimum", "最小版本也要能创建标签、按标签筛选、设置到期时间并在到期前提醒。");

    assert.equal(session.next_question?.id, "premise_decision");
    assert.equal(session.next_question?.confirmation_gate, true);
    assert.equal(session.next_question?.recommended_answer, "继续");
    assert.match(session.next_question?.plain_language_prompt || "", /继续|不继续/);

    answer(session, "premise_decision", "差不多");
    assert.equal(session.next_question?.id, "premise_decision");
    assert.equal(inspectDemandInterviewCoverage(session).ready_for_prd_intake, false);

    answer(session, "premise_decision", "继续");
    const coverage = inspectDemandInterviewCoverage(session);
    assert.equal("awaiting_initial_playback" in coverage, false);
    assert.equal("initial_playback" in session, false);
    assert.equal(session.next_question?.id, "target_users");
    assert.equal(session.next_question?.stage, "layer_1");
  }));

  test("a do-not-continue premise judgment stops instead of leaking into layer one", () => withSession((session) => {
    answer(session, "premise_consequence", "不做没有业务影响，也没有人会因此多花时间。");
    answer(session, "premise_minimum", "目前没有一个值得交付的最小版本。");
    answer(session, "premise_decision", "不继续");

    const coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.stopped, true);
    assert.equal(coverage.premise_judgment?.decision, "do_not_continue");
    assert.equal(session.next_question, null);
    assert.equal(coverage.ready_for_prd_intake, false);
  }));

  test("collects all four layers continuously without intermediate confirmation gates", () => withSession((session) => {
    answer(session, "premise_consequence", "每周都会漏掉到期任务，团队需要临时追赶。");
    answer(session, "premise_minimum", "最小版本包含标签、筛选、到期时间和站内提醒。");
    answer(session, "premise_decision", "继续");

    let next = selectDemandInterviewNextQuestion(session, inspectDemandInterviewCoverage(session));
    assert.equal(next?.id, "target_users");
    assert.equal(next?.stage, "layer_1");
    assert.match(next?.recommended_answer || "", /待办|团队/);

    answer(session, "target_users", "每天维护待办并负责按时交付的团队成员和项目负责人。");
    answer(session, "status_quo", "团队成员用标题前缀分类，负责人每天人工翻看日期。");
    answer(session, "pain_points", "标签写法不一致导致筛选困难，人工查看日期每周至少漏掉两次到期任务。");

    assert.equal(session.next_question?.id, "day_in_life");
    assert.equal(session.next_question?.stage, "layer_2");
  }));

  test("removes the five intermediate gates while retaining premise, requirements, and approval", () => withSession((session) => {
    const removedGateIds = [
      "initial_playback",
      "layer_1_confirmation",
      "layer_2_confirmation",
      "layer_3_confirmation",
      "layer_4_confirmation",
    ];
    const questionIds = session.questions?.map((question) => question.id) || [];
    const protocolQuestionIds: string[] = PM_PROTOCOL_STAGES.flatMap((stage) => [...stage.question_ids]);

    for (const gateId of removedGateIds) {
      assert.equal(questionIds.includes(gateId), false, gateId);
      assert.equal(protocolQuestionIds.includes(gateId), false, gateId);
    }

    const premiseGate = session.questions?.find((question) => question.id === "premise_decision");
    assert.equal(premiseGate?.confirmation_gate, true);

    const requirementGate = session.questions?.find((question) => question.id === "requirements_confirmation");
    assert.equal(requirementGate?.stage, "requirements_replay");
    assert.equal(requirementGate?.confirmation_gate, true);
    assert.match(requirementGate?.plain_language_prompt || "", /R-001/);

    const approvalGate = session.questions?.find((question) => question.id === "execution_approval");
    assert.equal(approvalGate?.confirmation_gate, true);
  }));

  test("requires every content slot plus the final checklist and execution approval", () => withSession((session) => {
    answerAllLayerContent(session);

    let coverage = inspectDemandInterviewCoverage(session);
    assert.equal(session.next_question?.id, "requirements_confirmation");
    assert.equal(coverage.ready_for_prd_intake, false);
    assert.ok(coverage.missing_slots.includes("requirements_confirmation"));
    assert.equal(Object.keys(coverage.layer_gates || {}).some((stage) => /^layer_[1-4]$/.test(stage)), false);

    answer(session, "requirements_confirmation", "不确认，还有遗漏。");
    coverage = inspectDemandInterviewCoverage(session);
    assert.equal(session.next_question?.id, "requirements_confirmation");
    assert.equal(coverage.ready_for_prd_intake, false);

    answer(session, "requirements_confirmation", "确认，R-001 清单准确且没有遗漏。");
    coverage = inspectDemandInterviewCoverage(session);
    assert.equal(session.next_question?.id, "execution_approval");
    assert.equal(coverage.ready_for_prd_intake, false);

    answer(session, "execution_approval", "批准，按确认后的需求清单进入 PRD。");
    coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.ready_for_prd_intake, true);
    assert.deepEqual(coverage.missing_slots, []);
  }));

  test("keeps every non-gate content slot required for PRD intake", () => withSession((session) => {
    answerAllLayerContent(session);
    answer(session, "requirements_confirmation", "确认，R-001 清单准确且没有遗漏。");
    answer(session, "execution_approval", "批准，按确认后的需求清单进入 PRD。");
    assert.equal(session.coverage?.ready_for_prd_intake, true);

    const contentSlots = [
      "premise_consequence",
      "mvp_priority",
      "target_users",
      "status_quo",
      "pain_points",
      "day_in_life",
      "desired_outcome",
      "exceptions",
      "scope_boundaries",
      "success_criteria",
    ];
    for (const slot of contentSlots) {
      const copy = structuredClone(session);
      const question = copy.questions?.find((item) => item.slot === slot);
      assert.ok(question?.id, slot);
      delete copy.answers?.[question.id];

      const coverage = inspectDemandInterviewCoverage(copy);
      assert.equal(coverage.ready_for_prd_intake, false, slot);
      assert.ok(coverage.missing_slots.includes(slot), slot);
    }
  }));

  test("an early correction invalidates only final decisions, not unchanged layer gates", () => withSession((session) => {
    answerAllLayerContent(session);
    answer(session, "requirements_confirmation", "确认，R-001 清单准确且没有遗漏。");
    answer(session, "execution_approval", "批准，按确认后的需求清单进入 PRD。");
    assert.equal(session.coverage?.ready_for_prd_intake, true);

    answer(session, "pain_points", "更正：筛选困难，而且每周会漏掉三次到期任务，影响项目负责人和执行成员。");

    const coverage = inspectDemandInterviewCoverage(session);
    assert.equal(session.next_question?.id, "requirements_confirmation");
    assert.equal(coverage.ready_for_prd_intake, false);
    assert.ok(coverage.missing_slots.includes("requirements_confirmation"));
    assert.ok(coverage.missing_slots.includes("execution_approval"));
    for (const gateId of ["layer_1_confirmation", "layer_2_confirmation", "layer_3_confirmation", "layer_4_confirmation"]) {
      assert.equal(coverage.missing_slots.includes(gateId), false, gateId);
    }

    answer(session, "requirements_confirmation", "确认，更新后的 R-001 清单准确且没有遗漏。");
    answer(session, "execution_approval", "批准，按更新后的需求清单进入 PRD。");
    assert.equal(session.coverage?.ready_for_prd_intake, true);
  }));

  test("removes redundant required fields from protocol stages", () => {
    const questionIds: string[] = PM_PROTOCOL_STAGES.flatMap((stage) => [...stage.question_ids]);
    assert.equal(questionIds.includes("premise_current_solution"), false);
    assert.equal(questionIds.includes("success_proof"), false);
  });

  test("keeps iron law four intact while removing duplicate protocol wording", () => {
    const markdown = renderPMProtocolMarkdown({
      id: "demand",
      name: "Demand",
      workflow: "demand",
      purpose: "test",
    });

    assert.match(markdown, /## 铁律四：具体化强制/);
    for (const trigger of ["都行", "越快越好", "差不多就行", "跟某某系统差不多", "用户体验要好", "性能要快", "稳定"]) {
      assert.match(markdown, new RegExp(trigger));
    }
    assert.match(markdown, /给我一个上周真实发生的例子/);
    assert.doesNotMatch(markdown, /4\. \*\*浅尝辄止/);
    assert.doesNotMatch(markdown, /7\. \*\*技术泄露/);
    assert.doesNotMatch(markdown, /2\. \*\*【铁律二】复述确认/);
    assert.doesNotMatch(markdown, /确认用户说「对」或给出纠正之后，才能进入下一阶段/);
    assert.doesNotMatch(markdown, /每层结束打印小结让用户逐项确认/);
    assert.doesNotMatch(markdown, /第[一二三四]层确认门/);
    assert.match(markdown, /需求清单回放/);
    assert.match(markdown, /用户不逐条勾认，不进入下一步/);
    assert.doesNotMatch(markdown, /质检正则/);
  });
});
