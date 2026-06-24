// PRD discovery and default-path inference for the CLI.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { prdSearchDirs } from "../../core/paths.js";
import { cleanCliText, defaultYoloRoot } from "./shared.js";

function readJsonMaybe(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isRunnablePrdJson(value: unknown = {}): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as { tasks?: unknown };
  if (!Array.isArray(record.tasks) || record.tasks.length === 0) return false;
  const first = record.tasks[0] as { id?: unknown; priority?: unknown } | undefined;
  return Boolean(first?.id) && Boolean(first?.priority);
}

function addCliPrdCandidate(files: Array<{ path: string; mtime: number }>, file: string) {
  try {
    if (!existsSync(file)) return;
    const stat = statSync(file);
    if (!stat.isFile()) return;
    files.push({ path: file, mtime: stat.mtimeMs });
  } catch {
    // Ignore disappearing files during discovery.
  }
}

function addJsonPrdCandidatesFromDir(files: Array<{ path: string; mtime: number }>, dir: string) {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json") || file === "package.json" || file === "tsconfig.json" || file.startsWith("retry-")) {
      continue;
    }
    addCliPrdCandidate(files, join(dir, file));
  }
}

function addDemandPrdCandidates(files: Array<{ path: string; mtime: number }>, demandDir: string) {
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

function lifecyclePrdCandidates(report: Record<string, unknown> = {}): string[] {
  const nested = (report.report || {}) as Record<string, unknown>;
  const artifacts = [
    ...(Array.isArray(report.artifacts) ? report.artifacts : []),
    ...(Array.isArray(nested.artifacts) ? nested.artifacts : []),
  ].filter((a): a is string => typeof a === "string");
  return [
    report.prd_path,
    report.prdPath,
    nested.prd_path,
    nested.prdPath,
    ...artifacts,
  ].filter((v): v is string => Boolean(v));
}

function existingCliPrdCandidate(projectRoot: string, value: unknown): string {
  const raw = cleanCliText(value);
  if (!raw || !raw.endsWith(".json")) return "";
  const file = isAbsolute(raw) ? resolve(raw) : resolve(projectRoot, raw);
  if (!existsSync(file)) return "";
  return isRunnablePrdJson(readJsonMaybe(file)) ? file : "";
}

export function findLatestPrd(yoloRoot: string = defaultYoloRoot): string | null {
  try {
    const files: Array<{ path: string; mtime: number }> = [];
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

export function inferDefaultCliPrdPath(input: Record<string, unknown> = {}, options: Record<string, unknown> = {}): string {
  const rootFromArgs = [input.projectRoot, input.project_root, options.projectRoot, options.project_root, input.cwd, options.cwd]
    .find((v): v is string => typeof v === "string");
  const projectRoot = resolve(rootFromArgs || process.cwd());
  const stateFromArgs = [input.stateRoot, input.state_root, options.stateRoot, options.state_root]
    .find((v): v is string => typeof v === "string");
  const stateRoot = resolve(stateFromArgs || join(projectRoot, ".yolo"));
  const latest = findLatestPrd(stateRoot);
  if (latest) return latest;

  for (const name of ["prd.json", "check-report.json", "run-report.json"]) {
    const report = readJsonMaybe(join(stateRoot, "lifecycle", name));
    if (!report) continue;
    if (isRunnablePrdJson(report)) return join(stateRoot, "lifecycle", name);
    for (const candidate of lifecyclePrdCandidates(report as Record<string, unknown>)) {
      const file = existingCliPrdCandidate(projectRoot, candidate);
      if (file) return file;
    }
  }

  return "";
}
