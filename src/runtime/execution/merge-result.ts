import { execFileSync as defaultExecFileSync } from "node:child_process";

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
} = {}) {
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
  } catch {
    return { added: 0, removed: 0 };
  }
}

export function buildScopeTargetCoverage(scopeTargets = [], changedFiles = []) {
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
  diffStats = {},
  businessFiles = [],
  metadataFiles = [],
  outOfScope = [],
  scopeTargets = [],
  now = Date.now,
  nowIso = () => new Date().toISOString(),
} = {}) {
  const coverage = buildScopeTargetCoverage(scopeTargets, [...businessFiles, ...metadataFiles]);
  return {
    id: taskId,
    timestamp: nowIso(),
    duration_sec: ((now() - startedAtMs) / 1000).toFixed(1),
    diff_lines_added: diffStats.added || 0,
    diff_lines_removed: diffStats.removed || 0,
    files_changed_total: businessFiles.length + metadataFiles.length,
    files_changed_business: businessFiles.length,
    files_changed_metadata: metadataFiles.length,
    ...coverage,
    out_of_scope_files: outOfScope,
  };
}
