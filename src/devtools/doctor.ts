#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentBridgeInstallPlan } from "../../tools/install-agent-bridge.js";
import {
  DEFAULT_YOLO_PUBLIC_COMMAND_NAMES,
  buildYoloCommandRegistry,
  inspectYoloCommandRegistry,
  listYoloCommandNames,
  listYoloCommands,
  YOLO_COMMAND_SURFACE_BUDGET,
} from "../workflows/command-registry.js";
import {
  lifecycleArtifactPath,
  lifecycleStatusPath,
  readLifecycleState,
} from "../lifecycle/state.js";
import { inspectWorktreeDrift } from "../lifecycle/source-snapshot.js";

export const YOLO_DOCTOR_SCHEMA_VERSION = "1.0";
export const YOLO_DOCTOR_SCHEMA = "yolo.doctor.report.v1";
const __dirname = dirname(fileURLToPath(import.meta.url));

type AgentBridgeInstallPlan = ReturnType<typeof buildAgentBridgeInstallPlan>;
type BridgeArtifact = NonNullable<AgentBridgeInstallPlan["files"][number]>;

export interface DoctorCheck {
  code: string;
  severity: "error" | "warning" | "pending";
  passed: boolean;
  message: string;
  [key: string]: unknown;
}

interface ReadJsonResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface LifecycleInspection {
  path?: string;
  exists: boolean;
  state?: unknown;
  validation: {
    status: string;
    valid: boolean;
    errors: Array<{ code: string; message: string }>;
    warnings: Array<{ code: string; message: string }>;
  };
}

function check(
  code: string,
  severity: "error" | "warning" | "pending",
  passed: boolean,
  message: string,
  extra: Record<string, unknown> = {},
): DoctorCheck {
  return {
    code,
    severity,
    passed: Boolean(passed),
    message,
    ...extra,
  };
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function readJsonSafe(path: string): ReadJsonResult {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function artifactStatus(file: Record<string, unknown> = {}) {
  const path = typeof file.path === "string" ? file.path : "";
  const exists = Boolean(path) && existsSync(path);
  const size = exists ? statSync(path).size : 0;
  return {
    target: (file.target as string | undefined) || (file.agent_target as string | undefined) || null,
    scope: (file.scope as string | undefined) || null,
    role: (file.role as string | undefined) || "workflow_skill",
    command: (file.command as string | undefined) || null,
    path,
    relative_path: (file.relative_path as string | undefined) || path,
    exists,
    non_empty: size > 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function existingPrdCandidate(projectRoot: string, value: unknown): string {
  const raw = clean(value);
  if (!raw || !raw.endsWith(".json")) return "";
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw);
  return existsSync(absolute) ? absolute : "";
}

function prdCandidatesFromLifecycleReport(report: Record<string, unknown> = {}): unknown[] {
  const nested = asRecord(report.report);
  return [report.prd_path, report.prdPath, nested.prd_path, nested.prdPath]
    .concat(Array.isArray(report.artifacts) ? report.artifacts : [])
    .concat(Array.isArray(nested.artifacts) ? nested.artifacts : []);
}

function latestCheckedPrdPath(projectRoot: string, stateRoot: string): string {
  for (const stage of ["check", "prd"]) {
    const path = lifecycleArtifactPath(stage, { projectRoot, stateRoot });
    if (!existsSync(path)) continue;
    const read = readJsonSafe(path);
    if (!read.ok) continue;
    for (const candidate of prdCandidatesFromLifecycleReport(asRecord(read.value))) {
      const prdPath = existingPrdCandidate(projectRoot, candidate);
      if (prdPath) return prdPath;
    }
  }
  return "";
}

function worktreeDriftFinding(projectRoot: string, stateRoot: string): DoctorCheck | null {
  const drift = inspectWorktreeDrift({ projectRoot, stateRoot });
  if (drift.status === "clean") return null;
  const prdPath = latestCheckedPrdPath(projectRoot, stateRoot);
  const fixCommand = prdPath ? `yolo check ${prdPath}` : "yolo check";
  if (drift.status === "unverifiable") {
    if (drift.baseline_state === "bootstrap") {
      return check("YOLO_DOCTOR_WORKTREE_BASELINE_PENDING", "pending", false, "Lifecycle source snapshot baseline is pending; the first successful yolo check will establish it.", {
        baseline_state: "bootstrap_pending",
        captured_at: null,
        current_difference_file_count: null,
        fix_command: fixCommand,
      });
    }
    return check("YOLO_DOCTOR_WORKTREE_UNVERIFIABLE", "error", false, "Lifecycle source snapshot is missing; worktree drift cannot be verified.", {
      captured_at: null,
      current_difference_file_count: null,
      fix_command: fixCommand,
    });
  }
  return check("YOLO_DOCTOR_WORKTREE_DRIFT", "error", false, "Lifecycle check snapshot differs from the current worktree.", {
    captured_at: drift.captured_at || null,
    current_difference_file_count: drift.current_difference_file_count ?? null,
    fix_command: fixCommand,
  });
}

function expectedBridgeArtifacts(bridgePlan: AgentBridgeInstallPlan): BridgeArtifact[] {
  return [
    ...bridgePlan.files,
    ...bridgePlan.native_skill_files,
    ...bridgePlan.claude_slash_commands,
  ];
}

function lifecycleInspection(projectRoot: string): LifecycleInspection {
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
        errors: [{ code: "LIFECYCLE_STATUS_PARSE_FAILED", message: error instanceof Error ? error.message : String(error) }],
        warnings: [],
      },
    };
  }
}

interface BuildDoctorReportOptions {
  projectRoot?: unknown;
  project_root?: unknown;
  cwd?: unknown;
  yoloRoot?: unknown;
  yolo_root?: unknown;
  homeDir?: unknown;
  home_dir?: unknown;
  targets?: unknown;
  target?: unknown;
  scope?: unknown;
  installScope?: unknown;
  install_scope?: unknown;
}

export function buildYoloDoctorReport(options: BuildDoctorReportOptions = {}) {
  const projectRoot = resolve(String(options.projectRoot || options.project_root || options.cwd || process.cwd()));
  const yoloRoot = resolve(String(options.yoloRoot || options.yolo_root || join(__dirname, "../..")));
  const homeDir = resolve(String(options.homeDir || options.home_dir || homedir()));
  const targets = String(options.targets || options.target || "both");
  const scope = String(options.scope || options.installScope || options.install_scope || "project");
  const stateRoot = join(projectRoot, ".yolo");
  const configPath = join(projectRoot, ".yolo/config.json");
  const configRead = existsSync(configPath) ? readJsonSafe(configPath) : { ok: false, error: "missing" };
  const lifecycle = lifecycleInspection(projectRoot);
  const commandRegistry = buildYoloCommandRegistry();
  const commandNames = listYoloCommandNames();
  const commandRegistryInspection = inspectYoloCommandRegistry(commandRegistry);
  const bridgePlan = buildAgentBridgeInstallPlan({
    projectRoot,
    yoloRoot,
    homeDir,
    targets,
    scope,
  });
  const bridgeArtifacts = expectedBridgeArtifacts(bridgePlan).map(artifactStatus);
  const missingBridgeArtifacts = bridgeArtifacts.filter((artifact) => !artifact.exists || !artifact.non_empty);
  const driftFinding = worktreeDriftFinding(projectRoot, stateRoot);

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
      commandRegistryInspection.valid === true
        && commandRegistry.surface_budget === YOLO_COMMAND_SURFACE_BUDGET
        && commandNames.length === DEFAULT_YOLO_PUBLIC_COMMAND_NAMES.length
        && commandNames.join("\n") === DEFAULT_YOLO_PUBLIC_COMMAND_NAMES.join("\n"),
      "command registry must expose the 8 stable lifecycle commands from one source of truth",
      {
        command_count: commandNames.length,
        commands: commandNames,
        expected_commands: DEFAULT_YOLO_PUBLIC_COMMAND_NAMES,
        surface_budget: commandRegistry.surface_budget,
        inspection: commandRegistryInspection,
      },
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
    ...(driftFinding ? [driftFinding] : []),
  ];

  const blockers = checks.filter((item) => item.severity === "error" && item.passed !== true);
  const warnings = checks.filter((item) => item.severity === "warning" && item.passed !== true);
  const pending = checks.filter((item) => item.severity === "pending" && item.passed !== true);
  const status = blockers.length > 0 ? "blocked" : (warnings.length > 0 ? "warning" : "pass");
  const driftBlocker = blockers.find((item) => item.code === "YOLO_DOCTOR_WORKTREE_DRIFT");
  const driftFixCommand = typeof driftBlocker?.fix_command === "string" ? driftBlocker.fix_command : "";

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
    pending,
    findings: driftFinding ? [driftFinding] : [],
    lifecycle: {
      status_path: lifecycle.path,
      exists: lifecycle.exists,
      validation: lifecycle.validation,
      current_stage: (lifecycle.state as Record<string, unknown> | undefined)?.current_stage || null,
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
    next_actions: driftFixCommand
      ? [`Run ${driftFixCommand} to revalidate the drifted worktree and refresh the lifecycle snapshot.`]
      : status === "blocked"
        ? ["Ask the agent to run yolo setup for this project, then run yolo status again."]
      : status === "warning"
        ? ["Ask the agent to run yolo install for the desired Codex/Claude scope, then restart or refresh the host."]
        : ["YOLO project lifecycle and agent entrypoints are ready; start with yolo status or yolo demand."],
  };
}

export function formatYoloDoctorText(report: ReturnType<typeof buildYoloDoctorReport>) {
  const lines = [
    `[yolo doctor] ${report.status}`,
    `project: ${report.project_root}`,
    `commands: ${report.commands?.count || 0}`,
    `lifecycle: ${report.lifecycle?.current_stage || "missing"}`,
  ];
  if (report.blockers?.length) {
    lines.push("blockers:");
    for (const blocker of report.blockers) {
      lines.push(`  - ${blocker.code}: ${blocker.message}`);
      if (blocker.fix_command) lines.push(`    fix_command: ${blocker.fix_command}`);
      if (blocker.captured_at) lines.push(`    captured_at: ${blocker.captured_at}`);
      if (blocker.current_difference_file_count != null) {
        lines.push(`    current_difference_file_count: ${blocker.current_difference_file_count}`);
      }
    }
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

interface DoctorParsedInput {
  projectRoot?: string;
  targets?: string;
  scope?: string;
  homeDir?: string;
}

interface DoctorParsedOptions {
  json: boolean;
  help: boolean;
}

interface DoctorIo {
  stdout?: { write: (data: string) => void };
  cwd?: string;
  yoloRoot?: string;
  home_dir?: string;
}

function parseDoctorArgs(argv: string[] = []): { input: DoctorParsedInput; options: DoctorParsedOptions } {
  const options: DoctorParsedOptions = { json: false, help: false };
  const input: DoctorParsedInput = {};
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

export function runYoloDoctorCli(argv: string[] = [], io: DoctorIo = {}): number {
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
  return report.status === "pass" ? 0 : report.status === "warning" ? 2 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.exitCode = runYoloDoctorCli(process.argv.slice(2));
}
