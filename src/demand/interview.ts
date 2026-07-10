import { isAbsolute, join, resolve } from "node:path";
import type {
  DemandRecord,
  DemandRuntimeInput,
  DemandRuntimeOptions,
  DemandStringListInput,
  DemandTextInput,
} from "./graph.js";

export const DEMAND_INTERVIEW_SCHEMA_VERSION = "1.0";
export const DEMAND_INTERVIEW_SCHEMA = "yolo.demand.interview.v1";

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
}

export const DEMAND_INTERVIEW_QUESTION_BANK: DemandInterviewQuestion[] = [
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

const DISCUSS_REQUIRED_SLOTS: string[] = ["target_users", "status_quo", "pain_points", "desired_outcome"];
const PRD_REQUIRED_SLOTS: string[] = [
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
  target_users: ["role_context"],
  status_quo: ["quantified", "artifact", "assertion"],
  pain_points: ["quantified", "artifact", "assertion", "causal"],
  desired_outcome: ["quantified", "artifact", "assertion"],
  success_criteria: ["quantified", "artifact", "assertion"],
  success_proof: ["quantified", "artifact", "assertion"],
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
  success_proof: {
    missing_detail: "还缺以下任一种：具体数量/日期、可执行的命令或产物名、或“当…时…”/“必须…”式可观察结果。",
    technical_only: "还缺证明动作和结果：请补具体数量/日期、产物名，或“当…时…”式检查结果。",
    vague: "还缺以下任一种：具体数量/日期、可执行的命令或产物名、或“当…时…”式证明步骤。",
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
    && (parseApproval(answer) || /(暂不|不批准|否|no|false|not approved|do not|don't)/i.test(normalized));
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
    severity: "warning",
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
  return questions.find((question) => question.id === questionId);
}

function questionBySlot(slot: unknown, questions: DemandInterviewQuestion[] = DEMAND_INTERVIEW_QUESTION_BANK): DemandInterviewQuestion | undefined {
  return questions.find((question) => question.slot === slot);
}

function answerRecordForSlot(session: DemandInterviewSessionInput = Object(), slot: string): DemandInterviewAnswerRecord | null {
  const question = questionBySlot(slot, session.questions || DEMAND_INTERVIEW_QUESTION_BANK);
  return question ? answerRecords(session.answers)[question.id || ""] : null;
}

function parseApproval(value: unknown): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (value && typeof value === "object") {
    const record = value as DemandRecord & { approved?: boolean; approve?: boolean };
    if (record.approved === true || record.approve === true) return true;
    if (record.approved === false || record.approve === false) return false;
  }
  const text = textFromValue(value).toLowerCase();
  if (!text) return false;
  if (/(暂不|不批准|不要|不能|否|no|false|not approved|do not|don't)/i.test(text)) return false;
  return /(批准|同意|确认|可以|进入\s*prd|approve|approved|yes|true|confirm|confirmed)/i.test(text);
}

function hasAnswer(record?: DemandInterviewAnswerRecord | null): boolean {
  if (!record) return false;
  if (record.slot === "execution_approval") {
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
  const hasFollowUps = followUpQuestions.length > 0;
  const discussFollowUps = followUpQuestions.filter((question) => DISCUSS_REQUIRED_SLOTS.includes(question.slot));

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
  const readyForDiscuss = missingDiscuss.length === 0 && discussFollowUps.length === 0;
  const readyForPrdIntake = missingPrd.length === 0 && approval.approved === true && !hasFollowUps;
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
  ];
  const warnings = followUpQuestions.map((question) => ({
    code: question.code || `FOLLOW_UP_${String(question.slot).toUpperCase()}`,
    slot: question.slot,
    severity: question.severity || "warning",
    message: question.plain_language_prompt,
    reason: question.reason,
  }));
  const totalRequired = PRD_REQUIRED_SLOTS.length + 1;
  const answeredRequired = PRD_REQUIRED_SLOTS.filter((slot) => !missingPrd.includes(slot)).length + (approval.approved ? 1 : 0);
  const nextActionPrompt = followUpQuestions[0]?.plain_language_prompt
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
    readiness: {
      status: readyForPrdIntake ? "ready" : hasFollowUps ? "needs_follow_up" : readyForDiscuss ? "discuss_ready" : "collecting",
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

export function createDemandInterviewSession(input: DemandRuntimeInput = Object(), options: DemandRuntimeOptions = Object()): DemandInterviewSession {
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
  session.answers = {
    ...answerRecords(session.answers),
    [question.id]: {
      question_id: question.id,
      slot: question.slot,
      category: question.category,
      answer,
      normalized: normalizeAnswer(question, answer),
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
  const successProof = itemsForSlot(session, "success_proof");
  const scopeBoundaries = itemsForSlot(session, "scope_boundaries");
  const exceptions = itemsForSlot(session, "exceptions");
  const roadmap = itemsForSlot(session, "mvp_priority");
  const approval = approvalState(session);
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
      },
      accepted_assumptions: coverage.assumptions,
    },
    ledgers: session.ledgers && typeof session.ledgers === "object" ? session.ledgers as DemandRecord : undefined,
    playback: session.playback && typeof session.playback === "object" ? session.playback as DemandRecord : null,
  };
}
