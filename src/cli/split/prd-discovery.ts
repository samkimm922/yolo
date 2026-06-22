// PRD discovery and default-path inference for the CLI.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { prdSearchDirs } from "../../core/paths.js";
import { cleanCliText, defaultYoloRoot } from "./shared.js";

function readJsonMaybe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isRunnablePrdJson(value = Object()) {
  return Array.isArray(value?.tasks) &&
    value.tasks.length > 0 &&
    Boolean(value.tasks[0]?.id) &&
    Boolean(value.tasks[0]?.priority);
}

function addCliPrdCandidate(files, file) {
  try {
    if (!existsSync(file)) return;
    const stat = statSync(file);
    if (!stat.isFile()) return;
    files.push({ path: file, mtime: stat.mtimeMs });
  } catch {
    // Ignore disappearing files during discovery.
  }
}

function addJsonPrdCandidatesFromDir(files, dir) {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || file === "package.json" || file === "tsconfig.json" || file.startsWith("retry-")) {
      continue;
    }
    addCliPrdCandidate(files, join(dir, file));
  }
}

function addDemandPrdCandidates(files, demandDir) {
  if (!existsSync(demandDir)) return;
  for (const name of readdirSync(demandDir)) {
    const dir = join(demandDir, name);
    try {
      if (statSync(dir).isDirectory()) addCliPrdCandidate(files, join(dir, "prd.json"));
    } catch {
      // Ignore malformed demand entries while searching for a PRD.
    }
  }
}

function lifecyclePrdCandidates(report = Object()) {
  const nested = report.report || {};
  const artifacts = [
    ...(Array.isArray(report.artifacts) ? report.artifacts : []),
    ...(Array.isArray(nested.artifacts) ? nested.artifacts : []),
  ];
  return [
    report.prd_path,
    report.prdPath,
    nested.prd_path,
    nested.prdPath,
    ...artifacts,
  ].filter(Boolean);
}

function existingCliPrdCandidate(projectRoot, value) {
  const raw = cleanCliText(value);
  if (!raw || !raw.endsWith(".json")) return "";
  const file = isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw);
  if (!existsSync(file)) return "";
  return isRunnablePrdJson(readJsonMaybe(file)) ? file : "";
}

export function findLatestPrd(yoloRoot = defaultYoloRoot) {
  try {
    const files = [];
    addDemandPrdCandidates(files, join(yoloRoot, "demand"));
    for (const dir of prdSearchDirs(yoloRoot)) {
      addJsonPrdCandidatesFromDir(files, dir);
    }

    files.sort((a, b) => b.mtime - a.mtime);
    for (const file of files) {
      if (isRunnablePrdJson(readJsonMaybe(file.path))) return file.path;
    }
  } catch {
    return null;
  }
  return null;
}

export function inferDefaultCliPrdPath(input = Object(), options = Object()) {
  const projectRoot = resolve(input.projectRoot || input.project_root || options.projectRoot || options.project_root || input.cwd || options.cwd || process.cwd());
  const stateRoot = resolve(input.stateRoot || input.state_root || options.stateRoot || options.state_root || join(projectRoot, ".yolo"));
  const latest = findLatestPrd(stateRoot);
  if (latest) return latest;

  for (const name of ["prd.json", "check-report.json", "run-report.json"]) {
    const report = readJsonMaybe(join(stateRoot, "lifecycle", name));
    if (!report) continue;
    if (isRunnablePrdJson(report)) return join(stateRoot, "lifecycle", name);
    for (const candidate of lifecyclePrdCandidates(report)) {
      const file = existingCliPrdCandidate(projectRoot, candidate);
      if (file) return file;
    }
  }

  return "";
}
