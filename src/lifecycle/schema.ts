export const LIFECYCLE_SCHEMA_VERSION = "1.0";
export const LIFECYCLE_STATE_SCHEMA = "yolo.lifecycle.state.v1";
export const LIFECYCLE_ARTIFACT_SCHEMA = "yolo.lifecycle.artifact.v1";

export type LifecycleRecord = Record<string, unknown>;

export interface LifecycleStage {
  id: string;
  sequence: number;
  label: string;
  purpose: string;
  default_artifact: string;
  entry_commands: string[];
  writes_code: boolean;
}

export interface LifecycleArtifactOptions extends LifecycleRecord {
  now?: unknown;
  projectName?: unknown;
  project_name?: unknown;
  status?: unknown;
}

export interface LifecycleSnapshotOptions extends LifecycleRecord {
  now?: unknown;
  projectName?: unknown;
  project_name?: unknown;
  currentStage?: unknown;
  current_stage?: unknown;
}

export interface LifecycleStateStageEntry extends LifecycleRecord {
  id?: string;
  status?: string;
  sequence?: unknown;
  label?: unknown;
  artifact?: unknown;
  writes_code?: unknown;
}

export interface LifecycleState extends LifecycleRecord {
  schema?: unknown;
  current_stage?: unknown;
  stages?: LifecycleStateStageEntry[];
}

export interface LifecycleValidationError {
  code: string;
  message: string;
  [key: string]: unknown;
}

export interface LifecycleValidationResult {
  status: "invalid" | "warning" | "pass";
  valid: boolean;
  errors: LifecycleValidationError[];
  warnings: LifecycleValidationError[];
}

export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  {
    id: "idea",
    sequence: 1,
    label: "Idea intake",
    purpose: "Capture the original user idea before planning or implementation.",
    default_artifact: "idea.json",
    entry_commands: ["yolo", "yolo-brainstorm", "yolo-interview", "yolo-discover"],
    writes_code: false,
  },
  {
    id: "discovery",
    sequence: 2,
    label: "Discovery",
    purpose: "Clarify problem, audience, success criteria, constraints, and unknowns.",
    default_artifact: "discovery.json",
    entry_commands: ["yolo-interview", "yolo-discuss", "yolo-discover"],
    writes_code: false,
  },
  {
    id: "setup",
    sequence: 3,
    label: "Project setup",
    purpose: "Initialize YOLO state, memory, specs, agent bridge, and project policy.",
    default_artifact: "setup.json",
    entry_commands: ["yolo-init", "yolo-setup", "yolo-install", "yolo-doctor"],
    writes_code: false,
  },
  {
    id: "roadmap",
    sequence: 4,
    label: "Roadmap and plan",
    purpose: "Turn a clarified requirement into sequenced work without changing code.",
    default_artifact: "roadmap.json",
    entry_commands: ["yolo-plan"],
    writes_code: false,
  },
  {
    id: "prd",
    sequence: 5,
    label: "PRD and executable spec",
    purpose: "Compile approved requirements into executable PRD/spec artifacts.",
    default_artifact: "prd.json",
    entry_commands: ["yolo-prd"],
    writes_code: false,
  },
  {
    id: "check",
    sequence: 6,
    label: "Readiness check",
    purpose: "Fail closed on weak PRD, missing context, adapter gaps, missing tests, or unsafe execution state.",
    default_artifact: "check-report.json",
    entry_commands: ["yolo-check", "yolo-eval", "yolo-doctor"],
    writes_code: false,
  },
  {
    id: "run",
    sequence: 7,
    label: "Gated execution",
    purpose: "Execute only approved, checked work with gates, retries, and evidence.",
    default_artifact: "run-report.json",
    entry_commands: ["yolo-run", "yolo-fix"],
    writes_code: true,
  },
  {
    id: "review-fix",
    sequence: 8,
    label: "Review and fix loop",
    purpose: "Review implementation, convert findings into tasks, fix, and re-run gates.",
    default_artifact: "review-report.json",
    entry_commands: ["yolo-review", "yolo-fix"],
    writes_code: true,
  },
  {
    id: "acceptance",
    sequence: 9,
    label: "Acceptance",
    purpose: "Collect product, runtime, UI, accessibility, visual, and evidence-based acceptance results.",
    default_artifact: "acceptance-report.json",
    entry_commands: ["yolo-accept", "yolo-ui-review"],
    writes_code: false,
  },
  {
    id: "delivery",
    sequence: 10,
    label: "Delivery",
    purpose: "Prepare handoff, release readiness, rollback notes, and final evidence.",
    default_artifact: "delivery-report.json",
    entry_commands: ["yolo-ship"],
    writes_code: false,
  },
  {
    id: "learn",
    sequence: 11,
    label: "Learning and retrospective",
    purpose: "Promote useful lessons, pitfalls, and recovery patterns into model-agnostic memory.",
    default_artifact: "retrospective.json",
    entry_commands: ["yolo-learn"],
    writes_code: false,
  },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function listLifecycleStages(): LifecycleStage[] {
  return LIFECYCLE_STAGES.map(clone);
}

export function lifecycleStageIds(): string[] {
  return LIFECYCLE_STAGES.map((stage) => stage.id);
}

export function getLifecycleStage(id: unknown = "idea"): LifecycleStage {
  const stageId = clean(id);
  const stage = LIFECYCLE_STAGES.find((item) => item.id === stageId);
  if (!stage) {
    throw new Error(`Unknown YOLO lifecycle stage "${stageId}". Available stages: ${lifecycleStageIds().join(", ")}`);
  }
  return clone(stage);
}

export function lifecycleStageForCommand(commandName: unknown = ""): LifecycleStage | null {
  const command = clean(commandName).replace(/^\//, "");
  const stage = LIFECYCLE_STAGES.find((item) => item.entry_commands.includes(command));
  return stage ? clone(stage) : null;
}

export interface LifecycleArtifact {
  schema_version: string;
  schema: string;
  project: { name: string };
  stage: {
    id: string;
    sequence: number;
    label: string;
    writes_code: boolean;
  };
  status: string;
  created_at: string;
  updated_at: string;
  inputs: unknown[];
  outputs: unknown[];
  decisions: unknown[];
  evidence: unknown[];
  blockers: unknown[];
  next_actions: unknown[];
}

export function createLifecycleArtifact(stageInput: string | LifecycleStage, options: LifecycleArtifactOptions = Object()): LifecycleArtifact {
  const stage = typeof stageInput === "string" ? getLifecycleStage(stageInput) : getLifecycleStage(stageInput.id);
  const now = clean(options.now) || new Date().toISOString();
  const projectName = clean(options.projectName || options.project_name) || "project";
  // Preserve original `options.status || "pending"` semantics verbatim; callers
  // pass a string status (see buildLifecycleStageReport), and the fallback keeps
  // any truthy value as-is rather than re-normalizing through clean().
  const status = (options.status || "pending") as string;
  return {
    schema_version: LIFECYCLE_SCHEMA_VERSION,
    schema: LIFECYCLE_ARTIFACT_SCHEMA,
    project: {
      name: projectName,
    },
    stage: {
      id: stage.id,
      sequence: stage.sequence,
      label: stage.label,
      writes_code: stage.writes_code,
    },
    status,
    created_at: now,
    updated_at: now,
    inputs: [],
    outputs: [],
    decisions: [],
    evidence: [],
    blockers: [],
    next_actions: [],
  };
}

export interface LifecycleStateSnapshot {
  schema_version: string;
  schema: string;
  project: { name: string };
  current_stage: string;
  created_at: string;
  updated_at: string;
  stages: Array<{
    id: string;
    sequence: number;
    label: string;
    status: string;
    artifact: string;
    writes_code: boolean;
  }>;
}

export function createLifecycleStateSnapshot(options: LifecycleSnapshotOptions = Object()): LifecycleStateSnapshot {
  const now = clean(options.now) || new Date().toISOString();
  const projectName = clean(options.projectName || options.project_name) || "project";
  const currentStage = clean(options.currentStage || options.current_stage) || "idea";
  getLifecycleStage(currentStage);
  return {
    schema_version: LIFECYCLE_SCHEMA_VERSION,
    schema: LIFECYCLE_STATE_SCHEMA,
    project: {
      name: projectName,
    },
    current_stage: currentStage,
    created_at: now,
    updated_at: now,
    stages: LIFECYCLE_STAGES.map((stage) => ({
      id: stage.id,
      sequence: stage.sequence,
      label: stage.label,
      status: stage.id === currentStage ? "active" : "pending",
      artifact: stage.default_artifact,
      writes_code: stage.writes_code,
    })),
  };
}

export function validateLifecycleState(state: unknown = Object()): LifecycleValidationResult {
  // A status.json containing valid JSON `null` (e.g., from a botched external
  // write, partial flush, or git merge) reaches here as null and would crash on
  // `state.schema` below. The default `= Object()` only covers undefined, so
  // guard null explicitly. Other non-object primitives (number/string/array/
  // boolean) already fail safe because property access returns undefined.
  const record = (state === null ? Object() : state) as LifecycleState;
  const errors: LifecycleValidationError[] = [];
  const warnings: LifecycleValidationError[] = [];

  if (record.schema !== LIFECYCLE_STATE_SCHEMA) {
    errors.push({
      code: "LIFECYCLE_STATE_SCHEMA_MISMATCH",
      expected: LIFECYCLE_STATE_SCHEMA,
      actual: record.schema || null,
      message: "lifecycle state schema is not supported",
    });
  }

  const expectedIds = lifecycleStageIds();
  const stages: LifecycleStateStageEntry[] = Array.isArray(record.stages) ? record.stages : [];
  if (stages.length === 0) {
    errors.push({ code: "LIFECYCLE_STAGES_EMPTY", message: "lifecycle state must include stages" });
  }

  const actualIds: Array<string | undefined> = stages.map((stage) => stage?.id);
  const missing = expectedIds.filter((id) => !actualIds.includes(id));
  const unknown = actualIds.filter((id) => id != null && !expectedIds.includes(id));
  if (missing.length > 0) {
    errors.push({ code: "LIFECYCLE_STAGE_MISSING", stages: missing, message: "lifecycle state is missing required stages" });
  }
  if (unknown.length > 0) {
    errors.push({ code: "LIFECYCLE_STAGE_UNKNOWN", stages: unknown, message: "lifecycle state contains unknown stages" });
  }

  const currentStage = clean(record.current_stage);
  if (!expectedIds.includes(currentStage)) {
    errors.push({
      code: "LIFECYCLE_CURRENT_STAGE_INVALID",
      current_stage: currentStage || null,
      message: "current_stage must reference a known lifecycle stage",
    });
  }

  const activeStages: Array<string | undefined> = stages.filter((stage) => stage?.status === "active").map((stage) => stage?.id);
  if (activeStages.length !== 1) {
    warnings.push({
      code: "LIFECYCLE_ACTIVE_STAGE_COUNT",
      active_stages: activeStages,
      message: "lifecycle state should have exactly one active stage",
    });
  } else if (activeStages[0] !== currentStage) {
    warnings.push({
      code: "LIFECYCLE_ACTIVE_STAGE_MISMATCH",
      active_stage: activeStages[0],
      current_stage: currentStage,
      message: "active stage should match current_stage",
    });
  }

  return {
    status: errors.length > 0 ? "invalid" : (warnings.length > 0 ? "warning" : "pass"),
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
