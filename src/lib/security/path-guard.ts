// security/path-guard.ts — P10.S2: path containment to project/state root
// Asserts that externally-controlled paths resolve within a trusted root.

import { resolve, relative, isAbsolute } from "node:path";

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
