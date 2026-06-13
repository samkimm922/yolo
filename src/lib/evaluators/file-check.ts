// evaluators/file-check.js — file_exists / file_not_exists / files_modified_max / file_lines_max / evalNoFileOverMaxLines

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

export function evalFileExists(params, _taskScope, ROOT) {
  const file = params.file || params.path;
  if (!file) return { passed: false, detail: "缺少 file/path 参数" };

  const absPath = resolve(ROOT, file);
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

  const absPath = resolve(ROOT, file);
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

function isBusinessDiffFile(file) {
  if (!file || file.includes("node_modules") || file.startsWith("dist")) return false;
  if (file.startsWith(".yolo/")) return false;
  if (file.startsWith("scripts/yolo/")) return false;
  if (file.startsWith("docs/")) return false;
  if (!file.includes("/") && /\.md$/i.test(file)) return false;
  if (file.startsWith("src/")) return true;
  if (file.startsWith("cloudfunctions/")) return true;
  if (file.startsWith("tests/")) return true;
  if (file.startsWith("__tests__/")) return true;
  if (file.includes("/__tests__/")) return true;
  return false;
}

function isInTargetScope(file, targetFiles = []) {
  if (targetFiles.length === 0) return true;
  return targetFiles.some((target) => file === target || file.startsWith(target.endsWith("/") ? target : `${target}/`));
}

export function evalFilesModifiedMax(params, taskScope, ROOT, exec) {
  const maxFiles = params.max ?? 5;
  const targetFiles = (taskScope?.targets || []).map((t) => t.file).filter(Boolean);
  const diff = exec("git diff --name-only");
  if (!diff.ok) {
    return {
      passed: false,
      status: "indeterminate",
      detail: `无法获取 diff，无法验证修改文件数（限制 ${maxFiles}）`,
      target_files: targetFiles,
      out_of_scope_files: [],
    };
  }

  const files = splitGitFileList(diff.out);

  const untracked = exec("git ls-files --others --exclude-standard");
  if (!untracked.ok) {
    return {
      passed: false,
      status: "indeterminate",
      detail: `无法获取未跟踪文件列表，无法验证修改文件数（限制 ${maxFiles}）`,
      files,
      target_files: targetFiles,
      out_of_scope_files: [],
    };
  }
  const untrackedFiles = splitGitFileList(untracked.out);

  const modifiedFiles = [...new Set([...files, ...untrackedFiles])].filter(isBusinessDiffFile);
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
    const absPath = resolve(ROOT, file);
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
