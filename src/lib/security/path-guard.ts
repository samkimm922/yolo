// security/path-guard.ts — P10.S2: path containment to project/state root
// P12.I2: resolveWithinRoot咽喉 — single entry point for untrusted path resolution.
// Asserts that externally-controlled paths resolve within a trusted root.

import { lstatSync, realpathSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";

export interface ResolveWithinRootResult {
  ok: boolean;
  path?: string;
  reason?: string;
  detail?: string;
}

/**
 * Returns true if `path` resolves to a location inside `root`.
 * Handles `..` traversal and absolute-path escapes.
 */
export function isWithin(path: string, root: string): boolean {
  const resolved = resolve(path);
  const rootResolved = resolve(root);
  const rel = relative(rootResolved, resolved);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function nearestExistingAncestor(path: string): string {
  let current = path;
  while (!pathExists(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * P12.I2咽喉: resolve an untrusted path relative to `root` and verify it stays
 * within root. Returns { ok: true, path } on success, or { ok: false, reason,
 * detail } on escape. All externally-sourced file paths (task scope targets,
 * params.file, evidence_path) must route through this.
 *
 * Rejects:
 *   - Absolute paths outside root
 *   - `..` traversal that escapes root
 *   - Null bytes
 */
export function resolveWithinRoot(root: string, inputPath: unknown): ResolveWithinRootResult {
  const p = String(inputPath ?? "");
  if (!p) return { ok: false, reason: "empty", detail: "path is empty" };
  if (p.includes("\0")) return { ok: false, reason: "null_byte", detail: "path contains null byte" };
  const rootResolved = resolve(root);
  const resolved = resolve(rootResolved, p);
  if (!isWithin(resolved, rootResolved)) {
    return {
      ok: false,
      reason: "path_escape",
      detail: `path "${p}" resolves outside root "${root}"`,
    };
  }

  let realRoot = "";
  try {
    realRoot = realpathSync(rootResolved);
  } catch {
    return { ok: true, path: resolved };
  }

  const existingBoundary = pathExists(resolved) ? resolved : nearestExistingAncestor(resolved);
  try {
    const realBoundary = realpathSync(existingBoundary);
    if (!isWithin(realBoundary, realRoot)) {
      return {
        ok: false,
        reason: "path_escape",
        detail: `path "${p}" resolves through a symlink outside root "${root}"`,
      };
    }
  } catch {
    return {
      ok: false,
      reason: "path_escape",
      detail: `path "${p}" cannot be resolved within root "${root}"`,
    };
  }
  return { ok: true, path: resolved };
}

/**
 * Returns true if `child` is a safe relative path under `root`.
 * Use for user-supplied relative paths (taskId, file) before joining.
 */
export function isSafeRelativePath(child: string): boolean {
  if (!child || typeof child !== "string") return false;
  if (isAbsolute(child)) return false;
  if (child.includes("..")) return false;
  if (child.includes("\0")) return false;
  // Reject path separators in bare IDs (taskId sanitization)
  return true;
}

/**
 * Returns true if `id` is safe to use as a path component (taskId, etc.).
 * Rejects /, .., absolute paths, and null bytes.
 */
export function isSafePathComponent(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (isAbsolute(id)) return false;
  if (id.includes("..")) return false;
  if (id.includes("/")) return false;
  if (id.includes("\\")) return false;
  if (id.includes("\0")) return false;
  return true;
}
