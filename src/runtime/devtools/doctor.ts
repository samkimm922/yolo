#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentBridgeInstallPlan } from "../../../tools/install-agent-bridge.js";
import {
  buildYoloCommandRegistry,
  listYoloCommandNames,
  listYoloCommands,
} from "../../workflows/command-registry.js";
import {
  lifecycleStatusPath,
  readLifecycleState,
} from "../../lifecycle/state.js";

export const YOLO_DOCTOR_SCHEMA_VERSION = "1.0";
export const YOLO_DOCTOR_SCHEMA = "yolo.doctor.report.v1";
const __dirname = dirname(fileURLToPath(import.meta.url));

function check(code, severity, passed, message, extra = {}) {
  return {
    code,
    severity,
    passed: Boolean(passed),
    message,
    ...extra,
  };
}

function clean(value) {
  return String(value ?? "").trim();
}

function readJsonSafe(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function artifactStatus(file = {}) {
  const path = file.path || "";
  const exists = Boolean(path) && existsSync(path);
  const size = exists ? statSync(path).size : 0;
  return {
    target: file.target || file.agent_target || null,
    scope: file.scope || null,
    role: file.role || "workflow_skill",
    command: file.command || null,
    path,
    relative_path: file.relative_path || path,
    exists,
    non_empty: size > 0,
  };
}

function skillPlanFiles(skillPlans = []) {
  return skillPlans.flatMap((plan) =>
    (plan.files || []).map((file) => ({
      target: plan.agent_target || plan.target || null,
      scope: plan.scope || null,
      role: "workflow_skill",
      command: null,
      path: file.path,
      relative_path: file.relative_path || file.path,
    }))
  );
}

function expectedBridgeArtifacts(bridgePlan = {}) {
  return [
    ...(bridgePlan.files || []),
    ...(bridgePlan.native_skill_files || []),
    ...(bridgePlan.command_files || []),
    ...(bridgePlan.source_command_files || []),
    ...skillPlanFiles(bridgePlan.skill_plans || []),
  ];
}

function lifecycleInspection(projectRoot) {
  const statusPath = lifecycleStatusPath({ projectRoot });
  if (!existsSync(statusPath)) {
    return {
      path: statusPath,
      exists: false,
      validation: {
        status: "invalid",
        valid: false,
        errors: [{ code: "LIFECYCLE_STATUS_MISSING", message: "lifecycle status file is missing" }],
        warnings: [],
      },
    };
  }

  try {
    return {
      exists: true,
      ...readLifecycleState({ projectRoot }),
    };
  } catch (error) {
    return {
      path: statusPath,
      exists: true,
      validation: {
        status: "invalid",
        valid: false,
        errors: [{ code: "LIFECYCLE_STATUS_PARSE_FAILED", message: error?.message || String(error) }],
        warnings: [],
      },
    };
  }
}

export function buildYoloDoctorReport(options = {}) {
  const projectRoot = resolve(options.projectRoot || options.project_root || options.cwd || process.cwd());
  const yoloRoot = resolve(options.yoloRoot || options.yolo_root || join(__dirname, "../../.."));
  const homeDir = resolve(options.homeDir || options.home_dir || homedir());
  const targets = options.targets || options.target || "both";
  const scope = options.scope || options.installScope || options.install_scope || "project";
  const configPath = join(projectRoot, ".yolo/config.json");
  const configRead = existsSync(configPath) ? readJsonSafe(configPath) : { ok: false, error: "missing" };
  const lifecycle = lifecycleInspection(projectRoot);
  const commandRegistry = buildYoloCommandRegistry();
  const commandNames = listYoloCommandNames();
  const bridgePlan = buildAgentBridgeInstallPlan({
    projectRoot,
    yoloRoot,
    homeDir,
    targets,
    scope,
  });
  const bridgeArtifacts = expectedBridgeArtifacts(bridgePlan).map(artifactStatus);
  const missingBridgeArtifacts = bridgeArtifacts.filter((artifact) => !artifact.exists || !artifact.non_empty);

  const checks = [
    check(
      "YOLO_DOCTOR_NO_SIDE_EFFECTS",
      "error",
      true,
      "doctor is inspect-only; it does not install, edit, publish, or execute providers",
    ),
    check(
      "YOLO_DOCTOR_PROJECT_ROOT_EXISTS",
      "error",
      existsSync(projectRoot),
      "project root must exist",
      { project_root: projectRoot },
    ),
    check(
      "YOLO_DOCTOR_CONFIG_EXISTS",
      "error",
      existsSync(configPath) && configRead.ok,
      "project must be initialized with .yolo/config.json",
      { path: configPath, parse_error: configRead.ok ? null : configRead.error },
    ),
    check(
      "YOLO_DOCTOR_LIFECYCLE_READY",
      "error",
      lifecycle.exists === true && lifecycle.validation?.valid === true,
      "project must have valid .yolo/lifecycle/status.json",
      { path: lifecycle.path, validation: lifecycle.validation },
    ),
    check(
      "YOLO_DOCTOR_COMMAND_REGISTRY_READY",
      "error",
      commandRegistry.commands.length === commandNames.length
        && commandNames.includes("yolo")
        && commandNames.includes("yolo-discover")
        && commandNames.includes("yolo-prd")
        && commandNames.includes("yolo-doctor"),
      "command registry must expose the full lifecycle command set from one source of truth",
      { command_count: commandNames.length, commands: commandNames },
    ),
    check(
      "YOLO_DOCTOR_AGENT_BRIDGE_INSTALLED",
      "warning",
      missingBridgeArtifacts.length === 0,
      "Codex/Claude bridge artifacts are not fully installed for the requested target/scope",
      {
        expected_artifact_count: bridgeArtifacts.length,
        missing_artifact_count: missingBridgeArtifacts.length,
        missing_artifacts: missingBridgeArtifacts.slice(0, 20),
      },
    ),
  ];

  const blockers = checks.filter((item) => item.severity === "error" && item.passed !== true);
  const warnings = checks.filter((item) => item.severity === "warning" && item.passed !== true);
  const status = blockers.length > 0 ? "blocked" : (warnings.length > 0 ? "warning" : "pass");

  return {
    schema_version: YOLO_DOCTOR_SCHEMA_VERSION,
    schema: YOLO_DOCTOR_SCHEMA,
    status,
    project_root: projectRoot,
    yolo_root: yoloRoot,
    home_dir: homeDir,
    checks,
    blockers,
    warnings,
    lifecycle: {
      status_path: lifecycle.path,
      exists: lifecycle.exists,
      validation: lifecycle.validation,
      current_stage: lifecycle.state?.current_stage || null,
    },
    commands: {
      schema: commandRegistry.schema,
      count: commandNames.length,
      names: commandNames,
      no_code: listYoloCommands({ noCode: true }).map((command) => command.name),
      writes_code: listYoloCommands({ writesCode: true }).map((command) => command.name),
    },
    agent_bridge: {
      expected_artifact_count: bridgeArtifacts.length,
      missing_artifact_count: missingBridgeArtifacts.length,
      missing_artifacts: missingBridgeArtifacts,
    },
    guarantees: {
      writes_workspace: false,
      writes_user_home: false,
      publishes: false,
      reads_credentials: false,
      provider_execution: false,
      billable_provider_execution: false,
    },
    next_actions: status === "blocked"
      ? ["Ask the agent to run /yolo-init for this project, then run /yolo-doctor again."]
      : status === "warning"
        ? ["Ask the agent to run /yolo-install for the desired Codex/Claude scope, then restart or refresh the host."]
        : ["YOLO project lifecycle and agent entrypoints are ready; start with /yolo-discover or /yolo-plan."],
  };
}

export function formatYoloDoctorText(report = {}) {
  const lines = [
    `[yolo doctor] ${report.status}`,
    `project: ${report.project_root}`,
    `commands: ${report.commands?.count || 0}`,
    `lifecycle: ${report.lifecycle?.current_stage || "missing"}`,
  ];
  if (report.blockers?.length) {
    lines.push("blockers:");
    for (const blocker of report.blockers) lines.push(`  - ${blocker.code}: ${blocker.message}`);
  }
  if (report.warnings?.length) {
    lines.push("warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning.code}: ${warning.message}`);
  }
  if (report.next_actions?.length) {
    lines.push("next:");
    for (const action of report.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

function parseDoctorArgs(argv = []) {
  const options = { json: false, help: false };
  const input = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--target" || arg.startsWith("--target=")) {
      const value = arg.includes("=") ? arg.split("=").slice(1).join("=") : argv[index + 1];
      input.targets = value;
      if (!arg.includes("=")) index += 1;
    } else if (arg === "--scope" || arg.startsWith("--scope=")) {
      const value = arg.includes("=") ? arg.split("=").slice(1).join("=") : argv[index + 1];
      input.scope = value;
      if (!arg.includes("=")) index += 1;
    } else if (arg === "--home-dir" || arg.startsWith("--home-dir=")) {
      const value = arg.includes("=") ? arg.split("=").slice(1).join("=") : argv[index + 1];
      input.homeDir = value;
      if (!arg.includes("=")) index += 1;
    } else if (!arg.startsWith("--") && !input.projectRoot) {
      input.projectRoot = arg;
    }
  }
  return { input, options };
}

export function runYoloDoctorCli(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const { input, options } = parseDoctorArgs(argv);
  if (options.help) {
    stdout.write("用法: yolo doctor [path] [--target codex|claude|both] [--scope project|user|both] [--json]\n");
    return 0;
  }
  const report = buildYoloDoctorReport({
    projectRoot: input.projectRoot || io.cwd || process.cwd(),
    yoloRoot: io.yoloRoot,
    homeDir: input.homeDir,
    targets: input.targets,
    scope: input.scope,
  });
  if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else stdout.write(`${formatYoloDoctorText(report)}\n`);
  return report.status === "blocked" ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.exitCode = runYoloDoctorCli(process.argv.slice(2));
}
