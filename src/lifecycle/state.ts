import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createLifecycleArtifact,
  createLifecycleStateSnapshot,
  getLifecycleStage,
  LIFECYCLE_STAGES,
  validateLifecycleState,
} from "./schema.js";

export const LIFECYCLE_DIR_NAME = "lifecycle";
export const LIFECYCLE_STATUS_FILE = "status.json";

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function clean(value) {
  return String(value ?? "").trim();
}

function projectRelative(projectRoot, absolutePath) {
  const rel = relative(projectRoot, absolutePath);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll("\\", "/") : absolutePath;
}

export function resolveLifecycleStateRoot(options = Object()) {
  if (options.stateRoot || options.state_root) return resolve(options.stateRoot || options.state_root);
  const projectRoot = resolve(options.projectRoot || options.project_root || options.cwd || process.cwd());
  return join(projectRoot, ".yolo");
}

export function lifecycleDir(options = Object()) {
  return join(resolveLifecycleStateRoot(options), LIFECYCLE_DIR_NAME);
}

export function lifecycleArtifactPath(stageId, options = Object()) {
  const stage = getLifecycleStage(stageId);
  return join(lifecycleDir(options), stage.default_artifact);
}

export function lifecycleStatusPath(options = Object()) {
  return join(lifecycleDir(options), LIFECYCLE_STATUS_FILE);
}

export function buildLifecycleStateFiles(options = Object()) {
  const projectName = clean(options.projectName || options.project_name) || "project";
  const now = clean(options.now) || new Date().toISOString();
  const status = createLifecycleStateSnapshot({ projectName, now });
  const files = [
    {
      path: `.yolo/${LIFECYCLE_DIR_NAME}/${LIFECYCLE_STATUS_FILE}`,
      role: "lifecycle-state",
      stage: null,
      content: stableJson(status),
    },
    ...LIFECYCLE_STAGES.map((stage) => ({
      path: `.yolo/${LIFECYCLE_DIR_NAME}/${stage.default_artifact}`,
      role: "lifecycle-artifact",
      stage: stage.id,
      content: stableJson(createLifecycleArtifact(stage, { projectName, now })),
    })),
  ];

  return {
    directory: `.yolo/${LIFECYCLE_DIR_NAME}`,
    files,
    status,
    validation: validateLifecycleState(status),
  };
}

export function readLifecycleState(options = Object()) {
  const path = lifecycleStatusPath(options);
  const state = JSON.parse(readFileSync(path, "utf8"));
  return {
    path,
    state,
    validation: validateLifecycleState(state),
  };
}

export function initLifecycleState(options = Object()) {
  const projectRoot = resolve(options.projectRoot || options.project_root || options.cwd || process.cwd());
  const stateRoot = resolveLifecycleStateRoot({ ...options, projectRoot });
  const force = options.force === true;
  const dryRun = options.dryRun === true || options.dry_run === true;
  const plan = buildLifecycleStateFiles(options);
  const createdDirs = [];
  const created = [];
  const overwritten = [];
  const skipped = [];

  const absoluteDir = join(projectRoot, plan.directory);
  if (!existsSync(absoluteDir)) {
    createdDirs.push(plan.directory);
    if (!dryRun) mkdirSync(absoluteDir, { recursive: true });
  }

  for (const file of plan.files) {
    const absoluteFile = join(projectRoot, file.path);
    const exists = existsSync(absoluteFile);
    if (exists && !force) {
      skipped.push(file.path);
      continue;
    }
    if (!dryRun) {
      mkdirSync(dirname(absoluteFile), { recursive: true });
      writeFileSync(absoluteFile, file.content, "utf8");
    }
    if (exists) overwritten.push(file.path);
    else created.push(file.path);
  }

  return {
    status: "success",
    summary: dryRun ? "planned YOLO lifecycle initialization" : "initialized YOLO lifecycle state",
    exit_code: 0,
    project_root: projectRoot,
    state_root: stateRoot,
    lifecycle_dir: projectRelative(projectRoot, join(stateRoot, LIFECYCLE_DIR_NAME)),
    dry_run: dryRun,
    force,
    created_dirs: createdDirs,
    created,
    overwritten,
    skipped,
    validation: plan.validation,
    artifacts: plan.files.map((file) => file.path),
  };
}
