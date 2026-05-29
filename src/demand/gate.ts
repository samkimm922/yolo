export const DEMAND_READINESS_SCHEMA_VERSION = "1.0";
export const DEMAND_READINESS_SCHEMA = "yolo.demand.readiness.v1";
export const DEMAND_QUALITY_SCHEMA_VERSION = "1.0";
export const DEMAND_QUALITY_SCHEMA = "yolo.demand.quality.v1";

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

function requirementItems(session = {}) {
  return asArray(session.requirements?.active || session.requirements);
}

function acceptanceScenarioCount(session = {}) {
  const requirements = requirementItems(session);
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

function qualityCheck(code, passed, points, severity, message, extra = {}) {
  return { code, passed: Boolean(passed), points, severity, message, ...extra };
}

function qualityDimension({ code, label, weight = 20, critical = false, checks = [], blockBelow = 60, warnBelow = 85 }) {
  const possible = checks.reduce((sum, item) => sum + Number(item.points || 0), 0);
  const earned = checks.reduce((sum, item) => sum + (item.passed ? Number(item.points || 0) : 0), 0);
  const score = possible > 0 ? Math.round((earned / possible) * 100) : 0;
  const failed_checks = checks.filter((item) => !item.passed);
  const hasFailedError = failed_checks.some((item) => item.severity === "error");
  const status = critical && (score < blockBelow || hasFailedError)
    ? "blocked"
    : score < warnBelow || failed_checks.length > 0
      ? "warning"
      : "pass";
  return {
    code,
    label,
    weight,
    critical,
    status,
    score,
    earned_points: earned,
    possible_points: possible,
    block_threshold: blockBelow,
    warning_threshold: warnBelow,
    checks,
    failed_checks,
  };
}

function taskTargets(task = {}) {
  return asArray(task.scope?.targets).map((target) => clean(target?.file || target)).filter(Boolean);
}

function taskAcceptanceCriteria(task = {}) {
  return asArray(task.handoff?.acceptance_criteria || task.acceptance_criteria);
}

function taskHasAcceptanceCondition(task = {}) {
  return asArray(task.post_conditions).some((condition) => condition?.type === "acceptance_criteria" && clean(condition.message || condition.params?.text).length > 0);
}

function handoffPresent(task = {}) {
  return task.handoff && typeof task.handoff === "object";
}

function handoffFieldsComplete(task = {}) {
  const handoff = task.handoff || {};
  return handoffPresent(task)
    && clean(handoff.plain_language_goal).length >= 10
    && clean(handoff.current_behavior).length > 0
    && clean(handoff.desired_behavior).length >= 10
    && clean(handoff.proof).length >= 10
    && clean(handoff.touchpoint).length > 0
    && clean(handoff.trigger).length > 0
    && taskTargets(task).length > 0;
}

function taskEvidenceChainComplete(task = {}) {
  const chain = task.handoff?.evidence_chain || {};
  return clean(chain.demand_id).length > 0
    && clean(chain.scenario_id).length > 0
    && clean(chain.surface_id).length > 0;
}

function taskSessionPlanComplete(task = {}) {
  const session = task.handoff?.session || task.session_plan || {};
  return clean(session.session_id).length > 0
    && clean(session.state_path).length > 0
    && clean(session.handoff_path).length > 0
    && clean(session.evidence_path).length > 0
    && hasItems(session.memory_update_paths)
    && clean(session.progress_update_path).length > 0
    && clean(session.resume_instructions).length > 0;
}

function scenarioHasProof(scenario = {}) {
  return clean(scenario.proof || scenario.acceptance).length >= 10;
}

function scenarioSurfaces(session = {}) {
  return scenarioMatrix(session).flatMap((scenario) => asArray(scenario.surfaces));
}

function allTasksHaveSourceQuestions(tasks = []) {
  return tasks.length > 0 && tasks.every((task) => hasTraceItems(task.source_question_ids || task.handoff?.source_question_ids || task.trace?.source_question_ids));
}

function allScenariosOrTasksHaveSourceQuestions(session = {}, tasks = []) {
  const scenarios = scenarioMatrix(session);
  if (tasks.length > 0) return allTasksHaveSourceQuestions(tasks);
  return scenarios.length > 0 && scenarios.every((scenario) => hasTraceItems(scenario.source_question_ids || scenario.question_trace));
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

export function inspectDemandQuality(session = {}, options = {}) {
  const phase = clean(options.phase || session.phase || "prd");
  const readiness = options.readiness || session.readiness || null;
  const tasks = asArray(options.tasks);
  const requireTasks = options.requireTasks === true || tasks.length > 0;
  const atomicity = options.atomicity || null;
  const requirements = requirementItems(session);
  const scenarios = scenarioMatrix(session);
  const surfaces = scenarioSurfaces(session);
  const surfaceBudgetIssues = surfaceBudgetFailures(session);
  const blockingQuestions = blockingOpenQuestions(session);
  const allRequirementsConcrete = requirements.length > 0
    && requirements.every((requirement) => clean(requirement.text || requirement.title).length >= 10);
  const allScenariosHaveProof = scenarios.length > 0 && scenarios.every(scenarioHasProof);
  const allSurfacesHaveProof = scenarios.length > 0 && scenarios.every((scenario) => (
    asArray(scenario.surfaces).length > 0
    && asArray(scenario.surfaces).every((surface) => clean(surface.proof || scenario.proof || scenario.acceptance).length >= 10)
  ));
  const tasksExistWhenRequired = !requireTasks || tasks.length > 0;
  const allTasksSessionSized = !requireTasks || (tasks.length > 0 && tasks.every((task) => {
    const targets = taskTargets(task);
    const maxFiles = Number(task.scope?.max_files || targets.length || 0);
    return targets.length > 0 && targets.length <= 2 && Number.isFinite(maxFiles) && maxFiles >= 1 && maxFiles <= 2;
  }));
  const allTasksHaveProof = !requireTasks || (tasks.length > 0 && tasks.every((task) => (
    clean(task.handoff?.proof || task.proof).length >= 10
    && taskAcceptanceCriteria(task).length > 0
    && taskHasAcceptanceCondition(task)
  )));
  const allTasksHaveVerificationHints = !requireTasks || (tasks.length > 0 && tasks.every((task) => (
    clean(task.verification_hint || task.handoff?.verification_hint).length >= 10
  )));
  const allTasksBounded = !requireTasks || (tasks.length > 0 && tasks.every((task) => (
    taskTargets(task).length > 0
    && task.scope?.allow_delete_files !== true
    && Number(task.scope?.max_lines_per_file || 0) > 0
  )));
  const allTaskHandoffsComplete = !requireTasks || (tasks.length > 0 && tasks.every(handoffFieldsComplete));
  const allTaskEvidenceChainsComplete = !requireTasks || (tasks.length > 0 && tasks.every(taskEvidenceChainComplete));
  const allTaskSessionPlansComplete = !requireTasks || (tasks.length > 0 && tasks.every(taskSessionPlanComplete));
  const allTasksCarryContext = !requireTasks || (tasks.length > 0 && tasks.every((task) => {
    const handoff = task.handoff || {};
    return handoffFieldsComplete(task)
      && asArray(handoff.read_first).length > 0
      && asArray(handoff.key_interfaces).length > 0
      && asArray(handoff.acceptance_criteria).length > 0;
  }));
  const atomicityBlocked = atomicity?.status === "blocked" || asArray(atomicity?.blockers).length > 0;

  const dimensions = [
    qualityDimension({
      code: "requirement_clarity",
      label: "需求清晰度",
      critical: true,
      checks: [
        qualityCheck(
          "QUALITY_VISION_CONCRETE",
          clean(session.vision?.statement || session.vision?.idea || session.idea || session.objective).length >= 20,
          20,
          "error",
          "Vision must describe the product direction in concrete language.",
        ),
        qualityCheck(
          "QUALITY_TARGET_USER_SPECIFIC",
          hasItems(session.vision?.target_users || session.project?.target_users || session.target_users),
          15,
          "error",
          "Target users must be explicit.",
        ),
        qualityCheck(
          "QUALITY_STATUS_QUO_CAPTURED",
          hasItems(session.vision?.status_quo || session.status_quo),
          15,
          "warning",
          "Current behavior or workaround should be captured.",
        ),
        qualityCheck(
          "QUALITY_REQUIREMENTS_CONCRETE",
          allRequirementsConcrete,
          20,
          "error",
          "Confirmed requirements must be present and concrete enough to implement.",
          { requirement_count: requirements.length },
        ),
        qualityCheck(
          "QUALITY_SCOPE_BOUNDARIES_PRESENT",
          hasItems(session.requirements?.out_of_scope || session.out_of_scope || session.non_goals)
            || hasItems(session.requirements?.constraints || session.constraints),
          15,
          "warning",
          "Constraints or out-of-scope boundaries should be explicit.",
        ),
        qualityCheck(
          "QUALITY_EVIDENCE_OR_ASSUMPTIONS_PRESENT",
          evidenceOrAssumptionPresent(session),
          15,
          "error",
          "Demand should carry either evidence or explicit assumptions.",
        ),
      ],
    }),
    qualityDimension({
      code: "task_atomicity",
      label: "任务原子度",
      critical: true,
      checks: [
        qualityCheck(
          "QUALITY_SCENARIO_MATRIX_COVERAGE",
          scenarios.length >= Math.max(1, requirements.length),
          20,
          "error",
          "Scenario matrix must cover confirmed requirements.",
          { scenario_count: scenarios.length, requirement_count: requirements.length },
        ),
        qualityCheck(
          "QUALITY_SCENARIO_SURFACES_PRESENT",
          scenarios.length > 0 && scenarioSurfaceCount(session) >= scenarios.length,
          20,
          "error",
          "Every scenario must map to at least one implementation surface.",
        ),
        qualityCheck(
          "QUALITY_SURFACE_SESSION_BUDGETS",
          surfaces.length > 0 && surfaceBudgetIssues.length === 0,
          25,
          "error",
          "Every surface must be bounded to a single-session budget with max_files <= 2.",
          { surface_budget_issues: surfaceBudgetIssues },
        ),
        qualityCheck(
          "QUALITY_GENERATED_TASKS_SESSION_SIZED",
          allTasksSessionSized,
          20,
          "error",
          "Generated tasks must be session-sized and target at most two files.",
          { task_count: tasks.length, required: requireTasks },
        ),
        qualityCheck(
          "QUALITY_ATOMIC_DOCTOR_PASSED",
          !atomicityBlocked,
          15,
          "error",
          "Atomicity doctor must not require a split before PRD execution.",
          { atomicity_status: atomicity?.status || null, blockers: asArray(atomicity?.blockers) },
        ),
      ],
    }),
    qualityDimension({
      code: "acceptance_evidence",
      label: "验收证据",
      critical: true,
      checks: [
        qualityCheck(
          "QUALITY_ACCEPTANCE_SCENARIOS_PRESENT",
          acceptanceScenarioCount(session) >= Math.max(1, requirements.length),
          20,
          "error",
          "Each requirement should include an acceptance scenario.",
        ),
        qualityCheck(
          "QUALITY_SCENARIO_PROOF_CONCRETE",
          allScenariosHaveProof,
          30,
          "error",
          "Every scenario must include concrete proof a non-technical user can recognize.",
        ),
        qualityCheck(
          "QUALITY_SURFACE_PROOF_PRESENT",
          allSurfacesHaveProof,
          15,
          "error",
          "Every scenario surface must inherit or declare concrete proof.",
        ),
        qualityCheck(
          "QUALITY_TASK_ACCEPTANCE_EVIDENCE",
          allTasksHaveProof,
          20,
          "error",
          "Each generated task must carry proof, acceptance criteria, and an acceptance post-condition.",
          { task_count: tasks.length, required: requireTasks },
        ),
        qualityCheck(
          "QUALITY_VERIFICATION_HINTS_PRESENT",
          allTasksHaveVerificationHints,
          15,
          "warning",
          "Each generated task should include a plain-language verification hint.",
          { task_count: tasks.length, required: requireTasks },
        ),
      ],
    }),
    qualityDimension({
      code: "session_executability",
      label: "session 可执行性",
      critical: true,
      checks: [
        qualityCheck(
          "QUALITY_APPROVAL_PRESENT",
          session.approval?.approved === true,
          20,
          "error",
          "Approved-demand PRD requires explicit user approval.",
        ),
        qualityCheck(
          "QUALITY_BLOCKING_QUESTIONS_EMPTY",
          blockingQuestions.length === 0,
          15,
          "error",
          "Blocking open questions must be resolved or deferred before execution.",
          { blocking_questions: blockingQuestions },
        ),
        qualityCheck(
          "QUALITY_EXECUTION_SCOPE_PRESENT",
          targetFileCount(session) > 0,
          20,
          "error",
          "Executable PRD needs bounded target files or modules.",
        ),
        qualityCheck(
          "QUALITY_GENERATED_TASKS_PRESENT",
          tasksExistWhenRequired,
          15,
          "error",
          "PRD quality evaluation must see generated tasks before execution.",
          { task_count: tasks.length, required: requireTasks },
        ),
        qualityCheck(
          "QUALITY_TASK_SCOPES_BOUNDED",
          allTasksBounded,
          15,
          "error",
          "Every task scope must name targets, forbid deletes, and cap per-file edits.",
          { task_count: tasks.length, required: requireTasks },
        ),
        qualityCheck(
          "QUALITY_READINESS_L3_EXECUTABLE",
          !readiness || readiness.executable_prd_ready === true,
          15,
          "error",
          "Demand readiness must be L3 executable before PRD execution.",
          { readiness_level: readiness?.readiness_level || null, readiness_status: readiness?.status || null },
        ),
      ],
    }),
    qualityDimension({
      code: "handoff_completeness",
      label: "上下文接力棒完整度",
      critical: true,
      checks: [
        qualityCheck(
          "QUALITY_QUESTION_TRACE_PRESENT",
          completedQuestioning(session),
          15,
          "error",
          "Question trace or discussion rounds must be preserved.",
        ),
        qualityCheck(
          "QUALITY_SOURCE_QUESTIONS_PROPAGATED",
          allScenariosOrTasksHaveSourceQuestions(session, tasks),
          20,
          "warning",
          "Source question IDs should propagate to scenarios or generated tasks.",
          { task_count: tasks.length, scenario_count: scenarios.length },
        ),
        qualityCheck(
          "QUALITY_TASK_HANDOFF_COMPLETE",
          allTaskHandoffsComplete,
          25,
          "error",
          "Every generated task needs a complete agent handoff payload.",
          { task_count: tasks.length, required: requireTasks },
        ),
        qualityCheck(
          "QUALITY_EVIDENCE_CHAIN_COMPLETE",
          allTaskEvidenceChainsComplete,
          15,
          "error",
          "Task handoff must include demand, scenario, and surface evidence-chain IDs.",
          { task_count: tasks.length, required: requireTasks },
        ),
        qualityCheck(
          "QUALITY_TASK_SESSION_PLAN_COMPLETE",
          allTaskSessionPlansComplete,
          15,
          "error",
          "Each generated task must include a fresh-session handoff plan with state, evidence, memory, progress, and resume targets.",
          { task_count: tasks.length, required: requireTasks },
        ),
        qualityCheck(
          "QUALITY_HANDOFF_CONTEXT_COMPLETE",
          allTasksCarryContext,
          15,
          "error",
          "Task handoff must include read-first context, key interfaces, and acceptance criteria.",
          { task_count: tasks.length, required: requireTasks },
        ),
      ],
    }),
  ];

  const totalWeight = dimensions.reduce((sum, item) => sum + item.weight, 0);
  const total_score = totalWeight > 0
    ? Math.round(dimensions.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight)
    : 0;
  const passScore = Number(options.passScore || 85);
  const blockScore = Number(options.blockScore || 70);
  const blockers = [];
  const warnings = [];

  for (const dimension of dimensions) {
    if (dimension.status === "blocked") {
      blockers.push({
        code: `DEMAND_QUALITY_${dimension.code.toUpperCase()}_LOW`,
        dimension: dimension.code,
        score: dimension.score,
        threshold: dimension.block_threshold,
        message: `${dimension.label} quality is below executable PRD threshold.`,
      });
    } else if (dimension.status === "warning") {
      warnings.push({
        code: `DEMAND_QUALITY_${dimension.code.toUpperCase()}_WARNING`,
        dimension: dimension.code,
        score: dimension.score,
        threshold: dimension.warning_threshold,
        message: `${dimension.label} quality has gaps that should be reviewed.`,
      });
    }
    for (const failed of dimension.failed_checks) {
      const issue = {
        code: failed.code,
        dimension: dimension.code,
        score: dimension.score,
        message: failed.message,
      };
      if (failed.severity === "error" && dimension.status === "blocked") blockers.push(issue);
      else warnings.push(issue);
    }
  }

  if (total_score < blockScore) {
    blockers.unshift({
      code: "DEMAND_QUALITY_TOTAL_LOW",
      score: total_score,
      threshold: blockScore,
      message: "Demand quality score is too low for executable PRD generation.",
    });
  } else if (total_score < passScore) {
    warnings.unshift({
      code: "DEMAND_QUALITY_TOTAL_WARNING",
      score: total_score,
      threshold: passScore,
      message: "Demand quality score is below the pass threshold; PRD can proceed only with warnings.",
    });
  }

  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "pass";
  return {
    schema_version: DEMAND_QUALITY_SCHEMA_VERSION,
    schema: DEMAND_QUALITY_SCHEMA,
    phase,
    status,
    total_score,
    pass_score: passScore,
    block_score: blockScore,
    dimensions,
    blockers,
    warnings,
    readiness_status: readiness?.status || null,
    readiness_level: readiness?.readiness_level || null,
    atomicity_status: atomicity?.status || null,
    next_actions: blockers.length > 0
      ? blockers.map((item) => item.message)
      : warnings.length > 0
        ? warnings.map((item) => item.message)
        : ["Demand quality is sufficient for approved-demand PRD execution."],
  };
}
