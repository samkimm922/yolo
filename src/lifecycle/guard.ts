import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { LIFECYCLE_STAGES, getLifecycleStage, lifecycleStageForCommand, validateLifecycleState, type LifecycleStage } from "./schema.js";
import { lifecycleArtifactPath, lifecycleStatusPath, resolveLifecycleStateRoot } from "./state.js";
import { inspectWorktreeDrift } from "./source-snapshot.js";
import { isStructuredManualAcceptanceEvidence } from "./manual-acceptance.js";

export const LIFECYCLE_GUARD_SCHEMA_VERSION = "1.0";
export const LIFECYCLE_GUARD_SCHEMA = "yolo.lifecycle.guard.v1";

const SETUP_COMMANDS = new Set(["yolo-init", "yolo-install", "yolo-doctor"]);
const EARLY_COMMANDS = new Set(["yolo", "yolo-next", "yolo-brainstorm", "yolo-interview", "yolo-discover", "yolo-discuss"]);
const WRITE_COMMANDS = new Set(["yolo-run", "yolo-fix", "yolo-init", "yolo-install"]);
const PRD_DEMAND_INPUTS = ["demandPath", "demand", "sessionPath", "session"];
// Must remain empty. Adding any stage here allows warning-state artifacts to bypass gate enforcement (fail-closed policy).
const WARNING_READY_STAGES: ReadonlySet<string> = Object.freeze(new Set<string>());
const BLOCKING_REPORT_STATUSES = new Set(["blocked", "error", "failed", "fail", "warning", "draft", "not_run", "indeterminate"]);
const PENDING_REPORT_STATUSES = new Set(["pending", "active", "running", "in_progress", "todo", "open"]);

// recommended_command must be a runnable `yolo <subcommand>` — non-technical users
// paste it directly into a terminal. Slash forms (/yolo-*) only resolve inside a
// Claude/Codex chat, so they must never appear as the recommended_command value.
const MAIN_NEXT_STAGES = [
  { stage: "discovery", command: "yolo demand --stage interview", description: "clarify the idea before planning" },
  { stage: "roadmap", command: "yolo tasks", description: "create the execution plan" },
  { stage: "prd", command: "yolo spec", description: "compile the executable PRD" },
  { stage: "check", command: "yolo check", description: "validate the PRD before edits" },
  { stage: "run", command: "yolo run", description: "execute only after check passes and the user approves execution" },
  { stage: "review-fix", command: "yolo review", description: "review the implementation and resolve findings" },
  { stage: "acceptance", command: "yolo release accept", description: "collect acceptance evidence" },
  { stage: "delivery", command: "yolo ship", description: "produce delivery readiness" },
  { stage: "learn", command: "yolo learn", description: "record bounded lessons" },
];

export type GuardRecord = Record<string, unknown>;

export interface GuardInput extends GuardRecord {
  command?: unknown;
  projectRoot?: unknown;
  project_root?: unknown;
  cwd?: unknown;
  prdPath?: unknown;
  prd_path?: unknown;
  prd?: unknown;
  [key: string]: unknown;
}

export interface GuardOptions extends GuardRecord {
  command?: unknown;
  projectRoot?: unknown;
  project_root?: unknown;
  cwd?: unknown;
  stateRoot?: unknown;
  state_root?: unknown;
  input?: GuardInput;
  [key: string]: unknown;
}

export interface LifecycleStatusState extends GuardRecord {
  current_stage?: unknown;
  stages?: LifecycleStatusStageEntry[];
}

export interface LifecycleStatusStageEntry extends GuardRecord {
  id?: string;
  status?: string;
  sequence?: unknown;
  label?: unknown;
  artifact?: unknown;
  writes_code?: unknown;
}

export interface StageReport extends GuardRecord {
  status?: unknown;
  verdict?: unknown;
  outcome?: unknown;
  result?: GuardRecord;
  report?: GuardRecord;
  report_json?: unknown;
  report_markdown?: unknown;
  evidence?: unknown[];
  artifacts?: unknown[];
  outputs?: unknown[];
  manual_criteria?: unknown[];
  blockers?: unknown[];
  blocked_reasons?: unknown[];
  issues?: unknown[];
  checks?: unknown[];
  inputs?: unknown[];
  decisions?: unknown[];
  next_actions?: unknown[];
  must_fix_before_ship?: unknown;
  mustFixBeforeShip?: unknown;
}

export interface EvidenceEntry extends GuardRecord {
  path?: unknown;
  file?: unknown;
  file_path?: unknown;
  filePath?: unknown;
  type?: unknown;
  task_id?: unknown;
  condition_id?: unknown;
}

export interface StageRequirement extends GuardRecord {
  stage: string;
  code: string;
  message: string;
  satisfiedBy?: string[];
  defaultArtifacts?: string[];
  requireLifecycleArtifact?: boolean;
  mustBeCompleted?: boolean;
  mustBeStrictCompleted?: boolean;
  requireCurrentPrdCheck?: boolean;
}

export interface GuardBlocker {
  code: string;
  stage: string;
  message: string;
}

export interface ReadLifecycleReportResult {
  path: string;
  report: StageReport | null;
  error: Error | null;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function asCommand(value: unknown = ""): string {
  const command = clean(value).replace(/^\//, "");
  return command || "yolo";
}

function normalizePath(projectRoot: string, value: unknown): string {
  const path = clean(value);
  if (!path) return "";
  return isAbsolute(path) ? path : resolve(projectRoot, path);
}

function readJsonFile(path: string): GuardRecord {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readCurrentStage(statusPath: string): string | null {
  if (!existsSync(statusPath)) return null;
  try {
    return (readJsonFile(statusPath).current_stage as string) || null;
  } catch {
    return null;
  }
}

function stageStatus(state: LifecycleStatusState = Object(), stageId = ""): string {
  // status.json may contain valid JSON with a null/non-object entry inside the
  // `stages` array, or `stages` may be a non-array value (botched external
  // write, partial flush, git merge). Without this guard, `stage.id` crashes
  // on null entries and `.find` crashes when `stages` is a string/object —
  // taking down every guard call site that routes through stageReady/
  // stageCompleted. Mirrors the optional-chaining + Array.isArray pattern
  // used in validateLifecycleState (schema.ts).
  const stages: LifecycleStatusStageEntry[] = Array.isArray(state?.stages) ? state.stages : [];
  return stages.find((stage) => stage?.id === stageId)?.status || "pending";
}

function stageCompleted(state: LifecycleStatusState = Object(), stageId = ""): boolean {
  return stageStatus(state, stageId) === "completed";
}

function stageReady(state: LifecycleStatusState = Object(), stageId = ""): boolean {
  const status = stageStatus(state, stageId);
  return status === "completed" || (status === "warning" && WARNING_READY_STAGES.has(stageId));
}

function inputPathExists(projectRoot: string, input: GuardInput = Object(), keys: string[] = []): boolean {
  return keys.some((key) => {
    const path = normalizePath(projectRoot, input[key] || input[key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]);
    return Boolean(path && existsSync(path));
  });
}

function existingDemandInputForPrd(command: string, projectRoot: string, input: GuardInput = Object()): boolean {
  return command === "yolo-prd" && inputPathExists(projectRoot, input, PRD_DEMAND_INPUTS);
}

function defaultArtifactExists(stateRoot: string, relativePath: string): boolean {
  return existsSync(resolve(stateRoot, relativePath));
}

function lifecycleArtifactReady(stateRoot: string, stageId: string): boolean {
  const path = lifecycleArtifactPath(stageId, { stateRoot });
  if (!existsSync(path)) return false;
  try {
    const artifact = readJsonFile(path) as StageReport;
    if (reportHasStatus(artifact, BLOCKING_REPORT_STATUSES) || reportHasStatus(artifact, PENDING_REPORT_STATUSES)) return false;
    return stageReady({ stages: [{ id: stageId, status: clean(artifact.status) }] }, stageId);
  } catch {
    return false;
  }
}

function normalizeReportStatus(value: unknown): string {
  return clean(value).toLowerCase().replace(/\s+/g, "_");
}

function reportStatusValues(report: GuardRecord = Object(), depth = 0): string[] {
  if (!report || typeof report !== "object" || depth > 4) return [];
  const result = report.result as GuardRecord | undefined;
  const nested = report.report as GuardRecord | undefined;
  return [
    report.status,
    report.verdict,
    report.outcome,
    result?.status,
    ...reportStatusValues(nested, depth + 1),
    ...reportStatusValues(result?.report as GuardRecord, depth + 1),
  ].map(normalizeReportStatus).filter(Boolean);
}

function reportHasStatus(report: GuardRecord, statuses: Set<string>): boolean {
  return reportStatusValues(report).some((status) => statuses.has(status));
}

function reportStatusForMessage(report: GuardRecord, statuses: Set<string>): string {
  return reportStatusValues(report).find((status) => statuses.has(status))
    || reportStatusValues(report)[0]
    || "unknown";
}

function readLifecycleReport(stateRoot: string, stageId: string): ReadLifecycleReportResult {
  const path = lifecycleArtifactPath(stageId, { stateRoot });
  if (!existsSync(path)) return { path, report: null, error: null };
  try {
    return { path, report: readJsonFile(path) as StageReport, error: null };
  } catch (error) {
    return { path, report: null, error: error as Error };
  }
}

function demandPathFromStageReport(report: GuardRecord = Object()): string {
  const nested = report.report as GuardRecord | undefined;
  const demand = nested?.demand as GuardRecord | undefined;
  const candidates: unknown[] = [
    nested?.demand_path,
    nested?.demandPath,
    demand?.demand_path,
    demand?.demandPath,
    nested?.demand_dir,
    nested?.demandDir,
    report.demand_path,
    report.demandPath,
    report.demand_dir,
    report.demandDir,
    ...(Array.isArray(nested?.outputs) ? nested.outputs : [])
      .filter((output) => output?.type === "demand_json" && clean((output as EvidenceEntry).path).endsWith("session.json"))
      .map((output) => (output as EvidenceEntry).path),
  ];
  return candidates.map(clean).find(Boolean) || "";
}

function demandPathForSpec(stateRoot: string): string {
  for (const stage of ["roadmap", "discovery"]) {
    const read = readLifecycleReport(stateRoot, stage);
    if (!read.report) continue;
    const demandPath = demandPathFromStageReport(read.report);
    if (demandPath) return demandPath;
  }
  return "";
}

function truthyFlag(value: unknown): boolean {
  return value === true || normalizeReportStatus(value) === "true";
}

function hasMustFixBeforeShip(value: unknown, depth = 0): boolean {
  if (!value || depth > 8) return false;
  if (Array.isArray(value)) return value.some((item) => hasMustFixBeforeShip(item, depth + 1));
  if (typeof value !== "object") return false;
  const record = value as GuardRecord;
  if (truthyFlag(record.must_fix_before_ship) || truthyFlag(record.mustFixBeforeShip)) return true;
  return Object.values(record).some((item) => hasMustFixBeforeShip(item, depth + 1));
}

function meaningfulEvidenceEntry(entry: unknown): boolean {
  if (!entry) return false;
  if (typeof entry === "string") return Boolean(clean(entry));
  if (typeof entry !== "object") return true;
  return Object.keys(entry as object).length > 0;
}

function evidencePathExists(projectRoot: string, entry: unknown): { exists: boolean; empty: boolean; path?: string } {
  if (!entry || typeof entry !== "object") return { exists: false, empty: true };
  const record = entry as EvidenceEntry;
  const rawPath = record.path || record.file || record.file_path || record.filePath;
  if (!rawPath) return { exists: false, empty: true };
  // Preserve original pass-through semantics: node:path throws on non-string
  // truthy values (the historical behavior under implicit-any), so keep the
  // raw runtime value rather than normalizing it through clean().
  const rawPathStr = rawPath as string;
  const absPath = isAbsolute(rawPathStr) ? rawPathStr : resolve(projectRoot, rawPathStr);
  if (!existsSync(absPath)) return { exists: false, empty: true, path: absPath };
  try {
    const stats = statSync(absPath);
    return { exists: true, empty: stats.size === 0, path: absPath };
  } catch {
    return { exists: false, empty: true, path: absPath };
  }
}

function validateEvidencePaths(projectRoot: string, report: GuardRecord = Object(), stageId = ""): GuardBlocker[] {
  const blockers: GuardBlocker[] = [];
  const entries = reportEvidenceEntries(report);
  if (entries.length === 0) return blockers;
  for (const entry of entries) {
    const { exists, empty, path } = evidencePathExists(projectRoot, entry);
    if (!exists) {
      blockers.push(makeBlocker(
        `${stageId.toUpperCase()}_EVIDENCE_PATH_MISSING`,
        stageId,
        `${stageId} evidence path does not exist: ${path || (entry as EvidenceEntry).path || (entry as EvidenceEntry).file || "unknown"}`,
      ));
    } else if (empty) {
      blockers.push(makeBlocker(
        `${stageId.toUpperCase()}_EVIDENCE_PATH_EMPTY`,
        stageId,
        `${stageId} evidence file is empty: ${path}`,
      ));
    }
  }
  return blockers;
}

function hasManualAcceptanceCriteria(report: GuardRecord = Object()): boolean {
  const nestedReport = report.report as GuardRecord | undefined;
  const manualCriteria = Array.isArray(report.manual_criteria) ? report.manual_criteria : [];
  const nested = Array.isArray(nestedReport?.manual_criteria) ? nestedReport.manual_criteria : [];
  // acceptance-report.json is an external artifact that can be hand-edited,
  // partially flushed, or git-merged into a valid-JSON-but-malformed shape.
  // A null/number/string entry inside `manual_criteria` would crash
  // `criterion.task_id` below and take down the entire delivery gate.
  // Reject non-object entries first, mirroring the asConditions/isBlockingCheck
  // pattern used elsewhere in this module.
  const allManual = [...manualCriteria, ...nested].filter(
    (criterion) => criterion && typeof criterion === "object" && !Array.isArray(criterion),
  ) as EvidenceEntry[];
  if (allManual.length === 0) return false;

  const evidence = reportEvidenceEntries(report);
  const manualEvidence = evidence.filter(
    (e) => isStructuredManualAcceptanceEvidence(e),
  );

  const unresolved = allManual.filter((criterion) => {
    const taskId = criterion.task_id;
    const conditionId = criterion.condition_id;
    if (!taskId || !conditionId) return true;
    return !manualEvidence.some(
      (record) => (record as EvidenceEntry).task_id === taskId && (record as EvidenceEntry).condition_id === conditionId,
    );
  });

  return unresolved.length > 0;
}

function reportEvidenceEntries(report: GuardRecord = Object()): EvidenceEntry[] {
  const nestedReport = report.report as GuardRecord | undefined;
  return [
    ...(Array.isArray(report.evidence) ? report.evidence : []),
    ...(Array.isArray(nestedReport?.evidence) ? nestedReport.evidence : []),
  ].filter(meaningfulEvidenceEntry) as EvidenceEntry[];
}

function samePath(projectRoot: string, left: unknown, right: unknown): boolean {
  const leftPath = normalizePath(projectRoot, left);
  const rightPath = normalizePath(projectRoot, right);
  return Boolean(leftPath && rightPath && leftPath === rightPath);
}

function checkedPrdMatchesInput(projectRoot: string, stateRoot: string, input: GuardInput = Object()): boolean {
  const prdPath = normalizePath(projectRoot, input.prdPath || input.prd_path || input.prd);
  if (!prdPath) return false;
  const path = lifecycleArtifactPath("check", { stateRoot });
  if (!existsSync(path)) return false;
  try {
    const artifact = readJsonFile(path);
    const nestedReport = artifact.report as GuardRecord | undefined;
    const checkedPrd = nestedReport?.prd_path || nestedReport?.prdPath || artifact.prd_path || artifact.prdPath;
    return samePath(projectRoot, checkedPrd, prdPath);
  } catch {
    return false;
  }
}

function lifecycleMissingResult({ command, projectRoot, stateRoot, statusPath }: { command: string; projectRoot: string; stateRoot: string; statusPath: string }) {
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
      message: "Run `yolo init` before guarded downstream stages.",
    }],
    warnings: [],
    allowed_commands: ["yolo init", "yolo doctor", "yolo demand --stage brainstorm", "yolo demand --stage interview", "yolo demand --stage discover", "yolo demand --stage discuss"],
    recommended_command: "yolo init",
    next_actions: ["Run `yolo init` for this target project, then use `yolo status`."],
  };
}

function makeBlocker(code: string, stage: string, message: string): GuardBlocker {
  return { code, stage, message };
}

function deliveryHardGateBlockers(stateRoot: string, projectRoot: string): GuardBlocker[] {
  const blockers: GuardBlocker[] = [];
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
  if (run.report) {
    blockers.push(...validateEvidencePaths(projectRoot, run.report, "run"));
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
    blockers.push(...validateEvidencePaths(projectRoot, acceptance.report, "acceptance"));
    if (hasManualAcceptanceCriteria(acceptance.report)) {
      blockers.push(makeBlocker(
        "ACCEPTANCE_MANUAL_CRITERIA_UNRESOLVED",
        "acceptance",
        "Acceptance evidence contains manual (unverified) acceptance criteria. Each criterion needs either a passing verify command or explicit human acceptance evidence.",
      ));
    }
  }

  return blockers;
}

function requiredStagesFor(command: string, input: GuardInput = Object()): StageRequirement[] {
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
    return [{
      stage: "roadmap",
      code: "PLAN_REQUIRED",
      message: "A completed plan, explicit plan artifact, or existing approved demand session is required before PRD compilation.",
      satisfiedBy: ["planPath", "plan", ...PRD_DEMAND_INPUTS],
      defaultArtifacts: ["discovery/plan.json"],
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
        message: "A passing `yolo check` stage for this PRD is required before YOLO can edit code.",
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
  if (command === "yolo-learn") {
    return [
      { stage: "delivery", code: "DELIVERY_REQUIRED", message: "Delivery evidence is required before lifecycle learning.", mustBeStrictCompleted: true, requireLifecycleArtifact: true },
    ];
  }
  return [];
}

function requirementSatisfied(requirement: StageRequirement, state: LifecycleStatusState, projectRoot: string, stateRoot: string, options: GuardOptions = Object()): boolean {
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

export function nextLifecycleAction(options: GuardOptions = Object()) {
  const projectRoot = resolve(String(options.projectRoot || options.project_root || options.cwd || process.cwd()));
  const stateRoot = resolveLifecycleStateRoot({ ...options, projectRoot });
  const statusPath = lifecycleStatusPath({ ...options, projectRoot, stateRoot });
  if (!existsSync(statusPath)) {
    return {
      command: "yolo init",
      stage: "setup",
      description: "initialize YOLO lifecycle state",
      reason: "lifecycle_not_initialized",
    };
  }
  let state: LifecycleStatusState;
  try {
    state = readJsonFile(statusPath) as LifecycleStatusState;
  } catch {
    return {
      command: "yolo doctor",
      stage: "check",
      description: "repair unreadable lifecycle status",
      reason: "lifecycle_status_unreadable",
    };
  }
  for (const item of MAIN_NEXT_STAGES) {
    if (!stageReady(state, item.stage)) {
      if (item.stage === "prd") {
        const demandPath = demandPathForSpec(stateRoot);
        if (demandPath) {
          return {
            ...item,
            command: `yolo spec --demand ${demandPath}`,
            reason: `${item.stage}_not_completed`,
          };
        }
      }
      return { ...item, reason: `${item.stage}_not_completed` };
    }
  }
  return {
    command: "yolo learn",
    stage: "learn",
    description: "record lessons or start a new YOLO request",
    reason: "main_lifecycle_complete",
  };
}

export function inspectLifecycleGuard(input = Object(), options = Object()) {
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
      allowed_commands: [recommended.command, "yolo status", "yolo doctor"],
      next_actions: [`Run ${recommended.command} when this stage is complete.`],
    };
  }

  if (!existsSync(statusPath)) {
    if (existingDemandInputForPrd(command, projectRoot, input)) {
      return {
        ...base,
        status: "pass",
        code: "LIFECYCLE_GUARD_PASS",
        summary: "Existing demand input can bootstrap PRD lifecycle state.",
        current_stage: null,
        missing_required_stages: [],
        blockers: [],
        warnings: [],
        allowed_commands: ["yolo spec", "yolo init", "yolo status", "yolo doctor"],
        next_actions: ["Run yolo spec with the existing demand session, then run yolo check on the compiled PRD."],
      };
    }
    return lifecycleMissingResult({ command, projectRoot, stateRoot, statusPath });
  }

  let state: LifecycleStatusState;
  try {
    state = readJsonFile(statusPath) as LifecycleStatusState;
  } catch (error) {
    // readFileSync throws NodeJS.ErrnoException (an Error subclass); .message is
    // a string in practice. Narrow once to read it, preserving the original
    // `error.message` rendering in the summary and blocker message.
    const message = (error as Error).message;
    return {
      ...base,
      status: "blocked",
      code: "LIFECYCLE_STATUS_UNREADABLE",
      summary: `YOLO lifecycle status cannot be read: ${message}`,
      current_stage: null,
      missing_required_stages: ["setup"],
      blockers: [makeBlocker("LIFECYCLE_STATUS_UNREADABLE", "setup", message)],
      warnings: [],
      allowed_commands: ["yolo doctor", "yolo init"],
      next_actions: ["Run `yolo doctor` to inspect lifecycle status."],
    };
  }

  const validation = validateLifecycleState(state);
  const blockers = [];
  if (!validation.valid) {
    blockers.push(...validation.errors.map((error) => makeBlocker(error.code, "setup", error.message)));
  }

  const drift = inspectLifecycleDrift(projectRoot);
  if (drift.has_drift) {
    for (const record of drift.drift_records) {
      blockers.push(makeBlocker(
        `LIFECYCLE_DRIFT_${record.code}`,
        record.stage,
        record.message,
      ));
    }
  }

  const requirements = requiredStagesFor(command, input);
  for (const requirement of requirements) {
    if (!requirementSatisfied(requirement, state, projectRoot, stateRoot, { ...options, ...input, projectRoot, stateRoot, input })) {
      blockers.push(makeBlocker(requirement.code, requirement.stage, requirement.message));
    }
  }
  if (command === "yolo-ship") {
    blockers.push(...deliveryHardGateBlockers(stateRoot, projectRoot));
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
      allowed_commands: [recommended.command, "yolo status", "yolo doctor"],
      next_actions: [
        `Run ${recommended.command} first.`,
        "Use `yolo status` when you are unsure which YOLO stage is currently allowed.",
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
    allowed_commands: [command.startsWith("yolo-") ? command.replace(/^yolo-/, "yolo ") : command, recommended.command, "yolo status"],
    next_actions: WRITE_COMMANDS.has(command)
      ? ["Confirm execution is current and specific before starting write-capable work."]
      : [`Complete this stage, then run ${recommended.command}.`],
  };
}

export interface DriftRecord {
  stage: string;
  code: string;
  declared: string;
  actual: string;
  message: string;
}

export interface LifecycleDriftResult {
  has_drift: boolean;
  drift_records: DriftRecord[];
}

const STAGE_ARTIFACTS: Record<string, string[]> = {
  discovery: ["discovery.json"],
  roadmap: ["roadmap.json"],
  prd: ["prd.json"],
  check: ["check-report.json"],
  run: ["run-report.json"],
  "review-fix": ["review-report.json"],
  acceptance: ["acceptance-report.json"],
  delivery: ["delivery-report.json"],
  learn: ["retrospective.json"],
};

function readArtifactTimestamp(stateRoot: string, stageId: string): string | null {
  const path = lifecycleArtifactPath(stageId, { stateRoot });
  if (!existsSync(path)) return null;
  try {
    const artifact = JSON.parse(readFileSync(path, "utf8"));
    return artifact.updated_at || artifact.timestamp || null;
  } catch {
    return null;
  }
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function inspectLifecycleDrift(projectRoot: string): LifecycleDriftResult {
  const stateRoot = resolveLifecycleStateRoot({ projectRoot });
  const statusPath = lifecycleStatusPath({ projectRoot, stateRoot });
  const drift_records: DriftRecord[] = [];
  if (!existsSync(statusPath)) {
    return { has_drift: false, drift_records };
  }
  let status: { stages?: Array<{ id: string; status: string }> };
  try {
    status = JSON.parse(readFileSync(statusPath, "utf8"));
  } catch {
    return { has_drift: false, drift_records };
  }
  // Filter null/non-object entries from a corrupted-but-valid-JSON stages
  // array up front; downstream `entry.status` access would otherwise crash on
  // null (same boundary as stageStatus above and PR #61/#65). validateLifecycle
  // State tolerates these via optional chaining; this drift path did not.
  const stages = Array.isArray(status.stages)
    ? status.stages.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    : [];

  const completedStages = new Set(
    stages
      .filter((entry) => entry.status === "completed")
      .map((entry) => entry.id),
  );

  // Check artifact presence for declared completed stages.
  for (const stageEntry of stages) {
    if (stageEntry.status !== "completed") continue;
    const artifacts = STAGE_ARTIFACTS[stageEntry.id];
    if (!artifacts) continue;
    const lifecycleDir = join(stateRoot, "lifecycle");
    const anyPresent = artifacts.some((rel) => existsSync(join(lifecycleDir, rel)));
    if (!anyPresent) {
      drift_records.push({
        stage: stageEntry.id,
        code: "ARTIFACT_MISSING",
        declared: "completed",
        actual: "missing",
        message: `Stage ${stageEntry.id} is declared completed but its artifact is missing.`,
      });
    }
  }

  // Check artifact presence for declared completed stages and timestamp monotonicity.
  const orderedCompleted = LIFECYCLE_STAGES.filter((s) => completedStages.has(s.id));
  // previousStage is set on every iteration; previousTimestamp only when a
  // stage has a parseable timestamp. They move together for the contradiction
  // check (a prior timestamp implies a prior stage was recorded), so narrow
  // previousStage inside the guarded branch rather than re-checking it.
  let previousStage: LifecycleStage | null = null;
  let previousTimestamp: number | null = null;
  for (const stage of orderedCompleted) {
    const ts = parseTimestamp(readArtifactTimestamp(stateRoot, stage.id));
    // Tolerate small clock jitter between rapid successive writes; only flag meaningful contradictions.
    if (previousTimestamp != null && ts != null && previousTimestamp - ts > 1000 && previousStage) {
      drift_records.push({
        stage: stage.id,
        code: "TIMESTAMP_CONTRADICTION",
        declared: "completed",
        actual: "earlier_than_prior",
        message: `Stage ${stage.id} artifact timestamp is earlier than prior completed stage ${previousStage.id}.`,
      });
    }
    previousStage = stage;
    if (ts != null) previousTimestamp = ts;
  }

  // BUG-C2: worktree drift — detect out-of-band source edits since the last
  // check snapshot. If the working tree signature changed, the lifecycle state
  // can no longer be trusted as authoritative.
  const worktreeDrift = inspectWorktreeDrift({ projectRoot });
  if (worktreeDrift.has_drift) {
    drift_records.push({
      stage: "check",
      code: "WORKTREE_DIVERGED",
      declared: "clean",
      actual: "diverged",
      message: worktreeDrift.reason || "Working tree changed since the last check snapshot.",
    });
  }

  return { has_drift: drift_records.length > 0, drift_records };
}

export function formatLifecycleGuardText(result = Object()) {
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
