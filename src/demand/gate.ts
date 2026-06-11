import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { inspectStoryAtomicityFromDemand } from "./story-atomicity.js";
import { validateLedgerChain, readLedgerJsonl } from "../runtime/evidence/ledger.js";

export const DEMAND_READINESS_SCHEMA_VERSION = "1.0";
export const DEMAND_READINESS_SCHEMA = "yolo.demand.readiness.v1";
export const DEMAND_QUALITY_SCHEMA_VERSION = "1.0";
export const DEMAND_QUALITY_SCHEMA = "yolo.demand.quality.v1";

function hasLedgerEvidence(stateDir) {
  if (!stateDir) return false;
  try {
    const ledgerPath = join(stateDir, "evidence", "ledger.jsonl");
    if (!existsSync(ledgerPath)) return false;
    const records = readLedgerJsonl(ledgerPath);
    if (records.length === 0) return false;
    const validation = validateLedgerChain(records);
    return validation.ok;
  } catch {
    return false;
  }
}

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

function targetFiles(session = {}) {
  return asArray(session.project?.target_files || session.target_files).map(clean).filter(Boolean);
}

function targetFileFactRecords(session = {}) {
  return asArray(session.project_facts?.target_files || session.project?.target_file_facts)
    .map((fact) => {
      if (typeof fact === "string") return { file: clean(fact), status: "needs_verification", source: "legacy_string" };
      return {
        ...fact,
        file: clean(fact?.file || fact?.path),
        status: clean(fact?.status || "needs_verification"),
        source: clean(fact?.source || fact?.reason),
      };
    })
    .filter((fact) => fact.file);
}

function scopedProjectPath(projectRoot, file) {
  const root = resolve(clean(projectRoot) || process.cwd());
  const target = clean(file);
  if (!target) return null;
  const path = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const relativePath = relative(root, path);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
  return path;
}

function assumptionFactRecords(session = {}) {
  return asArray(session.project_facts?.assumptions || session.reflection?.assumption_records || session.investigation?.assumptions)
    .map((fact) => {
      if (typeof fact === "string") return { text: clean(fact), status: "assumption" };
      return {
        ...fact,
        id: clean(fact?.id),
        text: clean(fact?.text || fact?.summary || fact?.claim),
        status: clean(fact?.status || "assumption"),
      };
    })
    .filter((fact) => fact.text || fact.id);
}

function combinedDemandText(session = {}) {
  const requirements = requirementItems(session);
  const scenarios = scenarioMatrix(session);
  const values = [
    session.vision?.statement,
    session.vision?.idea,
    session.idea,
    session.objective,
    session.vision?.status_quo,
    session.status_quo,
    session.investigation?.evidence?.map?.((item) => item?.text || item),
    session.evidence,
    session.reflection?.assumptions,
    session.assumptions,
    session.discussion?.decisions?.map?.((item) => item?.text || item),
    session.decisions,
    session.requirements?.constraints,
    session.constraints,
    session.context?.visual_style_source,
    session.requirements?.out_of_scope,
    session.out_of_scope,
    requirements.map((requirement) => [
      requirement.title,
      requirement.text,
      requirement.acceptance_scenarios,
      requirement.scenarios,
    ]),
    scenarios.map((scenario) => [
      scenario.current_behavior,
      scenario.desired_behavior,
      scenario.proof,
      scenario.acceptance,
      scenario.trigger,
      scenario.visual_style_source,
      scenario.surfaces?.map?.((surface) => [
        surface.proof,
        surface.verification_hint,
        surface.label,
        surface.visual_style_source,
      ]),
    ]),
  ];
  return values.flat(Infinity).map(clean).filter(Boolean).join("\n");
}

function visualStyleSourceItems(session = {}) {
  const scenarios = scenarioMatrix(session);
  return [
    session.context?.visual_style_source,
    session.visual_style,
    session.visual_style_source,
    scenarios.map((scenario) => [
      scenario.visual_style,
      scenario.visual_style_source,
      asArray(scenario.surfaces).map((surface) => [
        surface?.visual_style,
        surface?.visual_style_source,
      ]),
    ]),
  ].flat(Infinity).map(clean).filter(Boolean);
}

function conditionalStyleSourceIssue(session = {}) {
  const items = visualStyleSourceItems(session);
  for (const item of [...items, items.join("; ")]) {
    if (!item) continue;
    const lower = item.toLowerCase();
    const englishConditional = /\b(if|when)\b[\s\S]{0,160}\b(present|exists|available|found)\b[\s\S]{0,160}\b(otherwise|else|fallback)\b/.test(lower)
      || /\b(existing|project)\b[\s\S]{0,160}\b(if|when)\b[\s\S]{0,160}\b(otherwise|else|fallback)\b/.test(lower);
    const chineseConditional = /(如果|若|如)[^。；\n]{0,120}(存在|有|找到|可用)[^。；\n]{0,120}(否则|不然|反之)/.test(item);
    if (englishConditional || chineseConditional) return item;
  }
  return "";
}

function readProjectTargetText(session = {}, options = {}) {
  const projectRoot = clean(options.projectRoot || options.project_root || options.cwd);
  if (!projectRoot) return "";
  const chunks = [];
  for (const file of targetFiles(session)) {
    const path = scopedProjectPath(projectRoot, file);
    if (!path) continue;
    try {
      if (existsSync(path)) chunks.push(readFileSync(path, "utf8").slice(0, 64000));
    } catch {}
  }
  return chunks.join("\n");
}

function hasUiTarget(session = {}) {
  return targetFiles(session).some((file) => /(^|\/)(pages?|views?|screens?|components?|ui)\//i.test(file) || /\.(tsx|jsx|vue|svelte)$/i.test(file));
}

function hasApiOrServiceTarget(session = {}) {
  return targetFiles(session).some((file) => /(^|\/)(routes?|api|controllers?|server|services?|domain|lib)\//i.test(file));
}

function projectFactGrounding(session = {}, options = {}) {
  const projectRoot = clean(options.projectRoot || options.project_root || options.cwd);
  const text = combinedDemandText(session);
  const lower = text.toLowerCase();
  const projectText = readProjectTargetText(session, options);
  const projectLower = projectText.toLowerCase();
  const issues = [];
  const stockOrThreshold = /\b(low[-_\s]?stock|threshold|replenishment|floor|stockout)\b/i.test(text);
  const concreteRule = /(<=|>=|<|>|less than|greater than|below|above|equal|equals|at or below|at or above|per sku|configurable)/i.test(text);
  const concreteField = /\b([a-z]+[A-Za-z0-9]*_(?:threshold|floor|quantity|qty|units|available|stock)[A-Za-z0-9_]*|[a-z]+(?:Threshold|Quantity|Qty|Units|Available|Stock)[A-Za-z0-9]*)\b/.test(text);
  const fieldPassthrough = /\b(expose|return|include|map|copy|pass(?:ed)? through|preserve|透传|返回|包含|保留)\b/i.test(text);
  const genericFieldAssumption = /(already|existing|receives?|contains?|present|available)[^\n.]{0,80}\b(field|payload|row|request|data|threshold|quantity|qty)\b/i.test(text)
    || /\b(field|payload|row|request|data|threshold|quantity|qty)\b[^\n.]{0,80}(already|existing|receives?|contains?|present|available)/i.test(text);
  const projectMentionsCriticalField = /\b(threshold|replenishment|floor|lowstock|low_stock|quantity|qty_available|qty)\b/i.test(projectText);
  const executionTargets = new Set(targetFiles(session));
  const targetFacts = targetFileFactRecords(session);
  for (const file of executionTargets) {
    if (projectRoot && !scopedProjectPath(projectRoot, file)) {
      issues.push({
        code: "QUALITY_TARGET_FILE_WITHIN_PROJECT",
        file,
        message: "Target files must stay inside the project root before executable PRD generation.",
      });
    }
  }
  for (const fact of targetFacts) {
    if (fact.status === "invalid_scope" || (projectRoot && !scopedProjectPath(projectRoot, fact.file))) {
      issues.push({
        code: "QUALITY_TARGET_FILE_WITHIN_PROJECT",
        file: fact.file,
        message: "Target files must stay inside the project root before executable PRD generation.",
      });
    }
    if (executionTargets.has(fact.file) && fact.status === "candidate") {
      issues.push({
        code: "QUALITY_TARGET_FILE_NOT_INFERRED",
        file: fact.file,
        message: "Auto-scouted candidate files must not enter execution scope until a read/evidence step verifies relevance.",
      });
    }
    if (executionTargets.has(fact.file) && fact.status === "needs_verification") {
      issues.push({
        code: "QUALITY_TARGET_FILE_VERIFIED",
        file: fact.file,
        message: "Target files in execution scope must be verified by project read, evidence, or explicit verified_target_files before PRD execution.",
      });
    }
    if (fact.status === "contradicted") {
      issues.push({
        code: "QUALITY_TARGET_FILE_VERIFIED",
        file: fact.file,
        message: "Contradicted target-file facts must be resolved before PRD execution.",
      });
    }
  }
  for (const fact of assumptionFactRecords(session)) {
    if (fact.status === "contradicted") {
      issues.push({
        code: "QUALITY_CONTRADICTED_ASSUMPTION_BLOCKED",
        assumption_id: fact.id || null,
        message: "Contradicted assumptions must not be promoted to executable PRD facts, even with user approval.",
      });
    } else if (fact.status === "needs_verification") {
      issues.push({
        code: "QUALITY_ASSUMPTION_VERIFIED",
        assumption_id: fact.id || null,
        message: "Project-field assumptions must be verified by evidence or target project files before executable PRD generation.",
      });
    }
  }

  if (stockOrThreshold && !concreteRule && !(fieldPassthrough && concreteField)) {
    issues.push({
      code: "QUALITY_BUSINESS_RULE_CONCRETE",
      message: "Stock/threshold behavior must state a concrete comparison, field source, or configurable rule before PRD execution.",
    });
  }
  if ((stockOrThreshold || genericFieldAssumption) && !concreteField && !projectMentionsCriticalField) {
    issues.push({
      code: "QUALITY_FIELD_SOURCE_CONCRETE",
      message: "Field-dependent behavior needs a concrete field/source name from evidence or existing project files.",
    });
  }
  if (genericFieldAssumption && projectText && /threshold/i.test(text) && !/threshold|replenishment|floor|lowstock|low_stock/i.test(projectLower)) {
    issues.push({
      code: "QUALITY_FIELD_ASSUMPTION_VERIFIED",
      message: "Demand assumes threshold-like fields exist, but target project files do not show a matching field/source.",
    });
  }

  const visualUi = hasUiTarget(session) && /\b(badge|label|banner|visible|display|show)\b/i.test(text);
  const visualSpec = /(['"`][^'"`]{2,40}['"`]|text\s*[:=]|label\s*[:=]|color|position|before|after|inline|component|class|aria|icon|variant)/i.test(text);
  const visualStyleSource = /\b(style|visual|variant|color|class|component|design token|reuse|existing|current)\b|样式|视觉|颜色|组件|沿用|现有/i.test(text);
  const unresolvedConditionalStyleSource = conditionalStyleSourceIssue(session);
  const unresolvedProjectFactFirst = issues.some((issue) => [
    "QUALITY_TARGET_FILE_WITHIN_PROJECT",
    "QUALITY_TARGET_FILE_VERIFIED",
    "QUALITY_TARGET_FILE_NOT_INFERRED",
    "QUALITY_CONTRADICTED_ASSUMPTION_BLOCKED",
    "QUALITY_ASSUMPTION_VERIFIED",
    "QUALITY_FIELD_ASSUMPTION_VERIFIED",
  ].includes(issue.code));
  if (visualUi && !visualSpec) {
    issues.push({
      code: "QUALITY_UI_VISUAL_SPEC_CONCRETE",
      message: "Visible UI behavior must include at least one concrete visual/text/position/component specification before PRD execution.",
    });
  }
  if (visualUi && !visualStyleSource && !unresolvedProjectFactFirst) {
    issues.push({
      code: "QUALITY_UI_STYLE_SOURCE_CONCRETE",
      message: "Visible UI behavior must state a style source or explicit visual styling so the execution agent does not invent it.",
    });
  }
  if (visualUi && unresolvedConditionalStyleSource && !unresolvedProjectFactFirst) {
    issues.push({
      code: "QUALITY_UI_STYLE_SOURCE_RESOLVED",
      style_source: unresolvedConditionalStyleSource,
      message: "Visible UI style source must be resolved before PRD; conditional choices like 'use existing component if present, otherwise fallback' require an investigation result or a single approved styling path.",
    });
  }
  const serviceErrorBehavior = hasApiOrServiceTarget(session) && /\b(error|fail|invalid|reject|negative|below zero)\b|错误|报错|失败|非法/i.test(text);
  const errorContract = /\b(error[_-]?code|error code|message|status|NEGATIVE_[A-Z_]+|[A-Z0-9_]{4,}|ok:\s*false|code\s*[:=])\b|错误码|错误信息|状态码/i.test(text);
  if (serviceErrorBehavior && !errorContract && !unresolvedProjectFactFirst) {
    issues.push({
      code: "QUALITY_ERROR_CONTRACT_CONCRETE",
      message: "API/service error behavior must state an observable error shape, message, or code before PRD execution.",
    });
  }

  return issues;
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

// ── Completeness matrix (P2.15b): deterministic gate rules ──

function extractRoles(session = {}) {
  const raw = asArray(session.vision?.target_users || session.project?.target_users || session.target_users);
  return raw
    .map((entry) => {
      if (typeof entry === "string") return clean(entry);
      return clean(entry.role || entry.name || entry.title || entry.label || entry.id);
    })
    .filter(Boolean);
}

function roleScenarioCoverage(roles = [], scenarios = []) {
  const uncovered = [];
  for (const role of roles) {
    const matchingScenarios = scenarios.filter(
      (scenario) => clean(scenario.actor).toLowerCase() === role.toLowerCase()
    );
    if (matchingScenarios.length === 0) {
      uncovered.push({ role, scenario_count: 0 });
    }
  }
  return {
    roles_total: roles.length,
    roles_covered: roles.length - uncovered.length,
    roles_uncovered: uncovered,
  };
}

function scenarioExceptionCoverage(scenarios = [], session = {}) {
  // Check if exceptions were collected at all (session-level check)
  const sessionExceptions = asArray(
    session.prd_intake?.exceptions || session.nontechnical_intake?.exceptions || session.exceptions
  ).filter((item) => clean(typeof item === "string" ? item : item.text).length > 0);
  const anyScenarioHasExceptions = scenarios.some(
    (scenario) => asArray(scenario.exceptions).map(clean).filter(Boolean).length > 0
  );
  // Only flag missing exceptions if the session had exception data collected
  // or if at least one scenario has exceptions (making the omission visible)
  const shouldCheck = sessionExceptions.length > 0 || anyScenarioHasExceptions;

  const missing = [];
  if (shouldCheck) {
    for (const scenario of scenarios) {
      const exceptions = asArray(scenario.exceptions).map(clean).filter(Boolean);
      if (exceptions.length === 0) {
        missing.push({ scenario_id: scenario.id || null, actor: clean(scenario.actor) || "unknown" });
      }
    }
  }
  return {
    scenarios_total: scenarios.length,
    scenarios_with_exceptions: scenarios.length - missing.length,
    scenarios_missing_exceptions: missing,
    check_active: shouldCheck,
  };
}

function requirementAcceptanceEvidence(requirements = [], scenarios = []) {
  const missing = [];
  for (const requirement of requirements) {
    const acceptanceScenarios = asArray(requirement.acceptance_scenarios || requirement.scenarios);
    const hasDirectProof = acceptanceScenarios.some(
      (scenario) => clean(scenario.proof || scenario.acceptance || scenario.evidence).length > 0
    );
    // Also check if any scenario in the matrix covers this requirement with proof
    const hasScenarioProof = scenarios.some(
      (scenario) =>
        (scenario.requirement_id === requirement.id || !requirement.id) &&
        clean(scenario.proof || scenario.acceptance).length > 0
    );
    if (!hasDirectProof && !hasScenarioProof) {
      missing.push({
        requirement_id: requirement.id || null,
        requirement_text: clean(requirement.text || requirement.title).slice(0, 80) || null,
      });
    }
  }
  return {
    requirements_total: requirements.length,
    requirements_with_proof: requirements.length - missing.length,
    requirements_missing_proof: missing,
  };
}

function inspectCompletenessMatrix(session = {}) {
  const roles = extractRoles(session);
  const scenarios = scenarioMatrix(session);
  const requirements = requirementItems(session);

  const roleCoverage = roleScenarioCoverage(roles, scenarios);
  const exceptionCoverage = scenarioExceptionCoverage(scenarios, session);
  const evidenceCoverage = requirementAcceptanceEvidence(requirements, scenarios);

  const errors = [];
  if (roleCoverage.roles_uncovered.length > 0) {
    for (const item of roleCoverage.roles_uncovered) {
      errors.push({
        code: "ROLE_WITHOUT_SCENARIO",
        rule: "Each identified role must have at least one scenario",
        role: item.role,
        message: `Role "${item.role}" has no matching scenario in the scenario matrix.`,
      });
    }
  }
  if (exceptionCoverage.scenarios_missing_exceptions.length > 0) {
    for (const item of exceptionCoverage.scenarios_missing_exceptions) {
      errors.push({
        code: "SCENARIO_WITHOUT_EXCEPTIONS",
        rule: "Each scenario must have at least one exception / edge-case Q&A",
        scenario_id: item.scenario_id,
        actor: item.actor,
        message: `Scenario (actor="${item.actor}") has no exception Q&A entries.`,
      });
    }
  }
  if (evidenceCoverage.requirements_missing_proof.length > 0) {
    for (const item of evidenceCoverage.requirements_missing_proof) {
      errors.push({
        code: "REQUIREMENT_WITHOUT_ACCEPTANCE_EVIDENCE",
        rule: "Each requirement must have user-visible acceptance evidence",
        requirement_id: item.requirement_id,
        message: `Requirement "${item.requirement_text || item.requirement_id}" has no acceptance scenario with proof.`,
      });
    }
  }

  return {
    passed: errors.length === 0,
    status: errors.length === 0 ? "pass" : "blocked",
    coverage: {
      roles: roleCoverage,
      exceptions: exceptionCoverage,
      evidence: evidenceCoverage,
    },
    errors,
    error_count: errors.length,
  };
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

function deferredScopeConfirmation(session = {}) {
  const deferred = asArray(session.discussion?.deferred || session.deferred_scope)
    .map(clean)
    .filter(Boolean);
  const confirmation = session.discussion?.deferred_scope_confirmation || session.deferred_scope_confirmation || {};
  const required = deferred.length > 0 || confirmation.required === true;
  return {
    required,
    confirmed: !required || confirmation.confirmed === true,
    items: deferred.length ? deferred : asArray(confirmation.items).map(clean).filter(Boolean),
    status: clean(confirmation.status || (required ? "needs_confirmation" : "not_required")),
  };
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
  const deferredConfirmation = deferredScopeConfirmation(session);
  const hasExecutionScope = targetFileCount(session) > 0;
  const hasDeclaredTargetFacts = targetFileFactRecords(session).length > 0;
  const deepMode = ["discuss", "prd", "executable_prd"].includes(phase);
  const prdMode = ["prd", "executable_prd"].includes(phase);
  const factGroundingRequired = prdMode || (deepMode && approval.approved === true && (hasExecutionScope || hasDeclaredTargetFacts));
  const factGroundingIssues = factGroundingRequired ? projectFactGrounding(session, options) : [];

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
      "COMPLETENESS_MATRIX",
      (() => {
        const matrix = inspectCompletenessMatrix(session);
        return matrix.passed;
      })(),
      prdMode ? "error" : "warning",
      "Completeness matrix must pass: each role must have ≥1 scenario, each scenario ≥1 exception Q&A, each requirement must have user-visible acceptance evidence.",
      { completeness_matrix: inspectCompletenessMatrix(session) },
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
      "DEFERRED_SCOPE_CONFIRMED",
      !deferredConfirmation.required || deferredConfirmation.confirmed === true,
      (prdMode || (deepMode && approval.approved === true)) ? "error" : "warning",
      "Deferred scope must be explicitly confirmed before executable PRD approval.",
      { deferred_scope_confirmation: deferredConfirmation },
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
      "PLAYBACK_CONFIRMED",
      session.playback?.confirmed === true,
      prdMode || deepMode ? "error" : "warning",
      "Understanding playback must be generated and confirmed by the user before PRD. Run playback confirmation in the interview before to-demand.",
    ),
    check(
      "EVIDENCE_GROUNDED",
      hasLedgerEvidence(options.stateDir),
      prdMode || deepMode ? "error" : "warning",
      "Demand evidence must be grounded in a validated evidence ledger before executable PRD compilation.",
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
    check(
      "PROJECT_FACTS_GROUNDED",
      factGroundingIssues.length === 0,
      factGroundingRequired ? "error" : "warning",
      "Executable PRD requires project facts, field assumptions, and UI specs to be grounded before approval can proceed.",
      { fact_grounding_issues: factGroundingIssues },
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
  const storyAtomicity = options.storyAtomicity || options.story_atomicity || inspectStoryAtomicityFromDemand(session, {
    tasks,
    includeRequirements: false,
  });
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
  const storyAtomicityBlocked = storyAtomicity?.status === "blocked" || asArray(storyAtomicity?.blockers).length > 0;
  const factGroundingIssues = projectFactGrounding(session, options);
  const hasFactIssue = (code) => factGroundingIssues.some((issue) => issue.code === code);
  const evidence_grounded = hasLedgerEvidence(options.stateDir);

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
    { ...qualityDimension({
      code: "project_fact_grounding",
      label: "项目事实落地",
      critical: true,
      checks: [
        qualityCheck(
          "QUALITY_TARGET_FILE_WITHIN_PROJECT",
          !hasFactIssue("QUALITY_TARGET_FILE_WITHIN_PROJECT"),
          20,
          "error",
          factGroundingIssues.find((issue) => issue.code === "QUALITY_TARGET_FILE_WITHIN_PROJECT")?.message
            || "Execution-scope target files must stay inside the project root.",
          { issues: factGroundingIssues },
        ),
        qualityCheck(
          "QUALITY_TARGET_FILE_VERIFIED",
          !hasFactIssue("QUALITY_TARGET_FILE_VERIFIED"),
          20,
          "error",
          factGroundingIssues.find((issue) => issue.code === "QUALITY_TARGET_FILE_VERIFIED")?.message
            || "Execution-scope target files should be verified before PRD execution.",
          { issues: factGroundingIssues },
        ),
        qualityCheck(
          "QUALITY_TARGET_FILE_NOT_INFERRED",
          !hasFactIssue("QUALITY_TARGET_FILE_NOT_INFERRED"),
          15,
          "error",
          factGroundingIssues.find((issue) => issue.code === "QUALITY_TARGET_FILE_NOT_INFERRED")?.message
            || "Auto-scouted files should remain candidates until verified by evidence.",
          { issues: factGroundingIssues },
        ),
        qualityCheck(
          "QUALITY_CONTRADICTED_ASSUMPTION_BLOCKED",
          !hasFactIssue("QUALITY_CONTRADICTED_ASSUMPTION_BLOCKED"),
          20,
          "error",
          factGroundingIssues.find((issue) => issue.code === "QUALITY_CONTRADICTED_ASSUMPTION_BLOCKED")?.message
            || "Contradicted assumptions must block executable PRD generation.",
          { issues: factGroundingIssues },
        ),
        qualityCheck(
          "QUALITY_ASSUMPTION_VERIFIED",
          !hasFactIssue("QUALITY_ASSUMPTION_VERIFIED"),
          15,
          "error",
          factGroundingIssues.find((issue) => issue.code === "QUALITY_ASSUMPTION_VERIFIED")?.message
            || "Project-field assumptions should be verified by evidence or target files.",
          { issues: factGroundingIssues },
        ),
        qualityCheck(
          "QUALITY_BUSINESS_RULE_CONCRETE",
          !hasFactIssue("QUALITY_BUSINESS_RULE_CONCRETE"),
          30,
          "error",
          factGroundingIssues.find((issue) => issue.code === "QUALITY_BUSINESS_RULE_CONCRETE")?.message
            || "Business behavior should not require the execution agent to invent a rule.",
          { issues: factGroundingIssues },
        ),
        qualityCheck(
          "QUALITY_FIELD_SOURCE_CONCRETE",
          !hasFactIssue("QUALITY_FIELD_SOURCE_CONCRETE"),
          30,
          "error",
          factGroundingIssues.find((issue) => issue.code === "QUALITY_FIELD_SOURCE_CONCRETE")?.message
            || "Field-dependent behavior should cite concrete field/source names.",
          { issues: factGroundingIssues },
        ),
        qualityCheck(
          "QUALITY_FIELD_ASSUMPTION_VERIFIED",
          !hasFactIssue("QUALITY_FIELD_ASSUMPTION_VERIFIED"),
          20,
          "error",
          factGroundingIssues.find((issue) => issue.code === "QUALITY_FIELD_ASSUMPTION_VERIFIED")?.message
            || "Field assumptions should not contradict target project files.",
          { issues: factGroundingIssues },
        ),
        qualityCheck(
          "QUALITY_UI_VISUAL_SPEC_CONCRETE",
          !hasFactIssue("QUALITY_UI_VISUAL_SPEC_CONCRETE"),
          20,
          "error",
          factGroundingIssues.find((issue) => issue.code === "QUALITY_UI_VISUAL_SPEC_CONCRETE")?.message
            || "Visible UI behavior should include concrete visual/text/position/component specs.",
          { issues: factGroundingIssues },
        ),
        qualityCheck(
          "QUALITY_UI_STYLE_SOURCE_CONCRETE",
          !hasFactIssue("QUALITY_UI_STYLE_SOURCE_CONCRETE"),
          15,
          "error",
          factGroundingIssues.find((issue) => issue.code === "QUALITY_UI_STYLE_SOURCE_CONCRETE")?.message
            || "Visible UI behavior should state a style source or explicit styling.",
          { issues: factGroundingIssues },
        ),
        qualityCheck(
          "QUALITY_UI_STYLE_SOURCE_RESOLVED",
          !hasFactIssue("QUALITY_UI_STYLE_SOURCE_RESOLVED"),
          15,
          "error",
          factGroundingIssues.find((issue) => issue.code === "QUALITY_UI_STYLE_SOURCE_RESOLVED")?.message
            || "Conditional UI styling choices should be resolved before executable PRD generation.",
          { issues: factGroundingIssues },
        ),
        qualityCheck(
          "QUALITY_ERROR_CONTRACT_CONCRETE",
          !hasFactIssue("QUALITY_ERROR_CONTRACT_CONCRETE"),
          15,
          "error",
          factGroundingIssues.find((issue) => issue.code === "QUALITY_ERROR_CONTRACT_CONCRETE")?.message
            || "API/service error behavior should state an observable error shape, message, or code.",
          { issues: factGroundingIssues },
        ),
      ],
    }), evidence_grounded },
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
        qualityCheck(
          "QUALITY_STORY_ATOMICITY_PASSED",
          !storyAtomicityBlocked,
          20,
          "error",
          "Requirement, scenario, and task narratives must each carry only one independent user story.",
          { story_atomicity_status: storyAtomicity?.status || null, blockers: asArray(storyAtomicity?.blockers) },
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
        code: dimension.score < dimension.block_threshold
          ? `DEMAND_QUALITY_${dimension.code.toUpperCase()}_LOW`
          : `DEMAND_QUALITY_${dimension.code.toUpperCase()}_BLOCKED`,
        dimension: dimension.code,
        score: dimension.score,
        threshold: dimension.block_threshold,
        message: dimension.score < dimension.block_threshold
          ? `${dimension.label} quality is below executable PRD threshold.`
          : `${dimension.label} has blocking failed checks before executable PRD generation.`,
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
    story_atomicity_status: storyAtomicity?.status || null,
    next_actions: blockers.length > 0
      ? blockers.map((item) => item.message)
      : warnings.length > 0
        ? warnings.map((item) => item.message)
        : ["Demand quality is sufficient for approved-demand PRD execution."],
  };
}
