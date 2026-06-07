import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProjectBootstrapPlan, initProject } from "./bootstrap.js";
import { buildYoloDoctorReport } from "../runtime/devtools/doctor.js";
import {
  installAgentBridge,
  normalizeAgentTargets,
  normalizeInstallScopes,
} from "../../tools/install-agent-bridge.js";

export const YOLO_SETUP_SCHEMA_VERSION = "1.0";
export const YOLO_SETUP_SCHEMA = "yolo.project_setup.result.v1";

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

function readArgList(values = []) {
  return values.length === 0 ? "" : values.join(",");
}

function scopeOption(scopes = []) {
  return scopes.length === 0 ? "none" : readArgList(scopes);
}

function instructionFileFor(projectRoot, target) {
  return join(projectRoot, target === "claude" ? "CLAUDE.md" : "AGENTS.md");
}

function fileHasManagedBridge(path) {
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8").includes(BRIDGE_START);
}

function fileHasUserContent(path) {
  return existsSync(path) && readFileSync(path, "utf8").trim().length > 0;
}

function readJsonParseError(path) {
  if (!existsSync(path)) return null;
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return null;
  } catch (error) {
    return error?.message || String(error);
  }
}

function missingBootstrapArtifacts(plan = {}) {
  const projectRoot = plan.project_root;
  const missingDirs = (plan.directories || []).filter((dir) => !existsSync(join(projectRoot, dir)));
  const missingFiles = (plan.files || []).map((file) => file.path).filter((path) => !existsSync(join(projectRoot, path)));
  return {
    directories: missingDirs,
    files: missingFiles,
    count: missingDirs.length + missingFiles.length,
  };
}

function bootstrapExistingCount(plan = {}) {
  const projectRoot = plan.project_root;
  const existingDirs = (plan.directories || []).filter((dir) => existsSync(join(projectRoot, dir))).length;
  const existingFiles = (plan.files || []).filter((file) => existsSync(join(projectRoot, file.path))).length;
  return existingDirs + existingFiles;
}

function hasDevelopmentMarkers(projectRoot) {
  return DEVELOPMENT_MARKERS.some((marker) => existsSync(join(projectRoot, marker)));
}

function doctorBridgeExistingCount(report = {}) {
  const total = report.agent_bridge?.expected_artifact_count || 0;
  const missing = report.agent_bridge?.missing_artifact_count || 0;
  return Math.max(0, total - missing);
}

function doctorGap(check = {}) {
  const paths = [check.path].filter(Boolean);
  const missingArtifacts = check.missing_artifacts || [];
  return {
    code: check.code,
    severity: check.severity || "error",
    source: "doctor",
    message: check.message,
    paths,
    missing_artifacts: missingArtifacts.map((artifact) => artifact.relative_path || artifact.path).filter(Boolean),
  };
}

function riskyGaps({ projectRoot, targets, scopes, force, initialDoctor }) {
  const gaps = [];
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

function classifySetupState({ plan, initialDoctor, riskGaps }) {
  if (riskGaps.length > 0) return "risky";
  if (initialDoctor.status === "pass") return "initialized";

  const existingBootstrap = bootstrapExistingCount(plan);
  const existingBridge = doctorBridgeExistingCount(initialDoctor);
  if (existingBootstrap === 0 && existingBridge === 0 && !hasDevelopmentMarkers(plan.project_root)) return "new";
  return "partial";
}

function resultStateFromDoctor(report = {}) {
  return report.status === "pass" ? "initialized" : "partial";
}

function setupCommandArgs({ projectRoot, targets, scopes }) {
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

function doctorCommandArgs({ projectRoot, targets, scopes }) {
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

function nextActions({ status, dryRun, projectRoot, targets, scopes, riskGaps, finalDoctor }) {
  if (riskGaps.length > 0) {
    return [
      {
        id: "resolve_risky_setup_gaps",
        type: "manual",
        verifies: "risk_gaps.length == 0",
        gap_codes: riskGaps.map((gap) => gap.code),
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

function summarizeInitResult(result) {
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

function summarizeBridgeResult(result) {
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
    skill_installs: (result.skill_installs || []).map((install) => ({
      status: install.status,
      scope: install.scope,
      agent_target: install.agent_target,
      created: install.created,
      skipped: install.skipped,
    })),
  };
}

function buildGaps({ missingBootstrap, initialDoctor, riskGaps }) {
  const gaps = [...riskGaps];
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
  for (const blocker of initialDoctor.blockers || []) gaps.push(doctorGap(blocker));
  for (const warning of initialDoctor.warnings || []) gaps.push(doctorGap(warning));
  return gaps;
}

function humanContextGaps(setupState) {
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

export function setupProject(options = {}) {
  const projectRoot = resolve(options.projectRoot || options.project_root || options.cwd || process.cwd());
  const yoloRoot = resolve(options.yoloRoot || options.yolo_root || DEFAULT_YOLO_ROOT);
  const homeDir = resolve(options.homeDir || options.home_dir || homedir());
  const targets = normalizeAgentTargets(options.targets || options.target || "both");
  const scopes = Array.isArray(options.scopes)
    ? options.scopes
    : normalizeInstallScopes(options.scope || options.installScope || options.install_scope || "project");
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

export function inspectProjectSetupTarget(options = {}) {
  return setupProject({ ...options, dryRun: true });
}

export function buildProjectSetupPlan(options = {}) {
  return setupProject({ ...options, dryRun: true });
}

export const runProjectSetup = setupProject;

export function formatProjectSetupText(result = {}) {
  const lines = [
    `[yolo setup] ${result.status}: ${result.summary}`,
    `root: ${result.project_root}`,
    `state: ${result.setup_state} -> ${result.final_state}`,
    `targets: ${(result.targets || []).join(",") || "none"}`,
    `scopes: ${(result.scopes || []).join(",") || "none"}`,
  ];

  if (result.init_result) {
    lines.push(`initProject: created ${result.init_result.created?.length || 0}, skipped ${result.init_result.skipped?.length || 0}`);
  }
  if (result.agent_bridge_result) {
    const bridge = result.agent_bridge_result;
    const changed = (bridge.written?.length || 0) + (bridge.overwritten?.length || 0);
    lines.push(`installAgentBridge: changed ${changed}, skipped ${bridge.skipped?.length || 0}`);
  }
  if (result.gaps?.length) {
    lines.push("gaps:");
    for (const gap of result.gaps.slice(0, 20)) lines.push(`  - ${gap.code}: ${gap.message}`);
  }
  if (result.human_context_gaps?.length) {
    lines.push("human context still needed:");
    for (const gap of result.human_context_gaps) lines.push(`  - ${gap.code}: ${gap.message}`);
  }
  if (result.next_actions?.length) {
    lines.push("next:");
    for (const action of result.next_actions) {
      const command = action.command ? `${action.command} ${(action.args || []).join(" ")}` : action.id;
      lines.push(`  - ${command}`);
    }
  }
  return lines.join("\n");
}
