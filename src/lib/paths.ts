import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL_DIRS = [
  "data",
  "data/prd",
  "data/prd/current",
  "data/prd/archive",
  "logs",
  "state",
  "state/archive",
  "state/evidence",
  "state/runtime",
];

const PATH_KEYS = {
  runtime: "state/runtime",
  taskResults: "state/runtime/task-results.jsonl",
  currentRun: "state/current-run.json",
};

const DEFAULT_YOLO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function ensureCanonicalDirs(yoloRoot = DEFAULT_YOLO_ROOT) {
  for (const dir of CANONICAL_DIRS) {
    mkdirSync(resolve(yoloRoot, dir), { recursive: true });
  }
}

export function yoloPath(key, yoloRoot = DEFAULT_YOLO_ROOT) {
  const mapped = PATH_KEYS[key] || key;
  return resolve(yoloRoot, mapped);
}

export function prdSearchDirs(yoloRoot = DEFAULT_YOLO_ROOT) {
  return [
    resolve(yoloRoot, "data/prd/current"),
    resolve(yoloRoot, "data/prd/archive"),
    resolve(yoloRoot, "data"),
  ];
}

export function resolvePrdPath(input, yoloRoot = DEFAULT_YOLO_ROOT, options = {}) {
  if (!input) return null;

  const raw = String(input);
  if (isAbsolute(raw)) return resolve(raw);

  const cwdCandidate = resolve(options.cwd || options.projectRoot || options.project_root || process.cwd(), raw);
  if (existsSync(cwdCandidate)) return cwdCandidate;

  const yoloCandidate = resolve(yoloRoot, raw);
  if (existsSync(yoloCandidate)) return yoloCandidate;

  const name = raw.split(/[\\/]/).pop();
  for (const dir of prdSearchDirs(yoloRoot)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }

  return yoloCandidate;
}
