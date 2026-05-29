export const DEMAND_READINESS_SCHEMA_VERSION = "1.0";
export const DEMAND_READINESS_SCHEMA = "yolo.demand.readiness.v1";

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function clean(value) {
  return String(value ?? "").trim();
}

function hasItems(value) {
  return asArray(value).map(clean).filter(Boolean).length > 0;
}

function hasTraceItems(value) {
  return asArray(value).some((item) => {
    if (item && typeof item === "object") {
      return clean(item.id || item.question || item.answer || item.text).length > 0;
    }
    return clean(item).length > 0;
  });
}

function check(code, passed, severity, message, extra = {}) {
  return { code, passed: Boolean(passed), severity, message, ...extra };
}

function blockingOpenQuestions(session = {}) {
  return asArray(session.discussion?.open_questions || session.open_questions)
    .map((item) => {
      if (typeof item === "string") return { text: clean(item), blocking: true };
      return { ...item, text: clean(item.text || item.question || item.message), blocking: item.blocking !== false };
    })
    .filter((item) => item.text && item.blocking);
}

function requirementCount(session = {}) {
  return asArray(session.requirements?.active || session.requirements).length;
}

function acceptanceScenarioCount(session = {}) {
  const requirements = asArray(session.requirements?.active || session.requirements);
  return requirements.reduce((sum, requirement) => sum + asArray(requirement.acceptance_scenarios || requirement.scenarios).length, 0);
}

function scenarioMatrix(session = {}) {
  return asArray(session.scenario_matrix?.scenarios || session.scenarios);
}

function scenarioProofCount(session = {}) {
  return scenarioMatrix(session).filter((scenario) => clean(scenario.proof || scenario.acceptance).length > 0).length;
}

function scenarioSurfaceCount(session = {}) {
  return scenarioMatrix(session).filter((scenario) => asArray(scenario.surfaces).length > 0).length;
}

function scenarioSurfaceTotal(session = {}) {
  return scenarioMatrix(session).reduce((sum, scenario) => sum + asArray(scenario.surfaces).length, 0);
}

function surfaceBudgetFailures(session = {}) {
  const failures = [];
  for (const scenario of scenarioMatrix(session)) {
    for (const surface of asArray(scenario.surfaces)) {
      const budget = surface?.session_budget;
      const maxFiles = Number(budget?.max_files);
      if (!budget) {
        failures.push({
          scenario_id: scenario.id || null,
          surface_id: surface?.id || null,
          reason: "missing_session_budget",
        });
      } else if (!Number.isFinite(maxFiles) || maxFiles < 1 || maxFiles > 2) {
        failures.push({
          scenario_id: scenario.id || null,
          surface_id: surface?.id || null,
          reason: "max_files_over_budget",
          max_files: budget.max_files,
        });
      }
    }
  }
  return failures;
}

function targetFileCount(session = {}) {
  return asArray(session.project?.target_files || session.target_files).length;
}

function evidenceOrAssumptionPresent(session = {}) {
  return hasItems(session.investigation?.evidence)
    || hasItems(session.evidence)
    || hasItems(session.reflection?.assumptions)
    || hasItems(session.assumptions);
}

function completedQuestioning(session = {}) {
  return hasTraceItems(session.question_trace)
    || scenarioMatrix(session).some((scenario) => hasTraceItems(scenario.question_trace || scenario.source_question_ids))
    || hasTraceItems(session.discussion?.rounds)
    || hasTraceItems(session.discussion?.questions);
}

function statusFromChecks(checks) {
  if (checks.some((item) => item.severity === "error" && !item.passed)) return "blocked";
  if (checks.some((item) => item.severity === "warning" && !item.passed)) return "warning";
  return "pass";
}

function readinessLevel(checks, session = {}) {
  const passed = (code) => checks.find((item) => item.code === code)?.passed === true;
  if (
    passed("USER_APPROVAL_PRESENT")
    && passed("EXECUTION_SCOPE_PRESENT")
    && passed("ACCEPTANCE_SCENARIOS_PRESENT")
    && passed("SCENARIO_MATRIX_PRESENT")
    && passed("SCENARIO_SURFACES_PRESENT")
  ) {
    return "L3";
  }
  if (passed("REQUIREMENTS_CONFIRMED") && passed("BLOCKING_OPEN_QUESTIONS_EMPTY")) {
    return "L2";
  }
  if (passed("VISION_PRESENT") && passed("TARGET_USER_PRESENT") && evidenceOrAssumptionPresent(session)) {
    return "L1";
  }
  return "L0";
}

export function inspectDemandReadiness(session = {}, options = {}) {
  const phase = clean(options.phase || session.phase || "discuss");
  const approval = session.approval || {};
  const requirements = asArray(session.requirements?.active || session.requirements);
  const scenarios = scenarioMatrix(session);
  const surfaceBudgetIssues = surfaceBudgetFailures(session);
  const blockingQuestions = blockingOpenQuestions(session);
  const hasExecutionScope = targetFileCount(session) > 0;
  const deepMode = ["discuss", "prd", "executable_prd"].includes(phase);
  const prdMode = ["prd", "executable_prd"].includes(phase);

  const checks = [
    check(
      "VISION_PRESENT",
      clean(session.vision?.statement || session.vision?.idea || session.idea || session.objective).length >= 10,
      "error",
      "Vision must state the product direction or opportunity in enough detail.",
    ),
    check(
      "TARGET_USER_PRESENT",
      hasItems(session.vision?.target_users || session.project?.target_users || session.target_users),
      "error",
      "Target user must be explicit before PRD work.",
    ),
    check(
      "STATUS_QUO_PRESENT",
      hasItems(session.vision?.status_quo || session.status_quo),
      deepMode ? "error" : "warning",
      "Status quo/current workaround must be captured.",
    ),
    check(
      "REFLECTION_PRESENT",
      hasItems(session.reflection?.assumptions) || hasItems(session.reflection?.alternatives) || clean(session.reflection?.summary).length > 0,
      deepMode ? "error" : "warning",
      "Reflection must challenge premises, assumptions, or alternatives.",
    ),
    check(
      "INVESTIGATION_COMPLETE",
      evidenceOrAssumptionPresent(session),
      "error",
      "Investigation must record evidence or explicit assumptions/TBD-needs-validation.",
    ),
    check(
      "QUESTIONING_ROUNDS_COMPLETE",
      completedQuestioning(session),
      deepMode ? "error" : "warning",
      "Question trace or discussion rounds must capture the non-technical answers before PRD.",
    ),
    check(
      "REQUIREMENTS_PRESENT",
      requirementCount(session) > 0,
      "error",
      "At least one confirmed requirement is required.",
    ),
    check(
      "ACCEPTANCE_SCENARIOS_PRESENT",
      acceptanceScenarioCount(session) >= Math.max(1, requirements.length),
      prdMode ? "error" : "warning",
      "Every requirement should include at least one acceptance scenario.",
    ),
    check(
      "SCENARIO_MATRIX_PRESENT",
      scenarios.length >= Math.max(1, requirements.length),
      prdMode ? "error" : "warning",
      "Demand must be translated into a scenario matrix before executable PRD generation.",
    ),
    check(
      "SCENARIO_PROOF_PRESENT",
      scenarioProofCount(session) >= Math.max(1, scenarios.length),
      prdMode ? "error" : "warning",
      "Every scenario must include explicit proof that a non-technical user can recognize.",
    ),
    check(
      "SCENARIO_SURFACES_PRESENT",
      scenarioSurfaceCount(session) >= Math.max(1, scenarios.length),
      prdMode ? "error" : "warning",
      "Every scenario must map to at least one implementation surface for atomic task slicing.",
    ),
    check(
      "SURFACE_SESSION_BUDGET_EXECUTABLE",
      scenarios.length > 0 && scenarioSurfaceTotal(session) > 0 && surfaceBudgetIssues.length === 0,
      prdMode ? "error" : "warning",
      "Every scenario surface must declare session_budget.max_files <= 2 before executable PRD generation.",
      { surface_budget_issues: surfaceBudgetIssues },
    ),
    check(
      "OUT_OF_SCOPE_PRESENT",
      hasItems(session.requirements?.out_of_scope || session.out_of_scope || session.non_goals),
      deepMode ? "error" : "warning",
      "Out-of-scope boundaries must be explicit.",
    ),
    check(
      "ROADMAP_PRESENT",
      hasItems(session.roadmap?.mvp) || hasItems(session.roadmap?.phases),
      deepMode ? "error" : "warning",
      "Roadmap must define MVP or phased delivery.",
    ),
    check(
      "BLOCKING_OPEN_QUESTIONS_EMPTY",
      blockingQuestions.length === 0,
      "error",
      "Blocking open questions must be resolved or explicitly deferred before PRD.",
      { blocking_questions: blockingQuestions },
    ),
    check(
      "USER_APPROVAL_PRESENT",
      approval.approved === true,
      prdMode || deepMode ? "error" : "warning",
      "Explicit user approval with approved=true is required before executable PRD compilation.",
    ),
    check(
      "EXECUTION_SCOPE_PRESENT",
      hasExecutionScope,
      prdMode ? "error" : "warning",
      "Executable PRD requires target files/modules or a bounded execution scope.",
    ),
  ];

  const blockers = checks.filter((item) => item.severity === "error" && !item.passed);
  const warnings = checks.filter((item) => item.severity === "warning" && !item.passed);
  const level = readinessLevel(checks, session);
  const status = statusFromChecks(checks);
  return {
    schema_version: DEMAND_READINESS_SCHEMA_VERSION,
    schema: DEMAND_READINESS_SCHEMA,
    phase,
    status,
    readiness_level: level,
    demand_ready: ["L1", "L2", "L3"].includes(level),
    prd_ready: ["L2", "L3"].includes(level) && blockers.length === 0,
    executable_prd_ready: level === "L3" && blockers.length === 0,
    quality_score: Math.round((checks.filter((item) => item.passed).length / checks.length) * 100),
    checks,
    blockers,
    warnings,
    next_actions: blockers.length > 0
      ? blockers.map((item) => item.message)
      : warnings.length > 0
        ? warnings.map((item) => item.message)
        : ["Demand artifacts are ready for executable PRD compilation."],
  };
}
