import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProjectBootstrapPlan,
  initProject,
  type ProjectBootstrapPlan,
} from "./bootstrap.js";
import { buildYoloDoctorReport } from "../devtools/doctor.js";
import {
  installAgentBridge,
  normalizeAgentTargets,
  normalizeInstallScopes,
} from "../../tools/install-agent-bridge.js";

export const YOLO_SETUP_SCHEMA_VERSION = "1.0";
export const YOLO_SETUP_SCHEMA = "yolo.project_setup.result.v1";

export interface ProjectSetupOptions {
  projectRoot?: string;
  project_root?: string;
  cwd?: string;
  yoloRoot?: string;
  yolo_root?: string;
  homeDir?: string;
  home_dir?: string;
  targets?: unknown;
  target?: unknown;
  scope?: unknown;
  scopes?: unknown;
  installScope?: unknown;
  install_scope?: unknown;
  projectName?: unknown;
  project_name?: unknown;
  name?: unknown;
  now?: string | number | Date;
  force?: unknown;
  dryRun?: unknown;
  dry_run?: unknown;
}

type DoctorReport = ReturnType<typeof buildYoloDoctorReport>;
type SetupGap = {
  code: string;
  severity: string;
  source: string;
  message: string;
  paths?: string[];
  [key: string]: unknown;
};
type NextAction = {
  id: string;
  command?: string;
  args?: string[];
  type?: string;
  verifies?: string;
  gap_codes?: string[];
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_YOLO_ROOT = resolve(__dirname, "../..");
const BRIDGE_START = "<!-- yolo-agent-bridge:start -->";
const DEVELOPMENT_MARKERS = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "README.md",
  "docs",
  "src",
  "app",
  "lib",
  "test",
  "tests",
  "__tests__",
  ".git",
];

function readArgList(values: string[] = []): string {
  return values.length === 0 ? "" : values.join(",");
}

function scopeOption(scopes: string[] = []): string {
  return scopes.length === 0 ? "none" : readArgList(scopes);
}

function instructionFileFor(projectRoot: string, target: string): string {
  return join(projectRoot, target === "claude" ? "CLAUDE.md" : "AGENTS.md");
}

function fileHasManagedBridge(path: string): boolean {
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8").includes(BRIDGE_START);
}

function fileHasUserContent(path: string): boolean {
  return existsSync(path) && readFileSync(path, "utf8").trim().length > 0;
}

function readJsonParseError(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return null;
  } catch (error) {
    return error?.message || String(error);
  }
}

function missingBootstrapArtifacts(plan: ProjectBootstrapPlan = Object()): {
  directories: string[];
  files: string[];
  count: number;
} {
  const projectRoot = plan.project_root;
  const missingDirs = plan.directories.filter((dir) => !existsSync(join(projectRoot, dir)));
  const missingFiles = plan.files.map((file) => file.path).filter((path) => !existsSync(join(projectRoot, path)));
  return {
    directories: missingDirs,
    files: missingFiles,
    count: missingDirs.length + missingFiles.length,
  };
}

function bootstrapExistingCount(plan: ProjectBootstrapPlan = Object()): number {
  const projectRoot = plan.project_root;
  const existingDirs = plan.directories.filter((dir) => existsSync(join(projectRoot, dir))).length;
  const existingFiles = plan.files.filter((file) => existsSync(join(projectRoot, file.path))).length;
  return existingDirs + existingFiles;
}

function hasDevelopmentMarkers(projectRoot: string): boolean {
  return DEVELOPMENT_MARKERS.some((marker) => existsSync(join(projectRoot, marker)));
}

function doctorBridgeExistingCount(report: DoctorReport = Object()): number {
  const agentBridge = report.agent_bridge as Record<string, unknown> | undefined;
  const total = (agentBridge?.expected_artifact_count as number) || 0;
  const missing = (agentBridge?.missing_artifact_count as number) || 0;
  return Math.max(0, total - missing);
}

function doctorGap(check: Record<string, unknown> = Object()): SetupGap {
  const paths = [check.path].filter(Boolean) as string[];
  const missingArtifacts = (check.missing_artifacts as Array<Record<string, unknown>>) || [];
  return {
    code: check.code as string,
    severity: (check.severity as string) || "error",
    source: "doctor",
    message: check.message as string,
    paths,
    missing_artifacts: missingArtifacts.map((artifact) => artifact.relative_path || artifact.path).filter(Boolean),
  };
}

function riskyGaps({ projectRoot, targets, scopes, force, initialDoctor }: {
  projectRoot: string;
  targets: string[];
  scopes: string[];
  force: boolean;
  initialDoctor: DoctorReport;
}): SetupGap[] {
  const gaps: SetupGap[] = [];
  if (!existsSync(projectRoot)) {
    gaps.push({
      code: "YOLO_SETUP_PROJECT_ROOT_MISSING",
      severity: "error",
      source: "setup",
      message: "project root must exist before setup writes project-scoped artifacts",
      paths: [projectRoot],
    });
    return gaps;
  }

  const configPath = join(projectRoot, ".yolo/config.json");
  const configError = readJsonParseError(configPath);
  if (configError) {
    gaps.push({
      code: "YOLO_SETUP_CONFIG_INVALID",
      severity: "error",
      source: "setup",
      message: "existing .yolo/config.json is not valid JSON; setup will not overwrite it without an explicit repair",
      paths: [configPath],
      parse_error: configError,
    });
  }

  const lifecyclePath = join(projectRoot, ".yolo/lifecycle/status.json");
  const lifecycleInvalid = existsSync(lifecyclePath) && initialDoctor.lifecycle?.validation?.valid !== true;
  if (lifecycleInvalid) {
    gaps.push({
      code: "YOLO_SETUP_LIFECYCLE_STATUS_INVALID",
      severity: "error",
      source: "setup",
      message: "existing lifecycle status is invalid; setup will not overwrite it by default",
      paths: [lifecyclePath],
      validation: initialDoctor.lifecycle?.validation,
    });
  }

  if (!force && scopes.includes("project")) {
    for (const target of targets) {
      const path = instructionFileFor(projectRoot, target);
      if (fileHasUserContent(path) && !fileHasManagedBridge(path)) {
        gaps.push({
          code: "YOLO_SETUP_UNMANAGED_AGENT_INSTRUCTIONS",
          severity: "error",
          source: "setup",
          message: "project agent instruction file already has unmanaged content; setup will not append the bridge by default",
          paths: [path],
          target,
          next_action: "review the file, then run yolo setup --force or yolo install explicitly if appending the managed bridge is acceptable",
        });
      }
    }
  }

  return gaps;
}

function classifySetupState({ plan, initialDoctor, riskGaps }: {
  plan: ProjectBootstrapPlan;
  initialDoctor: DoctorReport;
  riskGaps: SetupGap[];
}): string {
  if (riskGaps.length > 0) return "risky";
  if (initialDoctor.status === "pass") return "initialized";

  const existingBootstrap = bootstrapExistingCount(plan);
  const existingBridge = doctorBridgeExistingCount(initialDoctor);
  if (existingBootstrap === 0 && existingBridge === 0 && !hasDevelopmentMarkers(plan.project_root)) return "new";
  return "partial";
}

function resultStateFromDoctor(report: DoctorReport = Object()): string {
  return report.status === "pass" ? "initialized" : "partial";
}

function setupCommandArgs({ projectRoot, targets, scopes }: {
  projectRoot: string;
  targets: string[];
  scopes: string[];
}): string[] {
  return [
    "setup",
    projectRoot,
    "--target",
    readArgList(targets),
    "--scope",
    scopeOption(scopes),
    "--json",
  ];
}

function doctorCommandArgs({ projectRoot, targets, scopes }: {
  projectRoot: string;
  targets: string[];
  scopes: string[];
}): string[] {
  return [
    "doctor",
    projectRoot,
    "--target",
    readArgList(targets),
    "--scope",
    scopeOption(scopes),
    "--json",
  ];
}

function nextActions({ status, dryRun, projectRoot, targets, scopes, riskGaps, finalDoctor }: {
  status: string;
  dryRun: boolean;
  projectRoot: string;
  targets: string[];
  scopes: string[];
  riskGaps: SetupGap[];
  finalDoctor: DoctorReport;
}): NextAction[] {
  if (riskGaps.length > 0) {
    return [
      {
        id: "resolve_risky_setup_gaps",
        type: "manual",
        verifies: "risk_gaps.length == 0",
        gap_codes: riskGaps.map((gap) => gap.code),
      },
      {
        id: "reinit_with_force",
        command: "yolo",
        args: ["init", "--force"],
        verifies: "setup_state != risky",
      },
      {
        id: "recheck_setup_plan",
        command: "yolo",
        args: [...setupCommandArgs({ projectRoot, targets, scopes }), "--dry-run"],
        verifies: "setup_state != risky",
      },
    ];
  }

  if (dryRun) {
    return [
      {
        id: "apply_setup",
        command: "yolo",
        args: setupCommandArgs({ projectRoot, targets, scopes }),
        verifies: "status in [success, warning] && doctor.status != blocked",
      },
    ];
  }

  if (finalDoctor.status === "pass") {
    return [
      {
        id: "verify_setup",
        command: "yolo",
        args: doctorCommandArgs({ projectRoot, targets, scopes }),
        verifies: "status == pass",
      },
    ];
  }

  if (status === "warning") {
    return [
      {
        id: "inspect_remaining_setup_gaps",
        command: "yolo",
        args: doctorCommandArgs({ projectRoot, targets, scopes }),
        verifies: "warnings[].code and agent_bridge.missing_artifacts",
      },
      {
        id: "apply_missing_bridge_artifacts_if_safe",
        command: "yolo",
        args: [...setupCommandArgs({ projectRoot, targets, scopes }), "--force"],
        verifies: "doctor.status == pass",
      },
    ];
  }

  return [
    {
      id: "inspect_blocked_setup",
      command: "yolo",
      args: doctorCommandArgs({ projectRoot, targets, scopes }),
      verifies: "blockers[].code",
    },
  ];
}

function summarizeInitResult(result: ReturnType<typeof initProject> | null) {
  if (!result) return null;
  return {
    status: result.status,
    dry_run: result.dry_run,
    force: result.force,
    created_dirs: result.created_dirs,
    created: result.created,
    overwritten: result.overwritten,
    skipped: result.skipped,
  };
}

function summarizeBridgeResult(result: ReturnType<typeof installAgentBridge> | null) {
  if (!result) return null;
  return {
    status: result.status,
    dry_run: result.dry_run,
    writes_workspace: result.writes_workspace,
    writes_user_home: result.writes_user_home,
    planned: result.planned,
    written: result.written,
    overwritten: result.overwritten,
    skipped: result.skipped,
  };
}

function buildGaps({ missingBootstrap, initialDoctor, riskGaps }: {
  missingBootstrap: ReturnType<typeof missingBootstrapArtifacts>;
  initialDoctor: DoctorReport;
  riskGaps: SetupGap[];
}): SetupGap[] {
  const gaps: SetupGap[] = [...riskGaps];
  if (missingBootstrap.count > 0) {
    gaps.push({
      code: "YOLO_SETUP_BOOTSTRAP_MISSING",
      severity: "error",
      source: "setup",
      message: "project is missing YOLO bootstrap directories or files",
      directories: missingBootstrap.directories,
      files: missingBootstrap.files,
    });
  }
  for (const blocker of (initialDoctor.blockers || [])) gaps.push(doctorGap(blocker as Record<string, unknown>));
  for (const warning of (initialDoctor.warnings || [])) gaps.push(doctorGap(warning as Record<string, unknown>));
  return gaps;
}

function humanContextGaps(setupState: string): SetupGap[] {
  if (!["partial", "risky"].includes(setupState)) return [];
  return [
    {
      code: "YOLO_SETUP_BUSINESS_GOAL_UNVERIFIED",
      severity: "info",
      source: "human",
      message: "business goal is not verified by setup; capture it in a separate onboarding or interview step",
    },
    {
      code: "YOLO_SETUP_CURRENT_PROGRESS_UNVERIFIED",
      severity: "info",
      source: "human",
      message: "current progress and half-finished work boundaries are not verified by setup",
    },
    {
      code: "YOLO_SETUP_TESTING_RELIABILITY_UNVERIFIED",
      severity: "info",
      source: "human",
      message: "test commands may be discoverable, but their reliability still needs project-owner confirmation",
    },
    {
      code: "YOLO_SETUP_KNOWN_RISKS_UNVERIFIED",
      severity: "info",
      source: "human",
      message: "known risks, no-touch areas, deadlines, and customer commitments require human confirmation",
    },
    {
      code: "YOLO_SETUP_ACTIVE_TODOS_UNVERIFIED",
      severity: "info",
      source: "human",
      message: "active todos and priorities are not inferred by setup",
    },
  ];
}

export function setupProject(options: ProjectSetupOptions = Object()) {
  const projectRoot = resolve(options.projectRoot || options.project_root || options.cwd || process.cwd());
  const yoloRoot = resolve(options.yoloRoot || options.yolo_root || DEFAULT_YOLO_ROOT);
  const homeDir = resolve(options.homeDir || options.home_dir || homedir());
  const targets = normalizeAgentTargets((options.targets || options.target || "both") as string);
  const scopes = Array.isArray(options.scopes)
    ? options.scopes
    : normalizeInstallScopes((options.scope || options.installScope || options.install_scope || "project") as string);
  const dryRun = options.dryRun === true || options.dry_run === true;
  const force = options.force === true;
  const projectName = options.projectName || options.project_name || options.name;
  const bridgeScope = scopeOption(scopes);
  const targetOption = readArgList(targets);
  const plan = buildProjectBootstrapPlan({ projectRoot, projectName, now: options.now });
  const initialDoctor = buildYoloDoctorReport({
    projectRoot,
    yoloRoot,
    homeDir,
    targets: targetOption,
    scope: bridgeScope,
  });
  const missingBootstrap = missingBootstrapArtifacts(plan);
  const riskGaps = riskyGaps({ projectRoot, targets, scopes, force, initialDoctor });
  const setupState = classifySetupState({ plan, initialDoctor, riskGaps });
  const gaps = buildGaps({ missingBootstrap, initialDoctor, riskGaps });
  const contextGaps = humanContextGaps(setupState);
  const needsBootstrap = missingBootstrap.count > 0;
  const needsBridge = (initialDoctor.agent_bridge?.missing_artifact_count || 0) > 0;

  let initResult = null;
  let bridgeResult = null;
  let finalDoctor = initialDoctor;

  if (setupState !== "risky" && setupState !== "initialized") {
    if (needsBootstrap) {
      initResult = initProject({
        projectRoot,
        projectName,
        force,
        dryRun,
        now: options.now,
      });
    }

    if (needsBridge) {
      bridgeResult = installAgentBridge({
        projectRoot,
        yoloRoot,
        homeDir,
        targets: targetOption,
        scope: bridgeScope,
        force,
        dryRun,
      });
    }

    if (!dryRun) {
      finalDoctor = buildYoloDoctorReport({
        projectRoot,
        yoloRoot,
        homeDir,
        targets: targetOption,
        scope: bridgeScope,
      });
    }
  }

  const finalState = setupState === "risky" ? "risky" : resultStateFromDoctor(finalDoctor);
  const status = setupState === "risky"
    ? "blocked"
    : dryRun
      ? "planned"
      : finalDoctor.status === "pass"
        ? "success"
        : finalDoctor.status;

  return {
    schema: YOLO_SETUP_SCHEMA,
    schema_version: YOLO_SETUP_SCHEMA_VERSION,
    status,
    exit_code: status === "blocked" ? 2 : 0,
    summary: dryRun
      ? "planned YOLO project setup"
      : status === "success"
        ? "YOLO project setup is initialized"
        : "YOLO project setup needs attention",
    setup_state: setupState,
    final_state: finalState,
    project_root: projectRoot,
    yolo_root: yoloRoot,
    home_dir: homeDir,
    project_name: plan.project_name,
    targets,
    scopes,
    dry_run: dryRun,
    force,
    gaps,
    human_context_gaps: contextGaps,
    risk_gaps: riskGaps,
    bootstrap: {
      missing_directories: missingBootstrap.directories,
      missing_files: missingBootstrap.files,
      missing_count: missingBootstrap.count,
    },
    init_result: summarizeInitResult(initResult),
    agent_bridge_result: summarizeBridgeResult(bridgeResult),
    doctor: finalDoctor,
    initial_doctor: {
      status: initialDoctor.status,
      blocker_count: initialDoctor.blockers?.length || 0,
      warning_count: initialDoctor.warnings?.length || 0,
    },
    guarantees: {
      force_default: false,
      force_enabled: force,
      default_scope: "project",
      writes_workspace: !dryRun && setupState !== "risky" && (Boolean(initResult) || Boolean(bridgeResult?.writes_workspace)),
      writes_user_home: !dryRun && setupState !== "risky" && Boolean(bridgeResult?.writes_user_home),
      onboarding_autofill: false,
      provider_execution: false,
      publishes: false,
      reads_credentials: false,
    },
    next_actions: nextActions({ status, dryRun, projectRoot, targets, scopes, riskGaps, finalDoctor }),
  };
}

export function inspectProjectSetupTarget(options: ProjectSetupOptions = Object()) {
  return setupProject({ ...options, dryRun: true });
}

export function buildProjectSetupPlan(options: ProjectSetupOptions = Object()) {
  return setupProject({ ...options, dryRun: true });
}

export const runProjectSetup = setupProject;

export function formatProjectSetupText(result: Record<string, unknown> = Object()): string {
  const targets = (result.targets as string[] | undefined) || [];
  const scopes = (result.scopes as string[] | undefined) || [];
  const lines = [
    `[yolo setup] ${result.status}: ${result.summary}`,
    `root: ${result.project_root}`,
    `state: ${result.setup_state} -> ${result.final_state}`,
    `targets: ${targets.join(",") || "none"}`,
    `scopes: ${scopes.join(",") || "none"}`,
  ];

  const initResult = result.init_result as Record<string, unknown> | undefined;
  if (initResult) {
    const created = (initResult.created as string[] | undefined)?.length || 0;
    const initSkipped = (initResult.skipped as string[] | undefined)?.length || 0;
    lines.push(`initProject: created ${created}, skipped ${initSkipped}`);
  }
  const bridgeResult = result.agent_bridge_result as Record<string, unknown> | undefined;
  if (bridgeResult) {
    const written = (bridgeResult.written as string[] | undefined)?.length || 0;
    const overwritten = (bridgeResult.overwritten as string[] | undefined)?.length || 0;
    const bridgeSkipped = (bridgeResult.skipped as string[] | undefined)?.length || 0;
    lines.push(`installAgentBridge: changed ${written + overwritten}, skipped ${bridgeSkipped}`);
  }
  const gaps = (result.gaps as Array<Record<string, unknown>>) || [];
  if (gaps.length) {
    lines.push("gaps:");
    for (const gap of gaps.slice(0, 20)) lines.push(`  - ${gap.code}: ${gap.message}`);
  }
  const contextGaps = (result.human_context_gaps as Array<Record<string, unknown>>) || [];
  if (contextGaps.length) {
    lines.push("human context still needed:");
    for (const gap of contextGaps) lines.push(`  - ${gap.code}: ${gap.message}`);
  }
  const nextActions = (result.next_actions as Array<Record<string, unknown>>) || [];
  if (nextActions.length) {
    lines.push("next:");
    for (const action of nextActions) {
      const args = (action.args as string[] | undefined) || [];
      const command = action.command ? `${action.command} ${args.join(" ")}` : action.id;
      lines.push(`  - ${command}`);
    }
  }
  return lines.join("\n");
}
