export const GATE_REMEDIATION_SCHEMA_VERSION = "1.0";
export const GATE_REMEDIATION_SCHEMA = "yolo.gate.remediation_plan.v1";

export const GATE_REMEDIATION_ACTIONS = Object.freeze({
  PASS: "PASS",
  AUTO_REMEDIATE: "AUTO_REMEDIATE",
  RETRY_WITH_CONTEXT: "RETRY_WITH_CONTEXT",
  REROUTE_REVIEW_FIX: "REROUTE_REVIEW_FIX",
  ASK_HUMAN: "ASK_HUMAN",
  STOP_UNSAFE: "STOP_UNSAFE",
});

const HUMAN_CODES = new Set([
  "MISSING_PRD_PATH",
  "PRD_NOT_FOUND",
  "PM_REQUIREMENTS_MISSING",
  "PM_TASKS_MISSING",
  "PM_TASK_SCOPE_MISSING",
  "ADAPTER_UI_ACCEPTANCE_MISSING",
  "PRD_PREFLIGHT_BLOCKED",
  "PRD_CONTRACT_BLOCKED",
  "PRD_SPEC_GOVERNANCE_BLOCKED",
  "BROWSER_RENDER_UNAVAILABLE_RELEASE",
  "PUBLIC_DOGFOOD_MISSING",
]);

const AUTO_REMEDIATE_CODES = new Set([
  "FIXTURE_EVIDENCE_MISSING",
  "FIXTURE_EXPECTED_ARTIFACT_MISSING",
  "HARNESS_EVIDENCE_SCHEMA_INVALID",
  "ADAPTER_EVIDENCE_MISSING",
  "UI_SCREENSHOT_MISSING",
  "PM_TASK_ACCEPTANCE_MISSING",
  "UI_STATE_MATRIX_MISSING",
  "UI_EVIDENCE_PLAN_MISSING",
  "EVIDENCE_POST_CONDITIONS_MISSING",
  "ATOMICITY_MUST_SPLIT",
  "ATOMICITY_INVESTIGATE_FIRST",
  "TASK_MISSING_EXECUTABLE_FAIL_GATE",
  "TASK_MISSING_POST_CONDITIONS",
  "TASK_TARGETS_MISSING_EXECUTABLE_COVERAGE",
  "MISSING_REQUIREMENT_TRACE",
  "MISSING_DESIGN_TRACE",
  "MISSING_TERMINAL_EVIDENCE",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === "") return [];
  return [value];
}

function issueCode(issue = Object()) {
  return clean(issue.code || issue.id || issue.rule_id || issue.type || issue.name || "GATE_FAILURE");
}

function issueMessage(issue = Object()) {
  return clean(issue.message || issue.detail || issue.summary || issue.reason || issue.description || issue.type || issue.code || "Gate issue");
}

function issueText(issue = Object()) {
  return lower([
    issueCode(issue),
    issue.type,
    issue.gate,
    issue.source,
    issueMessage(issue),
    ...asArray(issue.rules),
  ].join(" "));
}

function isUnsafeIssue(issue = Object()) {
  const text = issueText(issue);
  return /credential|secret|api[_ -]?key|password|token|publish|release|permission|sandbox|delete|destructive|unsafe|dangerous|innerhtml|billable|npm publish|curl|wget/.test(text);
}

function isHumanRequiredIssue(issue = Object()) {
  const code = issueCode(issue);
  const text = issueText(issue);
  return HUMAN_CODES.has(code) ||
    /discovery|requirement|scope missing|target missing|adapter.*missing|contract_suspect|contract review|needs_contract_review|user approval/.test(text);
}

function isAutoRemediableIssue(issue = Object()) {
  const code = issueCode(issue);
  const text = issueText(issue);
  if (/adapter/.test(text)) return false;
  return AUTO_REMEDIATE_CODES.has(code) ||
    /acceptance.*missing|post.?condition.*missing|state matrix|evidence plan|must split|atomicity/.test(text);
}

function isRetryableFailure(issue = Object(), context = Object()) {
  const text = issueText(issue);
  if (issue.retryable === false) return false;
  if (issue.retryable === true) return true;
  const exitCode = Number(context.gateExitCode);
  return (Number.isInteger(exitCode) && exitCode !== 0) ||
    /postcondition|file scope|file_scope|lint/.test(text);
}

function actionForIssue(issue = Object(), context = Object()) {
  const decisionAction = clean(context.decisionAction || context.gateFailureDecision?.action);
  if (isUnsafeIssue(issue)) return GATE_REMEDIATION_ACTIONS.STOP_UNSAFE;
  if (decisionAction === "contract_suspect") return GATE_REMEDIATION_ACTIONS.ASK_HUMAN;
  if (decisionAction === "stuck" || decisionAction === "max_retry") return GATE_REMEDIATION_ACTIONS.REROUTE_REVIEW_FIX;
  if (decisionAction === "retry" && isRetryableFailure(issue, context)) return GATE_REMEDIATION_ACTIONS.RETRY_WITH_CONTEXT;
  if (isAutoRemediableIssue(issue)) return GATE_REMEDIATION_ACTIONS.AUTO_REMEDIATE;
  if (isHumanRequiredIssue(issue)) return GATE_REMEDIATION_ACTIONS.ASK_HUMAN;
  if (isRetryableFailure(issue, context)) return GATE_REMEDIATION_ACTIONS.RETRY_WITH_CONTEXT;
  return GATE_REMEDIATION_ACTIONS.REROUTE_REVIEW_FIX;
}

function actionRationale(action) {
  switch (action) {
    case GATE_REMEDIATION_ACTIONS.STOP_UNSAFE:
      return "Unsafe or privileged operation detected; automation must stop before risk expands.";
    case GATE_REMEDIATION_ACTIONS.ASK_HUMAN:
      return "The gate found missing intent, scope, adapter, or contract evidence that needs human/product judgment.";
    case GATE_REMEDIATION_ACTIONS.REROUTE_REVIEW_FIX:
      return "The strict gate still fails after retries; convert the failure into a scoped review/fix task.";
    case GATE_REMEDIATION_ACTIONS.AUTO_REMEDIATE:
      return "The issue is structural and can be turned into a bounded remediation task.";
    case GATE_REMEDIATION_ACTIONS.RETRY_WITH_CONTEXT:
      return "The issue is likely fixable by retrying with the gate failure context injected.";
    default:
      return "No remediation required.";
  }
}

function actionAutomationCanContinue(action) {
  return [
    GATE_REMEDIATION_ACTIONS.AUTO_REMEDIATE,
    GATE_REMEDIATION_ACTIONS.RETRY_WITH_CONTEXT,
    GATE_REMEDIATION_ACTIONS.REROUTE_REVIEW_FIX,
  ].includes(action);
}

export function classifyGateRemediationIssue(issue = Object(), context = Object()) {
  const action = actionForIssue(issue, context);
  const taskId = issue.task_id || issue.taskId || context.task?.id || context.taskId || null;
  return {
    id: clean(issue.id || issue.finding_id || issue.code || `${context.source || "gate"}-${context.index ?? 0}`),
    code: issueCode(issue),
    gate: issue.gate || issue.source || issue.type || context.source || "gate",
    task_id: taskId,
    message: issueMessage(issue),
    action,
    automation_can_continue: actionAutomationCanContinue(action),
    requires_human: action === GATE_REMEDIATION_ACTIONS.ASK_HUMAN,
    unsafe_stop: action === GATE_REMEDIATION_ACTIONS.STOP_UNSAFE,
    blocks_ship: true,
    rationale: actionRationale(action),
  };
}

function aggregate(items = []) {
  if (!items.length) {
    return {
      status: "pass",
      action: GATE_REMEDIATION_ACTIONS.PASS,
      automation_can_continue: true,
      requires_human: false,
      unsafe_stop: false,
      blocks_ship: false,
    };
  }
  if (items.some((item) => item.action === GATE_REMEDIATION_ACTIONS.STOP_UNSAFE)) {
    return {
      status: "unsafe_stop",
      action: GATE_REMEDIATION_ACTIONS.STOP_UNSAFE,
      automation_can_continue: false,
      requires_human: true,
      unsafe_stop: true,
      blocks_ship: true,
    };
  }
  if (items.some((item) => item.action === GATE_REMEDIATION_ACTIONS.ASK_HUMAN)) {
    return {
      status: "human_required",
      action: GATE_REMEDIATION_ACTIONS.ASK_HUMAN,
      automation_can_continue: false,
      requires_human: true,
      unsafe_stop: false,
      blocks_ship: true,
    };
  }
  if (items.some((item) => item.action === GATE_REMEDIATION_ACTIONS.REROUTE_REVIEW_FIX)) {
    return {
      status: "remediation_required",
      action: GATE_REMEDIATION_ACTIONS.REROUTE_REVIEW_FIX,
      automation_can_continue: true,
      requires_human: false,
      unsafe_stop: false,
      blocks_ship: true,
    };
  }
  if (items.some((item) => item.action === GATE_REMEDIATION_ACTIONS.AUTO_REMEDIATE)) {
    return {
      status: "remediation_required",
      action: GATE_REMEDIATION_ACTIONS.AUTO_REMEDIATE,
      automation_can_continue: true,
      requires_human: false,
      unsafe_stop: false,
      blocks_ship: true,
    };
  }
  return {
    status: "remediation_required",
    action: GATE_REMEDIATION_ACTIONS.RETRY_WITH_CONTEXT,
    automation_can_continue: true,
    requires_human: false,
    unsafe_stop: false,
    blocks_ship: true,
  };
}

function nextActionsFor(summary) {
  if (summary.action === GATE_REMEDIATION_ACTIONS.PASS) {
    return ["Continue to the next lifecycle step."];
  }
  if (summary.action === GATE_REMEDIATION_ACTIONS.STOP_UNSAFE) {
    return ["Stop automation and get explicit approval before continuing."];
  }
  if (summary.action === GATE_REMEDIATION_ACTIONS.ASK_HUMAN) {
    return ["Ask for the missing product, scope, adapter, or contract decision before executing code."];
  }
  if (summary.action === GATE_REMEDIATION_ACTIONS.REROUTE_REVIEW_FIX) {
    return ["Create an immediate scoped review/fix task from this gate failure before starting unrelated feature work, then run the same strict gate again."];
  }
  if (summary.action === GATE_REMEDIATION_ACTIONS.AUTO_REMEDIATE) {
    return ["Generate a bounded remediation task now, apply it before new feature work, then rerun the strict gate."];
  }
  return ["Retry with the gate failure context injected, then rerun the strict gate."];
}

export function buildGateRemediationPlan({
  source = "gate",
  task = null,
  taskId = null,
  gateExitCode = null,
  attempt = null,
  maxRetry = null,
  decisionAction = null,
  gateFailureDecision = null,
  failures = [],
  blockers = [],
  warnings = [],
  summary = "",
} = Object()) {
  const issues = [...asArray(blockers), ...asArray(failures)];
  const items = issues.map((issue, index) => classifyGateRemediationIssue(issue, {
    source,
    task,
    taskId,
    index,
    gateExitCode,
    attempt,
    maxRetry,
    decisionAction,
    gateFailureDecision,
  }));
  const warningCount = asArray(warnings).length;
  const aggregateResult = items.length === 0 && warningCount > 0
    ? {
      status: "human_required",
      action: GATE_REMEDIATION_ACTIONS.ASK_HUMAN,
      automation_can_continue: false,
      requires_human: true,
      unsafe_stop: false,
      blocks_ship: true,
    }
    : aggregate(items);
  return {
    schema_version: GATE_REMEDIATION_SCHEMA_VERSION,
    schema: GATE_REMEDIATION_SCHEMA,
    source,
    gate_strength: "strict",
    policy: "strong_gate_fail_closed_remediation",
    status: aggregateResult.status,
    action: aggregateResult.action,
    automation_can_continue: aggregateResult.automation_can_continue,
    requires_human: aggregateResult.requires_human,
    unsafe_stop: aggregateResult.unsafe_stop,
    blocks_ship: aggregateResult.blocks_ship,
    task_id: task?.id || taskId || null,
    gate_exit_code: gateExitCode,
    attempt,
    max_retry: maxRetry,
    issue_count: items.length,
    warning_count: warningCount,
    summary: clean(summary) || (
      items.length
        ? "Strict gate produced remediation work; ship remains blocked until it passes."
        : warningCount
          ? "Strict gate produced warnings; automation is blocked until the warnings are reviewed or remediated."
          : "Strict gate passed."
    ),
    items,
    next_actions: nextActionsFor(aggregateResult),
  };
}
