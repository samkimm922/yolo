import { resolve } from "node:path";
import type { ReleaseCheck, ReleaseRecord } from "./readiness.js";

export const PI_EXECUTION_DRILL_SCHEMA_VERSION = "1.0";

const CONTROLLED_PI_MODES = ["mock", "dry_run", "controlled_billable"];

export interface PiExecutionDrillPlan extends ReleaseRecord {
  mode: string;
  writes_workspace: boolean;
  publishes: boolean;
  reads_credentials: boolean;
  spawns_provider: boolean;
  executes_billable_provider: boolean;
}

export interface PiExecutionEvidence extends ReleaseRecord {
  mode?: string;
  execution_mode?: string;
  provider?: string;
  status?: string;
  pi_agent?: boolean;
  agent?: string;
  agent_preset?: string;
  cost_acknowledged?: boolean;
}

export interface PiExecutionDrillOptions extends ReleaseRecord {
  yoloRoot?: string;
  cwd?: string;
  projectRoot?: string;
  project_root?: string;
  mode?: string;
  executionMode?: string;
  execution_mode?: string;
  plan?: PiExecutionDrillPlan;
  executionEvidence?: PiExecutionEvidence | null;
  execution_evidence?: PiExecutionEvidence | null;
  authorization?: ReleaseRecord | null;
  billableAuthorization?: ReleaseRecord | null;
  billable_authorization?: ReleaseRecord | null;
}

function check(code: string, passed: boolean, message: string, extra: ReleaseRecord = Object()): ReleaseCheck {
  return { code, passed, message, ...extra };
}

function isObject(value: unknown): value is ReleaseRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): boolean {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function evidencePresent(value: ReleaseRecord = Object()): boolean {
  return Boolean(value.artifact_path)
    || Boolean(value.report_path)
    || Boolean(value.public_url)
    || (Array.isArray(value.evidence_files) && value.evidence_files.length > 0)
    || (Array.isArray(value.evidence) && value.evidence.length > 0);
}

function noSdkExecutionClaim(value: ReleaseRecord = Object()): boolean {
  return value.executed_by_sdk !== true
    && value.provider_executed_by_sdk !== true
    && value.billable_provider_executed_by_sdk !== true;
}

function authorizationApproved(record: unknown = Object(), provider = ""): boolean {
  const summary = isObject(record) ? record : {};
  return summary.approved === true
    && nonEmptyString(summary.operator || summary.approver)
    && validTimestamp(summary.approved_at || summary.executed_at)
    && nonEmptyString(summary.provider || provider)
    && (summary.provider || provider) === provider
    && summary.cost_acknowledged === true
    && (summary.max_budget_usd === undefined || Number(summary.max_budget_usd) >= 0);
}

export function buildPiExecutionDrillPlan(options: PiExecutionDrillOptions = Object()): PiExecutionDrillPlan {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const projectRoot = resolve(options.projectRoot || options.project_root || process.cwd());
  const mode = options.mode || options.executionMode || options.execution_mode || "dry_run";
  return {
    schema_version: PI_EXECUTION_DRILL_SCHEMA_VERSION,
    schema: "yolo.release.pi_execution_drill_plan.v1",
    yolo_root: yoloRoot,
    project_root: projectRoot,
    mode,
    allowed_modes: CONTROLLED_PI_MODES,
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    requires_human_authorization_for_billable: true,
    required_evidence: [
      "PI agent execution evidence is pass and linked",
      "mock/dry-run evidence proves no provider or billable execution",
      "controlled billable evidence has explicit human authorization, provider name, timestamp, cost acknowledgement, and linked output",
      "billable/provider execution, when performed, happened outside this SDK gate and is recorded as external evidence",
    ],
    stop_conditions: [
      "PI execution evidence is missing, failed, or unlinked",
      "controlled billable evidence has no explicit operator authorization",
      "evidence claims the SDK itself executed a provider or incurred a billable action",
      "credential material or provider secrets are embedded in the evidence",
    ],
  };
}

export function runPiExecutionDrillGate(options: PiExecutionDrillOptions = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const projectRoot = resolve(options.projectRoot || options.project_root || process.cwd());
  const plan = options.plan || buildPiExecutionDrillPlan({
    yoloRoot,
    projectRoot,
    mode: options.mode || options.executionMode || options.execution_mode,
  });
  const executionEvidence = options.executionEvidence || options.execution_evidence || null;
  const evidenceMode = isObject(executionEvidence)
    ? executionEvidence.mode || executionEvidence.execution_mode || plan.mode
    : plan.mode;
  const provider = isObject(executionEvidence) ? executionEvidence.provider || "" : "";
  const authorization = options.authorization || options.billableAuthorization || options.billable_authorization || null;
  const billableMode = evidenceMode === "controlled_billable";

  const checks = [
    check(
      "PI_EXECUTION_DRILL_NO_SIDE_EFFECTS",
      plan.writes_workspace === false
        && plan.publishes === false
        && plan.reads_credentials === false
        && plan.spawns_provider === false
        && plan.executes_billable_provider === false,
      "PI execution drill gate must validate evidence only; it must not edit code, publish, read credentials, spawn providers, or execute billable providers",
    ),
    check(
      "PI_EXECUTION_DRILL_MODE_ALLOWED",
      CONTROLLED_PI_MODES.includes(evidenceMode),
      "PI execution drill mode must be mock, dry_run, or controlled_billable",
      { mode: evidenceMode, allowed_modes: CONTROLLED_PI_MODES },
    ),
    check(
      "PI_EXECUTION_DRILL_EVIDENCE_PRESENT",
      isObject(executionEvidence),
      "PI execution drill requires linked execution evidence",
    ),
    check(
      "PI_EXECUTION_DRILL_EVIDENCE_PASS",
      isObject(executionEvidence) && executionEvidence.status === "pass" && evidencePresent(executionEvidence),
      "PI execution evidence must pass and include an artifact/report/evidence link",
      { evidence: executionEvidence || null },
    ),
    check(
      "PI_EXECUTION_DRILL_PI_AGENT",
      isObject(executionEvidence) && (executionEvidence.pi_agent === true || executionEvidence.agent === "pi" || executionEvidence.agent_preset === "pi"),
      "execution evidence must identify the high-level PI agent path",
      { evidence_agent: isObject(executionEvidence) ? executionEvidence.agent || executionEvidence.agent_preset || null : null },
    ),
    check(
      "PI_EXECUTION_DRILL_EXTERNAL_ONLY",
      isObject(executionEvidence) && noSdkExecutionClaim(executionEvidence),
      "PI drill evidence must not claim that this SDK gate executed provider or billable actions",
    ),
    check(
      "PI_EXECUTION_DRILL_BILLABLE_AUTHORIZATION",
      !billableMode || authorizationApproved(authorization, provider),
      "controlled billable PI evidence requires explicit human authorization with provider and cost acknowledgement",
      { authorization: authorization || null, provider },
    ),
    check(
      "PI_EXECUTION_DRILL_BILLABLE_COST_ACKNOWLEDGED",
      !billableMode || executionEvidence?.cost_acknowledged === true,
      "controlled billable PI evidence must acknowledge cost",
    ),
  ];
  const blockers = checks.filter((item) => item.passed !== true);

  return {
    schema_version: PI_EXECUTION_DRILL_SCHEMA_VERSION,
    schema: "yolo.release.pi_execution_drill_result.v1",
    status: blockers.length === 0 ? "pass" : "blocked",
    yolo_root: yoloRoot,
    project_root: projectRoot,
    mode: evidenceMode,
    provider: provider || null,
    billable_authorized: billableMode && authorizationApproved(authorization, provider),
    checks,
    blockers,
    evidence: {
      execution: executionEvidence,
      authorization,
    },
    plan,
    guarantees: {
      writes_workspace: false,
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      provider_executed_by_this_gate: false,
      billable_executed_by_this_gate: false,
    },
    next_actions: blockers.length === 0
      ? ["Use this PI drill evidence in the public beta evidence bundle."]
      : ["Attach mock/dry-run PI evidence, or add explicit human authorization before accepting controlled billable PI evidence."],
  };
}
