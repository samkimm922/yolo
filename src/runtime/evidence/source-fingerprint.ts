// Source fingerprint: stable, fast sha256 map over a project's tracked source
// files. Captured at acceptance-freeze and re-checked at ship time so a
// mutation between acceptance and delivery blocks the ship gate (CR5 part b).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { sha256File } from "./artifact-integrity.js";

// Deterministic, narrow allow-list of source extensions. Kept deliberately
// small: this is a *source* fingerprint, not a full repo snapshot.
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py",
  ".go", ".rs", ".java", ".kt", ".rb", ".php",
  ".vue", ".svelte",
]);

// Path fragments that must never be hashed — they are build output,
// dependencies, or lifecycle state, not delivered source.
const EXCLUDED_PATH_FRAGMENTS = [
  "node_modules/",
  "node_modules\\",
  "dist/",
  "dist\\",
  "build/",
  "build\\",
  ".next/",
  ".next\\",
  ".yolo/",
  ".yolo\\",
  ".git/",
  ".git\\",
  "coverage/",
  "coverage\\",
  ".cache/",
  ".cache\\",
];

function hasSourceExtension(relPath: string): boolean {
  const dot = relPath.lastIndexOf(".");
  if (dot < 0) return false;
  return SOURCE_EXTENSIONS.has(relPath.slice(dot).toLowerCase());
}

function isExcluded(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return EXCLUDED_PATH_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Resolve the source-file set (relative paths) from `git ls-files` filtered to
 * source extensions. Returns an empty array when git is unavailable or the
 * project is not a repo (caller falls back to the acceptance artifacts list).
 * Never throws: this runs inside the delivery gate.
 */
export function gitTrackedSourceFiles(projectRoot: string): string[] {
  try {
    const output = execFileSync("git", ["ls-files"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(normalizeRel)
      .filter((rel) => hasSourceExtension(rel) && !isExcluded(rel))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Compute a source fingerprint: a stable `{ relativeSourcePath: sha256 }` map.
 * Source set resolution order:
 *   1. explicit `files` (relative paths) if provided;
 *   2. git-tracked source files under `projectRoot`;
 *   3. empty map if neither is available (deterministic, fail-open on set, but
 *      the ship re-check still compares against whatever was recorded).
 *
 * Missing files are silently skipped: a disappearing file is detected at
 * compare time via `compareSourceFingerprint` rather than corrupting the
 * capture. The returned object is insertion-sorted by relative path.
 */
export function computeSourceFingerprint(
  projectRoot: string,
  files?: string[],
): { [relPath: string]: string } {
  const resolvedRoot = resolve(projectRoot);
  const relFiles = files && files.length > 0
    ? [...new Set(files.map(normalizeRel).filter(Boolean))].sort((a, b) => a.localeCompare(b))
    : gitTrackedSourceFiles(resolvedRoot);
  const fingerprint: { [relPath: string]: string } = {};
  for (const rel of relFiles) {
    const abs = resolve(resolvedRoot, rel);
    if (!existsSync(abs)) continue;
    try {
      fingerprint[rel] = sha256File(abs);
    } catch {
      // Unreadable file: skip at capture; absence is caught at compare time.
    }
  }
  return fingerprint;
}

export interface SourceFingerprintCompare {
  /** true when the recorded fingerprint matches the current source on disk. */
  ok: boolean;
  /** relative paths whose sha256 changed between acceptance and now. */
  mismatched: string[];
  /** relative paths recorded at acceptance that no longer exist. */
  missing: string[];
}

/**
 * Re-check a recorded `source_fingerprint` against the current state of the
 * project source on disk. A changed hash OR a disappeared file makes this
 * fail-closed (`ok = false`). New files added since acceptance do not, by
 * themselves, block: the recorded fingerprint is the freeze contract.
 */
export function compareSourceFingerprint(
  expected: { [relPath: string]: string },
  projectRoot: string,
): SourceFingerprintCompare {
  const resolvedRoot = resolve(projectRoot);
  const mismatched: string[] = [];
  const missing: string[] = [];
  const relPaths = Object.keys(expected || {}).sort((a, b) => a.localeCompare(b));
  for (const rel of relPaths) {
    const expectedDigest = String(expected[rel] || "");
    const abs = resolve(resolvedRoot, rel);
    if (!existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    let actual = "";
    try {
      actual = sha256File(abs);
    } catch {
      missing.push(rel);
      continue;
    }
    if (actual !== expectedDigest) {
      mismatched.push(rel);
    }
  }
  return {
    ok: mismatched.length === 0 && missing.length === 0,
    mismatched,
    missing,
  };
}
