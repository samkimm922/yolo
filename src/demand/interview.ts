import { isAbsolute, join, resolve } from "node:path";

export const DEMAND_INTERVIEW_SCHEMA_VERSION = "1.0";
export const DEMAND_INTERVIEW_SCHEMA = "yolo.demand.interview.v1";

export const DEMAND_INTERVIEW_QUESTION_BANK = [
  {
    id: "target_users",
    slot: "target_users",
    category: "用户/角色",
    plain_language_prompt: "谁会使用、受影响或负责这个需求？请用业务角色描述，不需要写技术身份。",
    why_it_matters: "明确角色后，后续目标、验收标准和任务拆分才不会服务错对象。",
    accepts: {
      free_text: true,
      examples: [
        "门店店长，每天查看库存并处理缺货问题。",
        "客服主管，需要看到高风险工单并安排跟进。",
      ],
    },
    required_for: ["discuss", "prd_intake"],
  },
  {
    id: "status_quo",
    slot: "status_quo",
    category: "当前现状",
    plain_language_prompt: "现在遇到这个场景时，大家是怎么做的？可以写人工流程、表格、临时办法或现有系统表现。",
    why_it_matters: "现状能帮助团队判断要替换、补强还是保留哪些流程。",
    accepts: {
      free_text: true,
      examples: [
        "店长每天导出库存表，靠人工筛选快缺货的 SKU。",
        "客服要在多个后台来回查，才能判断一个工单是不是高优先级。",
      ],
    },
    required_for: ["discuss", "prd_intake"],
  },
  {
    id: "pain_points",
    slot: "pain_points",
    category: "痛点",
    plain_language_prompt: "现在最麻烦、最容易出错或最耽误时间的地方是什么？请写真实困扰。",
    why_it_matters: "痛点决定需求优先级，也能避免把精力花在不痛的优化上。",
    accepts: {
      free_text: true,
      examples: [
        "发现缺货太晚，客户投诉后才补救。",
        "主管不知道哪些工单真的紧急，容易平均用力。",
      ],
    },
    required_for: ["discuss", "prd_intake"],
  },
  {
    id: "desired_outcome",
    slot: "desired_outcome",
    category: "目标结果",
    plain_language_prompt: "如果这个需求做好了，用户应该能完成什么，或者业务上应该变成什么样？",
    why_it_matters: "目标结果会被转成 PRD 里的核心需求和用户故事。",
    accepts: {
      free_text: true,
      examples: [
        "店长能在缺货前看到清晰提醒，并优先处理高风险商品。",
        "客服主管能先处理可能违约的工单。",
      ],
    },
    required_for: ["discuss", "prd_intake"],
  },
  {
    id: "success_criteria",
    slot: "success_criteria",
    category: "成功标准",
    plain_language_prompt: "做到什么程度才算成功？请写用户看得见或业务能确认的结果。",
    why_it_matters: "成功标准会变成验收条件，避免实现完成后无法判断是否达标。",
    accepts: {
      free_text: true,
      examples: [
        "库存低于阈值时，列表里能看到低库存标记。",
        "主管能按风险等级筛选工单。",
      ],
    },
    required_for: ["prd_intake"],
  },
  {
    id: "success_proof",
    slot: "success_proof",
    category: "成功证明",
    plain_language_prompt: "你会怎样证明它真的有用？可以是页面检查、数据指标、运营记录或人工验收方式。",
    why_it_matters: "证明方式会帮助后续任务写出可验证的完成条件。",
    accepts: {
      free_text: true,
      examples: [
        "验收时新建一个低库存商品，页面必须显示提醒。",
        "上线后每周查看因缺货导致的投诉是否下降。",
      ],
    },
    required_for: ["prd_intake"],
  },
  {
    id: "scope_boundaries",
    slot: "scope_boundaries",
    category: "范围边界",
    plain_language_prompt: "这次明确不做什么？有哪些流程、用户、渠道、数据或功能不要碰？",
    why_it_matters: "边界能保护项目不膨胀，也能降低误改现有业务的风险。",
    accepts: {
      free_text: true,
      examples: [
        "只做库存提醒，不做供应商自动下单。",
        "只覆盖门店后台，不改移动端。",
      ],
    },
    required_for: ["prd_intake"],
  },
  {
    id: "exceptions",
    slot: "exceptions",
    category: "异常/边界情况",
    plain_language_prompt: "哪些特殊情况如果没处理好，会让用户觉得这个功能不可靠？没有也可以直接写“没有特殊情况”。",
    why_it_matters: "边界情况会被转成场景矩阵和原子任务的异常说明。",
    accepts: {
      free_text: true,
      examples: [
        "新品没有历史销量时，不要误报高风险。",
        "数据同步失败时要显示上次更新时间。",
      ],
    },
    required_for: ["prd_intake"],
  },
  {
    id: "mvp_priority",
    slot: "mvp_priority",
    category: "MVP/优先级",
    plain_language_prompt: "第一版最小可用版本必须包含什么？哪些可以后做？",
    why_it_matters: "MVP 顺序会变成 roadmap，帮助后续 PRD 拆成更小的可执行任务。",
    accepts: {
      free_text: true,
      examples: [
        "MVP 先做阈值提醒和列表标记，后续再做趋势预测。",
        "第一版只支持主管视图，团队绩效统计后做。",
      ],
    },
    required_for: ["prd_intake"],
  },
  {
    id: "execution_approval",
    slot: "execution_approval",
    category: "执行批准",
    plain_language_prompt: "以上信息确认无误后，是否批准进入 PRD intake？请明确回答“批准”或“暂不批准”。",
    why_it_matters: "只有你明确批准后，系统才应该把讨论结果推进到可执行 PRD。",
    accepts: {
      free_text: true,
      boolean: true,
      examples: [
        "批准，按这个范围进入 PRD。",
        "暂不批准，还需要先确认客服团队的流程。",
      ],
    },
    required_for: ["prd_intake"],
  },
];

const DISCUSS_REQUIRED_SLOTS = ["target_users", "status_quo", "pain_points", "desired_outcome"];
const PRD_REQUIRED_SLOTS = [
  "target_users",
  "status_quo",
  "pain_points",
  "desired_outcome",
  "success_criteria",
  "success_proof",
  "scope_boundaries",
  "exceptions",
  "mvp_priority",
];

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textFromValue(value) {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join("\n");
  if (typeof value === "object") {
    return clean(value.text || value.answer || value.value || value.note || value.details || value.summary);
  }
  return clean(value);
}

function arrayOfStrings(value) {
  return asArray(value)
    .flatMap((item) => textFromValue(item).split(/\r?\n/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function splitList(value) {
  return [...new Set(
    arrayOfStrings(value)
      .flatMap((item) => item.split(/\s*(?:;|；|\||、)\s*/))
      .map(clean)
      .filter(Boolean),
  )];
}

function nowIso(options = {}) {
  return clean(options.now) || new Date().toISOString();
}

function slug(value, fallback = "DEMAND") {
  const text = clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return text || fallback;
}

function idDate(now) {
  return clean(now).slice(0, 10).replace(/-/g, "") || "00000000";
}

function makeId(prefix, input = {}, now) {
  return clean(input.id || input.interview_id || input.interviewId)
    || `${prefix}-${idDate(now)}-${slug(input.title || input.idea || input.objective || "PROJECT")}`;
}

function makeDemandId(input = {}, now) {
  return clean(input.demand_id || input.demandId)
    || `DEMAND-${idDate(now)}-${slug(input.title || input.idea || input.objective || "PROJECT")}`;
}

function resolveRoot(value, fallback = process.cwd()) {
  return resolve(clean(value) || fallback);
}

function stateRootFor(input = {}, options = {}) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const explicit = input.stateRoot || input.state_root || options.stateRoot || options.state_root;
  return explicit ? (isAbsolute(explicit) ? explicit : resolve(projectRoot, explicit)) : join(projectRoot, ".yolo");
}

function questionById(questionId, questions = DEMAND_INTERVIEW_QUESTION_BANK) {
  return questions.find((question) => question.id === questionId);
}

function questionBySlot(slot, questions = DEMAND_INTERVIEW_QUESTION_BANK) {
  return questions.find((question) => question.slot === slot);
}

function answerRecordForSlot(session = {}, slot) {
  const question = questionBySlot(slot, session.questions || DEMAND_INTERVIEW_QUESTION_BANK);
  return question ? session.answers?.[question.id] : null;
}

function parseApproval(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (value && typeof value === "object") {
    if (value.approved === true || value.approve === true) return true;
    if (value.approved === false || value.approve === false) return false;
  }
  const text = textFromValue(value).toLowerCase();
  if (!text) return false;
  if (/(暂不|不批准|不要|不能|否|no|false|not approved|do not|don't)/i.test(text)) return false;
  return /(批准|同意|确认|可以|进入\s*prd|approve|approved|yes|true|confirm|confirmed)/i.test(text);
}

function hasAnswer(record) {
  if (!record) return false;
  if (record.slot === "execution_approval") {
    return typeof record.answer === "boolean" || textFromValue(record.answer).length > 0;
  }
  if (Array.isArray(record.answer)) return splitList(record.answer).length > 0;
  if (record.answer && typeof record.answer === "object") return textFromValue(record.answer).length > 0 || Object.keys(record.answer).length > 0;
  return textFromValue(record.answer).length > 0;
}

function normalizeAnswer(question, answer) {
  if (question.slot === "execution_approval") {
    return {
      approved: parseApproval(answer),
      text: textFromValue(answer),
    };
  }
  return {
    text: textFromValue(answer),
    items: splitList(answer),
  };
}

function decorateQuestions(questions = DEMAND_INTERVIEW_QUESTION_BANK, answers = {}) {
  return questions.map((question) => ({
    ...question,
    answered: hasAnswer(answers[question.id]),
  }));
}

function missingSlots(session = {}, slots = []) {
  return slots.filter((slot) => !hasAnswer(answerRecordForSlot(session, slot)));
}

function approvalState(session = {}) {
  const record = answerRecordForSlot(session, "execution_approval");
  return {
    answered: hasAnswer(record),
    approved: record?.normalized?.approved === true || parseApproval(record?.answer),
    answer: record?.answer,
    answered_at: record?.answered_at || null,
  };
}

function nextQuestion(session = {}, coverage = inspectDemandInterviewCoverage(session)) {
  const questions = session.questions || DEMAND_INTERVIEW_QUESTION_BANK;
  const missing = new Set(coverage.missing.map((item) => item.question_id));
  return questions.find((question) => missing.has(question.id)) || null;
}

function ledgerInfo({ id, demandId, projectRoot, stateRoot }) {
  const interviewDir = join(stateRoot, "demand", "interviews", id);
  const demandDir = join(stateRoot, "demand", demandId);
  return {
    schema: "yolo.demand.interview.ledgers.v1",
    writes_during_interview: false,
    project_memory: {
      path: join(stateRoot, "memory", "project.jsonl"),
      purpose: "长期项目事实、业务术语、用户角色和稳定决策的候选记录。",
    },
    demand_memory: {
      path: join(demandDir, "session.json"),
      purpose: "批准后由 demand runtime 写入的需求会话事实。",
    },
    interview_answers: {
      path: join(interviewDir, "answers.jsonl"),
      purpose: "逐题回答的可审计流水；当前模块只返回路径信息，不写文件。",
    },
    prd_intake: {
      path: join(demandDir, "prd.json"),
      purpose: "需求齐全并获批后生成的可执行 PRD 目标位置。",
    },
    projectRoot,
    stateRoot,
  };
}

export function inspectDemandInterviewCoverage(session = {}) {
  const questions = session.questions || DEMAND_INTERVIEW_QUESTION_BANK;
  const answered = questions
    .map((question) => ({ question, record: session.answers?.[question.id] }))
    .filter((item) => hasAnswer(item.record))
    .map(({ question, record }) => ({
      question_id: question.id,
      slot: question.slot,
      category: question.category,
      answered_at: record.answered_at || null,
    }));

  const missingDiscuss = missingSlots(session, DISCUSS_REQUIRED_SLOTS);
  const missingPrd = missingSlots(session, PRD_REQUIRED_SLOTS);
  const approval = approvalState(session);
  const missingSlotsForQuestioning = [...new Set([
    ...missingDiscuss,
    ...missingPrd,
    ...(approval.approved ? [] : ["execution_approval"]),
  ])];
  const missing = missingSlotsForQuestioning.map((slot) => {
    const question = questionBySlot(slot, questions);
    return {
      question_id: question?.id || slot,
      slot,
      category: question?.category || slot,
      plain_language_prompt: question?.plain_language_prompt || "",
      required_for: question?.required_for || ["prd_intake"],
    };
  });
  const readyForDiscuss = missingDiscuss.length === 0;
  const readyForPrdIntake = missingPrd.length === 0 && approval.approved === true;
  const blockers = [
    ...missingPrd.map((slot) => ({
      code: `MISSING_${slot.toUpperCase()}`,
      slot,
      message: `${questionBySlot(slot, questions)?.category || slot} is required before PRD intake.`,
    })),
    ...(approval.approved ? [] : [{
      code: "APPROVAL_REQUIRED",
      slot: "execution_approval",
      message: "Explicit user approval is required before PRD intake.",
    }]),
  ];
  const totalRequired = PRD_REQUIRED_SLOTS.length + 1;
  const answeredRequired = PRD_REQUIRED_SLOTS.filter((slot) => !missingPrd.includes(slot)).length + (approval.approved ? 1 : 0);

  return {
    schema_version: DEMAND_INTERVIEW_SCHEMA_VERSION,
    schema: "yolo.demand.interview.coverage.v1",
    answered,
    answered_slots: answered.map((item) => item.slot),
    missing,
    missing_slots: missing.map((item) => item.slot),
    approval,
    ready_for_discuss: readyForDiscuss,
    ready_for_prd_intake: readyForPrdIntake,
    readiness: {
      status: readyForPrdIntake ? "ready" : readyForDiscuss ? "discuss_ready" : "collecting",
      ready_for_discuss: readyForDiscuss,
      ready_for_prd_intake: readyForPrdIntake,
      quality_score: Math.round((answeredRequired / totalRequired) * 100),
      blockers,
      next_actions: readyForPrdIntake
        ? ["Convert interview answers to demand input and run demand discuss/PRD intake."]
        : missing.map((item) => item.plain_language_prompt).filter(Boolean),
    },
  };
}

function refreshSession(session) {
  session.questions = decorateQuestions(session.questions || DEMAND_INTERVIEW_QUESTION_BANK, session.answers || {});
  session.coverage = inspectDemandInterviewCoverage(session);
  session.readiness = session.coverage.readiness;
  session.next_question = nextQuestion(session, session.coverage);
  return session;
}

export function createDemandInterviewSession(input = {}, options = {}) {
  const now = nowIso(options);
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const objective = clean(input.objective || input.idea || input.title);
  const id = makeId("DINT", input, now);
  const demandId = makeDemandId(input, now);
  const session = {
    schema_version: DEMAND_INTERVIEW_SCHEMA_VERSION,
    schema: DEMAND_INTERVIEW_SCHEMA,
    id,
    demand_id: demandId,
    generated_at: now,
    updated_at: now,
    source: clean(input.source || options.source || "yolo-demand-interview"),
    title: clean(input.title || objective || "Demand interview"),
    objective,
    projectRoot,
    project_root: projectRoot,
    stateRoot,
    state_root: stateRoot,
    questions: decorateQuestions(DEMAND_INTERVIEW_QUESTION_BANK, {}),
    answers: {},
    ledgers: ledgerInfo({ id, demandId, projectRoot, stateRoot }),
  };
  return refreshSession(session);
}

export function answerDemandInterviewQuestion(session, { questionId, answer, now } = {}) {
  const question = questionById(questionId, session?.questions || DEMAND_INTERVIEW_QUESTION_BANK);
  if (!question) {
    throw new Error(`Unknown demand interview question: ${questionId}`);
  }
  const answeredAt = clean(now) || new Date().toISOString();
  session.answers = {
    ...(session.answers || {}),
    [question.id]: {
      question_id: question.id,
      slot: question.slot,
      category: question.category,
      answer,
      normalized: normalizeAnswer(question, answer),
      answered_at: answeredAt,
    },
  };
  session.updated_at = answeredAt;
  return refreshSession(session);
}

function itemsForSlot(session, slot) {
  const record = answerRecordForSlot(session, slot);
  if (!record) return [];
  return record.normalized?.items?.length ? record.normalized.items : splitList(record.answer);
}

function textForSlot(session, slot) {
  const record = answerRecordForSlot(session, slot);
  return record?.normalized?.text || textFromValue(record?.answer);
}

function answeredQuestionRounds(session = {}) {
  const answers = session.answers || {};
  return (session.questions || DEMAND_INTERVIEW_QUESTION_BANK)
    .filter((question) => hasAnswer(answers[question.id]))
    .map((question) => ({
      id: question.id,
      category: question.category,
      question: question.plain_language_prompt,
      answer: textFromValue(answers[question.id].answer),
      slot: question.slot,
    }));
}

function decisionLines(session = {}) {
  const lines = [];
  const categories = [
    ["target_users", "用户/角色"],
    ["desired_outcome", "目标结果"],
    ["success_criteria", "成功标准"],
    ["scope_boundaries", "范围边界"],
    ["mvp_priority", "MVP/优先级"],
  ];
  for (const [slot, label] of categories) {
    const text = textForSlot(session, slot);
    if (text) lines.push(`${label}: ${text}`);
  }
  const approval = approvalState(session);
  if (approval.answered) lines.push(`执行批准: ${approval.approved ? "批准" : "暂不批准"}`);
  return lines;
}

export function demandInterviewToDemandInput(session = {}) {
  const coverage = inspectDemandInterviewCoverage(session);
  const targetUsers = itemsForSlot(session, "target_users");
  const statusQuo = itemsForSlot(session, "status_quo");
  const painPoints = itemsForSlot(session, "pain_points");
  const desiredOutcomes = itemsForSlot(session, "desired_outcome");
  const successCriteria = itemsForSlot(session, "success_criteria");
  const successProof = itemsForSlot(session, "success_proof");
  const scopeBoundaries = itemsForSlot(session, "scope_boundaries");
  const exceptions = itemsForSlot(session, "exceptions");
  const roadmap = itemsForSlot(session, "mvp_priority");
  const approval = approvalState(session);
  const objective = clean(session.objective || session.title || desiredOutcomes[0] || painPoints[0]);

  return {
    demand_id: clean(session.demand_id) || makeDemandId({ title: session.title || objective }, session.generated_at),
    title: clean(session.title || objective || "Demand interview"),
    objective,
    idea: objective,
    projectRoot: session.projectRoot || session.project_root,
    project_root: session.projectRoot || session.project_root,
    stateRoot: session.stateRoot || session.state_root,
    state_root: session.stateRoot || session.state_root,
    phase: "discuss",
    source: "yolo-demand-interview",
    mode: "interview",
    target_users: targetUsers,
    status_quo: statusQuo,
    problem: painPoints.join("; ") || objective,
    success_criteria: [...new Set([...desiredOutcomes, ...successCriteria])],
    proof: successProof.length ? successProof : successCriteria,
    non_goals: scopeBoundaries,
    constraints: scopeBoundaries,
    exceptions,
    roadmap,
    decisions: decisionLines(session),
    questions: answeredQuestionRounds(session),
    answers: answeredQuestionRounds(session).map((round) => round.answer),
    approve: approval.approved === true,
    approved_by: "user",
    approved_at: approval.approved ? approval.answered_at : null,
    approval_note: textFromValue(approval.answer),
    assumptions: [
      "Interview answers are user-provided and should be validated against product or operational evidence before implementation.",
    ],
    open_questions: coverage.ready_for_prd_intake
      ? []
      : coverage.missing.map((item) => item.plain_language_prompt).filter(Boolean),
    interview: {
      id: session.id,
      schema: session.schema,
      schema_version: session.schema_version,
      coverage: {
        ready_for_discuss: coverage.ready_for_discuss,
        ready_for_prd_intake: coverage.ready_for_prd_intake,
        missing_slots: coverage.missing_slots,
        answered_slots: coverage.answered_slots,
      },
    },
    ledgers: session.ledgers,
  };
}
