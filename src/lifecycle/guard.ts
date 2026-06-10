import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { lifecycleStageForCommand, validateLifecycleState } from "./schema.js";
import { lifecycleArtifactPath, lifecycleStatusPath, resolveLifecycleStateRoot } from "./state.js";

export const LIFECYCLE_GUARD_SCHEMA_VERSION = "1.0";
export const LIFECYCLE_GUARD_SCHEMA = "yolo.lifecycle.guard.v1";

const SETUP_COMMANDS = new Set(["yolo-init", "yolo-install", "yolo-doctor"]);
const EARLY_COMMANDS = new Set(["yolo", "yolo-next", "yolo-brainstorm", "yolo-interview", "yolo-discover", "yolo-discuss"]);
const WRITE_COMMANDS = new Set(["yolo-run", "yolo-fix", "yolo-init", "yolo-install"]);
// Must remain empty. Adding any stage here allows warning-state artifacts to bypass gate enforcement (fail-closed policy).
const WARNING_READY_STAGES: ReadonlySet<string> = Object.freeze(new Set<string>());
const BLOCKING_REPORT_STATUSES = new Set(["blocked", "error", "failed", "fail", "warning", "draft", "not_run", "indeterminate"]);
const PENDING_REPORT_STATUSES = new Set(["pending", "active", "running", "in_progress", "todo", "open"]);

const MAIN_NEXT_STAGES = [
  { stage: "discovery", command: "/yolo-discover", description: "clarify the idea before planning" },
  { stage: "roadmap", command: "/yolo-plan", description: "create the execution plan" },
  { stage: "task-graph", command: "/yolo-tasks", description: "decompose the plan into atomic executable tasks" },
  { stage: "prd", command: "/yolo-prd", description: "compile the executable PRD" },
  { stage: "check", command: "/yolo-check", description: "validate the PRD before edits" },
  { stage: "run", command: "/yolo-run", description: "execute only after check passes and the user approves execution" },
  { stage: "review-fix", command: "/yolo-review", description: "review the implementation and resolve findings" },
  { stage: "acceptance", command: "/yolo-accept", description: "collect acceptance evidence" },
  { stage: "delivery", command: "/yolo-ship", description: "produce delivery readiness" },
  { stage: "learn", command: "/yolo-learn", description: "record bounded lessons" },
];

function clean(value) {
  return String(value ?? "").trim();
}

function asCommand(value = "") {
  const command = clean(value).replace(/^\//, "");
  return command || "yolo";
}

function normalizePath(projectRoot, value) {
  const path = clean(value);
  if (!path) return "";
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readCurrentStage(statusPath) {
  if (!existsSync(statusPath)) return null;
  try {
    return readJsonFile(statusPath).current_stage || null;
  } catch {
    return null;
  }
}

function stageStatus(state = {}, stageId = "") {
  return (state.stages || []).find((stage) => stage.id === stageId)?.status || "pending";
}

function stageCompleted(state = {}, stageId = "") {
  return stageStatus(state, stageId) === "completed";
}

function stageReady(state = {}, stageId = "") {
  const status = stageStatus(state, stageId);
  return status === "completed" || (status === "warning" && WARNING_READY_STAGES.has(stageId));
}

function inputPathExists(projectRoot, input = {}, keys = []) {
  return keys.some((key) => {
    const path = normalizePath(projectRoot, input[key] || input[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]);
    return path && existsSync(path);
  });
}

function defaultArtifactExists(stateRoot, relativePath) {
  return existsSync(resolve(stateRoot, relativePath));
}

function lifecycleArtifactReady(stateRoot, stageId) {
  const path = lifecycleArtifactPath(stageId, { stateRoot });
  if (!existsSync(path)) return false;
  try {
    const artifact = readJsonFile(path);
    if (reportHasStatus(artifact, BLOCKING_REPORT_STATUSES) || reportHasStatus(artifact, PENDING_REPORT_STATUSES)) return false;
    return stageReady({ stages: [{ id: stageId, status: artifact.status }] }, stageId);
  } catch {
    return false;
  }
}

function normalizeReportStatus(value) {
  return clean(value).toLowerCase().replace(/\s+/g, "_");
}

function reportStatusValues(report = {}, depth = 0) {
  if (!report || typeof report !== "object" || depth > 4) return [];
  return [
    report.status,
    report.verdict,
    report.outcome,
    report.result?.status,
    ...reportStatusValues(report.report, depth + 1),
    ...reportStatusValues(report.result?.report, depth + 1),
  ].map(normalizeReportStatus).filter(Boolean);
}

function reportHasStatus(report, statuses) {
  return reportStatusValues(report).some((status) => statuses.has(status));
}

function reportStatusForMessage(report, statuses) {
  return reportStatusValues(report).find((status) => statuses.has(status))
    || reportStatusValues(report)[0]
    || "unknown";
}

function readLifecycleReport(stateRoot, stageId) {
  const path = lifecycleArtifactPath(stageId, { stateRoot });
  if (!existsSync(path)) return { path, report: null, error: null };
  try {
    return { path, report: readJsonFile(path), error: null };
  } catch (error) {
    return { path, report: null, error };
  }
}

function truthyFlag(value) {
  return value === true || normalizeReportStatus(value) === "true";
}

function hasMustFixBeforeShip(value, depth = 0) {
  if (!value || depth > 8) return false;
  if (Array.isArray(value)) return value.some((item) => hasMustFixBeforeShip(item, depth + 1));
  if (typeof value !== "object") return false;
  if (truthyFlag(value.must_fix_before_ship) || truthyFlag(value.mustFixBeforeShip)) return true;
  return Object.values(value).some((item) => hasMustFixBeforeShip(item, depth + 1));
}

function meaningfulEvidenceEntry(entry) {
  if (!entry) return false;
  if (typeof entry === "string") return Boolean(clean(entry));
  if (typeof entry !== "object") return true;
  return Object.keys(entry).length > 0;
}

function reportEvidenceEntries(report = {}) {
  return [
    ...(Array.isArray(report.evidence) ? report.evidence : []),
    ...(Array.isArray(report.report?.evidence) ? report.report.evidence : []),
  ].filter(meaningfulEvidenceEntry);
}

function samePath(projectRoot, left, right) {
  const leftPath = normalizePath(projectRoot, left);
  const rightPath = normalizePath(projectRoot, right);
  return Boolean(leftPath && rightPath && leftPath === rightPath);
}

function checkedPrdMatchesInput(projectRoot, stateRoot, input = {}) {
  const prdPath = normalizePath(projectRoot, input.prdPath || input.prd_path || input.prd);
  if (!prdPath) return false;
  const path = lifecycleArtifactPath("check", { stateRoot });
  if (!existsSync(path)) return false;
  try {
    const artifact = readJsonFile(path);
    const checkedPrd = artifact.report?.prd_path || artifact.report?.prdPath || artifact.prd_path || artifact.prdPath;
    return samePath(projectRoot, checkedPrd, prdPath);
  } catch {
    return false;
  }
}

function lifecycleMissingResult({ command, projectRoot, stateRoot, statusPath }) {
  return {
    schema_version: LIFECYCLE_GUARD_SCHEMA_VERSION,
    schema: LIFECYCLE_GUARD_SCHEMA,
    status: "blocked",
    code: "LIFECYCLE_NOT_INITIALIZED",
    summary: "YOLO lifecycle is not initialized for this target project.",
    command,
    target_stage: lifecycleStageForCommand(command)?.id || null,
    current_stage: null,
    project_root: projectRoot,
    state_root: stateRoot,
    status_path: statusPath,
    missing_required_stages: ["setup"],
    blockers: [{
      code: "LIFECYCLE_NOT_INITIALIZED",
      stage: "setup",
      message: "Run /yolo-init before guarded downstream stages.",
    }],
    warnings: [],
    allowed_commands: ["/yolo-init", "/yolo-doctor", "/yolo-brainstorm", "/yolo-interview", "/yolo-discover", "/yolo-discuss"],
    recommended_command: "/yolo-init",
    next_actions: ["Run /yolo-init for this target project, then use /yolo-next."],
  };
}

function makeBlocker(code, stage, message) {
  return { code, stage, message };
}

function deliveryHardGateBlockers(stateRoot) {
  const blockers = [];
  const run = readLifecycleReport(stateRoot, "run");
  if (run.error) {
    blockers.push(makeBlocker("RUN_REPORT_UNREADABLE", "run", `Run report cannot be read: ${run.error.message}`));
  } else if (run.report && reportHasStatus(run.report, BLOCKING_REPORT_STATUSES)) {
    blockers.push(makeBlocker(
      "RUN_REPORT_BLOCKED",
      "run",
      `Run report status is ${reportStatusForMessage(run.report, BLOCKING_REPORT_STATUSES)}; delivery cannot pass until run is clean.`,
    ));
  }

  const review = readLifecycleReport(stateRoot, "review-fix");
  if (review.error) {
    blockers.push(makeBlocker("REVIEW_FIX_REPORT_UNREADABLE", "review-fix", `Review/fix report cannot be read: ${review.error.message}`));
  } else if (review.report) {
    if (reportHasStatus(review.report, PENDING_REPORT_STATUSES)) {
      blockers.push(makeBlocker(
        "REVIEW_FIX_PENDING",
        "review-fix",
        `Review/fix status is ${reportStatusForMessage(review.report, PENDING_REPORT_STATUSES)}; delivery cannot pass while review is pending.`,
      ));
    }
    if (hasMustFixBeforeShip(review.report)) {
      blockers.push(makeBlocker(
        "REVIEW_FIX_MUST_FIX_BEFORE_SHIP",
        "review-fix",
        "Review/fix evidence still contains must_fix_before_ship work.",
      ));
    }
  }

  const acceptance = readLifecycleReport(stateRoot, "acceptance");
  if (acceptance.error) {
    blockers.push(makeBlocker("ACCEPTANCE_REPORT_UNREADABLE", "acceptance", `Acceptance report cannot be read: ${acceptance.error.message}`));
  } else if (acceptance.report) {
    if (reportHasStatus(acceptance.report, PENDING_REPORT_STATUSES)) {
      blockers.push(makeBlocker(
        "ACCEPTANCE_REPORT_PENDING",
        "acceptance",
        `Acceptance status is ${reportStatusForMessage(acceptance.report, PENDING_REPORT_STATUSES)}; delivery cannot pass while acceptance is pending.`,
      ));
    }
    if (reportEvidenceEntries(acceptance.report).length === 0) {
      blockers.push(makeBlocker(
        "ACCEPTANCE_EVIDENCE_EMPTY",
        "acceptance",
        "Acceptance report evidence is empty; external E2E output cannot replace YOLO lifecycle evidence.",
      ));
    }
  }

  return blockers;
}

function requiredStagesFor(command, input = {}) {
  if (command === "yolo-plan") {
    return [{
      stage: "discovery",
      code: "DISCOVERY_REQUIRED",
      message: "Discovery must complete before YOLO can create an implementation plan.",
      satisfiedBy: ["discoveryPath", "discovery"],
      defaultArtifacts: ["discovery/discovery.json"],
    }];
  }
  if (command === "yolo-prd") {
    if (input.demandPath || input.demand_path || input.demand) return [];
    return [{
      stage: "roadmap",
      code: "PLAN_REQUIRED",
      message: "A completed plan or explicit plan artifact is required before PRD compilation.",
      satisfiedBy: ["planPath", "plan"],
      defaultArtifacts: ["discovery/plan.json"],
      requireLifecycleArtifact: true,
    },
    {
      stage: "task-graph",
      code: "TASK_GRAPH_REQUIRED",
      message: "A completed task-graph is required before PRD compilation.",
      requireLifecycleArtifact: true,
    }];
  }
  if (command === "yolo-check") {
    return [{
      stage: "prd",
      code: "PRD_REQUIRED",
      message: "A PRD must exist before readiness checks can run.",
      satisfiedBy: ["prdPath", "prd"],
      defaultArtifacts: ["discovery/prd.json"],
    }];
  }
  if (command === "yolo-run" || command === "yolo-fix") {
    return [
      {
        stage: "discovery",
        code: "DISCOVERY_REQUIRED",
        message: "Discovery evidence is required before YOLO can execute code changes.",
        defaultArtifacts: ["discovery/discovery.json"],
        requireLifecycleArtifact: true,
      },
      {
        stage: "roadmap",
        code: "PLAN_REQUIRED",
        message: "A completed plan is required before YOLO can execute code changes.",
        defaultArtifacts: ["discovery/plan.json"],
        requireLifecycleArtifact: true,
      },
      {
        stage: "prd",
        code: "PRD_REQUIRED",
        message: "A PRD artifact is required before YOLO can execute code changes.",
        satisfiedBy: ["prdPath", "prd"],
        defaultArtifacts: ["discovery/prd.json"],
      },
      {
        stage: "check",
        code: "CHECK_REQUIRED",
        message: "A passing /yolo-check stage for this PRD is required before YOLO can edit code.",
        mustBeCompleted: true,
        requireLifecycleArtifact: true,
        requireCurrentPrdCheck: true,
      },
    ];
  }
  if (command === "yolo-review") {
    return [{ stage: "run", code: "RUN_REQUIRED", message: "Run evidence is required before review.", mustBeStrictCompleted: true, requireLifecycleArtifact: true }];
  }
  if (command === "yolo-accept" || command === "yolo-ui-review") {
    return [
      { stage: "run", code: "RUN_REQUIRED", message: "Implementation must run before acceptance.", mustBeStrictCompleted: true, requireLifecycleArtifact: true },
      { stage: "review-fix", code: "REVIEW_REQUIRED", message: "Review/fix evidence is required before acceptance.", mustBeStrictCompleted: true, requireLifecycleArtifact: true },
    ];
  }
  if (command === "yolo-ship") {
    return [
      { stage: "run", code: "RUN_REQUIRED", message: "Run evidence is required before ship readiness.", mustBeStrictCompleted: true, requireLifecycleArtifact: true },
      { stage: "review-fix", code: "REVIEW_REQUIRED", message: "Review/fix evidence is required before ship readiness.", mustBeStrictCompleted: true, requireLifecycleArtifact: true },
      { stage: "acceptance", code: "ACCEPTANCE_REQUIRED", message: "Passing acceptance evidence is required before ship readiness.", mustBeStrictCompleted: true, requireLifecycleArtifact: true },
    ];
  }
  return [];
}

function requirementSatisfied(requirement, state, projectRoot, stateRoot, options = {}) {
  const lifecycleReady = requirement.mustBeStrictCompleted
    ? stageCompleted(state, requirement.stage)
    : stageReady(state, requirement.stage);
  const lifecycleArtifactOk = !requirement.requireLifecycleArtifact || lifecycleArtifactReady(stateRoot, requirement.stage);
  if (lifecycleReady && lifecycleArtifactOk) {
    if (requirement.requireCurrentPrdCheck) return checkedPrdMatchesInput(projectRoot, stateRoot, options.input || {});
    return true;
  }
  if (requirement.mustBeCompleted || requirement.mustBeStrictCompleted) return false;
  if (inputPathExists(projectRoot, options.input || {}, requirement.satisfiedBy || [])) return true;
  return (requirement.defaultArtifacts || []).some((path) => defaultArtifactExists(stateRoot, path));
}

export function nextLifecycleAction(options = {}) {
  const projectRoot = resolve(options.projectRoot || options.project_root || options.cwd || process.cwd());
  const stateRoot = resolveLifecycleStateRoot({ ...options, projectRoot });
  const statusPath = lifecycleStatusPath({ ...options, projectRoot, stateRoot });
  if (!existsSync(statusPath)) {
    return {
      command: "/yolo-init",
      stage: "setup",
      description: "initialize YOLO lifecycle state",
      reason: "lifecycle_not_initialized",
    };
  }
  let state = null;
  try {
    state = readJsonFile(statusPath);
  } catch {
    return {
      command: "/yolo-doctor",
      stage: "check",
      description: "repair unreadable lifecycle status",
      reason: "lifecycle_status_unreadable",
    };
  }
  for (const item of MAIN_NEXT_STAGES) {
    if (!stageReady(state, item.stage)) return { ...item, reason: `${item.stage}_not_completed` };
  }
  return {
    command: "/yolo-learn",
    stage: "learn",
    description: "record lessons or start a new YOLO request",
    reason: "main_lifecycle_complete",
  };
}

export function inspectLifecycleGuard(input = {}, options = {}) {
  const command = asCommand(input.command || options.command);
  const projectRoot = resolve(input.projectRoot || input.project_root || options.projectRoot || options.project_root || input.cwd || options.cwd || process.cwd());
  const stateRoot = resolveLifecycleStateRoot({ ...options, ...input, projectRoot });
  const statusPath = lifecycleStatusPath({ ...options, ...input, projectRoot, stateRoot });
  const commandStage = lifecycleStageForCommand(command);
  const recommended = nextLifecycleAction({ ...options, projectRoot, stateRoot });
  const base = {
    schema_version: LIFECYCLE_GUARD_SCHEMA_VERSION,
    schema: LIFECYCLE_GUARD_SCHEMA,
    command,
    target_stage: commandStage?.id || null,
    project_root: projectRoot,
    state_root: stateRoot,
    status_path: statusPath,
    recommended_command: recommended.command,
  };

  if (SETUP_COMMANDS.has(command) || EARLY_COMMANDS.has(command)) {
    return {
      ...base,
      status: "pass",
      code: "LIFECYCLE_GUARD_PASS",
      summary: "This command is allowed at the current lifecycle boundary.",
      current_stage: readCurrentStage(statusPath),
      missing_required_stages: [],
      blockers: [],
      warnings: [],
      allowed_commands: [recommended.command, "/yolo-next", "/yolo-doctor"],
      next_actions: [`Run ${recommended.command} when this stage is complete.`],
    };
  }

  if (!existsSync(statusPath)) return lifecycleMissingResult({ command, projectRoot, stateRoot, statusPath });

  let state;
  try {
    state = readJsonFile(statusPath);
  } catch (error) {
    return {
      ...base,
      status: "blocked",
      code: "LIFECYCLE_STATUS_UNREADABLE",
      summary: `YOLO lifecycle status cannot be read: ${error.message}`,
      current_stage: null,
      missing_required_stages: ["setup"],
      blockers: [makeBlocker("LIFECYCLE_STATUS_UNREADABLE", "setup", error.message)],
      warnings: [],
      allowed_commands: ["/yolo-doctor", "/yolo-init"],
      next_actions: ["Run /yolo-doctor to inspect lifecycle status."],
    };
  }

  const validation = validateLifecycleState(state);
  const blockers = [];
  if (!validation.valid) {
    blockers.push(...validation.errors.map((error) => makeBlocker(error.code, "setup", error.message)));
  }

  const requirements = requiredStagesFor(command, input);
  for (const requirement of requirements) {
    if (!requirementSatisfied(requirement, state, projectRoot, stateRoot, { ...options, ...input, projectRoot, stateRoot, input })) {
      blockers.push(makeBlocker(requirement.code, requirement.stage, requirement.message));
    }
  }
  if (command === "yolo-ship") {
    blockers.push(...deliveryHardGateBlockers(stateRoot));
  }

  const missing = [...new Set(blockers.map((blocker) => blocker.stage).filter(Boolean))];
  const writeWarning = WRITE_COMMANDS.has(command) && blockers.length === 0
    ? []
    : WRITE_COMMANDS.has(command)
      ? [{ code: "WRITE_COMMAND_BLOCKED", message: "Write-capable commands stay blocked until lifecycle prerequisites pass." }]
      : [];

  if (blockers.length > 0) {
    return {
      ...base,
      status: "blocked",
      code: "LIFECYCLE_GUARD_BLOCKED",
      summary: `${command} is blocked by lifecycle prerequisites.`,
      current_stage: state.current_stage,
      validation,
      missing_required_stages: missing,
      blockers,
      warnings: [...validation.warnings, ...writeWarning],
      allowed_commands: [recommended.command, "/yolo-next", "/yolo-doctor"],
      next_actions: [
        `Run ${recommended.command} first.`,
        "Use /yolo-next when you are unsure which YOLO stage is currently allowed.",
      ],
    };
  }

  return {
    ...base,
    status: "pass",
    code: "LIFECYCLE_GUARD_PASS",
    summary: `${command} is allowed by lifecycle prerequisites.`,
    current_stage: state.current_stage,
    validation,
    missing_required_stages: [],
    blockers: [],
    warnings: validation.warnings,
    allowed_commands: [command.startsWith("yolo-") ? `/${command}` : command, recommended.command, "/yolo-next"],
    next_actions: WRITE_COMMANDS.has(command)
      ? ["Confirm execution is current and specific before starting write-capable work."]
      : [`Complete this stage, then run ${recommended.command}.`],
  };
}

export interface DriftRecord {
  stage: string;
  declared: string;
  actual: "missing" | "corrupt";
}

export interface LifecycleDriftResult {
  has_drift: boolean;
  drift_records: DriftRecord[];
}

const STAGE_ARTIFACTS: Record<string, string[]> = {
  discovery: ["discovery.json"],
  roadmap: ["roadmap.json"],
  "task-graph": ["task-graph.json"],
  prd: ["prd.json"],
  check: ["check-report.json"],
  run: ["run-report.json"],
  "review-fix": ["review-report.json"],
  acceptance: ["acceptance-report.json"],
  delivery: ["delivery-report.json"],
  learn: ["retrospective.json"],
};

export function inspectLifecycleDrift(projectRoot: string): LifecycleDriftResult {
  const stateRoot = resolveLifecycleStateRoot({ projectRoot });
  const statusPath = lifecycleStatusPath({ projectRoot, stateRoot });
  if (!existsSync(statusPath)) {
    return { has_drift: false, drift_records: [] };
  }
  let status: { stages?: Array<{ id: string; status: string }> };
  try {
    status = JSON.parse(readFileSync(statusPath, "utf8"));
  } catch {
    return { has_drift: false, drift_records: [] };
  }
  const drift_records: DriftRecord[] = [];
  for (const stageEntry of status.stages || []) {
    if (stageEntry.status !== "completed") continue;
    const artifacts = STAGE_ARTIFACTS[stageEntry.id];
    if (!artifacts) continue;
    const lifecycleDir = join(stateRoot, "lifecycle");
    const anyPresent = artifacts.some((rel) => existsSync(join(lifecycleDir, rel)));
    if (!anyPresent) {
      drift_records.push({ stage: stageEntry.id, declared: "completed", actual: "missing" });
    }
  }
  return { has_drift: drift_records.length > 0, drift_records };
}

export function formatLifecycleGuardText(result = {}) {
  const lines = [`[yolo guard] ${result.status}: ${result.summary || ""}`.trimEnd()];
  if (result.current_stage) lines.push(`current_stage: ${result.current_stage}`);
  if (result.target_stage) lines.push(`target_stage: ${result.target_stage}`);
  if (result.recommended_command) lines.push(`recommended: ${result.recommended_command}`);
  if (Array.isArray(result.blockers) && result.blockers.length > 0) {
    lines.push("blockers:");
    for (const blocker of result.blockers) {
      lines.push(`  - ${blocker.code || "BLOCKER"} ${blocker.message || ""}`.trimEnd());
    }
  }
  if (Array.isArray(result.next_actions) && result.next_actions.length > 0) {
    lines.push("next:");
    for (const action of result.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}
