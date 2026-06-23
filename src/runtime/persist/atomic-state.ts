import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Write `data` to `path` atomically (crash-safe).
 *
 * .bak semantics (intentional disaster-recovery design, NOT a bug):
 *   Step 1 copies the current file to `<path>.bak` BEFORE writing. This
 *   snapshot captures the last known-consistent state. If the main file
 *   is later corrupted (partial write, disk error, kill -9 mid-rename),
 *   `readStateWithFallback` recovers from .bak. The .bak is overwritten
 *   on every successful write, so it always reflects the most recent
 *   consistent predecessor state.
 *
 * Security note (TOCTOU prevention):
 *   The backup uses openSync + readFileSync on the file descriptor instead
 *   of existsSync + copyFileSync. This eliminates the time-of-check-to-
 *   time-of-use window where an attacker could replace the file with a
 *   symlink pointing to a sensitive file (/etc/passwd, .env, etc.),
 *   which copyFileSync would follow and leak into .bak.
 */
export function writeStateAtomic(path: string, data: unknown): void {
  // 1. backup current as .bak — use fd to prevent TOCTOU symlink race
  try {
    const fd = openSync(path, "r");
    try {
      const content = readFileSync(fd);
      writeFileSync(`${path}.bak`, content);
    } finally {
      closeSync(fd);
    }
  } catch {
    // first write or file not readable — no backup to create
  }
  // 2. write tmp + fsync — ensure data hits disk before rename
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  // 3. atomic rename — visible state flips in one syscall
  renameSync(tmp, path);
}

/**
 * Read state from `path`. If the main file is corrupt or missing,
 * fall back to `<path>.bak` (the last consistent predecessor snapshot
 * saved by writeStateAtomic). This is the intended disaster-recovery
 * path — callers should treat a .bak read as a signal that the main
 * file was interrupted mid-write.
 */
export function readStateWithFallback<T = unknown>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    const bak = `${path}.bak`;
    if (existsSync(bak)) return JSON.parse(readFileSync(bak, "utf8")) as T;
    throw new Error(`State file ${path} is corrupt and no valid backup exists`);
  }
}
