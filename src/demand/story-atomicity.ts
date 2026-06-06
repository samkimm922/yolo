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

export function inspectStoryAtomicityText(text, item = {}) {
  const normalized = clean(text).toLowerCase();
  const signatures = uniqueSignatures(SIGNATURES.filter((signature) => signature.matches(normalized)));
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

export function inspectStoryAtomicityItems(items = [], options = {}) {
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

  const blockers = findings.map((finding) => ({
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

  return {
    schema_version: STORY_ATOMICITY_SCHEMA_VERSION,
    schema: STORY_ATOMICITY_SCHEMA,
    status: blockers.length > 0 ? "blocked" : "pass",
    inspected_count: inspected.length,
    finding_count: findings.length,
    inspected,
    findings,
    blockers,
    warnings: [],
    next_actions: blockers.length > 0
      ? ["Split each blocked requirement, scenario, or task so each one carries exactly one independent user story."]
      : ["Story atomicity passed."],
    ...options.extra,
  };
}

function conditionText(condition = {}) {
  return compact([
    condition.message,
    condition.params?.text,
    condition.params?.pattern,
    condition.params?.expected,
  ]).join("\n");
}

function scenarioText(scenario = {}) {
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

function requirementText(requirement = {}) {
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

function taskText(task = {}) {
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

export function collectStoryAtomicityItemsFromDemand(session = {}, options = {}) {
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

export function collectStoryAtomicityItemsFromPrd(prd = {}) {
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

export function inspectStoryAtomicityFromDemand(session = {}, options = {}) {
  return inspectStoryAtomicityItems(collectStoryAtomicityItemsFromDemand(session, options), {
    extra: { source: "demand" },
  });
}

export function inspectStoryAtomicityFromPrd(prd = {}) {
  return inspectStoryAtomicityItems(collectStoryAtomicityItemsFromPrd(prd), {
    extra: { source: "prd" },
  });
}
