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
} as const;

type PathKey = keyof typeof PATH_KEYS;

interface ResolvePrdPathOptions {
  cwd?: string;
  projectRoot?: string;
  project_root?: string;
}

const DEFAULT_YOLO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function ensureCanonicalDirs(yoloRoot: string = DEFAULT_YOLO_ROOT): void {
  for (const dir of CANONICAL_DIRS) {
    mkdirSync(resolve(yoloRoot, dir), { recursive: true });
  }
}

export function yoloPath(key: PathKey | (string & {}), yoloRoot: string = DEFAULT_YOLO_ROOT): string {
  const mapped = PATH_KEYS[key as PathKey] || key;
  return resolve(yoloRoot, mapped);
}

export function prdSearchDirs(yoloRoot: string = DEFAULT_YOLO_ROOT): string[] {
  return [
    resolve(yoloRoot, "data/prd/current"),
    resolve(yoloRoot, "data/prd/archive"),
    resolve(yoloRoot, "data"),
  ];
}

export function resolvePrdPath(
  input: unknown,
  yoloRoot: string = DEFAULT_YOLO_ROOT,
  options: ResolvePrdPathOptions = {},
): string | null {
  if (!input) return null;

  const raw = String(input);
  if (isAbsolute(raw)) return resolve(raw);

  const cwdCandidate = resolve(options.cwd || options.projectRoot || options.project_root || process.cwd(), raw);
  if (existsSync(cwdCandidate)) return cwdCandidate;

  const yoloCandidate = resolve(yoloRoot, raw);
  if (existsSync(yoloCandidate)) return yoloCandidate;

  const name = raw.split(/[\\/]/).pop() as string;
  for (const dir of prdSearchDirs(yoloRoot)) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }

  return yoloCandidate;
}
