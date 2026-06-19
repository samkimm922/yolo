export const STORY_ATOMICITY_SCHEMA_VERSION = "1.0";
export const STORY_ATOMICITY_SCHEMA = "yolo.story_atomicity.v1";

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function clean(value) {
  return String(value ?? "").trim();
}

function compact(values) {
  return values.flat(Infinity).map(clean).filter(Boolean);
}

function compactUnique(values) {
  const seen = new Set();
  return compact(values).filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termSource(term) {
  if (term instanceof RegExp) return term.source;
  const value = String(term);
  const escaped = escapeRegex(value);
  return /^[A-Za-z0-9_]+(?: [A-Za-z0-9_]+)*$/.test(value)
    ? `(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`
    : escaped;
}

function termsPattern(terms) {
  return `(?:${terms.map(termSource).join("|")})`;
}

function hasAny(text, terms) {
  const pattern = new RegExp(termsPattern(terms), "i");
  return pattern.test(text);
}

function uniqueSignatures(signatures) {
  const seen = new Set();
  return signatures.filter((signature) => {
    if (seen.has(signature.id)) return false;
    seen.add(signature.id);
    return true;
  });
}

// ── 通用（领域无关）原子性检测 ────────────────────────────────
// 覆盖任意领域的枚举动作、命令链、并列短语和跨层改动信号。
// 原则：显式结构优先，避免把 read/return/display 这类支撑性动作误报为多 story。

// 可独立交付的副作用/变更动词；刻意排除 read/return/show/display/get/fetch/render 等支撑动作。
// 结构化命令清单由枚举形态识别，不依赖这里枚举具体业务命令名。
const DELIVERABLE_VERB_TERMS = [
  "create", "creates", "add", "adds", "delete", "deletes", "remove", "removes",
  "update", "updates", "edit", "edits", "modify", "modifies", "rename", "renames",
  "send", "sends", "upload", "uploads", "download", "downloads",
  "deploy", "deploys", "validate", "validates", "authenticate", "authorize",
  "implement", "implements", "build", "builds", "configure", "configures", "install",
  "connect", "connects", "migrate", "migrates", "sync", "syncs", "export", "exports",
  "import", "imports", "notify", "notifies", "schedule", "schedules", "integrate",
  "transform", "transforms", "generate", "generates", "insert", "inserts",
  "register", "registers", "login", "logout", "encrypt", "encrypts", "paginate",
  "新增", "新建", "创建", "添加", "增加", "删除", "移除", "修改", "编辑", "重命名",
  "发送", "上传", "下载", "部署", "校验", "鉴权", "实现",
  "构建", "配置", "安装", "连接", "迁移", "同步", "导出", "导入", "通知", "集成", "生成", "插入",
];

// 仅用真正的并列连词，刻意排除 / , 、 这类标点——它们会出现在结构性 surface 标签里（如"测试/验证"），
// 用作连词会把自动生成的元数据误判成独立动作。
const GENERIC_STRICT_CONNECTOR = "(?:\\band\\b|\\bplus\\b|\\bthen\\b|\\+|并且|并|以及|同时|然后)";
const GENERIC_PAIR_DISTANCE = 40;

const GENERIC_LAYER_UI_TERMS = ["button", "form", "page", "modal", "dialog", "screen", "component", "input", "按钮", "表单", "页面", "弹窗", "界面", "组件"];
const GENERIC_LAYER_API_TERMS = ["endpoint", "api", "route", "request", "response", "rest", "graphql", "websocket", "接口", "路由", "请求", "响应"];
const GENERIC_LAYER_DB_TERMS = ["database", "table", "query", "schema", "migration", "row", "column ", "数据库", "表", "查询", "字段", "记录"];

const HARD_STORY_BOUNDARY = /\s*[;；。]\s*/u;
const COMPACT_ENUM_PATTERN = /(?<![\w./-])([A-Za-z][A-Za-z0-9_-]{1,31}(?:\s*(?:\/|→|->|=>|\+)\s*[A-Za-z][A-Za-z0-9_-]{1,31}){1,})(?![\w./-])/g;
const COMPACT_ENUM_SEPARATOR = /\s*(?:\/|→|->|=>|\+)\s*/u;
const PHRASE_ENUM_MARKER = /(?:、|，|,|\+|\band\b|\bthen\b|以及|与|和|并且)/iu;
const PHRASE_ENUM_SEPARATOR = /\s*(?:、|，|,|\+|\band\b|\bthen\b|以及|与|和|并且)\s*/iu;
const SHARED_SUFFIX_PATTERN = /^(.+?)\s+(all|each|都|均|皆)\s+(.+)$/iu;
const ENUMERATION_CUE_TAIL_PATTERN = /(?:\b(?:can|supports?|allows?|lets?|provide|provides|includes?)|支持|允许|可以|能够|包含|提供)\s*$/iu;
const ENUMERATION_LEAD_CONTEXT_PATTERN = /(?:\b(?:can|supports?|allows?|lets?|provide|provides|includes?)\b|支持|允许|可以|能够|包含|提供)[\s\S]{0,48}$/iu;
const ENUMERATION_RESULT_CONTEXT_PATTERN = /^\s*(?:flows?|commands?|features?|operations?|actions?|capabilities?|endpoints?|routes?|handlers?|steps?|behaviors?\b|流程|命令|功能|操作|动作|能力|接口|路由|处理器|步骤|行为)/iu;
const ARGUMENT_LIST_TAIL_PATTERN = /(?:\b(?:with|using|by|from|to|for|of|in|as|via)\s*|用|使用|通过|以|按|根据|基于)\s*$/iu;
const ASCII_COMMAND_TOKEN_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,31}$/;
const LEADING_ASCII_COMMAND_PATTERN = /^([A-Za-z][A-Za-z0-9_-]{1,31})(?:\s+(.+))?$/u;
const SUPPORT_ONLY_ACTIONS = new Set([
  "read", "reads", "return", "returns", "show", "shows", "display", "displays",
  "get", "gets", "fetch", "fetches", "render", "renders", "view", "views",
]);

// 名词化的可交付能力（"实现认证 + 邮箱验证 + OAuth" 这类句子动词只有一个，但列了多个独立能力）。
const DELIVERABLE_CAPABILITY_TERMS = [
  "authentication", "authorization", "verification", "validation", "migration",
  "integration", "notification", "deployment", "login", "logout", "signup", "sign up",
  "registration", "oauth", "sso", "single sign-on", "encryption", "pagination",
  "caching", "rate limiting", "localization", "认证", "鉴权", "授权", "验证", "迁移",
  "集成", "通知", "部署", "登录", "登出", "注册", "加密", "分页", "缓存", "限流", "本地化",
  // P2.17 capability noun signals — system-level nouns that typically span layers
  "支付", "付款", "交易", "扣款", "退款", "payment", "transaction", "billing", "checkout", "refund",
  "权限", "许可", "permission", "access control", "rbac", "acl", "role",
  "配置", "设置", "configuration", "settings", "config",
  "搜索", "过滤", "search", "filter",
  "报表", "统计", "report", "analytics", "dashboard",
  "日志", "审计", "logging", "audit", "audit trail",
  "备份", "恢复", "backup", "restore",
];

function distinctDeliverableActions(text) {
  const found = new Set();
  for (const verb of DELIVERABLE_VERB_TERMS) {
    if (new RegExp(termSource(verb), "i").test(text)) {
      // 归并英文时态变体到词根，避免 create/creates 计成两个
      const root = verb.replace(/(s|es)$/i, "").replace(/(创建|新建|新增|添加|增加)/, "create");
      found.add(root.toLowerCase());
    }
  }
  for (const noun of DELIVERABLE_CAPABILITY_TERMS) {
    if (new RegExp(termSource(noun), "i").test(text)) {
      found.add(noun.toLowerCase());
    }
  }
  return found;
}

// P2.17: 单动词 + 能力名词（支付/权限/登录等系统级名词）→ investigate_then_patch 而非直通。
// 这些名词代表通常跨 UI+service+DB 的完整能力，仅一个动词但暗含多层改动。
function detectSingleVerbCapabilityNouns(text) {
  // 先收集能力名词，用于在动词计数中排除充当两者的词（如"配置"既是动词又是能力名词）
  const capabilityNounSet = new Set(DELIVERABLE_CAPABILITY_TERMS.map((noun) => String(noun).toLowerCase()));
  const verbRoots = new Set();
  for (const verb of DELIVERABLE_VERB_TERMS) {
    // 跳过同时出现在能力名词列表中的动词（如"配置"在中文既是动词 configure 也是名词 configuration）
    if (capabilityNounSet.has(String(verb).toLowerCase())) continue;
    if (new RegExp(termSource(verb), "i").test(text)) {
      const root = verb.replace(/(s|es)$/i, "").replace(/(创建|新建|新增|添加|增加)/, "create");
      verbRoots.add(root.toLowerCase());
    }
  }
  const nouns = [];
  for (const noun of DELIVERABLE_CAPABILITY_TERMS) {
    if (new RegExp(termSource(noun), "i").test(text)) {
      nouns.push(noun.toLowerCase());
    }
  }
  return verbRoots.size === 1 && nouns.length >= 1 ? nouns : [];
}

// 两个可交付动作由并列连词在邻近范围连接 → 多 story 信号（避免全局共现误报）。
function hasDeliverablePair(text) {
  const deliv = termsPattern([...DELIVERABLE_VERB_TERMS, ...DELIVERABLE_CAPABILITY_TERMS]);
  const window = `[\\s\\S]{0,${GENERIC_PAIR_DISTANCE}}`;
  return new RegExp(`${deliv}${window}${GENERIC_STRICT_CONNECTOR}${window}${deliv}`, "i").test(text);
}

function crossesAllLayers(text) {
  const ui = hasAny(text, GENERIC_LAYER_UI_TERMS);
  const api = hasAny(text, GENERIC_LAYER_API_TERMS);
  const db = hasAny(text, GENERIC_LAYER_DB_TERMS);
  return ui && api && db;
}

// 框架自动注入的 surface 分类标签（见 artifacts.ts surfaceKindLabel / runtime.ts），
// 不是用户 story 内容；通用检测前剥离，避免把"代码实现"/"测试/验证"当成独立动作。
const STRUCTURAL_SURFACE_LABELS = [
  "用户可见界面", "接口/服务入口", "业务规则/服务逻辑", "数据/持久化", "测试/验证", "文档/说明", "代码实现",
];

function stripStructuralLabels(text) {
  let cleaned = text;
  for (const label of STRUCTURAL_SURFACE_LABELS) {
    cleaned = cleaned.split(label).join(" ");
  }
  return cleaned;
}

function normalizeStorySlice(value) {
  return clean(value)
    .replace(/\s+/g, " ")
    .replace(/^[,，、+/\s]+|[,，、+/\s]+$/g, "");
}

function uniqueStorySlices(values) {
  const seen = new Set();
  const slices = [];
  for (const value of values.map(normalizeStorySlice).filter((item) => item.length >= 3)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    slices.push(value);
  }
  return slices;
}

function splitRepeatedStoryOpeners(text) {
  const matches = [...clean(text).matchAll(/当用户/g)];
  if (matches.length <= 1) return [];
  return matches.map((match, index) => {
    const start = match.index || 0;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return normalizeStorySlice(text.slice(start, end));
  }).filter((item) => item.length >= 6);
}

function actionToken(value) {
  const text = normalizeStorySlice(value);
  const ascii = text.match(/[A-Za-z][A-Za-z0-9_-]*/);
  if (!ascii) return "";
  return ascii[0].toLowerCase();
}

function containsOnlySupportActions(values) {
  const tokens = values.map(actionToken).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => SUPPORT_ONLY_ACTIONS.has(token));
}

function expandCompactEnumeration(clause) {
  const source = normalizeStorySlice(clause);
  const match = [...source.matchAll(COMPACT_ENUM_PATTERN)][0];
  if (!match) return [];
  const sequence = match[1];
  const items = sequence.split(COMPACT_ENUM_SEPARATOR).map(normalizeStorySlice).filter(Boolean);
  if (items.length < 2 || containsOnlySupportActions(items)) return [];
  const start = match.index || 0;
  const end = start + sequence.length;
  const before = source.slice(0, start);
  const after = source.slice(end);
  const deliverableCount = items.filter(hasDeliverableIntent).length;
  const commandLikeItems = items.every((item) => ASCII_COMMAND_TOKEN_PATTERN.test(item) || hasDeliverableIntent(item));
  const hasBoundaryContext = ENUMERATION_LEAD_CONTEXT_PATTERN.test(before) || ENUMERATION_RESULT_CONTEXT_PATTERN.test(after);
  if (!commandLikeItems) return [];
  if (ARGUMENT_LIST_TAIL_PATTERN.test(before) && !ENUMERATION_RESULT_CONTEXT_PATTERN.test(after)) return [];
  if (!hasBoundaryContext && deliverableCount < 2) return [];
  return uniqueStorySlices(items.map((item) => `${before}${item}${after}`));
}

function splitFirstItemPrefix(value) {
  const source = normalizeStorySlice(value);
  const ascii = source.match(/^(.*\s)([A-Za-z][A-Za-z0-9_-]*)$/);
  if (ascii) return { prefix: ascii[1], item: ascii[2] };
  return { prefix: "", item: source };
}

function splitLastItemSuffix(value) {
  const source = normalizeStorySlice(value);
  const shared = source.match(SHARED_SUFFIX_PATTERN);
  if (shared) return { item: normalizeStorySlice(shared[1]), suffix: `${shared[2]} ${shared[3]}` };
  return { item: source, suffix: "" };
}

function splitLeadingCommandSuffix(value) {
  const source = normalizeStorySlice(value);
  const match = source.match(LEADING_ASCII_COMMAND_PATTERN);
  if (!match) return { item: source, suffix: "" };
  return { item: match[1], suffix: normalizeStorySlice(match[2] || "") };
}

function hasDeliverableIntent(value) {
  return hasAny(value, DELIVERABLE_VERB_TERMS) || hasAny(value, DELIVERABLE_CAPABILITY_TERMS);
}

function expandCommandCueEnumeration(rawItems) {
  const first = splitFirstItemPrefix(rawItems[0]);
  if (!ENUMERATION_CUE_TAIL_PATTERN.test(first.prefix)) return [];
  const lastShared = splitLastItemSuffix(rawItems[rawItems.length - 1]);
  const last = lastShared.suffix ? lastShared : splitLeadingCommandSuffix(rawItems[rawItems.length - 1]);
  const middle = rawItems.slice(1, -1).map((item) => splitLeadingCommandSuffix(item).item);
  const items = [first.item, ...middle, last.item].map(normalizeStorySlice).filter(Boolean);
  if (items.length < 2 || !items.every((item) => ASCII_COMMAND_TOKEN_PATTERN.test(item))) return [];
  if (containsOnlySupportActions(items)) return [];
  const suffix = last.suffix ? ` ${last.suffix}` : "";
  return uniqueStorySlices(items.map((item) => `${first.prefix}${item}${suffix}`));
}

function expandPhraseEnumeration(clause) {
  const source = normalizeStorySlice(clause);
  if (!PHRASE_ENUM_MARKER.test(source)) return [];
  if (/^当[\s\S]+?时\s*[，,]/u.test(source) || /^when\b[\s\S]+,\s*(?:then\b)?/iu.test(source)) return [];
  const rawItems = source.split(PHRASE_ENUM_SEPARATOR).map(normalizeStorySlice).filter(Boolean);
  if (rawItems.length < 2 || rawItems.length > 10 || containsOnlySupportActions(rawItems)) return [];
  if (rawItems.length === 2 && rawItems[0].length < 8 && rawItems[1].length >= 12) return [];
  const rawIntentCount = rawItems.filter(hasDeliverableIntent).length;
  if (rawIntentCount >= 2) return uniqueStorySlices(rawItems);
  const commandCue = expandCommandCueEnumeration(rawItems);
  if (commandCue.length > 1) return commandCue;
  const first = splitFirstItemPrefix(rawItems[0]);
  const last = splitLastItemSuffix(rawItems[rawItems.length - 1]);
  const items = [first.item, ...rawItems.slice(1, -1), last.item]
    .map(normalizeStorySlice)
    .filter(Boolean);
  if (items.length < 2) return [];
  const actionItemCount = items.filter((item) => hasAny(item, DELIVERABLE_VERB_TERMS)).length;
  if (actionItemCount < 2) return [];
  const prefix = first.prefix;
  const suffix = last.suffix ? ` ${last.suffix}` : "";
  const expanded = items.map((item) => `${prefix}${item}${suffix}`);
  return uniqueStorySlices(expanded);
}

export function splitGenericStorySlices(text) {
  const source = normalizeStorySlice(text);
  if (!source) return [];
  const repeated = splitRepeatedStoryOpeners(source);
  if (repeated.length > 1) return uniqueStorySlices(repeated.flatMap(splitGenericStorySlices));
  const clauses = source.split(HARD_STORY_BOUNDARY).map(normalizeStorySlice).filter(Boolean);
  if (clauses.length > 1) return uniqueStorySlices(clauses.flatMap(splitGenericStorySlices));
  const compact = expandCompactEnumeration(source);
  if (compact.length > 1) return compact;
  const phrase = expandPhraseEnumeration(source);
  if (phrase.length > 1) return phrase;
  return [source];
}

function genericStructureSignatures(text) {
  const slices = splitGenericStorySlices(text);
  if (slices.length < 2) return [];
  return slices.map((slice, index) => ({
    id: `generic_story_${index + 1}`,
    label: `story unit ${index + 1}: ${textExcerpt(slice)}`,
  }));
}

function detectGenericStories(rawText) {
  const text = stripStructuralLabels(rawText);
  const structural = genericStructureSignatures(text);
  if (structural.length >= 2) return structural;
  const stories = [];
  if (hasDeliverablePair(text)) {
    const verbs = [...distinctDeliverableActions(text)];
    if (verbs.length >= 2) {
      verbs.forEach((verb, index) => {
        stories.push({ id: `generic_action_${index + 1}`, label: `independent action: ${verb}` });
      });
    }
  } else if (crossesAllLayers(text)) {
    stories.push(
      { id: "generic_layer_ui", label: "UI layer change" },
      { id: "generic_layer_api", label: "API layer change" },
      { id: "generic_layer_db", label: "data layer change" },
    );
  }
  return stories;
}

function splitSuggestions(signatures, item) {
  return signatures.map((signature, index) => ({
    id: `${item.id || item.kind || "story"}-S${index + 1}`,
    title: `Split story: ${signature.label}`,
    goal: `Deliver only the ${signature.label} user story; keep the other detected story actions out of scope.`,
  }));
}

function textExcerpt(text) {
  const oneLine = clean(text).replace(/\s+/g, " ");
  return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

export function inspectStoryAtomicityText(text, item = Object()) {
  const normalized = clean(text).toLowerCase();
  let signatures = uniqueSignatures(detectGenericStories(normalized));
  // P2.17: 单动词 + 能力名词（支付/权限/登录等系统级名词）→ warn，建议 investigate_then_patch
  if (signatures.length < 2) {
    const capabilityNouns = detectSingleVerbCapabilityNouns(normalized);
    if (capabilityNouns.length >= 1) {
      const sigRecords = signatures.map((signature) => ({ id: signature.id, label: signature.label }));
      return {
        status: "warn",
        story_count: signatures.length,
        story_signatures: sigRecords,
        finding: {
          code: "STORY_ATOMICITY_CAPABILITY_NOUN",
          severity: "warn",
          kind: item.kind || "story",
          item_id: item.id || null,
          task_id: item.kind === "task" ? item.id || null : null,
          requirement_id: item.kind === "requirement" ? item.id || null : null,
          scenario_id: item.kind === "scenario" ? item.id || null : null,
          message: `${item.kind || "Story"} ${item.id || ""} contains a single verb with system-level capability nouns (${capabilityNouns.join(", ")}) that likely span multiple layers. Recommend investigate_then_patch instead of direct execution.`,
          text_excerpt: textExcerpt(text),
          story_count: signatures.length,
          story_signatures: sigRecords,
          capability_nouns: capabilityNouns,
        },
      };
    }
  }
  if (signatures.length < 2) {
    return {
      status: "pass",
      story_count: signatures.length,
      story_signatures: signatures.map((signature) => ({ id: signature.id, label: signature.label })),
      finding: null,
    };
  }

  const signatureRecords = signatures.map((signature) => ({ id: signature.id, label: signature.label }));
  const finding = {
    code: "STORY_ATOMICITY_MULTI_STORY",
    severity: "error",
    kind: item.kind || "story",
    item_id: item.id || null,
    task_id: item.kind === "task" ? item.id || null : null,
    requirement_id: item.kind === "requirement" ? item.id || null : null,
    scenario_id: item.kind === "scenario" ? item.id || null : null,
    message: `${item.kind || "Story"} ${item.id || ""} mixes ${signatures.length} independent user-story actions: ${signatureRecords.map((signature) => signature.label).join(", ")}.`,
    text_excerpt: textExcerpt(text),
    story_count: signatures.length,
    story_signatures: signatureRecords,
    split_suggestions: splitSuggestions(signatureRecords, item),
  };

  return {
    status: "blocked",
    story_count: signatures.length,
    story_signatures: signatureRecords,
    finding,
  };
}

export function inspectStoryAtomicityItems(items = [], options = Object()) {
  const findings = [];
  const inspected = [];
  for (const item of asArray(items)) {
    const text = clean(item?.text);
    if (!text) continue;
    const result = inspectStoryAtomicityText(text, item);
    inspected.push({
      kind: item.kind || "story",
      id: item.id || null,
      status: result.status,
      story_count: result.story_count,
      story_signatures: result.story_signatures,
    });
    if (result.finding) findings.push(result.finding);
  }

  const errorFindings = findings.filter((finding) => finding.severity !== "warn");
  const warnFindings = findings.filter((finding) => finding.severity === "warn");

  const blockers = errorFindings.map((finding) => ({
    code: finding.code,
    message: finding.message,
    kind: finding.kind,
    item_id: finding.item_id,
    task_id: finding.task_id,
    requirement_id: finding.requirement_id,
    scenario_id: finding.scenario_id,
    story_count: finding.story_count,
    story_signatures: finding.story_signatures,
    split_suggestions: finding.split_suggestions,
  }));

  const warnings = warnFindings.map((finding) => ({
    code: finding.code,
    message: finding.message,
    kind: finding.kind,
    item_id: finding.item_id,
    task_id: finding.task_id,
    requirement_id: finding.requirement_id,
    scenario_id: finding.scenario_id,
    story_count: finding.story_count,
    story_signatures: finding.story_signatures,
    capability_nouns: finding.capability_nouns,
  }));

  return {
    schema_version: STORY_ATOMICITY_SCHEMA_VERSION,
    schema: STORY_ATOMICITY_SCHEMA,
    status: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warn" : "pass",
    inspected_count: inspected.length,
    finding_count: findings.length,
    inspected,
    findings,
    blockers,
    warnings,
    next_actions: blockers.length > 0
      ? [
        "Edit or regenerate the demand session so every blocked requirement, scenario, or task contains one enumerated action only.",
        "Then rerun: yolo spec --demand <session.json|dir>",
      ]
      : warnings.length > 0
        ? ["Capability nouns detected with single verb — investigate before direct execution."]
        : ["Story atomicity passed."],
    ...options.extra,
  };
}

function scenarioText(scenario = Object()) {
  return compactUnique([
    scenario.title,
    scenario.text,
    scenario.desired_behavior,
    scenario.acceptance,
    scenario.then,
  ]).join("\n");
}

function requirementText(requirement = Object()) {
  return compactUnique([
    requirement.title,
    requirement.text,
    requirement.description,
    requirement.goal,
    requirement.user_story,
    requirement.acceptance_criteria,
  ]).join("\n");
}

function taskText(task = Object()) {
  const handoff = task.handoff || {};
  return compactUnique([
    task.description,
    task.goal,
    handoff.plain_language_goal,
    handoff.desired_behavior,
  ]).join("\n");
}

export function collectStoryAtomicityItemsFromDemand(session = Object(), options = Object()) {
  const requirements = options.includeRequirements === false
    ? []
    : asArray(session.requirements?.active || session.requirements).map((requirement, index) => ({
      kind: "requirement",
      id: requirement?.id || `REQ-${index + 1}`,
      text: requirementText(requirement),
    }));
  const scenarios = asArray(session.scenario_matrix?.scenarios || session.scenarios).map((scenario, index) => ({
    kind: "scenario",
    id: scenario?.id || `SCN-${index + 1}`,
    text: scenarioText(scenario),
  }));
  const tasks = asArray(options.tasks || session.tasks).map((task, index) => ({
    kind: "task",
    id: task?.id || `TASK-${index + 1}`,
    text: taskText(task),
  }));
  return [...requirements, ...scenarios, ...tasks];
}

export function collectStoryAtomicityItemsFromPrd(prd = Object()) {
  const requirements = asArray(prd.requirements).map((requirement, index) => ({
    kind: "requirement",
    id: requirement?.id || `REQ-${index + 1}`,
    text: requirementText(requirement),
  }));
  const scenarioSources = [
    prd.scenario_matrix?.scenarios,
    prd.demand?.scenario_matrix?.scenarios,
    prd.scenarios,
  ];
  const scenarios = scenarioSources.flatMap((source) => asArray(source)).map((scenario, index) => ({
    kind: "scenario",
    id: scenario?.id || `SCN-${index + 1}`,
    text: scenarioText(scenario),
  }));
  const tasks = asArray(prd.tasks).map((task, index) => ({
    kind: "task",
    id: task?.id || `TASK-${index + 1}`,
    text: taskText(task),
  }));
  return [...requirements, ...scenarios, ...tasks];
}

export function inspectStoryAtomicityFromDemand(session = Object(), options = Object()) {
  return inspectStoryAtomicityItems(collectStoryAtomicityItemsFromDemand(session, options), {
    extra: { source: "demand" },
  });
}

export function inspectStoryAtomicityFromPrd(prd = Object()) {
  return inspectStoryAtomicityItems(collectStoryAtomicityItemsFromPrd(prd), {
    extra: { source: "prd" },
  });
}
