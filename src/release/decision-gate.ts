import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runPublicBetaHardeningDrill } from "./hardening-drill.js";

export const CONTROLLED_BETA_RELEASE_DECISION_SCHEMA_VERSION = "1.0";

export const CONTROLLED_BETA_RELEASE_ACTIONS = Object.freeze([
  "remove_private",
  "publish_public_beta",
  "access_credentials",
  "billable_provider_execution",
]);

const DEFAULT_RELEASE_SCOPE = "public-beta";
const DEFAULT_REQUESTED_ACTIONS = ["remove_private", "publish_public_beta"];
const PRIVATE_RELEASE_BLOCKER = "PACKAGE_PRIVATE_RELEASE_BLOCK";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function check(code, passed, message, extra = {}) {
  return { code, passed, message, ...extra };
}

function normalizeRequestedActions(input) {
  const source = Array.isArray(input) && input.length > 0 ? input : DEFAULT_REQUESTED_ACTIONS;
  return [...new Set(source.map((item) => String(item || "").trim()).filter(Boolean))];
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function actionApproved(decision, action) {
  const approvals = isObject(decision?.approvals) ? decision.approvals : {};
  const approvedActions = Array.isArray(decision?.approved_actions)
    ? decision.approved_actions
    : Array.isArray(decision?.actions)
      ? decision.actions
      : [];
  return approvals[action] === true || approvedActions.includes(action);
}

function riskAccepted(decision) {
  return decision?.risk_acceptance === true
    || (Array.isArray(decision?.risk_acceptance) && decision.risk_acceptance.length > 0);
}

function hardeningReleaseBlockerCodes(hardeningDrill = {}) {
  return (hardeningDrill.release_blockers || []).map((blocker) => blocker.code).filter(Boolean);
}

function sanitizeDecision(decision) {
  if (!isObject(decision)) {
    return null;
  }
  return {
    approved: decision.approved === true,
    approver: decision.approver || null,
    approved_at: decision.approved_at || null,
    scope: decision.scope || decision.release_scope || null,
    package_version: decision.package_version || decision.version || null,
    approved_actions: Array.isArray(decision.approved_actions)
      ? decision.approved_actions
      : Array.isArray(decision.actions)
        ? decision.actions
        : [],
    risk_acceptance: decision.risk_acceptance === true
      ? true
      : Array.isArray(decision.risk_acceptance)
        ? decision.risk_acceptance
        : null,
    hardening_drill_reviewed: decision.hardening_drill_reviewed === true,
    private_blocker_acknowledged: decision.private_blocker_acknowledged === true,
  };
}

export function buildControlledBetaReleaseDecisionPlan(options = {}) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const releaseScope = options.releaseScope || options.release_scope || DEFAULT_RELEASE_SCOPE;
  const requestedActions = normalizeRequestedActions(options.requestedActions || options.requested_actions);
  return {
    schema_version: CONTROLLED_BETA_RELEASE_DECISION_SCHEMA_VERSION,
    schema: "yolo.release.controlled_beta_release_decision_gate.v1",
    yolo_root: yoloRoot,
    release_scope: releaseScope,
    requested_actions: requestedActions,
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    required_decision_fields: [
      "approved",
      "approver",
      "approved_at",
      "scope",
      "package_version",
      "approved_actions",
      "risk_acceptance",
      "hardening_drill_reviewed",
      "private_blocker_acknowledged",
    ],
    required_checks: [
      "P5 hardening drill must pass.",
      "`private:true` may only be removed after a human decision record acknowledges the private release blocker.",
      "Every requested release action must be explicitly approved in `approved_actions` or `approvals`.",
      "This gate never publishes, edits package.json, reads credentials, or executes model providers.",
    ],
    stop_conditions: [
      "hardening drill failed",
      "release blockers other than PACKAGE_PRIVATE_RELEASE_BLOCK are present",
      "human decision record is missing, stale, unsigned, or action-incomplete",
      "credential or billable provider actions are requested without explicit approval",
    ],
  };
}

export function runControlledBetaReleaseDecisionGate(options = {}) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJsonPath = join(yoloRoot, "package.json");
  const packageBefore = readJson(packageJsonPath);
  const plan = options.plan || buildControlledBetaReleaseDecisionPlan({
    yoloRoot,
    releaseScope: options.releaseScope || options.release_scope,
    requestedActions: options.requestedActions || options.requested_actions,
  });
  const requestedActions = normalizeRequestedActions(plan.requested_actions);
  const knownActions = new Set(CONTROLLED_BETA_RELEASE_ACTIONS);
  const unknownActions = requestedActions.filter((action) => !knownActions.has(action));
  const decision = options.decision || null;
  const releaseScope = plan.release_scope || DEFAULT_RELEASE_SCOPE;
  const hardeningDrill = options.hardeningDrill || (options.runPublicBetaHardeningDrill || runPublicBetaHardeningDrill)({
    yoloRoot,
    timeout_ms: options.timeout_ms || 120000,
    keepWorkspace: options.keepWorkspace === true,
    commandExists: options.commandExists,
    now: options.now,
    random: options.random,
    providerConfigs: options.providerConfigs,
  });
  const packageAfter = readJson(packageJsonPath);
  const releaseBlockerCodes = hardeningReleaseBlockerCodes(hardeningDrill);
  const nonPrivateReleaseBlockers = releaseBlockerCodes.filter((code) => code !== PRIVATE_RELEASE_BLOCKER);
  const hasPrivateReleaseBlocker = releaseBlockerCodes.includes(PRIVATE_RELEASE_BLOCKER);
  const packageVersion = packageBefore.version || null;
  const decisionScope = decision?.scope || decision?.release_scope || null;
  const decisionVersion = decision?.package_version || decision?.version || null;
  const requestedCredentials = requestedActions.includes("access_credentials");
  const requestedBillable = requestedActions.includes("billable_provider_execution");
  const allRequestedActionsApproved = unknownActions.length === 0
    && requestedActions.every((action) => actionApproved(decision, action));

  const checks = [
    check(
      "DECISION_GATE_NO_SIDE_EFFECTS",
      plan.publishes === false && plan.writes_workspace === false && plan.reads_credentials === false && plan.spawns_provider === false,
      "controlled beta release decision gate must be a no-publish/no-credential/no-provider decision record",
    ),
    check(
      "DECISION_GATE_PRIVATE_FIELD_UNCHANGED",
      packageBefore.private === packageAfter.private,
      "decision gate must not mutate package.json private field",
      { before: packageBefore.private === true, after: packageAfter.private === true },
    ),
    check(
      "DECISION_GATE_REQUESTED_ACTIONS_KNOWN",
      unknownActions.length === 0,
      "requested release actions must be known controlled-beta actions",
      { unknown_actions: unknownActions, known_actions: CONTROLLED_BETA_RELEASE_ACTIONS },
    ),
    check(
      "DECISION_GATE_HARDENING_DRILL_PASS",
      hardeningDrill.status === "pass",
      "P5 public beta hardening drill must pass before any release decision can be ready",
      { hardening_status: hardeningDrill.status, hardening_blockers: (hardeningDrill.blockers || []).map((item) => item.code) },
    ),
    check(
      "DECISION_GATE_RELEASE_BLOCKERS_PRIVATE_ONLY",
      nonPrivateReleaseBlockers.length === 0,
      "release readiness may only be blocked by PACKAGE_PRIVATE_RELEASE_BLOCK at this decision point",
      { release_blockers: releaseBlockerCodes },
    ),
    check(
      "DECISION_GATE_HUMAN_DECISION_PRESENT",
      isObject(decision),
      "a human release decision record is required before controlled beta release actions are authorized",
    ),
    check(
      "DECISION_GATE_HUMAN_APPROVED",
      decision?.approved === true,
      "human release decision must set approved=true",
    ),
    check(
      "DECISION_GATE_APPROVER_PRESENT",
      nonEmptyString(decision?.approver),
      "human release decision must name the approver",
    ),
    check(
      "DECISION_GATE_TIMESTAMP_VALID",
      validTimestamp(decision?.approved_at),
      "human release decision must include a valid approved_at timestamp",
    ),
    check(
      "DECISION_GATE_SCOPE_MATCH",
      decisionScope === releaseScope,
      "human release decision scope must match the requested release scope",
      { expected_scope: releaseScope, decision_scope: decisionScope },
    ),
    check(
      "DECISION_GATE_VERSION_MATCH",
      decisionVersion === packageVersion,
      "human release decision package_version must match package.json version",
      { expected_version: packageVersion, decision_version: decisionVersion },
    ),
    check(
      "DECISION_GATE_HARDENING_REVIEWED",
      decision?.hardening_drill_reviewed === true,
      "human release decision must acknowledge reviewing the passing hardening drill",
    ),
    check(
      "DECISION_GATE_RISK_ACCEPTED",
      riskAccepted(decision),
      "human release decision must explicitly accept public beta residual risk",
    ),
    check(
      "DECISION_GATE_PRIVATE_BLOCKER_ACKNOWLEDGED",
      !hasPrivateReleaseBlocker || decision?.private_blocker_acknowledged === true,
      "human release decision must acknowledge that private=true is the intentional remaining release blocker",
      { private_release_blocker_present: hasPrivateReleaseBlocker },
    ),
    check(
      "DECISION_GATE_ACTIONS_APPROVED",
      allRequestedActionsApproved,
      "every requested controlled beta release action must be explicitly approved",
      { requested_actions: requestedActions },
    ),
    check(
      "DECISION_GATE_CREDENTIAL_ACTION_EXPLICIT",
      !requestedCredentials || actionApproved(decision, "access_credentials"),
      "credential access cannot be requested without explicit human approval",
    ),
    check(
      "DECISION_GATE_BILLABLE_ACTION_EXPLICIT",
      !requestedBillable || actionApproved(decision, "billable_provider_execution"),
      "billable provider execution cannot be requested without explicit human approval",
    ),
  ];

  const blockers = checks.filter((item) => item.passed !== true);
  const ready = blockers.length === 0;
  return {
    schema_version: CONTROLLED_BETA_RELEASE_DECISION_SCHEMA_VERSION,
    schema: "yolo.release.controlled_beta_release_decision_gate_result.v1",
    status: ready ? "ready" : "blocked",
    release_scope: releaseScope,
    yolo_root: yoloRoot,
    requested_actions: requestedActions,
    approved_actions: ready ? requestedActions : [],
    action_authorization: Object.fromEntries(
      CONTROLLED_BETA_RELEASE_ACTIONS.map((action) => [action, ready && requestedActions.includes(action)])
    ),
    plan,
    checks,
    blockers,
    decision: sanitizeDecision(decision),
    release_blockers: hardeningDrill.release_blockers || [],
    components: {
      hardening_drill: hardeningDrill,
    },
    guarantees: {
      published: false,
      package_private_unchanged: packageBefore.private === packageAfter.private,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
    },
    next_actions: ready
      ? [
          "Gate is ready for a human operator to make the approved package/private/publish changes outside this SDK function.",
          "Run the hardening drill and full test suite again after any release-state mutation.",
        ]
      : [
          "Resolve decision gate blockers before changing private=true, publishing, touching credentials, or running billable providers.",
        ],
  };
}
