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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termSource(term) {
  if (term instanceof RegExp) return term.source;
  const value = String(term);
  const escaped = escapeRegex(value);
  return /^[A-Za-z0-9_ -]+$/.test(value) ? `\\b${escaped}\\b` : escaped;
}

function termsPattern(terms) {
  return `(?:${terms.map(termSource).join("|")})`;
}

function hasAny(text, terms) {
  const pattern = new RegExp(termsPattern(terms), "i");
  return pattern.test(text);
}

function hasNear(text, verbs, objects, maxDistance = 48) {
  const verb = termsPattern(verbs);
  const object = termsPattern(objects);
  return new RegExp(`${verb}[\\s\\S]{0,${maxDistance}}${object}|${object}[\\s\\S]{0,${maxDistance}}${verb}`, "i").test(text);
}

function hasDirectAction(text, verbs, objects, maxDistance = 28) {
  const verb = termsPattern(verbs);
  const object = termsPattern(objects);
  const boundary = "(?:后|之后|以后|时|的时候|显示|展示|show|display|count|数量|统计|\\+|/|,|，|、|；|;|。|\\n)";
  const between = `(?:(?!${boundary})[\\s\\S]){0,${maxDistance}}`;
  return new RegExp(`${verb}${between}${object}|${object}${between}${verb}`, "i").test(text);
}

function hasActionPair(text, leftTerms, rightTerms, maxDistance = 36) {
  const left = termsPattern(leftTerms);
  const right = termsPattern(rightTerms);
  const connector = "(?:\\+|/|,|，|、|和|并|并且|以及|然后|同时|and|then|plus|with)";
  return new RegExp(`${left}[\\s\\S]{0,${maxDistance}}${connector}[\\s\\S]{0,${maxDistance}}${right}|${right}[\\s\\S]{0,${maxDistance}}${connector}[\\s\\S]{0,${maxDistance}}${left}`, "i").test(text);
}

const CREATE_TERMS = ["新增", "新建", "创建", "添加", "增加", "add", "adds", "added", "adding", "create", "creates", "created", "creating", "new"];
const EDIT_TERMS = ["编辑", "修改", "重命名", "改名", "更名", "edit", "edits", "edited", "editing", "rename", "renames", "update", "updates", "change", "changes"];
const MOVE_TERMS = ["移动", "拖动", "拖拽", "排序", "换列", "move", "moves", "moved", "moving", "drag", "drags", "dragged", "reorder", "reorders"];
const ARCHIVE_TERMS = [/(?<!未)归档/u, "archive", "archives", "archived", "archiving"];
const PERSISTENCE_TERMS = ["刷新", "重新打开", "重载", "持久化", "保留", "仍然", "恢复", "reload", "refresh", "refreshed", "persist", "persists", "persistent", "persistence", "restore", "restores", "recover", "recovers", "remain", "remains"];

const LIST_TERMS = ["列表", "清单", "看板列", "泳道", "列", "list", "lists", "column", "columns", "lane", "lanes"];
const CARD_TERMS = ["卡片", "任务卡", "卡", "card", "cards", "ticket", "tickets"];
const BOARD_ITEM_TERMS = [...LIST_TERMS, ...CARD_TERMS, "看板", "board", "boards"];

const SIGNATURES = [
  {
    id: "create_list",
    label: "create list",
    matches: (text) => hasDirectAction(text, CREATE_TERMS, LIST_TERMS),
  },
  {
    id: "create_card",
    label: "create card",
    matches: (text) => hasDirectAction(text, CREATE_TERMS, CARD_TERMS),
  },
  {
    id: "edit_item",
    label: "edit item",
    matches: (text) => (hasAny(text, EDIT_TERMS) && hasNear(text, EDIT_TERMS, BOARD_ITEM_TERMS))
      || hasActionPair(text, EDIT_TERMS, MOVE_TERMS),
  },
  {
    id: "move_item",
    label: "move item",
    matches: (text) => (hasAny(text, MOVE_TERMS) && hasNear(text, MOVE_TERMS, BOARD_ITEM_TERMS))
      || hasActionPair(text, EDIT_TERMS, MOVE_TERMS),
  },
  {
    id: "archive_item",
    label: "archive item",
    matches: (text) => hasNear(text, ARCHIVE_TERMS, BOARD_ITEM_TERMS)
      || hasActionPair(text, ARCHIVE_TERMS, PERSISTENCE_TERMS),
  },
  {
    id: "persistence_or_restore",
    label: "persistence or restore",
    matches: (text) => hasActionPair(text, ARCHIVE_TERMS, PERSISTENCE_TERMS)
      || (hasAny(text, PERSISTENCE_TERMS) && hasNear(text, PERSISTENCE_TERMS, BOARD_ITEM_TERMS)),
  },
];

function uniqueSignatures(signatures) {
  const seen = new Set();
  return signatures.filter((signature) => {
    if (seen.has(signature.id)) return false;
    seen.add(signature.id);
    return true;
  });
}

// ── 通用（领域无关）原子性检测 ────────────────────────────────
// Kanban signatures 未命中 ≥2 时的兜底层，覆盖任意领域（API/CLI/数据/移动端等）。
// 原则：只在「显式连词连接的多个独立可交付动作」或「跨 UI+API+DB 三层」时判定非原子，
// 保持保守，避免对 read/return/display 这类支撑性动作误报。

// 可独立交付的副作用/变更动词；刻意排除 read/return/show/display/get/fetch/load/render 等支撑动作。
const DELIVERABLE_VERB_TERMS = [
  "create", "creates", "add", "adds", "delete", "deletes", "remove", "removes",
  "update", "updates", "edit", "edits", "modify", "modifies", "rename", "renames",
  "move", "moves", "send", "sends", "upload", "uploads", "download", "downloads",
  "deploy", "deploys", "validate", "validates", "verify", "authenticate", "authorize",
  "implement", "implements", "build", "builds", "configure", "configures", "install",
  "connect", "connects", "migrate", "migrates", "sync", "syncs", "export", "exports",
  "import", "imports", "notify", "notifies", "schedule", "schedules", "integrate",
  "transform", "transforms", "generate", "generates", "insert", "inserts", "parse",
  "register", "registers", "login", "logout", "encrypt", "encrypts", "paginate",
  "新增", "新建", "创建", "添加", "增加", "删除", "移除", "修改", "编辑", "重命名",
  "移动", "拖动", "发送", "上传", "下载", "部署", "校验", "验证", "鉴权", "实现",
  "构建", "配置", "安装", "连接", "迁移", "同步", "导出", "导入", "通知", "集成", "生成", "插入",
];

// 仅用真正的并列连词，刻意排除 / , 、 这类标点——它们会出现在结构性 surface 标签里（如"测试/验证"），
// 用作连词会把自动生成的元数据误判成独立动作。
const GENERIC_STRICT_CONNECTOR = "(?:\\band\\b|\\bplus\\b|\\bthen\\b|\\+|并且|并|以及|同时|然后)";
const GENERIC_PAIR_DISTANCE = 40;

const GENERIC_LAYER_UI_TERMS = ["button", "form", "page", "modal", "dialog", "screen", "component", "input", "按钮", "表单", "页面", "弹窗", "界面", "组件"];
const GENERIC_LAYER_API_TERMS = ["endpoint", "api", "route", "request", "response", "rest", "graphql", "websocket", "接口", "路由", "请求", "响应"];
const GENERIC_LAYER_DB_TERMS = ["database", "table", "query", "schema", "migration", "row", "column ", "数据库", "表", "查询", "字段", "记录"];

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
  "导入", "导出", "import", "export",
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

function detectGenericStories(rawText) {
  const text = stripStructuralLabels(rawText);
  const stories = [];
  if (hasDeliverablePair(text)) {
    const verbs = [...distinctDeliverableActions(text)];
    verbs.forEach((verb, index) => {
      stories.push({ id: `generic_action_${index + 1}`, label: `independent action: ${verb}` });
    });
    // 若去重后只剩一个词根（同一动作重复），仍按 pair 信号给出两个 story 占位以保持 ≥2。
    if (stories.length < 2) {
      stories.length = 0;
      stories.push(
        { id: "generic_action_1", label: "independent action" },
        { id: "generic_action_2", label: "independent action" },
      );
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
  let signatures = uniqueSignatures(SIGNATURES.filter((signature) => signature.matches(normalized)));
  // 通用层只在领域 signatures 完全沉默时启用：领域文本若已被 Kanban 专家检测器判定（哪怕 1 个签名=单一
  // story），就信任它，不用通用规则二次猜测——避免对领域内已判定原子的 task 误报。通用层覆盖 Kanban
  // 词汇之外的领域（API/CLI/数据/移动端等）。
  if (signatures.length === 0) {
    const generic = detectGenericStories(normalized);
    if (generic.length >= 2) signatures = generic;
  }
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
      ? ["Split each blocked requirement, scenario, or task so each one carries exactly one independent user story."]
      : warnings.length > 0
        ? ["Capability nouns detected with single verb — investigate before direct execution."]
        : ["Story atomicity passed."],
    ...options.extra,
  };
}

function conditionText(condition = Object()) {
  return compact([
    condition.message,
    condition.params?.text,
    condition.params?.pattern,
    condition.params?.expected,
  ]).join("\n");
}

function scenarioText(scenario = Object()) {
  return compact([
    scenario.title,
    scenario.text,
    scenario.current_behavior,
    scenario.desired_behavior,
    scenario.proof,
    scenario.acceptance,
    scenario.trigger,
    scenario.when,
    scenario.then,
    scenario.given,
    asArray(scenario.surfaces).map((surface) => [
      surface?.label,
      surface?.proof,
      surface?.verification_hint,
    ]),
  ]).join("\n");
}

function requirementText(requirement = Object()) {
  return compact([
    requirement.title,
    requirement.text,
    requirement.description,
    requirement.goal,
    requirement.user_story,
    requirement.acceptance_criteria,
    asArray(requirement.acceptance_scenarios || requirement.scenarios).map(scenarioText),
  ]).join("\n");
}

function taskText(task = Object()) {
  const handoff = task.handoff || {};
  return compact([
    task.title,
    task.description,
    task.goal,
    task.user_story,
    task.acceptance_criteria,
    task.proof,
    task.verification_hint,
    handoff.plain_language_goal,
    handoff.current_behavior,
    handoff.desired_behavior,
    handoff.proof,
    handoff.touchpoint,
    handoff.trigger,
    handoff.verification_hint,
    handoff.acceptance_criteria,
    asArray(task.post_conditions).map(conditionText),
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
