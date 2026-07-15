import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function newUiSession(root) {
  return createDemandInterviewSession({
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    idea: "Build a user-visible inventory dashboard page for store managers.",
    ui: true,
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

function openLayerOne(session) {
  answer(session, "premise_consequence", "Without a change, stores miss at least two stockout risks each week and managers spend an hour on recovery.");
  answer(session, "premise_minimum", "The minimum useful version must show a low-stock signal in the existing inventory workflow.");
  answer(session, "premise_decision", "继续");
  return session;
}

function answerAllRequired(session) {
  openLayerOne(session);
  answer(session, "target_users", "Store managers who review inventory every morning.");
  answer(session, "status_quo", "They export inventory counts and manually scan for risky SKUs.");
  answer(session, "pain_points", "Stockouts are discovered after customers complain.");
  answer(session, "day_in_life", "Every morning a store manager opens the inventory list, reviews low-stock items, and decides what to replenish before customers arrive.");
  answer(session, "desired_outcome", "Managers see low-stock risks before the item sells out.");
  answer(session, "exceptions", "New SKUs without sales history should not be marked high risk by default.");
  answer(session, "scope_boundaries", "Do not build supplier ordering; do not change order import.");
  answer(session, "success_criteria", "Low-stock SKUs show a clear badge in the inventory list.");
  answer(session, "requirements_confirmation", "确认，R-001 清单准确且没有遗漏。");
  return session;
}

describe("demand interview", () => {
  test("requires a concrete UI acceptance declaration for user-visible UI demand", () => withRoot((root) => {
    const session = newUiSession(root);
    const question = session.questions.find((item) => item.id === "ui_acceptance");

    assert.ok(question);
    assert.match(question.plain_language_prompt, /UI|界面/);
    assert.match(question.plain_language_prompt, /入口/);
    assert.doesNotMatch(question.plain_language_prompt, /manifest|JSON|命令/);
    assert.equal(session.coverage.missing_slots.includes("ui_acceptance"), true);
  }));

  test("accepts an existing adapter without an optional description", () => withRoot((root) => {
    const adapterDir = join(root, ".yolo", "adapters");
    mkdirSync(adapterDir, { recursive: true });
    writeFileSync(join(adapterDir, "browser.manifest.json"), JSON.stringify({
      schema: "yolo.manifest.v1", id: "browser", kind: "acceptance_adapter",
      inputs: ["url"], outputs: ["report"], commands: [{ command: "project-ui-smoke" }],
      evidence: ["screenshot"], capabilities: ["ui"], applies_to: ["ui"],
    }));

    const session = newUiSession(root);

    assert.equal(session.questions.some((item) => item.id === "ui_acceptance"), false);
    assert.equal(session.coverage.missing_slots.includes("ui_acceptance"), false);
  }));

  test("initializes a non-technical interview session from idea", () => withRoot((root) => {
    const session = newSession(root);

    assert.equal(DEMAND_INTERVIEW_SCHEMA_VERSION, "2.0");
    assert.equal(session.schema, DEMAND_INTERVIEW_SCHEMA);
    assert.equal(session.id.startsWith("DINT-20260529-"), true);
    assert.equal(session.demand_id.startsWith("DEMAND-20260529-"), true);
    assert.equal(session.projectRoot, root);
    assert.equal(session.stateRoot, join(root, ".yolo"));
    assert.equal(session.objective, "Build inventory stockout prevention for store managers.");
    assert.deepEqual(session.answers, {});
    assert.equal(session.next_question.id, "premise_consequence");
    assert.equal(session.next_question.stage, "premise");
    assert.equal(session.coverage.ready_for_discuss, false);
    assert.equal(session.coverage.ready_for_prd_intake, false);
    assert.equal("follow_up_counts" in session, false);
    assert.equal("follow_up_questions" in session, false);
    assert.equal("follow_up_plan" in session, false);
    assert.equal("accepted_assumptions" in session, false);
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
    assert.equal(DEMAND_INTERVIEW_QUESTION_BANK.some((question) => question.id === "premise_current_solution"), false);
    assert.equal(DEMAND_INTERVIEW_QUESTION_BANK.some((question) => question.id === "success_proof"), false);
  }));

  test("answers questions in order and advances coverage", () => withRoot((root) => {
    const session = openLayerOne(newSession(root));

    answer(session, "target_users", "Store managers who review inventory every morning and decide which SKU to replenish first.");
    assert.equal(session.answers.target_users.normalized.items[0], "Store managers who review inventory every morning and decide which SKU to replenish first.");
    assert.equal(session.questions.find((question) => question.id === "target_users").answered, true);
    assert.equal(session.next_question.id, "status_quo");

    answer(session, "status_quo", "They export inventory counts each morning and manually scan rows for risky SKUs.");
    answer(session, "pain_points", "Stockouts are discovered after customers complain, which causes rush replenishment work.");
    assert.equal(session.next_question.id, "day_in_life");
    answer(session, "day_in_life", "Every morning the store manager opens inventory, checks risky SKUs, and schedules replenishment before the store opens.");
    answer(session, "desired_outcome", "Store managers can see low-stock risks before the item sells out and prioritize replenishment.");
    assert.equal(session.next_question.id, "exceptions");

    const coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.ready_for_discuss, true);
    assert.equal(coverage.ready_for_prd_intake, false);
    assert.ok(coverage.answered_slots.includes("desired_outcome"));
    assert.ok(coverage.missing_slots.includes("exceptions"));
    assert.equal(session.next_question.id, "exceptions");
  }));

  test("accepts prose answers without regex quality metadata", () => withRoot((root) => {
    const session = openLayerOne(newSession(root));

    answer(session, "target_users", "用户");

    assert.equal(session.next_question.id, "status_quo");
    assert.equal("follow_up" in session.next_question, false);
    assert.equal("quality" in session.answers.target_users, false);
    assert.equal("answer_quality" in session.answers.target_users, false);
    assert.equal("follow_up_questions" in session.coverage, false);
    assert.equal("quality" in session.coverage, false);
  }));

  test("does not count command-like feature lines as target user roles", () => withRoot((root) => {
    const session = openLayerOne(newSession(root));

    answer(session, "target_users", "taskcli add creates a new task in src/tasks.ts");

    assert.equal(session.answers.target_users.normalized.items.length, 0);
    assert.equal(session.next_question.id, "target_users");
    assert.equal(session.coverage.missing_slots.includes("target_users"), true);
    assert.equal(session.coverage.ready_for_prd_intake, false);

    const input = demandInterviewToDemandInput(session);
    assert.deepEqual(input.target_users, []);
  }));

  test("keeps hyphenated product or fixture names inside valid role answers", () => withRoot((root) => {
    const session = openLayerOne(newSession(root));

    answer(session, "target_users", "Release managers and fixture maintainers check Node.js basic daily before publishing and are responsible for confirming smoke results.");

    assert.equal(session.answers.target_users.normalized.items.length, 1);
    assert.equal(session.next_question.id, "status_quo");
    assert.equal(session.coverage.missing_slots.includes("target_users"), false);
  }));

  test("stores concrete criteria without vocabulary scoring metadata", () => withRoot((root) => {
    const dogfoodCriteria = [
      "成功标准：CLI 必须输出 Markdown；包含总 commit 数、总新增/删除行数、按作者分组的 commit 列表，以及 feat/fix/chore/docs/refactor/test 六类计数；--output 必须写文件；错误输入必须非零退出。",
      "用户看得到的 Markdown 至少包含标题 Git Weekly Report、Summary 区块、Type Statistics 表、Commits by Author 区块；fixture 中 Alice/Bob 的提交主题和精确计数必须可断言。",
      "完成定义：测试 fixture 有 6 个指定提交时，stdout 必须精确包含 Total commits: 6、Lines added: 10、Lines deleted: 2、feat: 1、fix: 1、chore: 1、docs: 1、refactor: 1、test: 1，以及 Alice 和 Bob 分组标题。",
    ];

    for (const criterion of dogfoodCriteria) {
      const session = newSession(root);
      answer(session, "success_criteria", criterion);

      assert.equal("quality" in session.answers.success_criteria, false);
      assert.equal("answer_quality" in session.answers.success_criteria, false);
    }
  }));

  test("does not score or count repeated vague answers", () => withRoot((root) => {
    for (const vagueAnswer of ["做好一点", "让用户满意就行", "尽快完成"]) {
      const session = newSession(root);

      answer(session, "success_criteria", vagueAnswer);
      answer(session, "success_criteria", vagueAnswer);
      answer(session, "success_criteria", vagueAnswer);

      assert.equal(session.answers.success_criteria.answer, vagueAnswer);
      assert.equal("quality" in session.answers.success_criteria, false);
      assert.equal("follow_up_counts" in session, false);
      assert.equal("follow_up_questions" in session, false);
      assert.equal("accepted_assumptions" in session, false);
    }
  }));

  test("empty answers remain missing without the regex quality engine", () => withRoot((root) => {
    const session = newSession(root);

    answer(session, "success_criteria", "");

    const coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.answered_slots.includes("success_criteria"), false);
    assert.equal(coverage.missing_slots.includes("success_criteria"), true);
    assert.equal(coverage.ready_for_prd_intake, false);
  }));

  test("user confirmation gates, not regex scoring, decide whether vague wording can proceed", () => withRoot((root) => {
    const session = answerAllRequired(newSession(root));
    answer(session, "success_criteria", "做好一点");
    answer(session, "requirements_confirmation", "确认，R-001 清单准确且没有遗漏。");
    answer(session, "execution_approval", "批准，按这个范围进入 PRD。");

    const coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.ready_for_prd_intake, true);
    assert.equal(coverage.readiness.status, "ready");
    assert.equal("answer_quality_score" in coverage.readiness, false);
    assert.equal("follow_up_plan" in coverage, false);

    const input = demandInterviewToDemandInput(session);
    assert.deepEqual(input.open_questions, []);
    assert.equal("followups" in input, false);
    assert.equal("quality" in input.interview.coverage, false);

    const demandSession = buildDemandSession(input, { now: "2026-05-29T13:00:00.000Z" });
    assert.equal(demandSession.interview.coverage.ready_for_prd_intake, true);
  }));

  test("does not attach quality scoring to detailed MVP tradeoffs", () => withRoot((root) => {
    const session = newSession(root);

    answer(session, "premise_minimum", "MVP includes threshold comparison, visible low-stock label, and filter; supplier automation is explicitly deferred out of version one.");

    assert.equal("quality" in session.answers.premise_minimum, false);
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

  test("treats explicit execution approval negation as rejection before matching approval words", () => withRoot((root) => {
    const rejectedAnswers = [
      "我没有批准",
      "还未同意，请先等一下",
      "I cant approve yet",
      "I can't approve yet",
      "I haven't approved this",
      "disapproved",
    ];

    for (const rejectedAnswer of rejectedAnswers) {
      const session = answerAllRequired(newSession(root));
      answer(session, "execution_approval", rejectedAnswer);

      const coverage = inspectDemandInterviewCoverage(session);
      assert.equal(coverage.approval.answered, true, rejectedAnswer);
      assert.equal(coverage.approval.approved, false, rejectedAnswer);
      assert.equal(coverage.ready_for_prd_intake, false, rejectedAnswer);
      assert.ok(coverage.missing_slots.includes("execution_approval"), rejectedAnswer);
    }
  }));

  test("accepts explicit approval phrases without treating incidental no as rejection", () => withRoot((root) => {
    const session = answerAllRequired(newSession(root));
    answer(session, "execution_approval", "Approved with no changes needed.");

    const coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.approval.approved, true);
    assert.equal(coverage.ready_for_prd_intake, true);
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
    assert.deepEqual(input.proof, ["Low-stock SKUs show a clear badge in the inventory list."]);
    assert.deepEqual(input.non_goals, ["Do not build supplier ordering", "do not change order import."]);
    assert.deepEqual(input.exceptions, ["New SKUs without sales history should not be marked high risk by default."]);
    assert.deepEqual(input.roadmap, ["The minimum useful version must show a low-stock signal in the existing inventory workflow."]);
    assert.equal(input.approve, true);
    assert.equal(input.questions.length, session.questions.length);
    assert.equal(input.open_questions.length, 0);
    assert.equal("followups" in input, false);
    assert.equal("follow_up_plan" in input.interview.coverage, false);

    const demandSession = buildDemandSession(input, { now: "2026-05-29T13:00:00.000Z" });
    assert.equal(demandSession.id, session.demand_id);
    assert.deepEqual(demandSession.project.target_users, input.target_users);
    assert.equal(demandSession.approval.approved, true);
    assert.equal(demandSession.discussion.rounds.length, session.questions.length);
    assert.equal("follow_up_plan" in demandSession.interview.coverage, false);
  }));

  test("keeps Chinese enumeration phrases as one demand item", () => withRoot((root) => {
    const session = newSession(root);
    const criterion = "看板包含 Todo、Doing、Done 三列，卡片可在列之间移动。";

    answer(session, "success_criteria", criterion);

    assert.deepEqual(session.answers.success_criteria.normalized.items, [criterion]);

    const input = demandInterviewToDemandInput(session);
    assert.deepEqual(input.success_criteria, [criterion]);
    assert.deepEqual(input.proof, [criterion]);

    const demandSession = buildDemandSession({
      objective: "让产品负责人使用中文看板管理任务状态。",
      target_users: "产品负责人",
      status_quo: "现在靠表格维护任务状态。",
      success_criteria: criterion,
      proof: "新增列表、新增卡片、编辑、移动、归档、刷新持久化",
    }, { now: "2026-05-29T13:00:00.000Z" });

    assert.equal(demandSession.requirements.active.length, 1);
    assert.equal(demandSession.requirements.active[0].text, criterion);
    assert.deepEqual(demandSession.prd_intake.success_proof, ["新增列表、新增卡片、编辑、移动、归档、刷新持久化"]);
  }));

  test("omits regex quality and follow-up metadata during PRD conversion", () => withRoot((root) => {
    const session = answerAllRequired(newSession(root));
    answer(session, "execution_approval", true);

    const coverage = inspectDemandInterviewCoverage(session);
    assert.equal(coverage.ready_for_prd_intake, true);
    assert.equal("quality" in coverage, false);
    assert.equal("answer_quality" in coverage, false);
    assert.equal("follow_up_questions" in coverage, false);

    const input = demandInterviewToDemandInput(session);
    assert.equal("quality" in input.interview.coverage, false);
    assert.equal("follow_up_questions" in input.interview.coverage, false);
    assert.equal("followups" in input, false);

    const demandSession = buildDemandSession(input, { now: "2026-05-29T13:00:00.000Z" });
    assert.equal("quality" in demandSession.interview.coverage, false);
    assert.equal("follow_up_questions" in demandSession.interview.coverage, false);
  }));
});
