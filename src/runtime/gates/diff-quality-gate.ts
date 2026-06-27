// diff-quality-gate.js — keep provider patches proportional to task complexity

import { execFileSync } from "node:child_process";
import { classifyTaskExecution } from "../task-loop/router.js";

type DiffTaskTarget = string | { file?: string; path?: string };
type DiffTaskLike = {
  scope?: { targets?: DiffTaskTarget | DiffTaskTarget[] };
  quality_budget?: {
    max_files?: number;
    max_added_lines?: number;
    max_removed_lines?: number;
    max_total_lines?: number;
  };
  [key: string]: unknown;
};

type NumstatEntry = { file: string; added: number; removed: number };

type DiffQualityFailure = { code: string; detail: string };

function errorMessage(error: unknown): string {
  return (error as { message?: string } | null | undefined)?.message || String(error || "unknown error");
}

function execGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function targetFiles(task: DiffTaskLike = Object()): string[] {
  const targets = task.scope?.targets;
  const list: DiffTaskTarget[] = Array.isArray(targets) ? targets : targets ? [targets] : [];
  return list
    .map((target) => (typeof target === "string" ? target : target?.file))
    .filter((file): file is string => Boolean(file));
}

function mergeNumstat(unstagedOutput: string, stagedOutput: string): NumstatEntry[] {
  const map = new Map<string, NumstatEntry>();
  for (const line of [...unstagedOutput.split("\n"), ...stagedOutput.split("\n")].filter(Boolean)) {
    const [addedRaw, removedRaw, file] = line.split("\t");
    const added = addedRaw === "-" ? 0 : Number(addedRaw) || 0;
    const removed = removedRaw === "-" ? 0 : Number(removedRaw) || 0;
    const existing = map.get(file) || { file, added: 0, removed: 0 };
    map.set(file, { file, added: existing.added + added, removed: existing.removed + removed });
  }
  return [...map.values()];
}

function parseNumstat(output: string): NumstatEntry[] {
  return output.split("\n").filter(Boolean).map((line) => {
    const [addedRaw, removedRaw, file] = line.split("\t");
    return {
      file,
      added: addedRaw === "-" ? 0 : Number(addedRaw) || 0,
      removed: removedRaw === "-" ? 0 : Number(removedRaw) || 0,
    };
  });
}

function changedFiles(cwd: string): string[] {
  const unstaged = execGit(cwd, ["diff", "--name-only"]).split("\n").filter(Boolean);
  const staged = execGit(cwd, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  const untracked = execGit(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  return [...new Set([...staged, ...unstaged, ...untracked])];
}

export function validateDiffQuality(task: DiffTaskLike = Object(), options: { cwd?: string } = Object()) {
  const cwd = options.cwd || process.cwd();
  const route = classifyTaskExecution(task);
  if (route.quality_profile !== "single_line_mechanical") {
    return {
      status: "pass",
      blocks_execution: false,
      skipped: true,
      route,
      summary: `quality gate skipped for ${route.quality_profile}`,
      failures: [],
    };
  }

  const targets = targetFiles(task);
  let numstat: NumstatEntry[];
  let changed: string[];
  let untracked: string[];
  try {
    numstat = mergeNumstat(
      execGit(cwd, ["diff", "--numstat", "--", ...targets]),
      execGit(cwd, ["diff", "--cached", "--numstat", "--", ...targets]),
    );
    changed = changedFiles(cwd).filter((file) => targets.includes(file));
    untracked = execGit(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...targets])
      .split("\n")
      .filter(Boolean);
  } catch (gitError) {
    return {
      status: "fail",
      blocks_execution: true,
      route,
      failures: [
        {
          code: "DIFF_QUALITY_GIT_UNAVAILABLE",
          detail: `无法确定 diff（git 失败）: ${errorMessage(gitError)}`,
        },
      ],
      recovery_hint: "diff-quality-gate 依赖 git 探测变更范围，git 不可用时拒绝放行。",
    };
  }

  const added = numstat.reduce((sum, item) => sum + item.added, 0);
  const removed = numstat.reduce((sum, item) => sum + item.removed, 0);
  const total = added + removed;
  const budget = {
    max_files: task.quality_budget?.max_files ?? 1,
    max_added_lines: task.quality_budget?.max_added_lines ?? 8,
    max_removed_lines: task.quality_budget?.max_removed_lines ?? 8,
    max_total_lines: task.quality_budget?.max_total_lines ?? 20,
  };

  const failures: DiffQualityFailure[] = [];
  if (changed.length > budget.max_files) {
    failures.push({
      code: "TOO_MANY_FILES_FOR_MECHANICAL_FIX",
      detail: `changed files ${changed.length} > ${budget.max_files}: ${changed.join(", ")}`,
    });
  }
  if (untracked.length > 0) {
    failures.push({
      code: "NEW_FILES_FOR_MECHANICAL_FIX",
      detail: `mechanical single-line fixes cannot create files: ${untracked.join(", ")}`,
    });
  }
  if (added > budget.max_added_lines || removed > budget.max_removed_lines || total > budget.max_total_lines) {
    failures.push({
      code: "DIFF_TOO_LARGE_FOR_MECHANICAL_FIX",
      detail: `diff +${added}/-${removed} total ${total}; budget +${budget.max_added_lines}/-${budget.max_removed_lines} total ${budget.max_total_lines}`,
    });
  }

  return {
    status: failures.length > 0 ? "fail" : "pass",
    blocks_execution: failures.length > 0,
    route,
    budget,
    metrics: { files: changed.length, added, removed, total, changed_files: changed },
    failures,
    recovery_hint: failures.length > 0
      ? "这是机械小修任务。不要重写 mock/重构结构/新增文件；只做最小局部替换，让目标 post_conditions 通过。"
      : "diff size is proportional to task complexity",
  };
}
