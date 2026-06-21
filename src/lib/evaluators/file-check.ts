// evaluators/file-check.js — file_exists / file_not_exists / files_modified_max / file_lines_max / evalNoFileOverMaxLines

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveWithinRoot } from "../security/path-guard.js";
import { isBusinessFile } from "../../runtime/execution/change-set.js";

export function evalFileExists(params, _taskScope, ROOT) {
  const file = params.file || params.path;
  if (!file) return { passed: false, detail: "缺少 file/path 参数" };

  const guardResult = resolveWithinRoot(ROOT, file);
  if (!guardResult.ok) {
    return { passed: false, detail: `路径越界，拒绝访问: ${file}` };
  }
  const absPath = guardResult.path;
  const exists = existsSync(absPath) && !statSync(absPath).isDirectory();

  return {
    passed: exists,
    detail: exists ? `${file} 存在` : `${file} 不存在`,
    found: exists ? 1 : 0,
  };
}

export function evalDirExists(params, _taskScope, ROOT) {
  const file = params.file || params.path;
  if (!file) return { passed: false, detail: "缺少 file/path 参数" };

  const guardResult = resolveWithinRoot(ROOT, file);
  if (!guardResult.ok) {
    return { passed: false, detail: `路径越界，拒绝访问: ${file}` };
  }
  const absPath = guardResult.path;
  const exists = existsSync(absPath) && statSync(absPath).isDirectory();

  return {
    passed: exists,
    detail: exists ? `${file} 目录存在` : `${file} 目录不存在`,
    found: exists ? 1 : 0,
  };
}

export function evalFileNotExists(params, taskScope, ROOT) {
  const file = params.file || params.path;
  if (!file) return { passed: false, status: "not_run", detail: "缺少 file/path 参数" };

  const guardResult = resolveWithinRoot(ROOT, file);
  if (!guardResult.ok) {
    return { passed: false, status: "not_run", detail: `路径越界，拒绝访问: ${file}` };
  }
  const result = evalFileExists(params, taskScope, ROOT);
  return {
    passed: !result.passed,
    detail: result.passed ? `${params.file} 已存在（不应存在）` : `${params.file} 不存在`,
    found: result.passed ? 1 : 0,
  };
}

function splitGitFileList(output = "") {
  return String(output || "").split("\n").map((file) => file.trim()).filter(Boolean);
}

function changedFilesFromOptions(options = Object(), taskScope = Object()) {
  const candidates = [
    options.changedFiles,
    options.changed_files,
    taskScope.changedFiles,
    taskScope.changed_files,
  ];
  const files = candidates.find((value) => Array.isArray(value));
  return Array.isArray(files) ? [...new Set(files.map(String).map((file) => file.trim()).filter(Boolean))] : null;
}

function isBusinessDiffFile(file, options = Object()) {
  return isBusinessFile(file, options);
}

function isInTargetScope(file, targetFiles = []) {
  if (targetFiles.length === 0) return true;
  return targetFiles.some((target) => file === target || file.startsWith(target.endsWith("/") ? target : `${target}/`));
}

export function evalFilesModifiedMax(params, taskScope, ROOT, exec, options = Object()) {
  const maxFiles = params.max ?? 5;
  const targetFiles = (taskScope?.targets || []).map((t) => t.file).filter(Boolean);
  const providedChangedFiles = changedFilesFromOptions(options, taskScope);

  let changedFiles = providedChangedFiles;
  if (!changedFiles) {
    const unstagedDiff = exec("git diff --name-only");
    const stagedDiff = exec("git diff --cached --name-only");
    if (!unstagedDiff.ok && !stagedDiff.ok) {
      return {
        passed: false,
        status: "indeterminate",
        detail: `无法获取 diff，无法验证修改文件数（限制 ${maxFiles}）`,
        target_files: targetFiles,
        out_of_scope_files: [],
      };
    }

    const unstagedFiles = splitGitFileList(unstagedDiff.out);
    const stagedFiles = splitGitFileList(stagedDiff.out);

    const untracked = exec("git ls-files --others --exclude-standard");
    if (!untracked.ok) {
      return {
        passed: false,
        status: "indeterminate",
        detail: `无法获取未跟踪文件列表，无法验证修改文件数（限制 ${maxFiles}）`,
        files: [...new Set([...stagedFiles, ...unstagedFiles])],
        target_files: targetFiles,
        out_of_scope_files: [],
      };
    }
    const untrackedFiles = splitGitFileList(untracked.out);
    changedFiles = [...new Set([...stagedFiles, ...unstagedFiles, ...untrackedFiles])];
  }

  const modifiedFiles = changedFiles.filter((file) => isBusinessDiffFile(file, options));
  const outOfScopeFiles = targetFiles.length > 0
    ? modifiedFiles.filter((file) => !isInTargetScope(file, targetFiles))
    : [];
  const total = modifiedFiles.length;
  const scopeDetail = outOfScopeFiles.length > 0
    ? `；越界业务文件: ${outOfScopeFiles.join(", ")}`
    : "";

  if (total > maxFiles) {
    return {
      passed: false,
      detail: `修改了 ${total} 个业务文件（限制 ${maxFiles} 个）${scopeDetail}`,
      found: total,
      files: modifiedFiles,
      target_files: targetFiles,
      out_of_scope_files: outOfScopeFiles,
    };
  }

  return {
    passed: true,
    detail: `修改了 ${total} 个业务文件（限制 ${maxFiles}）${scopeDetail}`,
    found: total,
    files: modifiedFiles,
    target_files: targetFiles,
    out_of_scope_files: outOfScopeFiles,
  };
}

export function evalFileLinesMax(params, taskScope, ROOT) {
  const maxLines = params.max ?? 150;
  const legacyDeltaMax = params.legacy_delta_max ?? params.max_delta_on_legacy ?? 40;
  const targets =
    params.targets || params.files || (params.file ? [params.file] : null) ||
    (taskScope?.targets || []).map((t) => t.file).filter(Boolean);
  if (!targets.length) {
    return {
      passed: false,
      status: "not_run",
      detail: "无目标文件，无法验证文件行数",
    };
  }
  const baselinePath = resolve(ROOT, ".yolo-worktree-baseline.json");
  let baselineLineCounts = Object();
  if (existsSync(baselinePath)) {
    try {
      baselineLineCounts = JSON.parse(readFileSync(baselinePath, "utf8")).line_counts || {};
    } catch {}
  }
  const readBaselineLines = (file) => {
    if (Number.isFinite(baselineLineCounts[file])) return baselineLineCounts[file];
    try {
      const content = execFileSync("git", ["show", `HEAD:${file}`], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return content.split("\n").length;
    } catch {
      return null;
    }
  };

  const violations = [];
  const legacyAllowed = [];
  for (const file of targets) {
    // P12.I2: route untrusted file through resolveWithinRoot咽喉.
    const guardResult = resolveWithinRoot(ROOT, file);
    if (!guardResult.ok) {
      violations.push({ file, escape: true, detail: guardResult.detail });
      continue;
    }
    const absPath = guardResult.path;
    if (!existsSync(absPath)) {
      violations.push({ file, missing: true });
      continue;
    }
    if (statSync(absPath).isDirectory()) continue;
    if (/\.md$/i.test(file)) continue;
    const content = readFileSync(absPath, "utf8");
    const lines = content.split("\n").length;
    if (lines > maxLines) {
      const baselineLines = readBaselineLines(file);
      const delta = Number.isFinite(baselineLines) ? lines - baselineLines : null;
      if (baselineLines > maxLines && delta <= legacyDeltaMax) {
        legacyAllowed.push({ file, lines, baselineLines, delta });
        continue;
      }
      violations.push({ file, lines });
    }
  }

  if (violations.length > 0) {
    return {
      passed: false,
      detail: violations
        .map((v) => v.missing ? `${v.file}: 文件不存在` : `${v.file}: ${v.lines} 行（限制 ${maxLines} 行）`)
        .join("; "),
      violations,
    };
  }

  if (legacyAllowed.length > 0) {
    return {
      passed: true,
      detail: `遗留超长文件未显著恶化: ${legacyAllowed
        .map((v) => `${v.file}: ${v.lines} 行 (baseline ${v.baselineLines}, delta ${v.delta >= 0 ? "+" : ""}${v.delta}, 限制 +${legacyDeltaMax})`)
        .join("; ")}`,
      legacyAllowed,
    };
  }

  return { passed: true, detail: "所有文件行数未超限" };
}

export function evalNoFileOverMaxLines(params, _taskScope, ROOT) {
  const maxLines = params.max ?? 150;
  const violations = [];
  function scanDir(dir) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
          scanDir(full);
        } else if (/.(ts|tsx)$/.test(entry.name)) {
          const content = readFileSync(full, "utf8");
          const lines = content.split("\n").length;
          if (lines > maxLines) violations.push({ file: full.replace(ROOT + "/", ""), lines });
        }
      }
    } catch { /* permission error, skip */ }
  }
  scanDir(join(ROOT, "src"));
  if (violations.length > 0) {
    return { passed: false, detail: violations.map((v) => v.file + ": " + v.lines + " 行").join("; ").slice(0, 200), violations };
  }
  return { passed: true, detail: "所有源文件行数未超限" };
}
