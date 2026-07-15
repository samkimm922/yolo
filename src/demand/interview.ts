import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import type {
  DemandRecord,
  DemandRuntimeInput,
  DemandRuntimeOptions,
  DemandStringListInput,
  DemandTextInput,
} from "./graph.js";
import { resolveProjectContext } from "../packs/resolver.js";
import { validatePackManifest } from "../packs/manifest.js";
import { UI_ACCEPTANCE_SLOT } from "./ui-acceptance.js";
import {
  PM_PROTOCOL_LAYER_QUESTION_IDS,
  PM_PROTOCOL_SCHEMA,
  PM_PROTOCOL_STAGES,
  type PMProtocolStageId,
} from "../workflows/pm-protocol.js";

export const DEMAND_INTERVIEW_SCHEMA_VERSION = "2.0";
export const DEMAND_INTERVIEW_SCHEMA = "yolo.demand.interview.v2";

export interface DemandInterviewQuestion extends DemandRecord {
  id?: string;
  question_id?: string;
  slot?: string;
  category?: string;
  plain_language_prompt?: string;
  why_it_matters?: string;
  text?: string;
  accepts?: DemandRecord & {
    free_text?: boolean;
    boolean?: boolean;
    examples?: string[];
  };
  required_for?: string[];
  follow_up?: boolean;
  follow_up_id?: string;
  follow_up_code?: string;
  follow_up_reason?: string;
  follow_up_severity?: string;
  original_prompt?: string;
  stage?: PMProtocolStageId | string;
  layer?: number;
  confirmation_gate?: boolean;
  gate_for?: string;
  recommended_answer?: string;
  recommendation_reason?: string;
  protocol_schema?: string;
}

export interface DemandInterviewFollowUpQuestion extends DemandRecord {
  id?: string;
  question_id: string;
  slot: string;
  category: string;
  severity?: string;
  code?: string;
  reason?: string;
  plain_language_prompt: string;
  text?: string;
  message?: string;
}

export interface DemandInterviewFollowUpCounter extends DemandRecord {
  slot: string;
  count: number;
  reasons: string[];
  updated_at?: string | null;
}

export interface DemandInterviewAcceptedAssumption extends DemandRecord {
  slot: string;
  question_id: string;
  answer: string;
  reasons: string[];
  message: string;
  follow_up_count: number;
  accepted_at?: string | null;
}

export interface DemandInterviewAnswerQuality extends DemandRecord {
  score: number;
  level: string;
  reasons: string[];
  follow_up_questions: DemandInterviewFollowUpQuestion[];
  original_score?: number;
  assumption?: DemandInterviewAcceptedAssumption | null;
}

export interface DemandInterviewAnswerRecord extends DemandRecord {
  question_id: string;
  slot: string;
  category: string;
  answer: unknown;
  normalized?: DemandRecord & {
    approved?: boolean;
    text?: string;
    items?: string[];
  };
  quality?: DemandInterviewAnswerQuality;
  answer_quality?: DemandInterviewAnswerQuality;
  answered_at?: string | null;
}

export type DemandInterviewAnswers = Record<string, DemandInterviewAnswerRecord>;

export interface DemandInterviewFollowUpPlan extends DemandRecord {
  schema: string;
  status: string;
  total: number;
  follow_up_questions: DemandInterviewFollowUpQuestion[];
  by_slot: Array<{
    slot?: string;
    question_id?: string;
    category?: string;
    severity: string;
    code?: string;
    reason?: string;
    questions: string[];
  }>;
}

export interface DemandInterviewQualitySummary extends DemandRecord {
  score: number;
  level: string;
  checked_slots: string[];
  low_quality_slots: string[];
  accepted_with_assumption_slots?: string[];
}

export interface DemandInterviewApprovalState extends DemandRecord {
  answered: boolean;
  approved: boolean;
  answer?: unknown;
  answered_at: string | null;
}

export interface DemandInterviewReadiness extends DemandRecord {
  status: string;
  ready_for_discuss: boolean;
  ready_for_prd_intake: boolean;
  quality_score: number;
  answer_quality_score: number;
  answer_quality: DemandInterviewQualitySummary;
  blockers: DemandRecord[];
  warnings: DemandRecord[];
  follow_up_questions: DemandInterviewFollowUpQuestion[];
  follow_up_plan: DemandInterviewFollowUpPlan;
  assumptions: DemandInterviewAcceptedAssumption[];
  next_actions: string[];
}

export interface DemandInterviewCoverage extends DemandRecord {
  readiness: DemandInterviewReadiness;
  follow_up_questions: DemandInterviewFollowUpQuestion[];
  follow_up_plan: DemandInterviewFollowUpPlan;
  missing: DemandInterviewQuestion[];
  missing_slots: string[];
  answered_slots: string[];
  quality: DemandInterviewQualitySummary;
  answer_quality: DemandRecord[];
  assumptions: DemandInterviewAcceptedAssumption[];
  approval: DemandInterviewApprovalState;
  ready_for_discuss: boolean;
  ready_for_prd_intake: boolean;
  active_stage?: string | null;
  awaiting_initial_playback?: boolean;
  stopped?: boolean;
  premise_judgment?: DemandRecord & { decision?: string };
  layer_gates?: Record<string, DemandRecord & { confirmed?: boolean }>;
  requirement_checklist?: string[];
}

export interface DemandInterviewLedgers extends DemandRecord {
  schema: string;
  writes_during_interview: boolean;
  project_memory: { path: string; purpose: string };
  demand_memory: { path: string; purpose: string };
  interview_answers: { path: string; purpose: string };
  discussion_log?: { path: string; purpose: string };
  prd_intake: { path: string; purpose: string };
  projectRoot: string;
  stateRoot: string;
}

type DemandInterviewSessionInput = Omit<Partial<DemandInterviewSession>, "answers"> & DemandRecord & {
  answers?: unknown;
  questions?: DemandInterviewQuestion[];
  updated_at?: string;
  initial_playback?: DemandRecord & { confirmed?: boolean; confirmed_content_hash?: string };
};

export interface DemandInterviewSession extends Omit<DemandRuntimeInput, "answers"> {
  id?: string;
  demand_id?: string;
  generated_at?: string;
  updated_at?: string;
  questions?: DemandInterviewQuestion[];
  answers?: DemandInterviewAnswers;
  coverage?: DemandInterviewCoverage;
  readiness?: DemandInterviewReadiness;
  follow_up_questions?: DemandInterviewFollowUpQuestion[];
  follow_up_plan?: DemandInterviewFollowUpPlan;
  follow_up_counts?: Record<string, DemandInterviewFollowUpCounter>;
  accepted_assumptions?: DemandInterviewAcceptedAssumption[];
  next_question?: DemandInterviewQuestion | null;
  ledgers?: DemandInterviewLedgers;
  initial_playback?: DemandRecord & { confirmed?: boolean; confirmed_content_hash?: string };
}

const answerExamples = (first: string, second: string) => ({
  free_text: true,
  examples: [first, second],
});

const protocolQuestion = (question: DemandInterviewQuestion): DemandInterviewQuestion => ({
  ...question,
  protocol_schema: PM_PROTOCOL_SCHEMA,
});

export const DEMAND_INTERVIEW_QUESTION_BANK: DemandInterviewQuestion[] = [
  protocolQuestion({
    id: "premise_consequence", slot: "premise_consequence", stage: "premise", category: "不做的后果",
    plain_language_prompt: "如果三个月内不做，谁会继续受影响？会多花多少时间、出多少错，或者失去什么机会？",
    why_it_matters: "不做的后果决定是否值得投入，而不是默认所有想法都要实现。",
    accepts: answerExamples("负责人每周至少漏掉两次到期任务，需要临时补救。", "不做没有业务影响，也没有人会多花时间。"),
    required_for: ["discuss", "prd_intake"],
  }),
  protocolQuestion({
    id: "premise_minimum", slot: "mvp_priority", stage: "premise", category: "最小有价值版本",
    plain_language_prompt: "如果只交付一个最小但真正有用的版本，它必须包含什么？哪些能力少了就没有价值？",
    why_it_matters: "最小版本用于检验价值闭环，不替用户擅自砍掉已经确认的愿景。",
    accepts: answerExamples("至少能创建标签、按标签筛选、设置到期时间并看到提醒。", "至少能保存私密备注并在同一客户页面重新看到。"),
    required_for: ["discuss", "prd_intake"],
  }),
  protocolQuestion({
    id: "premise_decision", slot: "premise_decision", stage: "premise", category: "前提判断",
    confirmation_gate: true, gate_for: "premise",
    plain_language_prompt: "根据现有办法、不做的后果和最小版本，现在判断：继续进入需求澄清，还是不继续？请明确回答“继续”或“不继续”。",
    why_it_matters: "只有明确值得继续，才进入四层需求沟通。",
    accepts: answerExamples("继续。", "不继续，目前没有足够价值。"),
    required_for: ["discuss", "prd_intake"],
  }),
  protocolQuestion({
    id: "target_users", slot: "target_users", stage: "layer_1", layer: 1, category: "用户/角色",
    plain_language_prompt: "谁会使用、受影响或负责这个需求？请列全所有业务角色，包括偶尔看一眼的人。",
    why_it_matters: "明确全部角色后，后续场景和验收才不会服务错对象。",
    accepts: answerExamples("门店店长每天查看库存，区域经理每周看汇总。", "团队成员维护待办，项目负责人查看延期风险。"),
    required_for: ["discuss", "prd_intake"],
  }),
  protocolQuestion({
    id: "status_quo", slot: "status_quo", stage: "layer_1", layer: 1, category: "当前现状",
    plain_language_prompt: "这些角色现在分别怎么做？请补充谁在什么时候用表格、消息、口头或现有页面完成哪一步。",
    why_it_matters: "角色对应的现状能说明哪些流程要保留、替换或补强。",
    accepts: answerExamples("店长每天导出库存表，人工筛选快缺货的商品。", "成员用标题前缀分类，负责人每天下班前人工翻日期。"),
    required_for: ["discuss", "prd_intake"],
  }),
  protocolQuestion({
    id: "pain_points", slot: "pain_points", stage: "layer_1", layer: 1, category: "痛点",
    plain_language_prompt: "每个角色最痛、最容易出错或最耽误时间的地方是什么？给一个最近真实发生的例子。",
    why_it_matters: "真实痛点决定优先级，也暴露遗漏角色。",
    accepts: answerExamples("发现缺货太晚，客户投诉后店长才补救。", "标签写法不一致，而且负责人每周漏掉两次到期任务。"),
    required_for: ["discuss", "prd_intake"],
  }),
  protocolQuestion({
    id: "layer_1_confirmation", slot: "layer_1_confirmation", stage: "layer_1", layer: 1, category: "第一层确认",
    confirmation_gate: true, gate_for: "layer_1",
    plain_language_prompt: "请确认上面的角色、现状和痛点完整无误；如有遗漏先纠正。明确回答“确认”后才进入一天的使用故事。",
    why_it_matters: "第一层未确认时，后面的场景会建立在错误角色或现状上。",
    accepts: answerExamples("确认，这就是全部角色、现状和痛点。", "不确认，还漏了区域经理。"),
    required_for: ["discuss", "prd_intake"],
  }),
  protocolQuestion({
    id: "day_in_life", slot: "day_in_life", stage: "layer_2", layer: 2, category: "一天的使用故事",
    plain_language_prompt: "从一天开始讲：用户什么时候碰到这件事，先看到什么、做什么，然后做什么，直到事情结束？",
    why_it_matters: "按时间走一遍能发现机械题库遗漏的步骤、交接和绕行。",
    accepts: answerExamples("每天早上店长打开库存页，先看缺货列表，再逐项安排补货。", "成员早上按标签筛任务，下午更新到期时间，负责人下班前处理提醒。"),
    required_for: ["discuss", "prd_intake"],
  }),
  protocolQuestion({
    id: "desired_outcome", slot: "desired_outcome", stage: "layer_2", layer: 2, category: "目标结果",
    plain_language_prompt: "沿着刚才的一天，哪些步骤应该由新功能改变？用户每一步应看到或完成什么结果？",
    why_it_matters: "目标结果会成为按场景拆分的业务能力。",
    accepts: answerExamples("店长先看到缺货商品，再按风险处理补货。", "成员按标签找到任务，并在到期前看到提醒。"),
    required_for: ["discuss", "prd_intake"],
  }),
  protocolQuestion({
    id: "layer_2_confirmation", slot: "layer_2_confirmation", stage: "layer_2", layer: 2, category: "第二层确认",
    confirmation_gate: true, gate_for: "layer_2",
    plain_language_prompt: "请确认按时间回放的一天和每个交互点都正确；明确回答“确认”后才进入例外和边界。",
    why_it_matters: "第二层确认保证需求来自真实业务流程。",
    accepts: answerExamples("确认，这就是完整的一天。", "不确认，下午还有一次负责人复核。"),
    required_for: ["discuss", "prd_intake"],
  }),
  protocolQuestion({
    id: "exceptions", slot: "exceptions", stage: "layer_3", layer: 3, category: "异常/例外",
    plain_language_prompt: "正常流程在哪些情况下会走不下去？请覆盖空数据、错误数据、重复操作、中断、同时操作和特殊日期。",
    why_it_matters: "异常路径决定功能是否可靠。",
    accepts: answerExamples("没有到期时间的待办不提醒，已完成待办取消提醒。", "两个人同时改同一任务时，后保存的人要看到变化提示。"),
    required_for: ["prd_intake"],
  }),
  protocolQuestion({
    id: "scope_boundaries", slot: "scope_boundaries", stage: "layer_3", layer: 3, category: "范围边界",
    plain_language_prompt: "这次明确不做什么？哪些角色、流程、渠道或数据不要碰？哪些能力完整保留到以后？",
    why_it_matters: "边界由用户确认，系统不能自行把愿景砍成更小范围。",
    accepts: answerExamples("只做站内提醒，不做邮件和短信通知。", "保留现有待办创建流程，不改账号和权限。"),
    required_for: ["prd_intake"],
  }),
  protocolQuestion({
    id: "layer_3_confirmation", slot: "layer_3_confirmation", stage: "layer_3", layer: 3, category: "第三层确认",
    confirmation_gate: true, gate_for: "layer_3",
    plain_language_prompt: "请逐条确认例外的触发条件、期望行为、影响对象和本次边界；明确回答“确认”后才进入验收证据。",
    why_it_matters: "第三层确认防止异常和边界被默认处理。",
    accepts: answerExamples("确认，例外和边界都完整。", "不确认，还要补充已完成任务的提醒规则。"),
    required_for: ["prd_intake"],
  }),
  protocolQuestion({
    id: "success_criteria", slot: "success_criteria", stage: "layer_4", layer: 4, category: "成功标准",
    plain_language_prompt: "你打开页面或完成操作后，亲眼看到什么、点哪里发生什么，就能判断每项能力做对了？",
    why_it_matters: "每项需求都必须有用户可观察的验收结果。",
    accepts: answerExamples("创建标签后能在列表里选中它，筛选后只显示匹配待办。", "把待办设为明天到期后，今天能看到清晰提醒。"),
    required_for: ["prd_intake"],
  }),
  protocolQuestion({
    id: UI_ACCEPTANCE_SLOT, slot: UI_ACCEPTANCE_SLOT, stage: "layer_4", layer: 4, category: "界面验收证据",
    plain_language_prompt: "这个界面从哪个业务入口打开？用户必须看到哪些文字、位置和状态，留下什么截图或记录就能确认做对？",
    why_it_matters: "界面验收保持业务语言；项目已有的技术验收方式由系统内部解析。",
    accepts: answerExamples("从待办列表打开，标签在标题下方，筛选后截图只包含匹配任务。", "从任务详情打开，到期提醒显示在日期旁，截图能看到任务名和提醒时间。"),
    required_for: ["prd_intake"],
  }),
  protocolQuestion({
    id: "layer_4_confirmation", slot: "layer_4_confirmation", stage: "layer_4", layer: 4, category: "第四层确认",
    confirmation_gate: true, gate_for: "layer_4",
    plain_language_prompt: "请确认每项需求都有你能亲眼检查的验收证据；明确回答“确认”后才回放完整需求清单。",
    why_it_matters: "第四层确认保证不是只写抽象的成功标准。",
    accepts: answerExamples("确认，每项能力都有可见证据。", "不确认，标签管理还缺删除后的验收。"),
    required_for: ["prd_intake"],
  }),
  protocolQuestion({
    id: "requirements_confirmation", slot: "requirements_confirmation", stage: "requirements_replay", category: "需求清单确认",
    confirmation_gate: true, gate_for: "requirements_replay",
    plain_language_prompt: "系统会在这里按 R-001、R-002…回放完整业务能力清单。请逐条检查遗漏、不准确和不需要的项，明确回答“确认”后才进入批准。",
    why_it_matters: "R-001 清单是需求与领域任务拆分之间的唯一确认输入。",
    accepts: answerExamples("确认，R-001 到 R-004 都准确且没有遗漏。", "不确认，R-003 还要支持修改到期时间。"),
    required_for: ["prd_intake"],
  }),
  protocolQuestion({
    id: "execution_approval", slot: "execution_approval", stage: "approval", category: "执行批准",
    confirmation_gate: true, gate_for: "approval",
    plain_language_prompt: "以上四层和 R-001 需求清单确认无误后，是否批准进入 PRD？请明确回答“批准”或“暂不批准”。",
    why_it_matters: "只有用户明确批准，需求才可以进入 PRD。",
    accepts: { ...answerExamples("批准，按确认后的需求清单进入 PRD。", "暂不批准，还要补充一个例外。"), boolean: true },
    required_for: ["prd_intake"],
  }),
];

const DISCUSS_REQUIRED_SLOTS: string[] = [
  "premise_consequence",
  "mvp_priority",
  "premise_decision",
  "target_users",
  "status_quo",
  "pain_points",
  "layer_1_confirmation",
  "day_in_life",
  "desired_outcome",
  "layer_2_confirmation",
];
const FOLLOW_UP_SEVERITY = "warning";
const PRD_REQUIRED_SLOTS: string[] = [
  "premise_consequence",
  "mvp_priority",
  "premise_decision",
  "target_users",
  "status_quo",
  "pain_points",
  "layer_1_confirmation",
  "day_in_life",
  "desired_outcome",
  "layer_2_confirmation",
  "exceptions",
  "scope_boundaries",
  "layer_3_confirmation",
  "success_criteria",
  "layer_4_confirmation",
  "requirements_confirmation",
];

function acceptanceAdapterDeclaration(value: unknown): DemandRecord | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as DemandRecord;
  const manifest = record.acceptance_adapter && typeof record.acceptance_adapter === "object"
    ? record.acceptance_adapter as DemandRecord
    : record;
  return validatePackManifest(manifest).valid ? manifest : null;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function asArray<T = unknown>(value: T | T[] | readonly T[] | null | undefined): T[] {
  if (value == null) return [];
  return (Array.isArray(value) ? [...value] : [value]) as T[];
}

function textFromValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const record = value as DemandRecord;
    return clean(record.text || record.answer || record.value || record.note || record.details || record.summary);
  }
  return clean(value);
}

function answerRecords(value: unknown): Record<string, DemandInterviewAnswerRecord> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, DemandInterviewAnswerRecord>
    : {};
}

function arrayOfStrings(value: unknown): string[] {
  return asArray(value)
    .flatMap((item) => textFromValue(item).split(/\r?\n/))
    .map((item) => item.trim())
    .filter(Boolean);
}

const LIST_ITEM_PREFIX = /^(?:[-*•]\s+|\d{1,3}[.)、](?!\d)\s*|[（(]\d{1,3}[）)]\s*|[一二三四五六七八九十]{1,4}[.)、]\s*)/u;
const INLINE_NUMBERED_ITEM = /\s+(?=(?:\d{1,3}[.)、](?!\d)\s*|[（(]\d{1,3}[）)]\s*|[一二三四五六七八九十]{1,4}[.)、]\s*))/u;

function splitStructuredListItem(value: unknown): string[] {
  return clean(value)
    .split(INLINE_NUMBERED_ITEM)
    .flatMap((item) => item.split(/;\s+|\s+\|\s+/))
    .map((item) => clean(item).replace(LIST_ITEM_PREFIX, "").trim())
    .filter(Boolean);
}

function splitList(value: unknown): string[] {
  return [...new Set(
    arrayOfStrings(value)
      .flatMap(splitStructuredListItem),
  )];
}

const COMMAND_VERB_START = /^(?:add|list|create|update|delete|remove|edit|run|fix|implement|build|show|display|filter|sort|export|import|sync|validate|generate|open|save|archive|restore|search|find|mark|toggle|assign|complete|move|copy|upload|download|deploy|test|check)\b/i;
const CLI_COMMAND_START = /^\s*(?:[$>]\s*)?(?:[a-z][\w-]*(?:cli|cmd)|npm|pnpm|yarn|node|tsx|ts-node|python|pip|taskcli)(?:\s|$)/i;
const CODE_STYLE_SIGNAL = /--[\w-]+|(?:^|\s)(?:\.{0,2}\/|src\/|app\/|lib\/|packages\/|__tests__\/)|`[^`]+`/i;

export function isCommandOrCodeLikeTargetUser(value: unknown): boolean {
  const text = clean(value);
  if (!text) return false;
  if (CLI_COMMAND_START.test(text) || CODE_STYLE_SIGNAL.test(text)) return true;
  return COMMAND_VERB_START.test(text);
}

export function targetUserRoleItems(value: unknown): string[] {
  return splitList(value).filter((item) => !isCommandOrCodeLikeTargetUser(item));
}

export function hasTargetUserRole(value: unknown): boolean {
  return targetUserRoleItems(value).length > 0;
}

function wordTokens(text: unknown): string[] {
  return clean(text).match(/[A-Za-z0-9]+|[\u4e00-\u9fff]/g) || [];
}

function hasPattern(text: string, patterns: RegExp[] = []): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function compactReasons(reasons: Array<string | null | undefined> = []): string[] {
  return [...new Set(reasons.filter(Boolean))];
}

const VAGUE_PATTERNS = [
  /^(users?|admins?|customers?|staff|operator|manager|system|平台|用户|客户|管理员|人员|业务|系统)$/i,
  /^(做好一点|做得更好|让用户满意就行|用户满意就行|尽快完成|越快越好|差不多就行)$/i,
  /(etc\.?|等等|之类|相关|一些|某些|各种|多种|优化|提升|改善|更好|方便|智能|自动化|看情况)/i,
  /(满意|尽快|差不多|随便|都可以|不确定|先这样|越快越好)/i,
  /(better|improve|optimi[sz]e|nice|easy|fast|smart|automation|dashboard|tooling)/i,
];

const TECHNICAL_TERMS = [
  "api",
  "sdk",
  "db",
  "sql",
  "redis",
  "kafka",
  "react",
  "vue",
  "node",
  "typescript",
  "python",
  "java",
  "endpoint",
  "service",
  "backend",
  "frontend",
  "database",
  "schema",
  "server",
  "cache",
  "queue",
  "cron",
  "webhook",
  "token",
  "jwt",
  "oauth",
  "微服务",
  "接口",
  "数据库",
  "缓存",
  "队列",
  "前端",
  "后端",
  "服务",
  "模型",
  "算法",
];

function technicalOnly(text: unknown): boolean {
  const cleanText = clean(text).toLowerCase();
  if (!cleanText) return false;
  const chunks = cleanText.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  if (chunks.length === 0) return false;
  const technicalHits = TECHNICAL_TERMS.filter((term) => cleanText.includes(term)).length;
  const hasBusinessSignal = hasPattern(cleanText, [
    /manager|customer|support|sales|ops|operator|user|store|finance|legal|客服|店长|运营|销售|财务|法务|主管|用户|客户|门店|仓库|工单|订单|库存/,
    /when|daily|weekly|每[天周月]|上线|验收|现场|负责|处理|查看|确认|投诉|缺货|违约|审批|交付/,
  ]);
  return technicalHits > 0 && technicalHits / Math.max(chunks.length, technicalHits) >= 0.5 && !hasBusinessSignal;
}

type DetailSignal = "quantified" | "artifact" | "assertion" | "causal" | "role_context" | "explicit_none";

const SLOT_DETAIL_SIGNALS: Record<string, DetailSignal[]> = {
  premise_consequence: ["quantified", "assertion", "causal"],
  target_users: ["role_context"],
  status_quo: ["quantified", "artifact", "assertion"],
  pain_points: ["quantified", "artifact", "assertion", "causal"],
  day_in_life: ["quantified", "assertion", "role_context"],
  desired_outcome: ["quantified", "artifact", "assertion"],
  success_criteria: ["quantified", "artifact", "assertion"],
  ui_acceptance: ["quantified", "artifact", "assertion"],
  scope_boundaries: ["artifact", "assertion"],
  exceptions: ["explicit_none", "quantified", "artifact", "assertion", "causal"],
  mvp_priority: ["quantified", "artifact", "assertion"],
};

const DETAIL_SIGNAL_GUIDANCE: Record<DetailSignal, string> = {
  quantified: "具体数量/日期/百分比/时长",
  artifact: "可执行的命令或产物名",
  assertion: "“当…时…”或“必须…”式可观察结果",
  causal: "“因为/导致/造成/后果”式影响说明",
  role_context: "角色名词加具体场景描述",
  explicit_none: "明确写“没有特殊情况”",
};

function hasQuantifiedSignal(text: string): boolean {
  const value = clean(text);
  return hasPattern(value, [
    /\d/u,
    /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/u,
    /[零一二两三四五六七八九十百千万\d]+(?:个|次|天|周|月|年|小时|分钟|秒|行|条|件|类|名|位|份|组|列|项|轮|版|步|种|%)/u,
    /(?:每天|每日|每周|每月|每年|每次|每当|每[天日周月年次])/u,
    /\b(?:daily|weekly|monthly|hourly|each|every|once|twice|at least|at most|counts?|counted|counting|totals?)\b/i,
  ]);
}

function hasArtifactSignal(text: string): boolean {
  const value = clean(text);
  return hasPattern(value, [
    CLI_COMMAND_START,
    CODE_STYLE_SIGNAL,
    COMMAND_VERB_START,
    /https?:\/\/\S+|www\.\S+/i,
    /(?:^|\s)(?:\.{1,2}\/|\/[\w.-]+\/|[A-Za-z]:\\|[\w.-]+\/[\w./-]+)/u,
    /--[A-Za-z0-9][\w-]*/u,
    /`[^`]+`|"[^"]+"|'[^']+'|“[^”]+”|‘[^’]+’/u,
    /\b[A-Z]{2,}s?\b/u,
    /\b[A-Z][A-Z0-9_]{1,}\b/u,
    /\b[A-Z][a-z]+\/[A-Z][a-z]+\b/u,
    /\b[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)+\b/u,
    /\b[A-Z][A-Za-z0-9]+(?:\s+[A-Za-z0-9]+){0,3}\s*:/u,
  ]);
}

function hasAssertionSignal(text: string): boolean {
  const value = clean(text);
  return hasPattern(value, [
    /(?:必须|应当|不得|需要|不能|不应|禁止|至少|至多|确保|保证)[^。；;]{2,}/u,
    /(?:当|如果|若|每当|一旦)[^。；;]{2,}/u,
    /[^。；;，,]{2,40}时[，,]?\S{2,}/u,
    /(?:最小版本|第一版|本次).{0,20}(?:包含|支持|提供|显示)[^。；;]{2,}/u,
    /(?:用户|店长|成员|负责人|主管|客服|角色).{0,16}(?:可以|能|看到|收到|完成)[^。；;]{2,}/u,
    /(?:不做|不改|不碰|不包含|不要|不允许|不暴露|只做|仅覆盖|仅支持|排除)[^。；;]{2,}/u,
    /\b(?:must|should|shall|need(?:s)? to|has to|cannot|can't|do not|don't|does not|doesn't|only|without|exclude)\b.{2,}/i,
    /\b(?:when|if|whenever|once|after|before|during|while)\b.{2,}/i,
  ]);
}

function hasCausalSignal(text: string): boolean {
  const value = clean(text);
  return hasPattern(value, [
    /(?:因为|导致|造成|后果|影响|使得|以免|避免|返工|风险|太[慢晚贵长高低]|过[慢晚长高低])[^。；;]*/u,
    /\b(?:because|caus(?:e|es|ed|ing)|so that|therefore|leads? to|results? in|impact|risk|prevents?|avoid|after|too\s+\w+)\b/i,
  ]);
}

function hasExplicitNoExceptionSignal(text: string): boolean {
  return hasPattern(clean(text), [
    /^(?:没有|无|暂无|没有特殊情况|无特殊情况|没有异常|无异常)[。.!！\s]*$/u,
    /^(?:none|no special cases?|no exceptions?|n\/a)[.! \t]*$/i,
  ]);
}

function hasRoleContextSignal(text: string): boolean {
  const value = clean(text);
  const tokens = wordTokens(value);
  const hasChineseRole = /[\u4e00-\u9fff]{2,}(?:员|师|官|经理|主管|负责人|编辑|审核|维护者|管理员|用户|客户|团队|小组|角色)/u.test(value);
  const hasEnglishRole = /\b[A-Za-z][A-Za-z-]+(?:\s+[A-Za-z][A-Za-z-]+){0,3}\s+(?:managers?|owners?|operators?|editors?|reviewers?|maintainers?|analysts?|admins?|users?|customers?|leads?|teams?|staff|engineers?)\b/i.test(value)
    || /\b[A-Za-z][A-Za-z-]*(?:ers|ors|ists|ants|ees)\b/i.test(value);
  const hasContext = hasQuantifiedSignal(value)
    || hasAssertionSignal(value)
    || /\b(?:who|that|during|while|responsible for|need(?:s)? to|review(?:s)?|check(?:s)?|confirm(?:s)?)\b/i.test(value)
    || /(?:负责|需要|用于|用来|查看|确认|处理|审核|维护|在.+时)/u.test(value)
    || tokens.length >= 7;
  return (hasChineseRole || hasEnglishRole) && hasContext;
}

function signalMatches(signal: DetailSignal, text: string): boolean {
  if (signal === "quantified") return hasQuantifiedSignal(text);
  if (signal === "artifact") return hasArtifactSignal(text);
  if (signal === "assertion") return hasAssertionSignal(text);
  if (signal === "causal") return hasCausalSignal(text);
  if (signal === "role_context") return hasRoleContextSignal(text);
  if (signal === "explicit_none") return hasExplicitNoExceptionSignal(text);
  return false;
}

function hasSlotDetail(slot: string, text: string): boolean {
  const signals = SLOT_DETAIL_SIGNALS[slot] || ["quantified", "artifact", "assertion"];
  return signals.some((signal) => signalMatches(signal, text));
}

function shortAnswerAllowed(slot: string, text: string): boolean {
  return slot === "exceptions" && hasExplicitNoExceptionSignal(text);
}

const SLOT_FOLLOW_UPS: Record<string, Record<string, string>> = {
  target_users: {
    missing_detail: "还缺以下任一种：角色名词加具体场景描述、具体数量/日期、或“当…时…”/“必须…”式可观察结果。",
    technical_only: "还缺真实使用或负责的人：请写角色名词、具体场景描述，或补充具体数量/日期。",
    not_role: "还缺真实角色：当前像命令或功能名，请改成角色名词加具体场景描述。",
    vague: "还缺以下任一种：角色名词加具体场景描述、具体数量/日期、或“当…时…”/“必须…”式可观察结果。",
  },
  status_quo: {
    missing_detail: "还缺以下任一种：具体数量/日期、可执行的命令或产物名、或“当…时…”/“必须…”式可观察结果。",
    technical_only: "还缺当前流程的可观察结果：请补具体数量/日期、产物名，或“当…时…”式描述。",
    vague: "还缺以下任一种：具体数量/日期、可执行的命令或产物名、或“当…时…”式当前流程。",
  },
  pain_points: {
    missing_detail: "还缺以下任一种：具体数量/日期、可执行的命令或产物名、“当…时…”式场景，或“因为/导致/造成/后果”式影响说明。",
    technical_only: "还缺痛点影响：请补具体数量/日期，或写清“因为/导致/造成/后果”。",
    vague: "还缺以下任一种：具体数量/日期、“当…时…”式场景，或“因为/导致/造成/后果”式影响说明。",
  },
  desired_outcome: {
    missing_detail: "还缺以下任一种：具体数量/日期、可执行的命令或产物名、或“当…时…”/“必须…”式可观察结果。",
    technical_only: "还缺可观察结果：请补具体数量/日期、产物名，或“当…时…”式结果。",
    vague: "还缺以下任一种：具体数量/日期、可执行的命令或产物名、或“当…时…”式目标结果。",
  },
  success_criteria: {
    missing_detail: "还缺以下任一种：具体数量/日期、可执行的命令或产物名、或“当…时…”/“必须…”式可观察结果。",
    technical_only: "还缺可验收的观察点：请补具体数量/日期、产物名，或“当…时…”/“必须…”式结果。",
    vague: "还缺以下任一种：具体数量/日期、可执行的命令或产物名、或“当…时…”/“必须…”式可观察结果。",
  },
  scope_boundaries: {
    missing_detail: "还缺以下任一种：明确“不做/不改/不碰/只做”的可观察边界、具体数量/日期、或产物名。",
    technical_only: "还缺范围边界：请写明确“不做/不改/不碰/只做”的可观察边界。",
    vague: "还缺以下任一种：明确“不做/不改/不碰/只做”的可观察边界、具体数量/日期、或产物名。",
  },
  exceptions: {
    missing_detail: "还缺以下任一种：明确写“没有特殊情况”、具体数量/日期、产物名、“当…时…”式边界，或“因为/导致/造成/后果”式影响说明。",
    technical_only: "还缺异常条件和可观察结果：请补具体数量/日期、产物名，或“当…时…”式边界。",
    vague: "还缺以下任一种：明确写“没有特殊情况”、具体数量/日期，或“当…时…”式边界。",
  },
  mvp_priority: {
    missing_detail: "还缺以下任一种：具体数量/日期、可执行的命令或产物名、或“必须/后续/暂缓”式可观察取舍。",
    technical_only: "还缺第一版取舍：请补具体数量/日期、产物名，或“必须/后续/暂缓”式边界。",
    vague: "还缺以下任一种：具体数量/日期、可执行的命令或产物名、或“必须/后续/暂缓”式可观察取舍。",
  },
  execution_approval: {
    missing_detail: "请明确回答“批准”或“暂不批准”，如果暂不批准请说明还缺什么。",
    technical_only: "请直接确认是否批准进入 PRD intake。",
    vague: "请明确批准状态：批准进入 PRD，还是暂不批准继续补信息。",
  },
};

function followUpFor(slot: string, reason: string): string {
  const slotPrompts = SLOT_FOLLOW_UPS[slot] || {};
  if (slotPrompts[reason]) return slotPrompts[reason];
  if (slotPrompts.missing_detail) return slotPrompts.missing_detail;
  const signals = (SLOT_DETAIL_SIGNALS[slot] || ["quantified", "artifact", "assertion"])
    .map((signal) => DETAIL_SIGNAL_GUIDANCE[signal])
    .filter(Boolean);
  return `还缺以下任一种：${signals.join("、")}。`;
}

const MAX_GUIDED_FOLLOW_UPS_PER_SLOT = 2;
const CAPPED_FOLLOW_UP_REASONS = new Set(["missing_detail", "vague"]);

function answerQualityFor(question: DemandInterviewQuestion, answer: unknown): DemandInterviewAnswerQuality {
  if (question.confirmation_gate === true) {
    const decision = question.slot === "execution_approval"
      ? parseApprovalDecision(answer)
      : question.slot === "premise_decision"
        ? parsePremiseDecision(answer) !== null
        : parseLayerConfirmation(answer);
    return decision
      ? { score: 100, level: "sufficient", reasons: [], follow_up_questions: [] }
      : {
        score: 0,
        level: "needs_follow_up",
        reasons: ["missing_confirmation"],
        follow_up_questions: [{
          id: `FU-${String(question.slot).toUpperCase()}-MISSING_CONFIRMATION`,
          question_id: question.id,
          slot: question.slot,
          category: question.category,
          severity: FOLLOW_UP_SEVERITY,
          code: `FOLLOW_UP_${String(question.slot).toUpperCase()}_MISSING_CONFIRMATION`,
          reason: "missing_confirmation",
          plain_language_prompt: question.slot === "premise_decision"
            ? "请明确回答“继续”或“不继续”。"
            : question.slot === "execution_approval"
              ? "请明确回答“批准”或“暂不批准”。"
              : "请明确回答“确认”；如果不确认，请直接指出哪一项需要纠正。",
        }],
      };
  }
  const text = textFromValue(answer);
  const normalized = clean(text);
  if (!normalized) {
    return {
      score: 0,
      level: "missing",
      reasons: ["missing"],
      follow_up_questions: [],
    };
  }

  const tokens = wordTokens(normalized);
  const approvalClear = question.slot === "execution_approval"
    && parseApprovalDecision(answer) !== null;
  const hasDetail = question.slot !== "execution_approval" && hasSlotDetail(question.slot, normalized);
  const tooShort = !approvalClear
    && !shortAnswerAllowed(question.slot, normalized)
    && (normalized.length < 14 || tokens.length <= 2);
  const vague = hasPattern(normalized, VAGUE_PATTERNS) && (!hasDetail || normalized.length < 18 || tokens.length <= 3);
  const techOnly = technicalOnly(normalized);
  const commandOrFeatureAsRole = question.slot === "target_users" && isCommandOrCodeLikeTargetUser(normalized);
  const missingDetail = question.slot !== "execution_approval" && !hasDetail;
  const approvalMissing = question.slot === "execution_approval" && !approvalClear;

  const reasons = compactReasons([
    commandOrFeatureAsRole ? "not_role" : null,
    tooShort ? "too_short" : null,
    vague ? "vague" : null,
    techOnly ? "technical_only" : null,
    missingDetail || approvalMissing ? "missing_detail" : null,
  ]);

  const penalty = reasons.reduce((total, reason) => total + ({
    too_short: 30,
    vague: 20,
    technical_only: 35,
    missing_detail: 25,
    not_role: 45,
  }[reason] || 0), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const followUpReason = commandOrFeatureAsRole ? "not_role" : techOnly ? "technical_only" : vague ? "vague" : missingDetail || approvalMissing || tooShort ? "missing_detail" : null;
  const needsFollowUp = score < 75 || Boolean(followUpReason);
  const followUps: DemandInterviewFollowUpQuestion[] = needsFollowUp && followUpReason ? [{
    id: `FU-${String(question.slot).toUpperCase()}-${String(followUpReason).toUpperCase()}`,
    question_id: question.id,
    slot: question.slot,
    category: question.category,
    severity: FOLLOW_UP_SEVERITY,
    code: `FOLLOW_UP_${String(question.slot).toUpperCase()}_${String(followUpReason).toUpperCase()}`,
    reason: followUpReason,
    plain_language_prompt: followUpFor(question.slot, followUpReason),
  }] : [];

  return {
    score,
    level: needsFollowUp ? "needs_follow_up" : "sufficient",
    reasons,
    follow_up_questions: followUps,
  };
}

function followUpCountRecords(value: unknown): Record<string, DemandInterviewFollowUpCounter> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, DemandInterviewFollowUpCounter>)
    .map(([slot, record]) => [slot, {
      slot: clean(record?.slot || slot),
      count: Number(record?.count || 0),
      reasons: compactReasons(record?.reasons || []),
      updated_at: clean(record?.updated_at) || null,
    }]));
}

function cappedFollowUpReason(quality: DemandInterviewAnswerQuality): string {
  const reason = clean(quality.follow_up_questions?.[0]?.reason);
  return CAPPED_FOLLOW_UP_REASONS.has(reason) ? reason : "";
}

function blockAfterGuidedFollowUps(
  question: DemandInterviewQuestion,
  quality: DemandInterviewAnswerQuality,
  counter: DemandInterviewFollowUpCounter,
): DemandInterviewAnswerQuality {
  const followUp = quality.follow_up_questions[0];
  if (!followUp) return quality;
  return {
    ...quality,
    level: "blocked_needs_clarification",
    follow_up_questions: [{
      ...followUp,
      severity: "error",
      code: `${followUp.code || `FOLLOW_UP_${String(question.slot).toUpperCase()}`}_HUMAN_CLARIFICATION_REQUIRED`,
      plain_language_prompt: `${followUp.plain_language_prompt} 已连续 ${counter.count} 次未得到明确答案；为避免错误放行，请人工澄清后再继续。`,
    }],
  };
}

function nowIso(options: DemandRuntimeOptions = Object()): string {
  return clean(options.now) || new Date().toISOString();
}

function slug(value: unknown, fallback: string = "DEMAND"): string {
  const text = clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return text || fallback;
}

function idDate(now: unknown): string {
  return clean(now).slice(0, 10).replace(/-/g, "") || "00000000";
}

function makeId(prefix: string, input: DemandRuntimeInput = Object(), now: string): string {
  return clean(input.id || input.interview_id || input.interviewId)
    || `${prefix}-${idDate(now)}-${slug(input.title || input.idea || input.objective || "PROJECT")}`;
}

function makeDemandId(input: DemandRuntimeInput = Object(), now: string): string {
  return clean(input.demand_id || input.demandId)
    || `DEMAND-${idDate(now)}-${slug(input.title || input.idea || input.objective || "PROJECT")}`;
}

function resolveRoot(value: unknown, fallback: string = process.cwd()): string {
  return resolve(clean(value) || fallback);
}

function stateRootFor(input: DemandRuntimeInput = Object(), options: DemandRuntimeOptions = Object()): string {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const explicit = input.stateRoot || input.state_root || options.stateRoot || options.state_root;
  return explicit ? (isAbsolute(explicit) ? explicit : resolve(projectRoot, explicit)) : join(projectRoot, ".yolo");
}

function questionById(questionId: unknown, questions: DemandInterviewQuestion[] = DEMAND_INTERVIEW_QUESTION_BANK): DemandInterviewQuestion | undefined {
  const aliases: Record<string, string> = {
    mvp_priority: "premise_minimum",
  };
  const id = clean(questionId);
  return questions.find((question) => question.id === id)
    || questions.find((question) => question.id === aliases[id]);
}

function questionBySlot(slot: unknown, questions: DemandInterviewQuestion[] = DEMAND_INTERVIEW_QUESTION_BANK): DemandInterviewQuestion | undefined {
  return questions.find((question) => question.slot === slot);
}

function answerRecordForSlot(session: DemandInterviewSessionInput = Object(), slot: string): DemandInterviewAnswerRecord | null {
  const question = questionBySlot(slot, session.questions || DEMAND_INTERVIEW_QUESTION_BANK);
  return question ? answerRecords(session.answers)[question.id || ""] : null;
}

function parseApprovalDecision(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  if (value && typeof value === "object") {
    const record = value as DemandRecord & { approved?: boolean; approve?: boolean };
    if (record.approved === true || record.approve === true) return true;
    if (record.approved === false || record.approve === false) return false;
  }
  const text = textFromValue(value).trim();
  if (!text) return null;

  const explicitRejection = [
    /(?:暂不|不批准|不同意|不确认|不能批准|不能同意|不要批准|没有批准|尚未批准|还未批准|未批准|尚未同意|还未同意|未同意|拒绝|否决)/,
    /^\s*(?:no|false)\b/i,
    /\b(?:not\s+(?:yet\s+)?(?:approve|approved|agree|agreed|confirm|confirmed)|do\s+not\s+(?:approve|agree|confirm)|don't\s+(?:approve|agree|confirm)|cannot\s+(?:approve|agree|confirm)|can't\s+(?:approve|agree|confirm)|cant\s+(?:approve|agree|confirm)|have\s+not\s+approved|haven't\s+approved|havent\s+approved|has\s+not\s+approved|hasn't\s+approved|hasnt\s+approved|disapproved)\b/i,
  ].some((pattern) => pattern.test(text));
  if (explicitRejection) return false;

  const explicitApproval = [
    /^\s*(?:批准|同意|确认无误|可以(?:进入\s*prd)?|进入\s*prd)(?:$|[，。,.！!\s])/i,
    /^\s*我(?:已|明确)?(?:批准|同意|确认)(?:$|[，。,.！!\s])/i,
    /^\s*(?:yes|true|approve|approved|confirm|confirmed)(?:\b|[,.!])/i,
    /^\s*i\s+(?:approve|agree|confirm)\b/i,
  ].some((pattern) => pattern.test(text));
  return explicitApproval ? true : null;
}

function parseApproval(value: unknown): boolean {
  return parseApprovalDecision(value) === true;
}

function parsePremiseDecision(value: unknown): "continue" | "do_not_continue" | null {
  const text = textFromValue(value).trim();
  if (!text) return null;
  if (/^(?:不继续|停止|先不做|暂不继续|do not continue|stop)(?:$|[，。,.！!\s])/i.test(text)) return "do_not_continue";
  if (/^(?:继续|值得继续|进入需求澄清|continue|proceed)(?:$|[，。,.！!\s])/i.test(text)) return "continue";
  return null;
}

function parseLayerConfirmation(value: unknown): boolean {
  if (value === true) return true;
  const text = textFromValue(value).trim();
  if (!text) return false;
  const explicitConfirmation = /^(?:确认|确认无误|全部正确|没有遗漏|对，这就是全部|yes|confirmed)(?:$|[，。,.！!\s])/i.test(text);
  if (explicitConfirmation) return true;
  if (/差不多|大概|基本|不确认|有偏差|需要纠正|(?:有|存在|还有).{0,4}遗漏|不对/.test(text)) return false;
  return false;
}

function hasAnswer(record?: DemandInterviewAnswerRecord | null): boolean {
  if (!record) return false;
  if (record.slot === "execution_approval" || record.slot === "premise_decision") {
    return typeof record.answer === "boolean" || textFromValue(record.answer).length > 0;
  }
  if (Array.isArray(record.normalized?.items)) return record.normalized.items.length > 0;
  if (Array.isArray(record.answer)) return splitList(record.answer).length > 0;
  if (record.answer && typeof record.answer === "object") return textFromValue(record.answer).length > 0 || Object.keys(record.answer).length > 0;
  return textFromValue(record.answer).length > 0;
}

function normalizeAnswer(question: DemandInterviewQuestion, answer: unknown): DemandRecord {
  if (question.slot === "execution_approval") {
    return {
      approved: parseApproval(answer),
      text: textFromValue(answer),
    };
  }
  if (question.slot === "ui_acceptance") {
    return {
      text: textFromValue(answer),
      items: splitList(answer),
      acceptance_adapter: acceptanceAdapterDeclaration(answer),
    };
  }
  if (question.slot === "premise_decision") {
    return {
      decision: parsePremiseDecision(answer),
      text: textFromValue(answer),
    };
  }
  if (question.confirmation_gate === true) {
    return {
      confirmed: parseLayerConfirmation(answer),
      text: textFromValue(answer),
    };
  }
  return {
    text: textFromValue(answer),
    items: question.slot === "target_users" ? targetUserRoleItems(answer) : splitList(answer),
  };
}

function decorateQuestions(questions: DemandInterviewQuestion[] = DEMAND_INTERVIEW_QUESTION_BANK, answers: unknown = Object()): DemandInterviewQuestion[] {
  const records = answerRecords(answers);
  return questions.map((question) => ({
    ...question,
    answered: hasAnswer(records[question.id || ""]),
  }));
}

function missingSlots(session: DemandInterviewSessionInput = Object(), slots: string[] = []): string[] {
  return slots.filter((slot) => !hasAnswer(answerRecordForSlot(session, slot)));
}

function qualityForAnsweredRecord(question?: DemandInterviewQuestion, record?: DemandInterviewAnswerRecord | null): DemandInterviewAnswerQuality | null {
  if (!question || !hasAnswer(record)) return null;
  const stored = record.quality || record.answer_quality;
  if (stored && typeof stored === "object" && Number.isFinite(Number(stored.score))) {
    if (clean(stored.level) === "accepted_with_assumption") return answerQualityFor(question, record.answer);
    return {
      score: Number(stored.score),
      level: clean(stored.level || (Number(stored.score) >= 75 ? "sufficient" : "needs_follow_up")),
      reasons: compactReasons(stored.reasons || []),
      follow_up_questions: asArray(stored.follow_up_questions).filter(Boolean),
      original_score: Number.isFinite(Number(stored.original_score)) ? Number(stored.original_score) : undefined,
      assumption: stored.assumption && typeof stored.assumption === "object"
        ? stored.assumption as DemandInterviewAcceptedAssumption
        : null,
    };
  }
  return answerQualityFor(question, record.answer);
}

function answeredQualityItems(session: DemandInterviewSessionInput = Object(), questions: DemandInterviewQuestion[] = DEMAND_INTERVIEW_QUESTION_BANK) {
  const answers = answerRecords(session.answers);
  return questions
    .map((question) => {
      const record = answers[question.id || ""];
      const quality = qualityForAnsweredRecord(question, record);
      if (!quality) return null;
      return {
        question_id: question.id,
        slot: question.slot,
        category: question.category,
        score: quality.score,
        level: quality.level,
        reasons: quality.reasons,
        follow_up_questions: quality.follow_up_questions,
        assumption: quality.assumption || null,
      };
    })
    .filter(Boolean);
}

function followUpPlanForQuality(items: ReturnType<typeof answeredQualityItems> = []) {
  const followUpQuestions = items.flatMap((item) => item.follow_up_questions || []);
  const bySlot = followUpQuestions.map((question) => ({
    slot: question.slot,
    question_id: question.question_id,
    category: question.category,
    severity: question.severity || "warning",
    code: question.code,
    reason: question.reason,
    questions: [question.plain_language_prompt].filter(Boolean),
  }));
  return {
    schema: "yolo.demand.interview.follow_up_plan.v1",
    status: followUpQuestions.length ? "needs_follow_up" : "clear",
    total: followUpQuestions.length,
    follow_up_questions: followUpQuestions,
    by_slot: bySlot,
  };
}

function acceptedAssumptionsFromQuality(items: ReturnType<typeof answeredQualityItems> = []): DemandInterviewAcceptedAssumption[] {
  return items
    .map((item) => item.assumption)
    .filter((item): item is DemandInterviewAcceptedAssumption => Boolean(item && typeof item === "object"));
}

function acceptedAssumptionMessages(items: DemandInterviewAcceptedAssumption[] = []): string[] {
  return items.map((item) => clean(item.message)).filter(Boolean);
}

function qualitySummary(items: ReturnType<typeof answeredQualityItems> = []) {
  if (items.length === 0) {
    return {
      score: 0,
      level: "missing",
      checked_slots: [],
      low_quality_slots: [],
      accepted_with_assumption_slots: [],
    };
  }
  const score = Math.round(items.reduce((total, item) => total + Number(item.score || 0), 0) / items.length);
  const lowQuality = items.filter((item) => ["needs_follow_up", "blocked_needs_clarification", "missing"].includes(item.level));
  const acceptedWithAssumption = items.filter((item) => item.level === "accepted_with_assumption");
  return {
    score,
    level: lowQuality.length ? "needs_follow_up" : acceptedWithAssumption.length ? "accepted_with_assumption" : "sufficient",
    checked_slots: items.map((item) => item.slot),
    low_quality_slots: lowQuality.map((item) => item.slot),
    accepted_with_assumption_slots: acceptedWithAssumption.map((item) => item.slot),
  };
}

function protocolEnabled(session: DemandInterviewSessionInput = Object()): boolean {
  return (session.questions || []).some((question) => Boolean(question.stage));
}

function stageDefinition(stageId: string) {
  return PM_PROTOCOL_STAGES.find((stage) => stage.id === stageId);
}

function stageQuestions(session: DemandInterviewSessionInput, stageId: string): DemandInterviewQuestion[] {
  const questions = session.questions || DEMAND_INTERVIEW_QUESTION_BANK;
  const ids = new Set(PM_PROTOCOL_LAYER_QUESTION_IDS[stageId as PMProtocolStageId] || []);
  return questions.filter((question) => ids.has(clean(question.id)));
}

function stageContentRecords(session: DemandInterviewSessionInput, stageId: string) {
  const answers = answerRecords(session.answers);
  return stageQuestions(session, stageId)
    .filter((question) => question.confirmation_gate !== true)
    .map((question) => ({
      id: clean(question.id),
      slot: clean(question.slot),
      category: clean(question.category),
      answer: textFromValue(answers[question.id || ""]?.answer),
    }))
    .filter((item) => item.answer);
}

function stageContentHash(session: DemandInterviewSessionInput, stageId: string): string {
  const snapshot = JSON.stringify({
    protocol: PM_PROTOCOL_SCHEMA,
    stage: stageId,
    items: stageId === "requirements_replay"
      ? requirementChecklist(session)
      : stageContentRecords(session, stageId),
  });
  return `sha256:${createHash("sha256").update(snapshot).digest("hex")}`;
}

function stageSummary(session: DemandInterviewSessionInput, stageId: string): string {
  const definition = stageDefinition(stageId);
  const items = stageContentRecords(session, stageId);
  if (items.length === 0) return `${definition?.label || stageId}：尚未收集到内容。`;
  return [
    `${definition?.label || stageId}小结：`,
    ...items.map((item) => `- ${item.category}：${item.answer}`),
  ].join("\n");
}

function layerGateState(session: DemandInterviewSessionInput, stageId: string) {
  const definition = stageDefinition(stageId);
  const question = definition?.confirmation_question_id
    ? questionById(definition.confirmation_question_id, session.questions || DEMAND_INTERVIEW_QUESTION_BANK)
    : undefined;
  const record = question ? answerRecords(session.answers)[question.id || ""] : undefined;
  const currentHash = stageContentHash(session, stageId);
  const premiseDecision = stageId === "premise" ? parsePremiseDecision(record?.answer) : null;
  const confirmed = stageId === "premise"
    ? premiseDecision !== null
    : stageId === "approval"
      ? parseApprovalDecision(record?.answer) === true
      : record?.normalized?.confirmed === true
        && clean(record?.normalized?.confirmed_content_hash) === currentHash;
  return {
    stage: stageId,
    question_id: question?.id || null,
    confirmed,
    current_content_hash: currentHash,
    confirmed_content_hash: clean(record?.normalized?.confirmed_content_hash) || null,
  };
}

function premiseJudgment(session: DemandInterviewSessionInput) {
  const decisionRecord = answerRecordForSlot(session, "premise_decision");
  const explicit = parsePremiseDecision(decisionRecord?.answer);
  const consequence = textForSlot(session, "premise_consequence");
  const minimum = textForSlot(session, "mvp_priority");
  const lowImpact = /(?:没有|无|不会|不产生|几乎没有).{0,8}(?:业务)?影响|没人受影响|无需投入|no (?:business )?impact/i.test(consequence);
  const noMinimum = /没有.{0,8}(?:最小版本|值得交付)|暂时不值得|no valuable minimum/i.test(minimum);
  const recommended = lowImpact || noMinimum ? "do_not_continue" : "continue";
  return {
    schema: "yolo.demand.premise_judgment.v1",
    decision: explicit || "pending",
    recommended_decision: recommended,
    recommended_answer: recommended === "continue" ? "继续" : "不继续",
    reason: recommended === "continue"
      ? "现有办法仍有明确代价，而且已经能说清一个有价值的最小闭环。"
      : "当前没有足够的不做代价，或还没有一个值得交付的最小闭环。",
  };
}

function initialPlaybackConfirmed(session: DemandInterviewSessionInput): boolean {
  return session.initial_playback?.confirmed === true;
}

function requirementChecklist(session: DemandInterviewSessionInput): string[] {
  const desiredOutcomes = itemsForSlot(session, "desired_outcome");
  const source = desiredOutcomes.length > 0 ? desiredOutcomes : itemsForSlot(session, "success_criteria");
  const unique = [...new Set(source.map(clean).filter(Boolean))];
  return unique.map((item, index) => `R-${String(index + 1).padStart(3, "0")}  ${item}`);
}

function recommendedAnswer(question: DemandInterviewQuestion, session: DemandInterviewSessionInput): string {
  if (question.id === "premise_decision") return premiseJudgment(session).recommended_answer;
  if (question.id === "target_users") {
    const objective = clean(session.objective || session.title || "这项需求");
    return `建议先写：每天直接处理“${objective}”的业务人员，以及最终为结果负责或查看结果的人。`;
  }
  if (question.confirmation_gate === true) {
    return question.id === "execution_approval" ? "批准" : "确认";
  }
  return clean(question.accepts?.examples?.[0]);
}

function decorateProtocolQuestion(question: DemandInterviewQuestion, session: DemandInterviewSessionInput): DemandInterviewQuestion {
  if (!question.stage) return question;
  const recommendation = recommendedAnswer(question, session);
  let prompt = clean(question.plain_language_prompt);
  if (question.id === "premise_decision") {
    const judgment = premiseJudgment(session);
    prompt = `${stageSummary(session, "premise")}\n\n建议判断：${judgment.recommended_answer}。原因：${judgment.reason}\n\n${prompt}`;
  } else if (question.id === "requirements_confirmation") {
    const checklist = requirementChecklist(session);
    prompt = `${checklist.length ? checklist.join("\n") : "R-001  （尚无可确认的需求）"}\n\n${prompt}`;
  } else if (question.confirmation_gate === true && question.gate_for) {
    prompt = `${stageSummary(session, question.gate_for)}\n\n${prompt}`;
  }
  return {
    ...question,
    plain_language_prompt: prompt,
    text: prompt,
    recommended_answer: recommendation,
    recommendation_reason: recommendation ? "根据已收集的需求和项目上下文生成，可直接确认或修改。" : undefined,
  };
}

function invalidProtocolGateSlots(session: DemandInterviewSessionInput): string[] {
  if (!protocolEnabled(session)) return [];
  return ["layer_1", "layer_2", "layer_3", "layer_4", "requirements_replay"]
    .filter((stageId) => !layerGateState(session, stageId).confirmed)
    .map((stageId) => clean(stageDefinition(stageId)?.confirmation_question_id))
    .filter(Boolean);
}

function approvalState(session: DemandInterviewSessionInput = Object()) {
  const record = answerRecordForSlot(session, "execution_approval");
  return {
    answered: hasAnswer(record),
    approved: record?.normalized?.approved === true || parseApproval(record?.answer),
    answer: record?.answer,
    answered_at: record?.answered_at || null,
  };
}

function nextQuestionFromFollowUp(followUp: DemandInterviewFollowUpQuestion | null | undefined, questions: DemandInterviewQuestion[] = DEMAND_INTERVIEW_QUESTION_BANK): DemandInterviewQuestion | null {
  if (!followUp) return null;
  const original = questionById(followUp.question_id, questions) || questionBySlot(followUp.slot, questions);
  const prompt = clean(followUp.plain_language_prompt || followUp.text || followUp.message || original?.plain_language_prompt);
  const questionId = clean(followUp.question_id || original?.id || followUp.slot);
  return {
    ...(original || {}),
    id: questionId,
    question_id: questionId,
    slot: clean(followUp.slot || original?.slot || questionId),
    category: clean(followUp.category || original?.category || followUp.slot),
    plain_language_prompt: prompt,
    text: prompt,
    why_it_matters: original?.why_it_matters,
    follow_up: true,
    follow_up_id: followUp.id,
    follow_up_code: followUp.code,
    follow_up_reason: followUp.reason,
    follow_up_severity: followUp.severity || "warning",
    original_prompt: original?.plain_language_prompt,
  };
}

export function selectDemandInterviewNextQuestion(session: DemandInterviewSessionInput = Object(), coverage = inspectDemandInterviewCoverage(session)): DemandInterviewQuestion | null {
  const questions = session.questions || DEMAND_INTERVIEW_QUESTION_BANK;
  if (protocolEnabled(session)) {
    const judgment = premiseJudgment(session);
    if (judgment.decision === "do_not_continue") return null;

    for (const stage of PM_PROTOCOL_STAGES) {
      if (stage.id === "layer_1" && judgment.decision === "continue" && !initialPlaybackConfirmed(session)) return null;
      const questionsInStage = stageQuestions(session, stage.id);
      for (const question of questionsInStage) {
        const followUp = (coverage.follow_up_questions || []).find((item) => item.question_id === question.id);
        if (followUp) return decorateProtocolQuestion(nextQuestionFromFollowUp(followUp, questions) || question, session);
        const record = answerRecords(session.answers)[question.id || ""];
        const needsAnswer = question.id === "premise_decision"
          ? parsePremiseDecision(record?.answer) === null
          : question.id === "execution_approval"
            ? parseApprovalDecision(record?.answer) !== true
            : question.confirmation_gate === true
              ? !layerGateState(session, clean(question.gate_for || question.stage)).confirmed
              : !hasAnswer(record);
        if (needsAnswer) return decorateProtocolQuestion(question, session);
      }
    }
    return null;
  }
  const followUp = (coverage.follow_up_questions || [])[0];
  if (followUp) return nextQuestionFromFollowUp(followUp, questions);
  const missing = new Set(coverage.missing.map((item) => item.question_id));
  return questions.find((question) => missing.has(question.id)) || null;
}

function ledgerInfo({ id, demandId, projectRoot, stateRoot }: { id: string; demandId: string; projectRoot: string; stateRoot: string }) {
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

export function inspectDemandInterviewCoverage(session: DemandInterviewSessionInput = Object()): DemandInterviewCoverage {
  const questions = session.questions || DEMAND_INTERVIEW_QUESTION_BANK;
  const answers = answerRecords(session.answers);
  const answered = questions
    .map((question) => ({ question, record: answers[question.id || ""] }))
    .filter((item) => hasAnswer(item.record))
    .map(({ question, record }) => ({
      question_id: question.id,
      slot: question.slot,
      category: question.category,
      answered_at: record.answered_at || null,
    }));
  const answerQuality = answeredQualityItems(session, questions);
  const quality = qualitySummary(answerQuality);
  const followUpPlan = followUpPlanForQuality(answerQuality);
  const followUpQuestions = followUpPlan.follow_up_questions;
  const acceptedAssumptions = acceptedAssumptionsFromQuality(answerQuality);
  const protocol = protocolEnabled(session);
  const premise = protocol ? premiseJudgment(session) : null;
  const stopped = premise?.decision === "do_not_continue";
  const awaitingInitialPlayback = premise?.decision === "continue" && !initialPlaybackConfirmed(session);
  const hasFollowUps = followUpQuestions.length > 0;
  const discussFollowUps = followUpQuestions.filter((question) => DISCUSS_REQUIRED_SLOTS.includes(question.slot));

  const missingDiscuss = missingSlots(session, DISCUSS_REQUIRED_SLOTS);
  const requiredPrdSlots = questions.some((question) => question.slot === "ui_acceptance")
    ? [...PRD_REQUIRED_SLOTS, "ui_acceptance"]
    : PRD_REQUIRED_SLOTS;
  const invalidGateSlots = invalidProtocolGateSlots(session);
  const missingPrd = [...new Set([
    ...missingSlots(session, requiredPrdSlots),
    ...invalidGateSlots,
  ])];
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
  const readyForDiscuss = !stopped && !awaitingInitialPlayback && missingDiscuss.length === 0 && discussFollowUps.length === 0;
  const readyForPrdIntake = !stopped && !awaitingInitialPlayback && missingPrd.length === 0 && approval.approved === true && !hasFollowUps;
  const blockers = [
    ...missingPrd.map((slot) => ({
      code: `MISSING_${slot.toUpperCase()}`,
      slot,
      message: `${questionBySlot(slot, questions)?.category || slot} is required before PRD intake.`,
    })),
    ...followUpQuestions.map((question) => ({
      code: question.code || `FOLLOW_UP_${String(question.slot).toUpperCase()}`,
      slot: question.slot,
      message: question.plain_language_prompt,
      reason: question.reason,
    })),
    ...(approval.approved ? [] : [{
      code: "APPROVAL_REQUIRED",
      slot: "execution_approval",
      message: "Explicit user approval is required before PRD intake.",
    }]),
    ...(awaitingInitialPlayback ? [{
      code: "INITIAL_PLAYBACK_REQUIRED",
      slot: "initial_playback",
      message: "Confirm the scenario playback before entering layer one.",
    }] : []),
    ...(stopped ? [{
      code: "PREMISE_DO_NOT_CONTINUE",
      slot: "premise_decision",
      message: "The premise judgment explicitly stopped this demand before the four layers.",
    }] : []),
  ];
  const warnings = followUpQuestions.map((question) => ({
    code: question.code || `FOLLOW_UP_${String(question.slot).toUpperCase()}`,
    slot: question.slot,
    severity: question.severity || "warning",
    message: question.plain_language_prompt,
    reason: question.reason,
  }));
  const totalRequired = requiredPrdSlots.length + 1;
  const answeredRequired = requiredPrdSlots.filter((slot) => !missingPrd.includes(slot)).length + (approval.approved ? 1 : 0);
  const layerGates = Object.fromEntries(
    ["layer_1", "layer_2", "layer_3", "layer_4", "requirements_replay"]
      .map((stageId) => [stageId, layerGateState(session, stageId)]),
  );
  const activeStage = stopped
    ? null
    : awaitingInitialPlayback
      ? "initial_playback"
      : PM_PROTOCOL_STAGES.find((stage) => stageQuestions(session, stage.id).some((question) => {
        const record = answers[question.id || ""];
        if (question.id === "execution_approval") return parseApprovalDecision(record?.answer) !== true;
        if (question.confirmation_gate === true) return !layerGateState(session, clean(question.gate_for || question.stage)).confirmed;
        return !hasAnswer(record) || followUpQuestions.some((followUp) => followUp.question_id === question.id);
      }))?.id || null;
  const nextActionPrompt = stopped
    ? "Premise judgment is do-not-continue. Start a new interview only if the business premise changes."
    : awaitingInitialPlayback
      ? "Generate and confirm the scenario playback before layer one."
      : followUpQuestions[0]?.plain_language_prompt
    || missing[0]?.plain_language_prompt
    || (readyForPrdIntake ? "Convert interview answers to demand input and run demand discuss/PRD intake." : "Review interview status before continuing.");

  return {
    schema_version: DEMAND_INTERVIEW_SCHEMA_VERSION,
    schema: "yolo.demand.interview.coverage.v1",
    answered,
    answered_slots: answered.map((item) => item.slot),
    answer_quality: answerQuality,
    quality,
    follow_up_questions: followUpQuestions,
    follow_up_plan: followUpPlan,
    assumptions: acceptedAssumptions,
    missing,
    missing_slots: missing.map((item) => item.slot),
    approval,
    ready_for_discuss: readyForDiscuss,
    ready_for_prd_intake: readyForPrdIntake,
    active_stage: activeStage,
    awaiting_initial_playback: awaitingInitialPlayback,
    stopped,
    premise_judgment: premise || undefined,
    layer_gates: layerGates,
    requirement_checklist: requirementChecklist(session),
    readiness: {
      status: stopped ? "stopped" : readyForPrdIntake ? "ready" : hasFollowUps ? "needs_follow_up" : readyForDiscuss ? "discuss_ready" : "collecting",
      ready_for_discuss: readyForDiscuss,
      ready_for_prd_intake: readyForPrdIntake,
      quality_score: Math.round((answeredRequired / totalRequired) * 100),
      answer_quality_score: quality.score,
      answer_quality: quality,
      blockers,
      warnings,
      follow_up_questions: followUpQuestions,
      follow_up_plan: followUpPlan,
      assumptions: acceptedAssumptions,
      next_actions: [nextActionPrompt].filter(Boolean),
    },
  };
}

function refreshSession(session: DemandInterviewSession): DemandInterviewSession {
  session.questions = decorateQuestions(session.questions || DEMAND_INTERVIEW_QUESTION_BANK, session.answers || {});
  const coverage = inspectDemandInterviewCoverage(session);
  session.accepted_assumptions = coverage.assumptions;
  session.assumptions = acceptedAssumptionMessages(coverage.assumptions);
  session.coverage = coverage;
  session.readiness = coverage.readiness;
  session.follow_up_questions = coverage.follow_up_questions;
  session.follow_up_plan = coverage.follow_up_plan;
  session.next_question = selectDemandInterviewNextQuestion(session, coverage);
  return session;
}

function invalidateProtocolConfirmations(session: DemandInterviewSessionInput, changedQuestion: DemandInterviewQuestion, now: string) {
  if (!changedQuestion.stage || changedQuestion.confirmation_gate === true) return;
  const changedStageIndex = PM_PROTOCOL_STAGES.findIndex((stage) => stage.id === changedQuestion.stage);
  if (changedStageIndex < 0) return;
  const answers = answerRecords(session.answers);
  for (const stage of PM_PROTOCOL_STAGES.slice(changedStageIndex)) {
    const gateId = stage.confirmation_question_id;
    if (gateId && gateId !== changedQuestion.id) delete answers[gateId];
  }
  session.answers = answers;
  if (changedQuestion.stage === "premise" && session.initial_playback) {
    session.initial_playback = {
      ...session.initial_playback,
      confirmed: false,
      invalidated_at: now,
      invalidation_reason: "premise_answer_changed",
    };
  }
}

export function createDemandInterviewSession(input: DemandRuntimeInput = Object(), options: DemandRuntimeOptions = Object()): DemandInterviewSession {
  const now = nowIso(options);
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const objective = clean(input.objective || input.idea || input.title);
  const id = makeId("DINT", input, now);
  const demandId = makeDemandId(input, now);
  const uiRequested = input.ui === true || input.interface === "ui" || /\b(?:ui|page|screen|browser|frontend)\b|界面|页面|前端/i.test(objective);
  const existingAdapter = uiRequested && resolveProjectContext({ projectRoot, stateRoot }).selected.acceptance_adapter.id !== "unknown/custom";
  const questions = DEMAND_INTERVIEW_QUESTION_BANK.filter((question) => question.slot !== "ui_acceptance" || (uiRequested && !existingAdapter));
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
    questions: decorateQuestions(questions, {}),
    answers: {},
    follow_up_counts: {},
    accepted_assumptions: [],
    ledgers: ledgerInfo({ id, demandId, projectRoot, stateRoot }),
  };
  return refreshSession(session);
}

export function answerDemandInterviewQuestion(
  session: DemandInterviewSessionInput,
  { questionId, answer, now }: { questionId?: string; answer?: unknown; now?: string } = Object(),
): DemandInterviewSession {
  const question = questionById(questionId, session?.questions || DEMAND_INTERVIEW_QUESTION_BANK);
  if (!question) {
    throw new Error(`Unknown demand interview question: ${questionId}`);
  }
  const answeredAt = clean(now) || new Date().toISOString();
  invalidateProtocolConfirmations(session, question, answeredAt);
  const baseQuality = answerQualityFor(question, answer);
  const followUpReason = cappedFollowUpReason(baseQuality);
  const followUpCounts = followUpCountRecords(session.follow_up_counts);
  let quality = baseQuality;
  if (followUpReason) {
    const slot = clean(question.slot || question.id);
    const current = followUpCounts[slot] || {
      slot,
      count: 0,
      reasons: [],
      updated_at: null,
    };
    const nextCounter = {
      slot,
      count: current.count + 1,
      reasons: compactReasons([...current.reasons, followUpReason]),
      updated_at: answeredAt,
    };
    followUpCounts[slot] = nextCounter;
    if (nextCounter.count > MAX_GUIDED_FOLLOW_UPS_PER_SLOT) {
      quality = blockAfterGuidedFollowUps(question, baseQuality, nextCounter);
    }
  }
  session.follow_up_counts = followUpCounts;
  const normalized = normalizeAnswer(question, answer);
  if (question.confirmation_gate === true && question.gate_for && question.slot !== "premise_decision" && question.slot !== "execution_approval") {
    normalized.confirmed_content_hash = stageContentHash(session, question.gate_for);
  }
  session.answers = {
    ...answerRecords(session.answers),
    [question.id]: {
      question_id: question.id,
      slot: question.slot,
      category: question.category,
      answer,
      normalized,
      quality,
      answered_at: answeredAt,
    },
  };
  session.updated_at = answeredAt;
  const playback = session.playback && typeof session.playback === "object"
    ? session.playback as DemandRecord & { confirmed?: boolean }
    : null;
  if (playback?.confirmed === true) {
    session.playback = {
      ...playback,
      confirmed: false,
      invalidated_at: answeredAt,
      invalidation_reason: "interview_answer_changed",
    };
  }
  return refreshSession(session as DemandInterviewSession);
}

function itemsForSlot(session: DemandInterviewSessionInput, slot: string): string[] {
  const record = answerRecordForSlot(session, slot);
  if (!record) return [];
  if (Array.isArray(record.normalized?.items)) return record.normalized.items;
  return splitList(record.answer);
}

function textForSlot(session: DemandInterviewSessionInput, slot: string): string {
  const record = answerRecordForSlot(session, slot);
  return record?.normalized?.text || textFromValue(record?.answer);
}

function answeredQuestionRounds(session: DemandInterviewSessionInput = Object()) {
  const answers = answerRecords(session.answers);
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

function decisionLines(session: DemandInterviewSessionInput = Object()): string[] {
  const lines: string[] = [];
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

export function demandInterviewToDemandInput(session: DemandInterviewSessionInput): DemandRuntimeInput {
  const coverage = inspectDemandInterviewCoverage(session);
  const followUpPrompts = (coverage.follow_up_questions || [])
    .map((item) => item.plain_language_prompt)
    .filter(Boolean);
  const acceptedAssumptionMessagesForDemand = acceptedAssumptionMessages(coverage.assumptions);
  const targetUsers = itemsForSlot(session, "target_users");
  const statusQuo = itemsForSlot(session, "status_quo");
  const painPoints = itemsForSlot(session, "pain_points");
  const desiredOutcomes = itemsForSlot(session, "desired_outcome");
  const successCriteria = itemsForSlot(session, "success_criteria");
  const scopeBoundaries = itemsForSlot(session, "scope_boundaries");
  const exceptions = itemsForSlot(session, "exceptions");
  const roadmap = itemsForSlot(session, "mvp_priority");
  const confirmedRequirements = (coverage.requirement_checklist || [])
    .map((item) => item.replace(/^R-\d{3}\s+/, "").trim())
    .filter(Boolean);
  const approval = approvalState(session);
  const acceptanceAdapter = answerRecordForSlot(session, "ui_acceptance")?.normalized?.acceptance_adapter;
  const objective = clean(session.objective || session.title || desiredOutcomes[0] || painPoints[0]);

  return {
    demand_id: clean(session.demand_id) || makeDemandId({ title: session.title || objective }, clean(session.generated_at)),
    title: clean(session.title || objective || "Demand interview"),
    objective,
    idea: objective,
    projectRoot: clean(session.projectRoot || session.project_root) || undefined,
    project_root: clean(session.projectRoot || session.project_root) || undefined,
    stateRoot: clean(session.stateRoot || session.state_root) || undefined,
    state_root: clean(session.stateRoot || session.state_root) || undefined,
    phase: "discuss",
    source: "yolo-demand-interview",
    mode: "interview",
    target_users: targetUsers,
    status_quo: statusQuo,
    problem: painPoints.join("; ") || objective,
    success_criteria: [...new Set([...desiredOutcomes, ...successCriteria])],
    proof: successCriteria,
    non_goals: scopeBoundaries,
    constraints: scopeBoundaries,
    exceptions,
    roadmap,
    requirement_checklist: confirmedRequirements,
    premise_challenges: [
      textForSlot(session, "premise_consequence"),
      textForSlot(session, "mvp_priority"),
      clean(coverage.premise_judgment?.decision),
    ].filter(Boolean),
    acceptance_adapter: acceptanceAdapter || undefined,
    decisions: decisionLines(session),
    questions: answeredQuestionRounds(session),
    answers: answeredQuestionRounds(session).map((round) => round.answer),
    approve: approval.approved === true,
    approved_by: "user",
    approved_at: approval.approved ? approval.answered_at : null,
    approval_note: textFromValue(approval.answer),
    assumptions: [
      "Interview answers are user-provided and should be validated against product or operational evidence before implementation.",
      ...acceptedAssumptionMessagesForDemand,
    ],
    followups: followUpPrompts,
    open_questions: coverage.ready_for_prd_intake
      ? []
      : [...new Set([
        ...followUpPrompts,
        ...coverage.missing.map((item) => item.plain_language_prompt).filter(Boolean),
      ])],
    interview: {
      id: session.id,
      schema: session.schema,
      schema_version: session.schema_version,
      coverage: {
        ready_for_discuss: coverage.ready_for_discuss,
        ready_for_prd_intake: coverage.ready_for_prd_intake,
        missing_slots: coverage.missing_slots,
        answered_slots: coverage.answered_slots,
        quality: coverage.quality,
        answer_quality: coverage.answer_quality,
        follow_up_questions: coverage.follow_up_questions,
        follow_up_plan: coverage.follow_up_plan,
        assumptions: coverage.assumptions,
        warnings: coverage.readiness.warnings,
        active_stage: coverage.active_stage,
        premise_judgment: coverage.premise_judgment,
        layer_gates: coverage.layer_gates,
        requirement_checklist: coverage.requirement_checklist,
      },
      accepted_assumptions: coverage.assumptions,
    },
    ledgers: session.ledgers && typeof session.ledgers === "object" ? session.ledgers as DemandRecord : undefined,
    playback: session.playback && typeof session.playback === "object" ? session.playback as DemandRecord : null,
  };
}
