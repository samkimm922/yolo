import { execFileSync as defaultExecFileSync } from "node:child_process";

export type WorktreeDiffStats =
  | { added: number; removed: number }
  | { added: null; removed: null; error: string };

export function parseGitNumstat(output = "") {
  let added = 0;
  let removed = 0;
  for (const line of String(output).split("\n").filter(Boolean)) {
    const [rawAdded, rawRemoved] = line.split("\t");
    if (rawAdded !== "-") added += Number(rawAdded) || 0;
    if (rawRemoved !== "-") removed += Number(rawRemoved) || 0;
  }
  return { added, removed };
}

export function readWorktreeDiffStats({
  wtPath,
  baseRef = null,
  execFileSync = defaultExecFileSync,
} = Object()): WorktreeDiffStats {
  try {
    const committed = baseRef
      ? execFileSync("git", ["-C", wtPath, "diff", "--numstat", baseRef, "HEAD"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()
      : "";
    const uncommitted = execFileSync("git", ["-C", wtPath, "diff", "--numstat"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return parseGitNumstat([committed, uncommitted].filter(Boolean).join("\n"));
  } catch (error) {
    return {
      added: null,
      removed: null,
      error: `git diff 统计失败: ${(error as { message?: string } | null | undefined)?.message || String(error)}`,
    };
  }
}

export function buildScopeTargetCoverage(scopeTargets: string[] = [], changedFiles: string[] = []) {
  const touched = scopeTargets.filter((target) =>
    changedFiles.some((file) => file === target || file.startsWith(target.endsWith("/") ? target : `${target}/`)),
  );
  return {
    scope_targets_touched: touched,
    scope_targets_missed: scopeTargets.filter((target) => !touched.includes(target)),
  };
}

export function buildTaskExecutionBaseRecord({
  taskId,
  startedAtMs,
  diffStats = Object(),
  businessFiles = [],
  metadataFiles = [],
  outOfScope = [],
  scopeTargets = [],
  now = Date.now,
  nowIso = () => new Date().toISOString(),
} = Object()) {
  const coverage = buildScopeTargetCoverage(scopeTargets, [...businessFiles, ...metadataFiles]);
  const statsFailed = diffStats.added === null || diffStats.removed === null;
  return {
    id: taskId,
    timestamp: nowIso(),
    duration_sec: ((now() - startedAtMs) / 1000).toFixed(1),
    diff_lines_added: statsFailed ? null : (diffStats.added || 0),
    diff_lines_removed: statsFailed ? null : (diffStats.removed || 0),
    files_changed_total: businessFiles.length + metadataFiles.length,
    files_changed_business: businessFiles.length,
    files_changed_metadata: metadataFiles.length,
    ...coverage,
    out_of_scope_files: outOfScope,
    ...(diffStats.error ? { diff_stats_error: diffStats.error } : {}),
  };
}
