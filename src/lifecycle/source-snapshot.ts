// Source-snapshot + worktree drift detection (BUG-C2).
//
// When `yolo check` writes its report, it also stamps a snapshot of the
// working-tree signature. On the next check/status, if the signature
// changed, the lifecycle guard reports WORKTREE_DIVERGED — the state
// machine no longer trusts its own "clean/blocked" verdict when source has
// been edited out-of-band.
//
// Git projects: signature = sha256("git status --porcelain" output). Fast
// and captures every working-tree mutation. Non-git: walk source files and
// sha256 their content digests.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveLifecycleStateRoot, lifecycleDir } from "./state.js";

export const SOURCE_SNAPSHOT_FILE = "source-snapshot.json";
export const SOURCE_SNAPSHOT_SCHEMA = "yolo.lifecycle.source_snapshot.v1";

const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "coverage",
  ".next", ".cache", ".turbo", ".parcel-cache", "out",
  ".yolo", ".claude", ".codex", ".agents",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function gitHead(projectRoot) {
  const run = spawnSync("git", ["-C", projectRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (run.status !== 0 || !run.stdout) return null;
  return clean(run.stdout);
}

function gitStatusPorcelain(projectRoot) {
  const run = spawnSync("git", ["-C", projectRoot, "status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  if (run.status !== 0 || run.stdout == null) return null;
  // Filter out harness/state/config dirs so writing lifecycle artifacts
  // (source-snapshot.json itself, check-report.json, etc.) does not cause
  // instant false drift. Only project source mutations should move the
  // signature.
  return run.stdout
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      // Porcelain format: "XY path" or "XY \"quoted path\"". Path starts at col 3.
      const path = line.slice(3).replace(/^"(.*)"$/, "$1").replace(/\s+->\s.*$/, "");
      const firstSegment = path.split("/")[0];
      return !EXCLUDED_DIRS.has(firstSegment);
    })
    .join("\n");
}

function isGitProject(projectRoot) {
  const run = spawnSync("git", ["-C", projectRoot, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5000,
  });
  return run.status === 0 && clean(run.stdout) === "true";
}

function walkSourceFiles(root, dir = root, acc = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(root, path, acc);
    else acc.push(path);
  }
  return acc;
}

function fileDigest(path) {
  try {
    const content = readFileSync(path);
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return "unreadable";
  }
}

function nonGitSignature(projectRoot) {
  const files = walkSourceFiles(projectRoot);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(fileDigest(file));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function computeWorktreeSignature(projectRoot) {
  const root = resolve(projectRoot);
  if (isGitProject(root)) {
    const porcelain = gitStatusPorcelain(root);
    if (porcelain != null) {
      return {
        method: "git_porcelain",
        git_head: gitHead(root),
        signature: createHash("sha256").update(porcelain).digest("hex"),
      };
    }
  }
  return {
    method: "walk",
    git_head: null,
    signature: nonGitSignature(root),
  };
}

export function sourceSnapshotPath(options = Object()) {
  return join(lifecycleDir(options), SOURCE_SNAPSHOT_FILE);
}

export function writeSourceSnapshot(options = Object()) {
  const projectRoot = resolve(options.projectRoot || options.project_root || options.cwd || process.cwd());
  const stateRoot = resolveLifecycleStateRoot({ ...options, projectRoot });
  const path = sourceSnapshotPath({ projectRoot, stateRoot });
  const signature = computeWorktreeSignature(projectRoot);
  const payload = {
    schema_version: "1.0",
    schema: SOURCE_SNAPSHOT_SCHEMA,
    captured_at: clean(options.now) || new Date().toISOString(),
    project_root: projectRoot,
    ...signature,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { path, payload };
}

export function readSourceSnapshot(options = Object()) {
  const path = sourceSnapshotPath(options);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export interface WorktreeDriftResult {
  has_drift: boolean;
  reason: string | null;
}

// Compares the current worktree signature to the stored snapshot.
// Drift = signatures differ (method-agnostic: any working-tree change).
export function inspectWorktreeDrift(options = Object()): WorktreeDriftResult {
  const projectRoot = resolve(options.projectRoot || options.project_root || options.cwd || process.cwd());
  const snapshot = readSourceSnapshot({ ...options, projectRoot });
  if (!snapshot) {
    return { has_drift: false, reason: "no_snapshot" };
  }
  const current = computeWorktreeSignature(projectRoot);
  if (current.signature === snapshot.signature) {
    return { has_drift: false, reason: null };
  }
  return {
    has_drift: true,
    reason: `working tree changed since last check snapshot (snapshot method: ${snapshot.method}, captured_at: ${snapshot.captured_at || "unknown"})`,
  };
}
