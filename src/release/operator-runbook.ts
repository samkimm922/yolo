import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runOperatorReleaseStateMutation } from "./operator-state.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS } from "../lib/toolchain.js";
import type { ReleaseCheck, ReleaseRecord } from "./readiness.js";

export const OPERATOR_RELEASE_RUNBOOK_SCHEMA_VERSION = "1.0";

export const OPERATOR_RELEASE_OPERATIONS = Object.freeze([
  "publish_public_beta",
  "access_credentials",
  "billable_provider_execution",
  "public_dogfood_report",
]);

const DEFAULT_RELEASE_SCOPE = "public-beta";
const DEFAULT_REQUESTED_OPERATIONS = ["publish_public_beta", "public_dogfood_report"];

export interface PackageJsonLike extends ReleaseRecord {
  name?: string;
  version?: string;
  private?: boolean;
}

export interface ManualCommand extends ReleaseRecord {
  id: string;
  command: string;
  execute: boolean;
  requires_human: boolean;
  requires_credentials: boolean;
  requires_billable_provider: boolean;
}

export interface DecisionGateLike extends ReleaseRecord {
  action_authorization?: Record<string, boolean>;
  approved_actions?: string[];
}

export interface OperatorStateLike extends ReleaseRecord {
  status?: string;
  guarantees?: ReleaseRecord;
  components?: {
    decision_gate?: DecisionGateLike | null;
  };
  decision_gate?: DecisionGateLike | null;
}

export interface DogfoodReportLike extends ReleaseRecord {
  status?: string;
  report_path?: string;
  artifact_path?: string;
  evidence_files?: unknown[];
  evidence?: unknown[];
  privacy_reviewed?: boolean;
  publication_approved?: boolean;
  approver?: string;
}

export interface OperatorReleaseRunbookPlan extends ReleaseRecord {
  release_scope: string;
  requested_operations: string[];
  writes_workspace: boolean;
  publishes: boolean;
  reads_credentials: boolean;
  spawns_provider: boolean;
  executes_billable_provider: boolean;
  publishes_dogfood_report: boolean;
  manual_commands: ManualCommand[];
}

export interface OperatorRunbookOptions extends ReleaseRecord {
  yoloRoot?: string;
  cwd?: string;
  packageJson?: PackageJsonLike;
  releaseScope?: string;
  release_scope?: string;
  requestedOperations?: unknown;
  requested_operations?: unknown;
  dogfoodReport?: DogfoodReportLike | null;
  dogfood_report?: DogfoodReportLike | null;
  providerCommand?: string;
  provider_command?: string;
  plan?: OperatorReleaseRunbookPlan;
  operatorState?: OperatorStateLike;
  operator_state?: OperatorStateLike;
  decisionGate?: DecisionGateLike | null;
  decision_gate?: DecisionGateLike | null;
  decision?: ReleaseRecord;
  timeout_ms?: number;
  commandExists?: (command: string) => boolean;
  now?: unknown;
  random?: unknown;
  providerConfigs?: unknown;
  runOperatorReleaseStateMutation?: (options: ReleaseRecord) => OperatorStateLike;
}

function readJson(filePath: string): ReleaseRecord {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function check(code: string, passed: boolean, message: string, extra: ReleaseRecord = Object()): ReleaseCheck {
  return { code, passed, message, ...extra };
}

function normalizeRequestedOperations(input: unknown): string[] {
  const source = Array.isArray(input) && input.length > 0 ? input : DEFAULT_REQUESTED_OPERATIONS;
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
}

function operationRequested(operations: string[], operation: string): boolean {
  return operations.includes(operation);
}

function actionAuthorized(decisionGate: DecisionGateLike | null | undefined, action: string): boolean {
  return decisionGate?.action_authorization?.[action] === true
    || (Array.isArray(decisionGate?.approved_actions) && decisionGate.approved_actions.includes(action));
}

function decisionGateFromOperatorState(operatorState: OperatorStateLike = Object()): DecisionGateLike | null {
  return operatorState.components?.decision_gate || operatorState.decision_gate || null;
}

function dogfoodReportEvidencePresent(report: unknown = Object()): boolean {
  const summary: DogfoodReportLike = report && typeof report === "object" ? report as DogfoodReportLike : {};
  return Boolean(summary.report_path)
    || Boolean(summary.artifact_path)
    || (Array.isArray(summary.evidence_files) && summary.evidence_files.length > 0)
    || (Array.isArray(summary.evidence) && summary.evidence.length > 0);
}

function dogfoodReportApproved(report: unknown = Object()): boolean {
  const summary: DogfoodReportLike = report && typeof report === "object" ? report as DogfoodReportLike : {};
  return summary.publication_approved === true
    && typeof summary.approver === "string"
    && summary.approver.trim().length > 0;
}

function buildManualCommands(operations: string[], packageJson: PackageJsonLike = Object(), options: OperatorRunbookOptions = Object()): ManualCommand[] {
  const packageName = packageJson.name || "package";
  const packageVersion = packageJson.version || "0.0.0";
  const providerCommand = options.providerCommand || options.provider_command || "<operator-provider-command>";
  const dogfoodReportPath = options.dogfoodReport?.report_path || options.dogfoodReport?.artifact_path || "<dogfood-report.md>";
  const commands: ManualCommand[] = [];

  if (operationRequested(operations, "publish_public_beta")) {
    commands.push({
      id: "publish_public_beta",
      command: "npm publish --access public --tag beta",
      purpose: `Publish ${packageName}@${packageVersion} as public beta.`,
      execute: false,
      requires_human: true,
      requires_credentials: true,
      requires_billable_provider: false,
    });
  }
  if (operationRequested(operations, "access_credentials")) {
    commands.push({
      id: "access_credentials",
      command: "npm whoami",
      purpose: "Human operator verifies npm authentication outside the SDK.",
      execute: false,
      requires_human: true,
      requires_credentials: true,
      requires_billable_provider: false,
    });
  }
  if (operationRequested(operations, "billable_provider_execution")) {
    commands.push({
      id: "billable_provider_execution",
      command: providerCommand,
      purpose: "Human operator runs an approved billable provider dogfood canary outside the SDK.",
      execute: false,
      requires_human: true,
      requires_credentials: true,
      requires_billable_provider: true,
    });
  }
  if (operationRequested(operations, "public_dogfood_report")) {
    commands.push({
      id: "public_dogfood_report",
      command: `publish reviewed dogfood report ${dogfoodReportPath}`,
      purpose: "Human operator publishes a privacy-reviewed dogfood report outside the SDK.",
      execute: false,
      requires_human: true,
      requires_credentials: false,
      requires_billable_provider: false,
    });
  }
  return commands;
}

export function buildOperatorReleaseRunbookPlan(options: OperatorRunbookOptions = Object()): OperatorReleaseRunbookPlan {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const requestedOperations = normalizeRequestedOperations(options.requestedOperations || options.requested_operations);
  const packageJson: PackageJsonLike = options.packageJson || readJson(join(yoloRoot, "package.json"));
  return {
    schema_version: OPERATOR_RELEASE_RUNBOOK_SCHEMA_VERSION,
    schema: "yolo.release.operator_runbook_plan.v1",
    yolo_root: yoloRoot,
    release_scope: options.releaseScope || options.release_scope || DEFAULT_RELEASE_SCOPE,
    requested_operations: requestedOperations,
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    publishes_dogfood_report: false,
    requires_operator_state_applied_for_publish: true,
    manual_commands: buildManualCommands(requestedOperations, packageJson, options),
    stop_conditions: [
      "operator release-state mutation is not applied before publish",
      "manual command is marked execute=true",
      "credential or billable provider operation lacks controlled decision authorization",
      "public dogfood report lacks pass status, evidence, privacy review, or publication approval",
    ],
  };
}

export function runOperatorReleaseRunbookGate(options: OperatorRunbookOptions = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJson: PackageJsonLike = options.packageJson || readJson(join(yoloRoot, "package.json"));
  const plan = options.plan || buildOperatorReleaseRunbookPlan({
    yoloRoot,
    releaseScope: options.releaseScope || options.release_scope,
    requestedOperations: options.requestedOperations || options.requested_operations,
    dogfoodReport: options.dogfoodReport || options.dogfood_report,
    providerCommand: options.providerCommand || options.provider_command,
    packageJson,
  });
  const requestedOperations = normalizeRequestedOperations(plan.requested_operations);
  const knownOperations = new Set(OPERATOR_RELEASE_OPERATIONS);
  const unknownOperations = requestedOperations.filter((operation) => !knownOperations.has(operation));
  const operatorState: OperatorStateLike = options.operatorState || options.operator_state || (options.runOperatorReleaseStateMutation || runOperatorReleaseStateMutation)({
    yoloRoot,
    decision: options.decision,
    requestedActions: ["remove_private", "publish_public_beta"],
    timeout_ms: options.timeout_ms || DEFAULT_EXECUTOR_TIMEOUT_MS,
    commandExists: options.commandExists,
    now: options.now,
    random: options.random,
    providerConfigs: options.providerConfigs,
  });
  const decisionGate = options.decisionGate || options.decision_gate || decisionGateFromOperatorState(operatorState);
  const dogfoodReport = options.dogfoodReport || options.dogfood_report || null;
  const manualCommands = Array.isArray(plan.manual_commands) ? plan.manual_commands : [];
  const publishRequested = operationRequested(requestedOperations, "publish_public_beta");
  const credentialRequested = operationRequested(requestedOperations, "access_credentials");
  const billableRequested = operationRequested(requestedOperations, "billable_provider_execution");
  const dogfoodRequested = operationRequested(requestedOperations, "public_dogfood_report");

  const checks = [
    check(
      "RUNBOOK_NO_SIDE_EFFECTS",
      plan.writes_workspace === false
        && plan.publishes === false
        && plan.reads_credentials === false
        && plan.spawns_provider === false
        && plan.executes_billable_provider === false
        && plan.publishes_dogfood_report === false,
      "operator release runbook gate must not mutate workspace, publish, read credentials, execute providers, or publish dogfood reports",
    ),
    check(
      "RUNBOOK_OPERATIONS_KNOWN",
      unknownOperations.length === 0,
      "requested operator release operations must be known",
      { unknown_operations: unknownOperations, known_operations: OPERATOR_RELEASE_OPERATIONS },
    ),
    check(
      "RUNBOOK_MANUAL_COMMANDS_ONLY",
      manualCommands.length > 0 && manualCommands.every((command) => command.execute === false && command.requires_human === true),
      "operator runbook commands must be manual instructions and must never be executed by the SDK",
      { command_ids: manualCommands.map((command) => command.id) },
    ),
    check(
      "RUNBOOK_OPERATOR_STATE_APPLIED_FOR_PUBLISH",
      !publishRequested || operatorState.status === "applied",
      "publish_public_beta requires an applied operator release-state mutation",
      { operator_state_status: operatorState.status },
    ),
    check(
      "RUNBOOK_OPERATOR_STATE_NO_SIDE_EFFECTS_BEYOND_PRIVATE",
      operatorState.guarantees?.published === false
        && operatorState.guarantees?.credential_access === false
        && operatorState.guarantees?.provider_execution === false
        && operatorState.guarantees?.billable_provider_execution === false
        && operatorState.guarantees?.publish_command_executed === false,
      "operator release-state helper must not have published, read credentials, executed providers, or run publish commands",
    ),
    check(
      "RUNBOOK_PUBLISH_AUTHORIZED",
      !publishRequested || actionAuthorized(decisionGate, "publish_public_beta"),
      "publish_public_beta must be authorized by the controlled decision gate",
    ),
    check(
      "RUNBOOK_CREDENTIAL_ACCESS_AUTHORIZED",
      !credentialRequested || actionAuthorized(decisionGate, "access_credentials"),
      "access_credentials must be authorized by the controlled decision gate",
    ),
    check(
      "RUNBOOK_BILLABLE_PROVIDER_AUTHORIZED",
      !billableRequested || actionAuthorized(decisionGate, "billable_provider_execution"),
      "billable_provider_execution must be authorized by the controlled decision gate",
    ),
    check(
      "RUNBOOK_BILLABLE_PROVIDER_MANUAL_ONLY",
      !billableRequested || manualCommands.some((command) =>
        command.id === "billable_provider_execution"
          && command.execute === false
          && command.requires_billable_provider === true
      ),
      "billable provider operation must remain a manual command and must not execute inside the SDK",
    ),
    check(
      "RUNBOOK_DOGFOOD_REPORT_PRESENT",
      !dogfoodRequested || Boolean(dogfoodReport),
      "public_dogfood_report requires a dogfood report artifact summary",
    ),
    check(
      "RUNBOOK_DOGFOOD_REPORT_PASS",
      !dogfoodRequested || dogfoodReport?.status === "pass",
      "public dogfood report must have status=pass",
      { dogfood_status: dogfoodReport?.status || null },
    ),
    check(
      "RUNBOOK_DOGFOOD_REPORT_EVIDENCE",
      !dogfoodRequested || dogfoodReportEvidencePresent(dogfoodReport),
      "public dogfood report must include evidence files or an artifact path",
    ),
    check(
      "RUNBOOK_DOGFOOD_REPORT_PRIVACY_REVIEWED",
      !dogfoodRequested || dogfoodReport?.privacy_reviewed === true,
      "public dogfood report must be privacy reviewed before manual publication",
    ),
    check(
      "RUNBOOK_DOGFOOD_REPORT_PUBLICATION_APPROVED",
      !dogfoodRequested || dogfoodReportApproved(dogfoodReport),
      "public dogfood report publication must be explicitly approved by a human",
    ),
  ];

  const blockers = checks.filter((item) => item.passed !== true);
  const ready = blockers.length === 0;
  return {
    schema_version: OPERATOR_RELEASE_RUNBOOK_SCHEMA_VERSION,
    schema: "yolo.release.operator_runbook_result.v1",
    status: ready ? "ready" : "blocked",
    release_scope: plan.release_scope,
    yolo_root: yoloRoot,
    package: {
      name: packageJson.name || null,
      version: packageJson.version || null,
      private: packageJson.private === true,
    },
    requested_operations: requestedOperations,
    manual_commands: manualCommands,
    plan,
    checks,
    blockers,
    components: {
      operator_state: operatorState,
      decision_gate: decisionGate,
      dogfood_report: dogfoodReport,
    },
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      publish_command_executed: false,
      dogfood_report_published: false,
    },
    next_actions: ready
      ? [
          "Operator runbook is ready. A human operator may execute the listed manual commands outside the SDK.",
          "After any manual publish, run package install smoke, public beta hardening drill, and full tests again.",
        ]
      : [
          "Resolve operator runbook blockers before publishing, reading credentials, executing billable providers, or publishing dogfood reports.",
        ],
  };
}
