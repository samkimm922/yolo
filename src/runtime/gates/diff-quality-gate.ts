// diff-quality-gate.js — keep provider patches proportional to task complexity

import { execFileSync } from "node:child_process";
import { classifyTaskExecution } from "../task-loop/router.js";

function execGit(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10000,
  }).trim();
}

function targetFiles(task = Object()) {
  return (task.scope?.targets || []).map((target) => target.file).filter(Boolean);
}

function mergeNumstat(unstagedOutput, stagedOutput) {
  const map = new Map();
  for (const line of [...unstagedOutput.split("\n"), ...stagedOutput.split("\n")].filter(Boolean)) {
    const [addedRaw, removedRaw, file] = line.split("\t");
    const added = addedRaw === "-" ? 0 : Number(addedRaw) || 0;
    const removed = removedRaw === "-" ? 0 : Number(removedRaw) || 0;
    const existing = map.get(file) || { file, added: 0, removed: 0 };
    map.set(file, { file, added: existing.added + added, removed: existing.removed + removed });
  }
  return [...map.values()];
}

function parseNumstat(output) {
  return output.split("\n").filter(Boolean).map((line) => {
    const [addedRaw, removedRaw, file] = line.split("\t");
    return {
      file,
      added: addedRaw === "-" ? 0 : Number(addedRaw) || 0,
      removed: removedRaw === "-" ? 0 : Number(removedRaw) || 0,
    };
  });
}

function changedFiles(cwd) {
  const unstaged = execGit(cwd, ["diff", "--name-only"]).split("\n").filter(Boolean);
  const staged = execGit(cwd, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  const untracked = execGit(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  return [...new Set([...staged, ...unstaged, ...untracked])];
}

export function validateDiffQuality(task = Object(), options = Object()) {
  const cwd = options.cwd || process.cwd();
  const route = classifyTaskExecution(task);
  // M2: the gate previously SKIPPED for any non-single_line_mechanical profile
  // (allowlist polarity inverted). It now runs for ALL profiles, but with
  // profile-calibrated budgets: mechanical fixes stay tight (1 file/8 lines),
  // while larger profiles (structural_refactor, default, deterministic_recipe)
  // get proportionally looser defaults. A task can always override via
  // task.quality_budget. New-file detection still applies everywhere (a fix
  // should not create files regardless of profile).
  const targets = targetFiles(task);
  let numstat;
  let changed;
  let untracked;
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
          detail: `无法确定 diff（git 失败）: ${gitError?.message || String(gitError)}`,
        },
      ],
      recovery_hint: "diff-quality-gate 依赖 git 探测变更范围，git 不可用时拒绝放行。",
    };
  }

  const added = numstat.reduce((sum, item) => sum + item.added, 0);
  const removed = numstat.reduce((sum, item) => sum + item.removed, 0);
  const total = added + removed;
  // M2: profile-calibrated default budgets. Mechanical fixes stay tight; larger
  // profiles get proportionally looser defaults. A task-level quality_budget
  // always overrides these.
  const PROFILE_BUDGETS: Record<string, { max_files: number; max_added_lines: number; max_removed_lines: number; max_total_lines: number }> = {
    single_line_mechanical: { max_files: 1, max_added_lines: 8, max_removed_lines: 8, max_total_lines: 20 },
    deterministic_check: { max_files: 3, max_added_lines: 40, max_removed_lines: 40, max_total_lines: 80 },
    deterministic_recipe: { max_files: 4, max_added_lines: 80, max_removed_lines: 80, max_total_lines: 160 },
    structural_refactor: { max_files: 8, max_added_lines: 200, max_removed_lines: 200, max_total_lines: 400 },
    default: { max_files: 4, max_added_lines: 60, max_removed_lines: 60, max_total_lines: 120 },
  };
  const profileDefault = PROFILE_BUDGETS[route.quality_profile] || PROFILE_BUDGETS.default;
  const budget = {
    max_files: task.quality_budget?.max_files ?? profileDefault.max_files,
    max_added_lines: task.quality_budget?.max_added_lines ?? profileDefault.max_added_lines,
    max_removed_lines: task.quality_budget?.max_removed_lines ?? profileDefault.max_removed_lines,
    max_total_lines: task.quality_budget?.max_total_lines ?? profileDefault.max_total_lines,
  };

  const failures = [];
  if (changed.length > budget.max_files) {
    failures.push({
      code: "TOO_MANY_FILES_FOR_MECHANICAL_FIX",
      detail: `changed files ${changed.length} > ${budget.max_files}: ${changed.join(", ")}`,
    });
  }
  // M2: new-file detection. A task that explicitly opts in via
  // scope.allow_new_files (e.g. a fixture/marker task that legitimately creates
  // a new source file) is allowed to create files; otherwise new files flag.
  const allowNewFiles = task?.scope?.allow_new_files === true || task?.scope?.allowNewFiles === true;
  if (untracked.length > 0 && !allowNewFiles) {
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
