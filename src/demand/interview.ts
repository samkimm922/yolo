import { isAbsolute, join, resolve } from "node:path";

export const DEMAND_INTERVIEW_SCHEMA_VERSION = "1.0";
export const DEMAND_INTERVIEW_SCHEMA = "yolo.demand.interview.v1";

// Closed set of interview slots — the question bank and every slot-keyed lookup
// table (SLOT_FOLLOW_UPS / SLOT_QUALITY_RULES) key off these. Typing them as a
// literal union (not `string`) keeps the lookups compile-checked while staying
// zero-runtime-cost.
export type InterviewSlot =
  | "target_users"
  | "status_quo"
  | "pain_points"
  | "desired_outcome"
  | "success_criteria"
  | "success_proof"
  | "scope_boundaries"
  | "exceptions"
  | "mvp_priority"
  | "execution_approval";

// Loose input/options records (the N4 pattern): interview inputs are assembled
// from user/agent data and read as `Record<string, unknown>`, narrowed at each
// touch point, never widened to `any`.
type Loose = Record<string, unknown>;

export interface InterviewQuestionAccepts {
  free_text?: boolean;
  boolean?: boolean;
  examples?: string[];
}

// A "next question" may be a bank question OR a synthesized follow-up question
// (which carries extra follow_up_* fields). All fields optional and NO index
// signature: this stays structurally compatible with the CLI's own
// all-optional InterviewQuestion (which also has no index signature) at the
// boundary (N7 alignment: adding an index signature here would make the CLI's
// type fail to assign into this one). `accepts`/`required_for` are present so
// spreading a bank question into a follow-up result type-checks.
export interface InterviewNextQuestion {
  id?: string;
  question_id?: string;
  slot?: string;
  category?: string;
  plain_language_prompt?: string;
  text?: string;
  why_it_matters?: string;
  accepts?: InterviewQuestionAccepts;
  required_for?: string[];
  follow_up?: boolean;
  follow_up_id?: string;
  follow_up_code?: string;
  follow_up_reason?: string | null;
  follow_up_severity?: string;
  original_prompt?: string;
}

// All fields optional so this is structurally compatible with the CLI's own
// InterviewQuestion (all-optional) — the demand interview functions accept
// either shape at the boundary (N7 alignment: demand types must not require the
// CLI's record to match a stricter shape). No index signature: the CLI's
// InterviewQuestion has none, and adding one here would make *it* fail to
// assign into this type.
export interface InterviewQuestion {
  id?: string;
  slot?: InterviewSlot | string;
  category?: string;
  plain_language_prompt?: string;
  why_it_matters?: string;
  accepts?: InterviewQuestionAccepts;
  required_for?: string[];
}

export interface FollowUpQuestion {
  id?: string;
  question_id?: string;
  slot?: InterviewSlot | string;
  category?: string;
  severity?: string;
  code?: string;
  reason?: string | null;
  plain_language_prompt?: string;
  text?: string;
  message?: string;
  [key: string]: unknown;
}

export interface AnswerQuality {
  score: number;
  level: "missing" | "sufficient" | "needs_follow_up";
  reasons: string[];
  follow_up_questions: FollowUpQuestion[];
}

export interface NormalizedAnswer {
  approved?: boolean;
  text?: string;
  items?: string[];
  [key: string]: unknown;
}

// Answer records are user/agent-produced and read loosely here; they are typed
// as a record with the consumed fields plus an index signature for passthrough
// fields (the established N4 pattern).
export interface AnswerRecord {
  question_id?: string;
  slot?: InterviewSlot | string;
  category?: string;
  answer?: unknown;
  normalized?: NormalizedAnswer;
  quality?: AnswerQuality & { score?: unknown; level?: unknown; reasons?: unknown; follow_up_questions?: unknown };
  answer_quality?: AnswerQuality & { score?: unknown; level?: unknown; reasons?: unknown; follow_up_questions?: unknown };
  answered_at?: string | null;
  [key: string]: unknown;
}

// The interview session is assembled by createDemandInterviewSession and then
// mutated in place by refreshSession/answerDemandInterviewQuestion (fields are
// assigned onto it), so the index signature preserves that mutability without
// `any`. `coverage` is a large structured object built by
// inspectDemandInterviewCoverage; it is carried opaquely here.
//
// Note on the public boundary: answerDemandInterviewQuestion and
// demandInterviewToDemandInput are also called by the CLI (src/cli/split),
// which passes/accepts its own InterviewState (an opaque `[key: string]:
// unknown` record). Those two entry points therefore accept/return the wider
// `Record<string, unknown>` shape and narrow to InterviewSession internally, so
// demand's precise InterviewSession never has to agree structurally with the
// CLI's type (the N7 cli↔prd alignment pitfall).
export interface InterviewSession {
  schema_version?: string;
  schema?: string;
  id?: string;
  demand_id?: string;
  generated_at?: string;
  updated_at?: string;
  source?: string;
  title?: string;
  objective?: string;
  projectRoot?: string;
  project_root?: string;
  stateRoot?: string;
  state_root?: string;
  questions?: InterviewQuestion[];
  answers?: Record<string, AnswerRecord>;
  ledgers?: Record<string, unknown>;
  coverage?: Record<string, unknown>;
  readiness?: Record<string, unknown>;
  follow_up_questions?: FollowUpQuestion[];
  follow_up_plan?: Record<string, unknown>;
  next_question?: InterviewNextQuestion | null;
  playback?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export const DEMAND_INTERVIEW_QUESTION_BANK: InterviewQuestion[] = [
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

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function asArray<T = unknown>(value: unknown): T[] {
  if (value == null) return [] as T[];
  return (Array.isArray(value) ? value : [value]) as T[];
}

function textFromValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return clean(record.text || record.answer || record.value || record.note || record.details || record.summary);
  }
  return clean(value);
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

function hasPattern(text: unknown, patterns: RegExp[] = []): boolean {
  return patterns.some((pattern) => pattern.test(clean(text)));
}

function compactReasons(reasons: unknown[] = []): string[] {
  return [...new Set(reasons.filter((reason): reason is string => typeof reason === "string" && Boolean(reason)))];
}

const VAGUE_PATTERNS = [
  /^(users?|admins?|customers?|staff|operator|manager|system|平台|用户|客户|管理员|人员|业务|系统)$/i,
  /(etc\.?|等等|之类|相关|一些|某些|各种|多种|优化|提升|改善|更好|方便|智能|自动化|看情况)/i,
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

const SLOT_FOLLOW_UPS: Record<InterviewSlot, Record<string, string>> = {
  target_users: {
    missing_detail: "请补充具体业务角色、他们多久遇到一次这个场景，以及他们负责处理什么结果。",
    technical_only: "先不用写技术组件，请换成真实使用或负责的人：是什么角色、在什么频率下用、要负责什么。",
    not_role: "这看起来像功能或命令，不像业务角色。请改写成真实使用或负责的人：是什么角色、使用频率、负责什么结果。",
    vague: "“用户”还不够具体，请写出角色名称、使用频率和责任，比如谁每天/每周要靠它完成什么。",
  },
  status_quo: {
    missing_detail: "请描述现在实际怎么处理：谁在做、用什么表格/系统/人工办法、卡在哪里。",
    technical_only: "请先写业务现场流程，而不是技术实现：现在谁怎么处理这个问题？",
    vague: "请把现状说成一个真实流程：从发现问题到处理完，中间现在怎么走。",
  },
  pain_points: {
    missing_detail: "请补充最耽误时间、最容易出错或最影响业务的具体痛点，以及它造成的后果。",
    technical_only: "请把技术问题翻译成业务痛点：它让谁多花时间、错过什么或承担什么风险？",
    vague: "请写一个具体困扰，不要只写“效率低”或“体验不好”：哪里慢、哪里错、影响谁。",
  },
  desired_outcome: {
    missing_detail: "请补充做好后用户能完成的动作，或业务状态会变成什么样。",
    technical_only: "请先不写技术方案，改写成用户或业务结果：谁能做什么，结果怎么变好。",
    vague: "目标需要更具体：用户看到什么、能做什么、业务上减少什么问题。",
  },
  success_criteria: {
    missing_detail: "请补充可验收标准：用户看得到什么，或业务能用什么结果判断已经完成。",
    technical_only: "请把技术交付物换成验收现象：页面、流程或数据上要看到什么才算成功。",
    vague: "“更好/更快”还不能验收，请写成可观察的通过条件。",
  },
  success_proof: {
    missing_detail: "请说明现场怎么证明：用什么样例、页面检查、指标或人工验收步骤来确认它真的有效。",
    technical_only: "请把技术验证换成现场证明方式：验收时怎么操作、看什么结果。",
    vague: "证明方式需要能执行：谁拿什么数据或样例，在哪里看到什么结果，才算通过。",
  },
  scope_boundaries: {
    missing_detail: "请明确这次不做什么、不碰哪些流程/渠道/用户/数据，避免范围扩大。",
    technical_only: "请把技术边界换成业务边界：哪些流程、数据、渠道或用户这次不要改。",
    vague: "边界需要直接写“不做/不改/不覆盖”：这次哪些事情先排除。",
  },
  exceptions: {
    missing_detail: "请补充至少一个特殊情况，或明确写“没有特殊情况”。",
    technical_only: "请换成用户会遇到的异常场景：哪些情况如果没处理好会让结果不可信。",
    vague: "异常需要具体一点：什么数据缺失、状态冲突或边界场景要特别处理。",
  },
  mvp_priority: {
    missing_detail: "请拆成第一版必须有的内容，以及可以后做的内容。",
    technical_only: "请用业务优先级表达：第一版必须支撑哪条流程，哪些技术或能力可以后做。",
    vague: "MVP 需要有取舍：第一版保留什么、暂缓什么。",
  },
  execution_approval: {
    missing_detail: "请明确回答“批准”或“暂不批准”，如果暂不批准请说明还缺什么。",
    technical_only: "请直接确认是否批准进入 PRD intake。",
    vague: "请明确批准状态：批准进入 PRD，还是暂不批准继续补信息。",
  },
};

const SLOT_QUALITY_RULES: Partial<Record<InterviewSlot, { detail: RegExp[] }>> = {
  target_users: {
    detail: [
      /manager|customer|support|sales|ops|operator|user|store|admin|owner|analyst|店长|客服|主管|运营|销售|财务|法务|用户|客户|门店|仓库|负责人|审核/,
      /daily|weekly|monthly|morning|每[天周月]|每天|每周|每月|早上|上线后|负责|处理|查看|审核|安排|确认/,
    ],
  },
  status_quo: {
    detail: [
      /now|today|currently|manual|spreadsheet|export|email|system|后台|表格|导出|人工|现在|目前|临时|流程|系统/,
      /use|check|scan|copy|send|处理|查看|筛选|复制|发送|登记|来回|靠/,
    ],
  },
  pain_points: {
    detail: [
      /late|slow|error|miss|complain|risk|delay|duplicate|manual|too long|太晚|太慢|出错|遗漏|投诉|风险|耽误|重复|人工/,
      /because|when|after|导致|因为|客户|损失|违约|返工|补救/,
    ],
  },
  desired_outcome: {
    detail: [
      /can|able|before|without|reduce|see|know|finish|complete|能|可以|提前|减少|看到|完成|避免|优先/,
      /manager|customer|user|业务|用户|客户|主管|店长|客服|运营|工单|库存|订单/,
    ],
  },
  success_criteria: {
    detail: [
      /show|display|filter|sort|alert|badge|status|metric|count|rate|list|visible|显示|看到|筛选|提醒|标记|状态|指标|数量|比例/,
      /when|if|below|above|less|more|before|after|当|如果|低于|高于|达到|之前|之后/,
    ],
  },
  success_proof: {
    detail: [
      /test|create|verify|confirm|check|measure|compare|report|metric|验收|新建|验证|确认|检查|对比|指标|报表|现场|证明/,
      /see|show|display|record|log|drop|increase|pass|看到|显示|记录|下降|提升|通过/,
    ],
  },
  scope_boundaries: {
    detail: [
      /do not|don't|doesn't|not |only|exclude|out of scope|without|不做|不改|不碰|不包含|不要|只做|仅|排除|范围外/,
      /supplier|mobile|import|channel|data|role|workflow|供应商|移动端|导入|渠道|数据|角色|流程|权限/,
    ],
  },
  exceptions: {
    detail: [
      /none|no special|empty|missing|failed|offline|duplicate|edge|hidden|deleted|without|should not|default|history|没有|无|缺失|失败|离线|重复|特殊|异常|边界|隐藏|删除|默认|历史/,
    ],
  },
  mvp_priority: {
    detail: [
      /mvp|first|later|phase|must|defer|next|第一版|先|后续|以后|暂缓|必须|优先|阶段/,
      /include|only|support|包含|只做|支持|上线|版本/,
    ],
  },
};

function hasSlotDetail(slot: string, text: string): boolean {
  const rules = SLOT_QUALITY_RULES[slot as InterviewSlot]?.detail || [];
  return rules.length === 0 || rules.some((pattern) => pattern.test(text));
}

function followUpFor(slot: string, reason: string): string {
  const slotPrompts = SLOT_FOLLOW_UPS[slot as InterviewSlot] || {};
  return slotPrompts[reason] || slotPrompts.missing_detail || "请补充一个更具体、可被业务现场确认的回答。";
}

function answerQualityFor(question: InterviewQuestion, answer: unknown): AnswerQuality {
  const text = textFromValue(answer);
  const normalized = clean(text);
  const lower = normalized.toLowerCase();
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
  const hasDetail = question.slot !== "execution_approval" && hasSlotDetail(question.slot, lower);
  const tooShort = !approvalClear && (normalized.length < 14 || tokens.length <= 2);
  const vague = hasPattern(normalized, VAGUE_PATTERNS) && !hasDetail;
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

  const PENALTY_BY_REASON: Record<string, number> = {
    too_short: 30,
    vague: 20,
    technical_only: 35,
    missing_detail: 25,
    not_role: 45,
  };
  const penalty = reasons.reduce((total, reason) => total + (PENALTY_BY_REASON[reason] || 0), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const followUpReason = commandOrFeatureAsRole ? "not_role" : techOnly ? "technical_only" : vague ? "vague" : missingDetail || approvalMissing || tooShort ? "missing_detail" : null;
  const needsFollowUp = score < 75 || Boolean(followUpReason);
  const followUps = needsFollowUp && followUpReason ? [{
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

function nowIso(options: Loose = Object()): string {
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

function makeId(prefix: string, input: Loose = Object(), now: unknown): string {
  return clean(input.id || input.interview_id || input.interviewId)
    || `${prefix}-${idDate(now)}-${slug(input.title || input.idea || input.objective || "PROJECT")}`;
}

function makeDemandId(input: Loose = Object(), now: unknown): string {
  return clean(input.demand_id || input.demandId)
    || `DEMAND-${idDate(now)}-${slug(input.title || input.idea || input.objective || "PROJECT")}`;
}

function resolveRoot(value: unknown, fallback: string = process.cwd()): string {
  return resolve(clean(value) || fallback);
}

function stateRootFor(input: Loose = Object(), options: Loose = Object()): string {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const explicit = input.stateRoot || input.state_root || options.stateRoot || options.state_root;
  return explicit ? (isAbsolute(explicit as string) ? (explicit as string) : resolve(projectRoot, explicit as string)) : join(projectRoot, ".yolo");
}

function questionById(questionId: string, questions: InterviewQuestion[] = DEMAND_INTERVIEW_QUESTION_BANK): InterviewQuestion | undefined {
  return questions.find((question) => question.id === questionId);
}

function questionBySlot(slot: string, questions: InterviewQuestion[] = DEMAND_INTERVIEW_QUESTION_BANK): InterviewQuestion | undefined {
  return questions.find((question) => question.slot === slot);
}

function answerRecordForSlot(session: InterviewSession = Object() as InterviewSession, slot: string): AnswerRecord | null {
  const question = questionBySlot(slot, (session.questions as InterviewQuestion[]) || DEMAND_INTERVIEW_QUESTION_BANK);
  return question ? ((session.answers || {})[question.id] ?? null) : null;
}

function parseApproval(value: unknown): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.approved === true || record.approve === true) return true;
    if (record.approved === false || record.approve === false) return false;
  }
  const text = textFromValue(value).toLowerCase();
  if (!text) return false;
  if (/(暂不|不批准|不要|不能|否|no|false|not approved|do not|don't)/i.test(text)) return false;
  return /(批准|同意|确认|可以|进入\s*prd|approve|approved|yes|true|confirm|confirmed)/i.test(text);
}

function hasAnswer(record: AnswerRecord | null | undefined): boolean {
  if (!record) return false;
  if (record.slot === "execution_approval") {
    return typeof record.answer === "boolean" || textFromValue(record.answer).length > 0;
  }
  if (Array.isArray(record.normalized?.items)) return (record.normalized!.items as unknown[]).length > 0;
  if (Array.isArray(record.answer)) return splitList(record.answer).length > 0;
  if (record.answer && typeof record.answer === "object") return textFromValue(record.answer).length > 0 || Object.keys(record.answer as object).length > 0;
  return textFromValue(record.answer).length > 0;
}

function normalizeAnswer(question: InterviewQuestion, answer: unknown): NormalizedAnswer {
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

function decorateQuestions(questions: InterviewQuestion[] = DEMAND_INTERVIEW_QUESTION_BANK, answers: Record<string, AnswerRecord> = Object()): InterviewQuestion[] {
  return questions.map((question) => ({
    ...question,
    answered: hasAnswer(answers[question.id]),
  }));
}

function missingSlots(session: InterviewSession = Object() as InterviewSession, slots: string[] = []): string[] {
  return slots.filter((slot) => !hasAnswer(answerRecordForSlot(session, slot)));
}

function qualityForAnsweredRecord(question: InterviewQuestion | null | undefined, record: AnswerRecord | null | undefined): AnswerQuality | null {
  if (!question || !hasAnswer(record)) return null;
  const stored = (record.quality || record.answer_quality) as AnswerQuality & { score?: unknown; level?: unknown; reasons?: unknown; follow_up_questions?: unknown } | undefined;
  if (stored && typeof stored === "object" && Number.isFinite(Number(stored.score))) {
    return {
      score: Number(stored.score),
      level: (clean(stored.level || (Number(stored.score) >= 75 ? "sufficient" : "needs_follow_up")) as AnswerQuality["level"]),
      reasons: compactReasons(asArray(stored.reasons)),
      follow_up_questions: asArray<FollowUpQuestion>(stored.follow_up_questions).filter(Boolean),
    };
  }
  return answerQualityFor(question, record!.answer);
}

function answeredQualityItems(session: InterviewSession = Object() as InterviewSession, questions: InterviewQuestion[] = DEMAND_INTERVIEW_QUESTION_BANK) {
  return questions
    .map((question) => {
      const record = (session.answers || {})[question.id];
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
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function followUpPlanForQuality(items: ReturnType<typeof answeredQualityItems> = []) {
  const followUpQuestions: FollowUpQuestion[] = items.flatMap((item) => (item.follow_up_questions as FollowUpQuestion[]) || []);
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

function qualitySummary(items: ReturnType<typeof answeredQualityItems> = []) {
  if (items.length === 0) {
    return {
      score: 0,
      level: "missing",
      checked_slots: [] as string[],
      low_quality_slots: [] as string[],
    };
  }
  const score = Math.round(items.reduce((total, item) => total + Number(item.score || 0), 0) / items.length);
  const lowQuality = items.filter((item) => Number(item.score || 0) < 75 || item.level === "needs_follow_up");
  return {
    score,
    level: lowQuality.length ? "needs_follow_up" : "sufficient",
    checked_slots: items.map((item) => item.slot),
    low_quality_slots: lowQuality.map((item) => item.slot),
  };
}

function approvalState(session: InterviewSession = Object() as InterviewSession) {
  const record = answerRecordForSlot(session, "execution_approval");
  return {
    answered: hasAnswer(record),
    approved: record?.normalized?.approved === true || parseApproval(record?.answer),
    answer: record?.answer,
    answered_at: record?.answered_at || null,
  };
}

function nextQuestionFromFollowUp(followUp: FollowUpQuestion | null | undefined, questions: InterviewQuestion[] = DEMAND_INTERVIEW_QUESTION_BANK): InterviewNextQuestion | null {
  if (!followUp) return null;
  const original = questionById(clean(followUp.question_id), questions) || questionBySlot(clean(followUp.slot), questions);
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

export function selectDemandInterviewNextQuestion(session: InterviewSession | Record<string, unknown> = Object() as InterviewSession, coverage: Record<string, unknown> = inspectDemandInterviewCoverage(session as InterviewSession)): InterviewNextQuestion | null {
  const questions = (session.questions as InterviewQuestion[]) || DEMAND_INTERVIEW_QUESTION_BANK;
  const followUp = ((coverage.follow_up_questions as FollowUpQuestion[]) || [])[0];
  if (followUp) return nextQuestionFromFollowUp(followUp, questions);
  const missing = new Set((coverage.missing as Array<{ question_id?: string }>).map((item) => item.question_id));
  const found = questions.find((question) => missing.has(question.id || ""));
  return found ? found : null;
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

export function inspectDemandInterviewCoverage(session: InterviewSession | Record<string, unknown> = Object() as InterviewSession) {
  const s = session as InterviewSession;
  const questions = (s.questions as InterviewQuestion[]) || DEMAND_INTERVIEW_QUESTION_BANK;
  const answered = questions
    .map((question) => ({ question, record: (s.answers || {})[question.id || ""] }))
    .filter((item) => hasAnswer(item.record))
    .map(({ question, record }) => ({
      question_id: question.id,
      slot: question.slot,
      category: question.category,
      answered_at: record!.answered_at || null,
    }));
  const answerQuality = answeredQualityItems(session, questions);
  const quality = qualitySummary(answerQuality);
  const followUpPlan = followUpPlanForQuality(answerQuality);
  const followUpQuestions = followUpPlan.follow_up_questions;
  const hasFollowUps = followUpQuestions.length > 0;
  const discussFollowUps = followUpQuestions.filter((question) => DISCUSS_REQUIRED_SLOTS.includes(question.slot));

  const missingDiscuss = missingSlots(s, DISCUSS_REQUIRED_SLOTS);
  const missingPrd = missingSlots(s, PRD_REQUIRED_SLOTS);
  const approval = approvalState(s);
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
      next_actions: [nextActionPrompt].filter(Boolean),
    },
  };
}

function refreshSession(session: InterviewSession): InterviewSession {
  session.questions = decorateQuestions((session.questions as InterviewQuestion[]) || DEMAND_INTERVIEW_QUESTION_BANK, session.answers || {});
  session.coverage = inspectDemandInterviewCoverage(session);
  const coverage = session.coverage as Record<string, unknown>;
  const readiness = coverage.readiness;
  session.readiness = readiness && typeof readiness === "object" ? readiness as Record<string, unknown> : undefined;
  session.follow_up_questions = coverage.follow_up_questions as FollowUpQuestion[];
  session.follow_up_plan = coverage.follow_up_plan as Record<string, unknown>;
  session.next_question = selectDemandInterviewNextQuestion(session, coverage);
  return session;
}

export function createDemandInterviewSession(input: Loose = Object(), options: Loose = Object()): InterviewSession {
  const now = nowIso(options);
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const objective = clean(input.objective || input.idea || input.title);
  const id = makeId("DINT", input, now);
  const demandId = makeDemandId(input, now);
  const session: InterviewSession = {
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

export function answerDemandInterviewQuestion(session: InterviewSession | Record<string, unknown>, { questionId, answer, now } = Object() as { questionId?: string; answer?: unknown; now?: string }): InterviewSession {
  const typedSession = session as InterviewSession;
  const question = questionById(clean(questionId), (typedSession?.questions as InterviewQuestion[]) || DEMAND_INTERVIEW_QUESTION_BANK);
  if (!question) {
    throw new Error(`Unknown demand interview question: ${questionId}`);
  }
  const answeredAt = clean(now) || new Date().toISOString();
  typedSession.answers = {
    ...(typedSession.answers || {}),
    [question.id]: {
      question_id: question.id,
      slot: question.slot,
      category: question.category,
      answer,
      normalized: normalizeAnswer(question, answer),
      quality: answerQualityFor(question, answer),
      answered_at: answeredAt,
    },
  };
  typedSession.updated_at = answeredAt;
  return refreshSession(typedSession);
}

function itemsForSlot(session: InterviewSession, slot: string): string[] {
  const record = answerRecordForSlot(session, slot);
  if (!record) return [];
  if (Array.isArray(record.normalized?.items)) return record.normalized!.items as string[];
  return splitList(record.answer);
}

function textForSlot(session: InterviewSession, slot: string): string {
  const record = answerRecordForSlot(session, slot);
  return (record?.normalized?.text as string) || textFromValue(record?.answer);
}

function answeredQuestionRounds(session: InterviewSession = Object() as InterviewSession) {
  const answers = session.answers || {};
  return (session.questions as InterviewQuestion[] || DEMAND_INTERVIEW_QUESTION_BANK)
    .filter((question) => hasAnswer(answers[question.id]))
    .map((question) => ({
      id: question.id,
      category: question.category,
      question: question.plain_language_prompt,
      answer: textFromValue(answers[question.id].answer),
      slot: question.slot,
    }));
}

function decisionLines(session: InterviewSession = Object() as InterviewSession): string[] {
  const lines: string[] = [];
  const categories: Array<[string, string]> = [
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

export function demandInterviewToDemandInput(session: InterviewSession | Record<string, unknown> = Object() as InterviewSession) {
  const s = session as InterviewSession;
  const coverage = inspectDemandInterviewCoverage(s);
  const followUpPrompts = ((coverage.follow_up_questions as FollowUpQuestion[]) || [])
    .map((item) => item.plain_language_prompt)
    .filter(Boolean);
  const targetUsers = itemsForSlot(s, "target_users");
  const statusQuo = itemsForSlot(s, "status_quo");
  const painPoints = itemsForSlot(s, "pain_points");
  const desiredOutcomes = itemsForSlot(s, "desired_outcome");
  const successCriteria = itemsForSlot(s, "success_criteria");
  const successProof = itemsForSlot(s, "success_proof");
  const scopeBoundaries = itemsForSlot(s, "scope_boundaries");
  const exceptions = itemsForSlot(s, "exceptions");
  const roadmap = itemsForSlot(s, "mvp_priority");
  const approval = approvalState(s);
  const objective = clean(s.objective || s.title || desiredOutcomes[0] || painPoints[0]);

  return {
    demand_id: clean(s.demand_id) || makeDemandId({ title: s.title || objective }, s.generated_at),
    title: clean(s.title || objective || "Demand interview"),
    objective,
    idea: objective,
    projectRoot: s.projectRoot || s.project_root,
    project_root: s.projectRoot || s.project_root,
    stateRoot: s.stateRoot || s.state_root,
    state_root: s.stateRoot || s.state_root,
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
    decisions: decisionLines(s),
    questions: answeredQuestionRounds(s),
    answers: answeredQuestionRounds(s).map((round) => round.answer),
    approve: approval.approved === true,
    approved_by: "user",
    approved_at: approval.approved ? approval.answered_at : null,
    approval_note: textFromValue(approval.answer),
    assumptions: [
      "Interview answers are user-provided and should be validated against product or operational evidence before implementation.",
    ],
    followups: followUpPrompts,
    open_questions: coverage.ready_for_prd_intake
      ? []
      : [...new Set([
        ...followUpPrompts,
        ...coverage.missing.map((item) => item.plain_language_prompt).filter(Boolean),
      ])],
    interview: {
      id: s.id,
      schema: s.schema,
      schema_version: s.schema_version,
      coverage: {
        ready_for_discuss: coverage.ready_for_discuss,
        ready_for_prd_intake: coverage.ready_for_prd_intake,
        missing_slots: coverage.missing_slots,
        answered_slots: coverage.answered_slots,
        quality: coverage.quality,
        answer_quality: coverage.answer_quality,
        follow_up_questions: coverage.follow_up_questions,
        follow_up_plan: coverage.follow_up_plan,
        warnings: coverage.readiness.warnings,
      },
    },
    ledgers: s.ledgers,
    playback: s.playback || null,
  };
}
