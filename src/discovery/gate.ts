export const DISCOVERY_GATE_SCHEMA_VERSION = "1.0";
export const DISCOVERY_BRIEF_SCHEMA = "yolo.discovery.brief.v1";
export const DISCOVERY_READINESS_SCHEMA = "yolo.discovery.readiness.v1";

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function clean(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values) {
  return [...new Set(asArray(values).map((value) => clean(value)).filter(Boolean))];
}

function hasSignal(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function check(code, passed, severity, message, extra = {}) {
  return { code, passed: Boolean(passed), severity, message, ...extra };
}

export function buildDiscoveryBrief(input = {}, options = {}) {
  const idea = typeof input === "string" ? input : input.idea || input.requirement || input.text;
  return {
    schema_version: DISCOVERY_GATE_SCHEMA_VERSION,
    schema: DISCOVERY_BRIEF_SCHEMA,
    id: clean(input.id || options.id || "DISCOVERY-001"),
    idea: clean(idea),
    problem: clean(input.problem),
    target_users: uniqueStrings(input.target_users || input.users || input.audience),
    success_criteria: uniqueStrings(input.success_criteria || input.acceptance_criteria),
    constraints: uniqueStrings(input.constraints),
    non_goals: uniqueStrings(input.non_goals || input.nonGoals),
    target_files: uniqueStrings(input.target_files || input.files),
    open_questions: uniqueStrings(input.open_questions || input.questions),
    risks: uniqueStrings(input.risks),
    ready_for_prd: input.ready_for_prd === true || input.readyForPrd === true,
  };
}

export function inspectDiscoveryReadiness(input = {}, options = {}) {
  const brief = buildDiscoveryBrief(input, options);
  const text = [
    brief.idea,
    brief.problem,
    brief.success_criteria.join(" "),
    brief.constraints.join(" "),
    brief.target_files.join(" "),
  ].join(" ").toLowerCase();

  const checks = [
    check(
      "DISCOVERY_IDEA_PRESENT",
      brief.idea.length >= 10,
      "error",
      "idea or requirement must have enough text to inspect",
    ),
    check(
      "DISCOVERY_PROBLEM_PRESENT",
      Boolean(brief.problem) || hasSignal(text, [/because|problem|pain|用户|问题|目标|为了|希望/]),
      "warning",
      "problem or user outcome should be explicit",
    ),
    check(
      "DISCOVERY_SUCCESS_CRITERIA_PRESENT",
      brief.success_criteria.length > 0 || hasSignal(text, [/success|criteria|acceptance|验收|标准|完成|应该|必须|can |能够|可以/]),
      "error",
      "success criteria must be explicit before PRD or execution",
    ),
    check(
      "DISCOVERY_SCOPE_SIGNAL_PRESENT",
      brief.target_files.length > 0 || hasSignal(text, [/file|path|api|page|component|service|database|src\/|页面|接口|组件|服务|数据库/]),
      "error",
      "scope, surface, target files, or affected system area must be explicit",
    ),
    check(
      "DISCOVERY_CONSTRAINTS_RECORDED",
      brief.constraints.length > 0 || hasSignal(text, [/constraint|risk|non-goal|兼容|限制|不能|不要|风险/]),
      "warning",
      "constraints and non-goals should be recorded before execution",
    ),
  ];

  const blockers = checks.filter((item) => item.severity === "error" && item.passed !== true);
  const warnings = checks.filter((item) => item.severity === "warning" && item.passed !== true);
  const status = blockers.length > 0 ? "blocked" : (warnings.length > 0 ? "warning" : "pass");

  return {
    schema_version: DISCOVERY_GATE_SCHEMA_VERSION,
    schema: DISCOVERY_READINESS_SCHEMA,
    status,
    ready_for_plan: blockers.length === 0,
    ready_for_prd: blockers.length === 0 && warnings.length === 0,
    brief,
    checks,
    blockers,
    warnings,
    next_actions: blockers.length > 0
      ? [
          "Run /yolo-discover with the idea and answer the missing problem, success criteria, and scope questions.",
          "Do not generate executable PRD or run implementation until discovery readiness passes.",
        ]
      : warnings.length > 0
        ? ["Proceed to /yolo-plan, but record constraints and non-goals before execution."]
        : ["Proceed to /yolo-plan or /yolo-prd with this discovery brief."],
  };
}
