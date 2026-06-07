import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { buildAgentBridgeInstallPlan } from "../../tools/install-agent-bridge.js";
import { listYoloCommandNames } from "../workflows/command-registry.js";

export const AGENT_INTEGRATION_DOCTOR_SCHEMA_VERSION = "1.0";
const DEFAULT_HOST_DISCOVERY_FRESHNESS_MS = 30 * 60 * 1000;

function check(code, passed, message, extra = {}) {
  return { code, passed, message, ...extra };
}

function artifactStatus(file = {}) {
  const path = file.path || "";
  const exists = Boolean(path) && existsSync(path);
  const size = exists ? statSync(path).size : 0;
  return {
    target: file.target || file.agent_target || null,
    scope: file.scope || null,
    role: file.role || file.kind || "workflow_skill",
    command: file.command || null,
    path,
    relative_path: file.relative_path || file.path || "",
    exists,
    size,
    non_empty: size > 0,
  };
}

function skillPlanFiles(skillPlans = []) {
  return skillPlans.flatMap((plan) =>
    (plan.files || []).map((file) => ({
      target: plan.agent_target || plan.target || null,
      scope: plan.scope || null,
      role: "workflow_skill",
      path: file.path,
      relative_path: file.relative_path || file.path,
    }))
  );
}

function expectedArtifacts(bridgePlan = {}) {
  return [
    ...(bridgePlan.files || []),
    ...(bridgePlan.native_skill_files || []),
    ...(bridgePlan.command_files || []),
    ...(bridgePlan.source_command_files || []),
    ...(bridgePlan.codex_slash_command_files || []),
    ...skillPlanFiles(bridgePlan.skill_plans || []),
  ];
}

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === "") return [];
  return [value];
}

function timestampMs(value) {
  const time = Date.parse(clean(value));
  return Number.isFinite(time) ? time : null;
}

function hostDiscoveryEvidence(options = {}, plan = {}) {
  return options.hostDiscoveryEvidence
    || options.host_discovery_evidence
    || plan.host_discovery_evidence
    || plan.components?.host_discovery_evidence
    || null;
}

function inspectHostDiscoveryEvidence(options = {}, plan = {}) {
  const evidence = hostDiscoveryEvidence(options, plan);
  const nowMs = Number(options.nowMs || options.now_ms) || (typeof options.now === "function" ? options.now() : Date.now());
  const freshnessMs = Number(options.hostDiscoveryFreshnessMs || options.host_discovery_freshness_ms) || DEFAULT_HOST_DISCOVERY_FRESHNESS_MS;
  const blockers = [];
  if (!evidence || typeof evidence !== "object") {
    blockers.push({
      code: "AGENT_INTEGRATION_DOCTOR_HOST_DISCOVERY_MISSING",
      message: "fresh host discovery evidence is required before native agent integration can pass",
    });
    return {
      status: "blocked",
      fresh: false,
      evidence: null,
      checked_at: new Date(nowMs).toISOString(),
      freshness_ms: freshnessMs,
      blockers,
    };
  }

  const discoveredTargets = new Set(asArray(evidence.targets || evidence.discovered_targets || evidence.target).map(clean));
  const requestedTargets = asArray(plan.targets).map(clean);
  const missingTargets = requestedTargets.filter((target) => !discoveredTargets.has(target));
  if (missingTargets.length > 0) {
    blockers.push({
      code: "AGENT_INTEGRATION_DOCTOR_HOST_DISCOVERY_TARGET_MISSING",
      message: "host discovery evidence does not cover every requested target",
      missing_targets: missingTargets,
    });
  }

  const status = clean(evidence.status || evidence.discovery_status || "").toLowerCase();
  if (!["pass", "passed", "discovered", "ready"].includes(status)) {
    blockers.push({
      code: "AGENT_INTEGRATION_DOCTOR_HOST_DISCOVERY_NOT_PASS",
      message: "host discovery evidence must have pass/discovered status",
      discovery_status: evidence.status || evidence.discovery_status || null,
    });
  }

  const discoveredAtMs = timestampMs(evidence.discovered_at || evidence.generated_at || evidence.checked_at || evidence.created_at);
  if (discoveredAtMs === null) {
    blockers.push({
      code: "AGENT_INTEGRATION_DOCTOR_HOST_DISCOVERY_TIMESTAMP_MISSING",
      message: "host discovery evidence must include discovered_at, generated_at, checked_at, or created_at",
    });
  } else if (nowMs - discoveredAtMs > freshnessMs || discoveredAtMs - nowMs > freshnessMs) {
    blockers.push({
      code: "AGENT_INTEGRATION_DOCTOR_HOST_DISCOVERY_STALE",
      message: "host discovery evidence is stale or from the future",
      age_ms: nowMs - discoveredAtMs,
      freshness_ms: freshnessMs,
    });
  }

  if (!clean(evidence.discovery_run_id || evidence.host_session_id || evidence.session_id)) {
    blockers.push({
      code: "AGENT_INTEGRATION_DOCTOR_HOST_DISCOVERY_RUN_ID_MISSING",
      message: "host discovery evidence must include discovery_run_id or host_session_id",
    });
  }

  return {
    status: blockers.length > 0 ? "blocked" : "pass",
    fresh: blockers.length === 0,
    evidence,
    checked_at: new Date(nowMs).toISOString(),
    freshness_ms: freshnessMs,
    blockers,
  };
}

export function buildAgentIntegrationDoctorPlan(options = {}) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const homeDir = resolve(options.homeDir || options.home_dir || homedir());
  const bridgePlan = options.bridgePlan || options.bridge_plan || buildAgentBridgeInstallPlan({
    yoloRoot,
    projectRoot,
    homeDir,
    targets: options.targets || "both",
    scopes: options.scopes,
    scope: options.scope || options.installScope || options.install_scope || "project",
    commands: options.commands,
    installCommands: options.installCommands,
  });
  const artifacts = expectedArtifacts(bridgePlan);
  const commandList = listYoloCommandNames().map((command) => `/${command}`).join(", ");

  return {
    schema_version: AGENT_INTEGRATION_DOCTOR_SCHEMA_VERSION,
    schema: "yolo.release.agent_integration_doctor_plan.v1",
    yolo_root: yoloRoot,
    project_root: projectRoot,
    home_dir: homeDir,
    targets: bridgePlan.targets || [],
    scopes: bridgePlan.scopes || [],
    expected_artifact_count: artifacts.length,
    expected_artifacts: artifacts.map((artifact) => ({
      target: artifact.target || artifact.agent_target || null,
      scope: artifact.scope || null,
      role: artifact.role || "workflow_skill",
      command: artifact.command || null,
      path: artifact.path,
      relative_path: artifact.relative_path || artifact.path,
    })),
    writes_workspace: false,
    writes_user_home: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    required_evidence: [
      "Codex and/or Claude native YOLO skill artifacts exist",
      `Codex exposes one /yolo entry while Claude slash commands and internal workflow descriptors remain separate for ${commandList}`,
      "workflow skill descriptors are installed for the requested scope",
      "fresh host discovery evidence proves the current Codex/Claude host can discover the installed integration",
    ],
    stop_conditions: [
      "any requested skill, command, source-command, or workflow artifact is missing",
      "artifacts exist only in the YOLO repository but not in the requested project/user scope",
      "the operator expects current Codex/Claude session discovery without fresh host discovery evidence",
    ],
    components: {
      bridge_install_plan: bridgePlan,
      host_discovery_evidence: options.hostDiscoveryEvidence || options.host_discovery_evidence || null,
    },
  };
}

export function runAgentIntegrationDoctor(options = {}) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const projectRoot = resolve(options.projectRoot || process.cwd());
  const homeDir = resolve(options.homeDir || options.home_dir || homedir());
  const plan = options.plan || buildAgentIntegrationDoctorPlan({
    yoloRoot,
    projectRoot,
    homeDir,
    targets: options.targets,
    scopes: options.scopes,
    scope: options.scope || options.installScope || options.install_scope,
    commands: options.commands,
    installCommands: options.installCommands,
    bridgePlan: options.bridgePlan || options.bridge_plan,
  });
  const artifactStatuses = plan.expected_artifacts.map(artifactStatus);
  const missingArtifacts = artifactStatuses.filter((artifact) => !artifact.exists || !artifact.non_empty);
  const hostDiscovery = inspectHostDiscoveryEvidence(options, plan);

  const checks = [
    check(
      "AGENT_INTEGRATION_DOCTOR_NO_SIDE_EFFECTS",
      plan.writes_workspace === false
        && plan.writes_user_home === false
        && plan.publishes === false
        && plan.reads_credentials === false
        && plan.spawns_provider === false
        && plan.executes_billable_provider === false,
      "agent integration doctor must inspect only; it must not install, publish, read credentials, or execute providers",
    ),
    check(
      "AGENT_INTEGRATION_DOCTOR_ROOTS_EXIST",
      existsSync(yoloRoot) && existsSync(projectRoot) && existsSync(homeDir),
      "YOLO root, project root, and home directory must exist before native agent integration can be trusted",
      { yolo_root_exists: existsSync(yoloRoot), project_root_exists: existsSync(projectRoot), home_dir_exists: existsSync(homeDir) },
    ),
    check(
      "AGENT_INTEGRATION_DOCTOR_TARGETS_PRESENT",
      Array.isArray(plan.targets) && plan.targets.length > 0,
      "at least one agent target must be selected",
      { targets: plan.targets },
    ),
    check(
      "AGENT_INTEGRATION_DOCTOR_SCOPES_PRESENT",
      Array.isArray(plan.scopes) && plan.scopes.length > 0,
      "at least one install scope must be selected",
      { scopes: plan.scopes },
    ),
    check(
      "AGENT_INTEGRATION_DOCTOR_ARTIFACTS_PRESENT",
      missingArtifacts.length === 0,
      "all expected native skill, command, source-command, and workflow artifacts must exist and be non-empty",
      { missing_artifacts: missingArtifacts },
    ),
    check(
      "AGENT_INTEGRATION_DOCTOR_HOST_DISCOVERY_FRESH",
      hostDiscovery.status === "pass",
      "fresh host discovery evidence must prove the current host can discover requested YOLO integration",
      { host_discovery: hostDiscovery },
    ),
  ];
  const blockers = checks.filter((item) => item.passed !== true);

  return {
    schema_version: AGENT_INTEGRATION_DOCTOR_SCHEMA_VERSION,
    schema: "yolo.release.agent_integration_doctor_result.v1",
    status: blockers.length === 0 ? "pass" : "blocked",
    yolo_root: yoloRoot,
    project_root: projectRoot,
    home_dir: homeDir,
    targets: plan.targets,
    scopes: plan.scopes,
    artifact_count: artifactStatuses.length,
    artifacts_present: artifactStatuses.length - missingArtifacts.length,
    missing_artifacts: missingArtifacts,
    host_discovery: hostDiscovery,
    checks,
    blockers,
    artifacts: artifactStatuses,
    plan,
    guarantees: {
      writes_workspace: false,
      writes_user_home: false,
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      host_discovery_fresh: hostDiscovery.status === "pass",
    },
    next_actions: blockers.length === 0
      ? [
          "Keep the host discovery evidence attached to the release bundle.",
          "Dogfood /yolo-plan, /yolo-check, and /yolo-review from chat, not from a raw terminal-only flow.",
        ]
      : [
          "Run the agent bridge installer for the missing scope/target, then restart or refresh the host and capture discovery evidence.",
          "Re-run this doctor before claiming native /yolo or skill integration is usable.",
        ],
  };
}
