import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inspectPublicBetaReadiness } from "./readiness.js";
import { runControlledBetaReleaseDecisionGate } from "./decision-gate.js";
import { DEFAULT_EXECUTOR_TIMEOUT_MS } from "../lib/toolchain.js";
import type { ReleaseCheck, ReleaseIssue, ReleaseRecord } from "./readiness.js";

export const OPERATOR_RELEASE_STATE_SCHEMA_VERSION = "1.0";

const DEFAULT_RELEASE_SCOPE = "public-beta";
const DEFAULT_REQUESTED_ACTIONS = ["remove_private", "publish_public_beta"];
const PRIVATE_RELEASE_BLOCKER = "PACKAGE_PRIVATE_RELEASE_BLOCK";

export interface PackageJsonLike extends ReleaseRecord {
  private?: boolean;
}

export interface DecisionGateResult extends ReleaseRecord {
  status?: string;
  blockers?: ReleaseIssue[];
  action_authorization?: {
    remove_private?: boolean;
    publish_public_beta?: boolean;
  };
  approved_actions?: string[];
}

export interface ReadinessResult extends ReleaseRecord {
  blockers?: ReleaseIssue[];
}

export interface OperatorReleaseStatePlan extends ReleaseRecord {
  yolo_root: string;
  release_scope: string;
  requested_actions: string[];
  mode: string;
  publishes: boolean;
  reads_credentials: boolean;
  spawns_provider: boolean;
}

export interface MutationRecord extends ReleaseRecord {
  applied: boolean;
  file: string;
  private_before: boolean;
  private_after: boolean;
  changed_fields: string[];
}

export interface OperatorReleaseStateOptions extends ReleaseRecord {
  yoloRoot?: string;
  cwd?: string;
  releaseScope?: string;
  release_scope?: string;
  requestedActions?: unknown;
  requested_actions?: unknown;
  apply?: boolean;
  allowWorkspaceMutation?: boolean;
  allow_workspace_mutation?: boolean;
  plan?: OperatorReleaseStatePlan;
  decisionGate?: DecisionGateResult;
  decision?: ReleaseRecord;
  timeout_ms?: number;
  commandExists?: (command: string) => boolean;
  now?: unknown;
  random?: unknown;
  providerConfigs?: unknown;
  inspectPostMutationReadiness?: (options: ReleaseRecord) => ReadinessResult;
  runControlledBetaReleaseDecisionGate?: (options: ReleaseRecord) => DecisionGateResult;
}

function readJson(filePath: string): ReleaseRecord {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath: string, value: ReleaseRecord): void {
  const tmpPath = join(dirname(filePath), `.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

function check(code: string, passed: boolean, message: string, extra: ReleaseRecord = Object()): ReleaseCheck {
  return { code, passed, message, ...extra };
}

function normalizeRequestedActions(input: unknown): string[] {
  const source = Array.isArray(input) && input.length > 0 ? input : DEFAULT_REQUESTED_ACTIONS;
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
}

function removePrivateRequested(actions: string[]): boolean {
  return actions.includes("remove_private");
}

function publishRequested(actions: string[]): boolean {
  return actions.includes("publish_public_beta");
}

function privateBlockerCodes(readiness: ReadinessResult = Object()): string[] {
  return (readiness.blockers || []).map((blocker) => blocker.code).filter((code) => code === PRIVATE_RELEASE_BLOCKER);
}

function buildNextPackageJson(packageJson: PackageJsonLike, actions: string[]): PackageJsonLike {
  if (!removePrivateRequested(actions)) {
    return { ...packageJson };
  }
  const next = { ...packageJson };
  delete next.private;
  return next;
}

export function buildOperatorReleaseStatePlan(options: OperatorReleaseStateOptions = Object()): OperatorReleaseStatePlan {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const requestedActions = normalizeRequestedActions(options.requestedActions || options.requested_actions);
  const apply = options.apply === true;
  return {
    schema_version: OPERATOR_RELEASE_STATE_SCHEMA_VERSION,
    schema: "yolo.release.operator_state_mutation_plan.v1",
    yolo_root: yoloRoot,
    release_scope: options.releaseScope || options.release_scope || DEFAULT_RELEASE_SCOPE,
    requested_actions: requestedActions,
    mode: apply ? "apply" : "dry-run",
    writes_workspace: apply,
    mutates_package_private: apply && removePrivateRequested(requestedActions),
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    requires_decision_gate_ready: true,
    requires_allow_workspace_mutation_for_apply: true,
    manual_commands_not_executed: publishRequested(requestedActions)
      ? ["npm publish --access public --tag beta"]
      : [],
    stop_conditions: [
      "controlled beta decision gate is not ready",
      "apply mode requested without allowWorkspaceMutation=true",
      "post-mutation readiness still has PACKAGE_PRIVATE_RELEASE_BLOCK",
      "publish, credential, or provider execution attempted inside this SDK function",
    ],
  };
}

export function runOperatorReleaseStateMutation(options: OperatorReleaseStateOptions = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJsonPath = join(yoloRoot, "package.json");
  const packageBefore: PackageJsonLike = readJson(packageJsonPath);
  const plan = options.plan || buildOperatorReleaseStatePlan({
    yoloRoot,
    releaseScope: options.releaseScope || options.release_scope,
    requestedActions: options.requestedActions || options.requested_actions,
    apply: options.apply === true,
  });
  const requestedActions = normalizeRequestedActions(plan.requested_actions);
  const apply = plan.mode === "apply" || options.apply === true;
  const allowWorkspaceMutation = options.allowWorkspaceMutation === true || options.allow_workspace_mutation === true;
  const decisionGate: DecisionGateResult = options.decisionGate || (options.runControlledBetaReleaseDecisionGate || runControlledBetaReleaseDecisionGate)({
    yoloRoot,
    decision: options.decision,
    requestedActions,
    releaseScope: plan.release_scope,
    timeout_ms: options.timeout_ms || DEFAULT_EXECUTOR_TIMEOUT_MS,
    commandExists: options.commandExists,
    now: options.now,
    random: options.random,
    providerConfigs: options.providerConfigs,
  });
  const nextPackageJson = buildNextPackageJson(packageBefore, requestedActions);
  const postMutationReadiness: ReadinessResult = (options.inspectPostMutationReadiness || inspectPublicBetaReadiness)({
    yoloRoot,
    packageJson: nextPackageJson,
  });

  const privateBlockersAfterMutation = privateBlockerCodes(postMutationReadiness);
  const checks = [
    check(
      "OPERATOR_STATE_NO_PUBLISH",
      plan.publishes === false,
      "operator release-state mutation must not execute npm publish",
    ),
    check(
      "OPERATOR_STATE_NO_CREDENTIAL_ACCESS",
      plan.reads_credentials === false,
      "operator release-state mutation must not read npm tokens, API keys, or provider credentials",
    ),
    check(
      "OPERATOR_STATE_NO_PROVIDER_EXECUTION",
      plan.spawns_provider === false,
      "operator release-state mutation must not execute model providers",
    ),
    check(
      "OPERATOR_STATE_DECISION_GATE_READY",
      decisionGate.status === "ready",
      "controlled beta release decision gate must be ready before release-state mutation",
      { decision_status: decisionGate.status, decision_blockers: (decisionGate.blockers || []).map((blocker) => blocker.code) },
    ),
    check(
      "OPERATOR_STATE_REMOVE_PRIVATE_AUTHORIZED",
      !removePrivateRequested(requestedActions) || decisionGate.action_authorization?.remove_private === true,
      "remove_private action must be authorized by the controlled decision gate",
    ),
    check(
      "OPERATOR_STATE_PUBLISH_AUTHORIZED_BUT_NOT_EXECUTED",
      !publishRequested(requestedActions) || decisionGate.action_authorization?.publish_public_beta === true,
      "publish_public_beta action must be authorized even though this function does not publish",
    ),
    check(
      "OPERATOR_STATE_APPLY_EXPLICITLY_ALLOWED",
      !apply || allowWorkspaceMutation,
      "apply mode must set allowWorkspaceMutation=true before package.json can be mutated",
    ),
    check(
      "OPERATOR_STATE_POST_MUTATION_READINESS_NO_PRIVATE_BLOCKER",
      privateBlockersAfterMutation.length === 0,
      "simulated/applied release-state must remove PACKAGE_PRIVATE_RELEASE_BLOCK",
      { private_blockers_after_mutation: privateBlockersAfterMutation },
    ),
  ];

  const preApplyBlockers = checks.filter((item) => item.passed !== true);
  let mutation: MutationRecord = Object.assign(Object(), {
    applied: false,
    file: "package.json",
    private_before: packageBefore.private === true,
    private_after: packageBefore.private === true,
    changed_fields: [],
  });

  if (preApplyBlockers.length === 0 && apply && removePrivateRequested(requestedActions)) {
    writeJsonAtomic(packageJsonPath, nextPackageJson);
    const packageAfterWrite: PackageJsonLike = readJson(packageJsonPath);
    mutation = {
      applied: true,
      file: "package.json",
      private_before: packageBefore.private === true,
      private_after: packageAfterWrite.private === true,
      changed_fields: packageBefore.private === packageAfterWrite.private ? [] : ["private"],
    };
  }

  const packageAfter: PackageJsonLike = readJson(packageJsonPath);
  if (!apply) {
    mutation = {
      ...mutation,
      simulated_private_after: nextPackageJson.private === true,
      private_after: packageAfter.private === true,
    };
  }

  const postApplyChecks = [
    check(
      "OPERATOR_STATE_PACKAGE_PRIVATE_MATCHES_MODE",
      apply && preApplyBlockers.length === 0 && removePrivateRequested(requestedActions)
        ? packageAfter.private !== true
        : packageAfter.private === packageBefore.private,
      "package.json private field must either remain unchanged in dry-run/blocked mode or be removed only in authorized apply mode",
      { before: packageBefore.private === true, after: packageAfter.private === true, apply },
    ),
  ];

  const blockers = [...preApplyBlockers, ...postApplyChecks.filter((item) => item.passed !== true)];
  const status = blockers.length > 0
    ? "blocked"
    : apply
      ? "applied"
      : "planned";

  return {
    schema_version: OPERATOR_RELEASE_STATE_SCHEMA_VERSION,
    schema: "yolo.release.operator_state_mutation_result.v1",
    status,
    mode: apply ? "apply" : "dry-run",
    release_scope: plan.release_scope,
    yolo_root: yoloRoot,
    requested_actions: requestedActions,
    approved_actions: decisionGate.approved_actions || [],
    plan,
    checks: [...checks, ...postApplyChecks],
    blockers,
    mutation,
    post_mutation_readiness: postMutationReadiness,
    components: {
      decision_gate: decisionGate,
    },
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      publish_command_executed: false,
      package_private_mutated: mutation.applied === true && mutation.changed_fields.includes("private"),
    },
    next_actions: status === "applied"
      ? [
          "Run public beta hardening drill and full test suite after this release-state mutation.",
          "A human operator may publish outside this SDK only after reviewing the post-mutation evidence.",
        ]
      : status === "planned"
        ? [
            "Dry-run passed. Re-run with apply=true and allowWorkspaceMutation=true only on an operator-approved release branch.",
          ]
        : [
            "Resolve operator release-state blockers before mutating package.json or publishing.",
          ],
  };
}
