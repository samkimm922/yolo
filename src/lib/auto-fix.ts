// auto-fix.js — 批量 AUTO_FIX 引擎
// 输入: scannerToTasks() 输出的 AUTO_FIX 任务数组
// 输出: { success, escalatedTasks, stats }

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { execFileSync } from "node:child_process";

// ══════════════════════════════════════════════════════════════════════
// 工具函数
// ══════════════════════════════════════════════════════════════════════

/** 计算从 srcFile 到 targetFile 的 import 路径（不含扩展名） */
function relativeImportPath(srcFile, targetFile, rootDir) {
  const srcAbs = resolve(rootDir, srcFile);
  const tgtAbs = resolve(rootDir, targetFile);
  const srcDir = dirname(srcAbs);
  let rel = relative(srcDir, tgtAbs).replace(/\.(ts|tsx|js|jsx|mjs)$/, "");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

/** 从 COLLECTIONS 对象源码中解析 key → value 映射 */
function parseCollectionsMap(collectionsSrc) {
  const map = new Map(); // value (collection name) → key (CONSTANT name)
  const re = /^\s*([A-Z_][A-Z0-9_]*)\s*:\s*['"]([^'"]+)['"]\s*,?\s*(?:\/\/.*)?$/gm;
  let m;
  while ((m = re.exec(collectionsSrc)) !== null) {
    map.set(m[2], m[1]);
  }
  return map;
}

/**
 * 解析 TSC 错误输出，格式: relative/path.ts(line,col): error TSxxxx: message
 */
function parseTscErrors(stdout, rootDir) {
  const errors = [];
  const lines = stdout.split("\n");
  for (const line of lines) {
    const m = line.match(/^(.+?)\((\d+),\d+\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/);
    if (m) {
      errors.push({
        file: m[1],
        line: parseInt(m[2], 10),
        code: m[4],
        message: m[5].trim(),
      });
    }
  }
  return errors;
}

/** 展平 ESLint JSON 结果为文件级错误列表 */
function flattenEslintErrors(eslintResult, rootDir) {
  const errors = [];
  if (!Array.isArray(eslintResult)) return errors;
  for (const r of eslintResult) {
    const file = r.filePath ? relative(rootDir, r.filePath) : "";
    for (const msg of r.messages || []) {
      errors.push({
        file,
        line: msg.line || 0,
        code: msg.ruleId || "unknown",
        message: msg.message || "",
      });
    }
  }
  return errors;
}

/**
 * 两组错误比较：currentErrors 中存在但 baselineErrors 中不存在的，
 * 且文件路径在 modifiedFiles 中。
 */
function diffNewErrors(baselineErrors, currentErrors, modifiedFiles) {
  const baselineSet = new Set(
    baselineErrors.map(e => `${e.file}:${e.line}:${e.code}`),
  );
  const fileSet = new Set(modifiedFiles);
  return currentErrors.filter(e => {
    if (!fileSet.has(e.file)) return false;
    return !baselineSet.has(`${e.file}:${e.line}:${e.code}`);
  });
}

// ══════════════════════════════════════════════════════════════════════
// 修复器注册表
// ══════════════════════════════════════════════════════════════════════

function getFixer(scannerId) {
  const FIXERS = {
    "debug-console-log": fixConsoleLog,
    "debug-debugger": fixDebugger,
    "raw-collection": fixRawCollection,
    "R6-as-unknown-as": fixSafeR6UnknownAs,
  };
  return FIXERS[scannerId] || null;
}

// ══════════════════════════════════════════════════════════════════════
// 修复器: console.log — 移除 console.log(...) 调用行
// ══════════════════════════════════════════════════════════════════════

function fixConsoleLog(content, findings, filePath, rootDir) {
  if (!findings || findings.length === 0) return { modified: content, changes: 0 };

  const lines = content.split("\n");
  // 自底向上删除，行号不受影响
  const sorted = [...findings]
    .filter(f => f.line > 0 && f.line <= lines.length)
    .sort((a, b) => b.line - a.line);

  let changes = 0;
  for (const f of sorted) {
    const idx = f.line - 1;
    const original = lines[idx];
    if (original === undefined) continue;

    // 删除 console.log(...) — 处理单行调用
    const cleaned = original.replace(/console\.log\s*\([^)]*\)\s*;?/g, "").trimEnd();

    if (cleaned === "") {
      lines.splice(idx, 1);
    } else if (cleaned !== original.trimEnd()) {
      // 保留 console.log 前后的代码
      lines[idx] = original.slice(
        0,
        original.length - (original.trimEnd().length - cleaned.length),
      );
    } else {
      continue;
    }
    changes++;
  }

  return { modified: lines.join("\n"), changes };
}

// ══════════════════════════════════════════════════════════════════════
// 修复器: debugger — 移除 debugger; / debugger 语句
// ══════════════════════════════════════════════════════════════════════

function fixDebugger(content, findings, filePath, rootDir) {
  if (!findings || findings.length === 0) return { modified: content, changes: 0 };

  const lines = content.split("\n");
  const sorted = [...findings]
    .filter(f => f.line > 0 && f.line <= lines.length)
    .sort((a, b) => b.line - a.line);

  let changes = 0;
  for (const f of sorted) {
    const idx = f.line - 1;
    const original = lines[idx];
    if (original === undefined) continue;

    const cleaned = original.replace(/debugger\s*;?/, "").trimEnd();

    if (cleaned === "") {
      lines.splice(idx, 1);
    } else if (cleaned !== original.trimEnd()) {
      lines[idx] = original.slice(
        0,
        original.length - (original.trimEnd().length - cleaned.length),
      );
    } else {
      continue;
    }
    changes++;
  }

  return { modified: lines.join("\n"), changes };
}

// ══════════════════════════════════════════════════════════════════════
// 修复器: R6 测试 mock 双重断言 — 只处理已知安全的 db.collection mockReturnValue
// ══════════════════════════════════════════════════════════════════════

function isTestFile(filePath = "") {
  return filePath.includes("/__tests__/") || /\.(test|spec)\.[tj]sx?$/.test(filePath);
}

function fixSafeR6UnknownAs(content, findings, filePath, rootDir) {
  if (!findings || findings.length === 0) return { modified: content, changes: 0 };
  if (!isTestFile(filePath)) {
    return {
      modified: content,
      changes: 0,
      escalated: findings.map(f => ({ file: f.file, line: f.line, reason: "R6 auto-fix 仅允许测试文件" })),
    };
  }

  const lines = content.split("\n");
  const sorted = [...findings]
    .filter(f => f.line > 0 && f.line <= lines.length)
    .sort((a, b) => b.line - a.line);
  const escalated = [];
  let changes = 0;

  for (const f of sorted) {
    const idx = f.line - 1;
    const original = lines[idx];
    if (original === undefined || !original.includes("as unknown as")) continue;

    const isKnownMockCollectionCast =
      /mockReturnValue\s*\(/.test(original) &&
      /as unknown as\s+WechatMiniprogram\.TypedCollection<unknown>/.test(original) &&
      /(?:const\s+\{\s*db\s*\}\s*=\s*await\s+import\(['"][^'"]*db['"]\)|from\s+['"][^'"]*db['"])/.test(content);

    if (!isKnownMockCollectionCast) {
      escalated.push({
        file: f.file || filePath,
        line: f.line,
        reason: "R6 auto-fix 只支持 db.collection mockReturnValue 的 TypedCollection 双重断言",
      });
      continue;
    }

    const next = original.replace(
      /as unknown as\s+WechatMiniprogram\.TypedCollection<unknown>/,
      "as ReturnType<typeof db.collection>",
    );
    if (next !== original) {
      lines[idx] = next;
      changes++;
    }
  }

  return {
    modified: lines.join("\n"),
    changes,
    escalated: escalated.length > 0 ? escalated : undefined,
  };
}

// ══════════════════════════════════════════════════════════════════════
// 修复器: raw-collection — db.collection('name') → COLLECTIONS.CONSTANT
// ══════════════════════════════════════════════════════════════════════

function fixRawCollection(content, findings, filePath, rootDir) {
  if (!findings || findings.length === 0) return { modified: content, changes: 0 };

  // 1. 查找并解析 COLLECTIONS 常量文件
  const collectionsPaths = [
    resolve(rootDir, "src/services/constants.ts"),
    resolve(rootDir, "src/types/constants.ts"),
    resolve(rootDir, "src/constants.ts"),
  ];

  let collectionsMap = null;
  let collectionsFilePath = null;
  for (const p of collectionsPaths) {
    if (existsSync(p)) {
      try {
        const src = readFileSync(p, "utf8");
        collectionsMap = parseCollectionsMap(src);
        if (collectionsMap.size > 0) {
          collectionsFilePath = p;
          break;
        }
      } catch { /* skip unreadable files */ }
    }
  }

  if (!collectionsMap || collectionsMap.size === 0) {
    return {
      modified: content,
      changes: 0,
      escalated: findings.map(f => ({
        file: f.file,
        line: f.line,
        reason: "COLLECTIONS 常量文件不可用",
      })),
    };
  }

  // 2. 提取每条 finding 中的集合名字符串
  const colNameRe = /db\.collection\s*\(\s*['"]([^'"]+)['"]\s*\)/;
  const changesByLine = new Map(); // line → { oldStr, constName }
  const escalated = [];

  for (const f of findings) {
    const m = (f.match || "").match(colNameRe);
    if (!m) {
      escalated.push({ file: f.file, line: f.line, reason: `无法解析集合名: ${f.match}` });
      continue;
    }
    const colName = m[1];
    const constName = collectionsMap.get(colName);
    if (!constName) {
      escalated.push({
        file: f.file,
        line: f.line,
        reason: `"${colName}" 在 COLLECTIONS 中无匹配常量`,
      });
      continue;
    }
    changesByLine.set(f.line, { oldStr: m[1], constName });
  }

  if (changesByLine.size === 0) {
    return { modified: content, changes: 0, escalated: escalated.length > 0 ? escalated : undefined };
  }

  // 3. 按行号降序执行替换
  const lines = content.split("\n");
  const sortedEntries = [...changesByLine.entries()].sort((a, b) => b[0] - a[0]);
  let changes = 0;

  for (const [lineNum, entry] of sortedEntries) {
    const idx = lineNum - 1;
    if (idx < 0 || idx >= lines.length) {
      escalated.push({ file: filePath, line: lineNum, reason: `行号 ${lineNum} 超出文件范围` });
      continue;
    }

    const original = lines[idx];
    const sq = `'${entry.oldStr}'`;
    const dq = `"${entry.oldStr}"`;
    let newLine = original;
    if (newLine.includes(sq)) {
      newLine = newLine.replace(sq, `COLLECTIONS.${entry.constName}`);
    } else if (newLine.includes(dq)) {
      newLine = newLine.replace(dq, `COLLECTIONS.${entry.constName}`);
    } else {
      continue;
    }

    if (newLine !== original) {
      lines[idx] = newLine;
      changes++;
    }
  }

  // 4. 处理 import: 确保文件顶部有 `import { COLLECTIONS } from '...'`
  if (changes > 0 && collectionsFilePath) {
    const hasImport = /import\s+\{[^}]*\bCOLLECTIONS\b[^}]*\}\s+from\s+['"]/.test(content);
    if (!hasImport) {
      const importPath = relativeImportPath(filePath, collectionsFilePath, rootDir);
      const importStmt = `import { COLLECTIONS } from '${importPath}';`;
      const importRe = /^import\s+/;
      let lastImportIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (importRe.test(lines[i])) lastImportIdx = i;
      }
      if (lastImportIdx >= 0) {
        lines.splice(lastImportIdx + 1, 0, importStmt);
      } else {
        lines.unshift(importStmt);
      }
    }
  }

  return {
    modified: lines.join("\n"),
    changes,
    escalated: escalated.length > 0 ? escalated : undefined,
  };
}

// ══════════════════════════════════════════════════════════════════════
// 单文件修复调度
// ══════════════════════════════════════════════════════════════════════

function applyFixesToFile(filePath, findings, rootDir) {
  const absPath = resolve(rootDir, filePath);
  if (!existsSync(absPath)) {
    return { modified: false, changes: 0, escalated: undefined };
  }

  const content = readFileSync(absPath, "utf8");

  // 按 scanner_id 分组
  const groups = new Map();
  for (const f of findings) {
    const key = f.scanner_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  let current = content;
  let totalChanges = 0;
  const allEscalated = [];

  const sortedKeys = [...groups.keys()].sort();
  for (const scannerId of sortedKeys) {
    const group = groups.get(scannerId);
    const fixer = getFixer(scannerId);
    if (!fixer) {
      allEscalated.push(...group.map(f => ({
        file: f.file,
        line: f.line,
        reason: `无可用修复器: ${scannerId}`,
      })));
      continue;
    }

    try {
      const result = fixer(current, group, filePath, rootDir);
      if (result.modified !== current) {
        current = result.modified;
        totalChanges += result.changes;
      }
      if (result.escalated?.length) {
        allEscalated.push(...result.escalated);
      }
    } catch (err) {
      allEscalated.push(...group.map(f => ({
        file: f.file,
        line: f.line,
        reason: `修复器异常: ${err.message}`,
      })));
    }
  }

  if (totalChanges > 0) {
    writeFileSync(absPath, current, "utf8");
  }

  return {
    modified: totalChanges > 0,
    changes: totalChanges,
    escalated: allEscalated.length > 0 ? allEscalated : undefined,
  };
}

// ══════════════════════════════════════════════════════════════════════
// 校验: 变更后不引入新错误
// ══════════════════════════════════════════════════════════════════════

/**
 * @param {string[]} files - 相对路径数组
 * @param {string} rootDir - 项目根目录绝对路径
 * @param {Function} [_efSync] - 可注入的 execFileSync
 * @returns {Promise<{ passed: boolean, errors: Array }>}
 */
async function validateAutoFix(files, rootDir, _efSync) {
  const efs = _efSync || execFileSync;
  const absFiles = files.map(f => resolve(rootDir, f).replace(/\\/g, "/"));
  const relFiles = files.map(f => f.replace(/\\/g, "/"));

  let baselineTscErrors = [];
  let baselineEslintErrors = [];

  // 1. stash 当前修改（仅针对目标文件），取基线
  try {
    efs("git", ["stash", "push", "-m", "auto-fix-baseline", "--", ...absFiles], {
      cwd: rootDir, encoding: "utf8", timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // 基线 TSC
    try {
      efs("pnpm", ["exec", "tsc", "--noEmit"], {
        cwd: rootDir, encoding: "utf8", timeout: 60000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      baselineTscErrors = parseTscErrors(e.stdout || "", rootDir);
    }

    // 基线 ESLint
    try {
      const out = efs("pnpm", ["exec", "eslint", ...relFiles, "--format", "json"], {
        cwd: rootDir, encoding: "utf8", timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      baselineEslintErrors = flattenEslintErrors(JSON.parse(out.trim() || "[]"), rootDir);
    } catch (e) {
      try {
        baselineEslintErrors = flattenEslintErrors(JSON.parse(e.stdout?.trim() || "[]"), rootDir);
      } catch { /* eslint JSON parse failed — assume no baseline errors */ }
    }

    // 恢复修改
    efs("git", ["stash", "pop"], {
      cwd: rootDir, encoding: "utf8", timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // stash 可能失败（工作区干净、无修改等），尝试清理残留
    try {
      efs("git", ["stash", "pop"], {
        cwd: rootDir, encoding: "utf8", timeout: 15000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { /* no stash to pop */ }
  }

  // 2. 当前状态 TSC
  let currentTscErrors = [];
  try {
    efs("pnpm", ["exec", "tsc", "--noEmit"], {
      cwd: rootDir, encoding: "utf8", timeout: 60000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    currentTscErrors = parseTscErrors(e.stdout || "", rootDir);
  }

  // 3. 当前状态 ESLint
  let currentEslintErrors = [];
  try {
    const out = efs("pnpm", ["exec", "eslint", ...relFiles, "--format", "json"], {
      cwd: rootDir, encoding: "utf8", timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    currentEslintErrors = flattenEslintErrors(JSON.parse(out.trim() || "[]"), rootDir);
  } catch (e) {
    try {
      currentEslintErrors = flattenEslintErrors(JSON.parse(e.stdout?.trim() || "[]"), rootDir);
    } catch { /* eslint JSON parse failed */ }
  }

  // 4. 对比: 仅关注 modified files 中的新增错误
  const newTsc = diffNewErrors(baselineTscErrors, currentTscErrors, relFiles);
  const newEslint = diffNewErrors(baselineEslintErrors, currentEslintErrors, relFiles);

  return {
    passed: newTsc.length === 0 && newEslint.length === 0,
    errors: [
      ...newTsc.map(e => ({ ...e, source: "tsc" })),
      ...newEslint.map(e => ({ ...e, source: "eslint" })),
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════
// ESLint --fix 自动修复
// ══════════════════════════════════════════════════════════════════════

/**
 * @param {object} task - 任务对象（含 scope.targets）
 * @param {string} rootDir - 项目根目录绝对路径
 * @param {Function} [_efSync] - 可注入的 execFileSync
 * @returns {Promise<{ success: boolean, escalatedTasks?: Array }>}
 */
async function handleEslintFix(task, rootDir, _efSync) {
  const efs = _efSync || execFileSync;
  const files = (task.scope?.targets || []).map(t => t.file).filter(Boolean);
  if (files.length === 0) return { success: true };

  try {
    efs("pnpm", ["exec", "eslint", "--fix", ...files], {
      cwd: rootDir, encoding: "utf8", timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    // eslint 在残留不可自动修复的错误时退出非零 — 检查剩余错误
    try {
      const stdout = e.stdout || "";
      const result = JSON.parse(stdout.trim() || "[]");
      const remaining = Array.isArray(result)
        ? result.filter(r => r.errorCount > 0 || r.warningCount > 0)
        : [];
      if (remaining.length > 0) {
        const escalatedTasks = [];
        for (const r of remaining) {
          for (const msg of r.messages || []) {
            escalatedTasks.push({
              file: r.filePath ? r.filePath.replace(rootDir + "/", "") : "",
              scanner_id: `eslint-${msg.ruleId || "unknown"}`,
              severity: msg.severity === 2 ? "HIGH" : "MEDIUM",
              line: msg.line || 0,
              description: msg.message || "eslint error",
              match: (msg.message || "").slice(0, 80),
              fix_type: "CLAUDE_FIX",
            });
          }
        }
        return { success: false, escalatedTasks };
      }
    } catch { /* JSON parse failed — assume clean */ }
  }

  let changedFiles = [];
  try {
    const diff = efs("git", ["diff", "--name-only", "--", ...files], {
      cwd: rootDir, encoding: "utf8", timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    changedFiles = diff ? diff.split("\n").filter(Boolean) : [];
  } catch { /* diff unavailable: keep success but no changed file evidence */ }

  return { success: changedFiles.length > 0, modifiedFiles: changedFiles };
}

// ══════════════════════════════════════════════════════════════════════
// 主入口: applyAutoFixTasks
// ══════════════════════════════════════════════════════════════════════

/**
 * 批量执行 AUTO_FIX 任务，直接修改文件、校验并提交或升级。
 *
 * @param {Array} tasks - scannerToTasks() 输出的 AUTO_FIX 任务数组
 * @param {string} rootDir - 项目根目录绝对路径
 * @param {object} [options={}]
 * @param {Function} [options.commitFn] - async (task, prdPath, modifiedFiles) => { committed }
 * @param {Function} [options.logP] - (scope, level, message) => void
 * @param {string} [options.prdPath] - PRD JSON 文件路径，传给 commitFn
 * @param {Function} [options.execFileSync] - 可注入的子进程执行函数
 * @param {Function} [options.readFileSync] - 可注入的文件读取函数
 * @param {Function} [options.writeFileSync] - 可注入的文件写入函数
 * @param {Function} [options.existsSync] - 可注入的文件存在检查函数
 * @returns {Promise<{ success: boolean, escalatedTasks?: Array, stats: { fixed: number, escalated: number, unchanged: number } }>}
 */
export async function applyAutoFixTasks(tasks, rootDir, options = Object()) {
  const {
    commitFn,
    logP,
    prdPath,
    execFileSync: injectedExec,
    readFileSync: injectedRead,
    writeFileSync: injectedWrite,
    existsSync: injectedExists,
  } = options;

  const efs = injectedExec || execFileSync;
  const rfs = injectedRead || readFileSync;
  const wfs = injectedWrite || writeFileSync;
  const exs = injectedExists || existsSync;

  const stats = { fixed: 0, escalated: 0, unchanged: 0 };
  const allEscalatedTasks = [];
  const allModifiedFiles = [];
  let hasAnyFix = false;

  for (const task of tasks) {
    const scannerId = task.fix_rule;

    // ── ESLint 自动修复（特殊通道） ──
    if (scannerId?.startsWith("eslint-")) {
      const result = await handleEslintFix(task, rootDir, efs);
      if (result.success) {
        stats.fixed++;
        hasAnyFix = true;
        for (const file of result.modifiedFiles || []) allModifiedFiles.push(file);
        if (commitFn && prdPath) {
          try {
            const targets = (result.modifiedFiles?.length ? result.modifiedFiles : (task.scope?.targets || []).map(t => t.file).filter(Boolean));
            await commitFn(task, prdPath, targets);
          } catch (e) {
            if (logP) logP("AUTO_FIX", "commit", `失败: ${e.message}`);
          }
        }
        if (logP) logP("AUTO_FIX", "✅", `${task.id}: eslint --fix 已执行`);
      } else if (result.escalatedTasks?.length) {
        allEscalatedTasks.push(...result.escalatedTasks);
        stats.escalated++;
        if (logP) logP("AUTO_FIX", "⚠️", `${task.id}: eslint --fix 后仍有 ${result.escalatedTasks.length} 个错误，升级为 CLAUDE_FIX`);
      } else {
        const findings = task.fix_findings || [];
        allEscalatedTasks.push(...findings.map(f => ({
          file: f.file,
          scanner_id: f.scanner_id,
          severity: f.severity || "MEDIUM",
          line: f.line,
          description: "eslint --fix 未产生目标文件改动",
          match: f.match?.slice(0, 80) || "",
          fix_type: "CLAUDE_FIX",
        })));
        stats.escalated++;
        if (logP) logP("AUTO_FIX", "⚠️", `${task.id}: eslint --fix 无改动，升级为 CLAUDE_FIX`);
      }
      continue;
    }

    // ── 通用修复器 ──
    const fixer = getFixer(scannerId);
    if (!fixer) {
      const findings = task.fix_findings || [];
      allEscalatedTasks.push(...findings.map(f => ({
        file: f.file,
        scanner_id: f.scanner_id,
        severity: f.severity || "MEDIUM",
        line: f.line,
        description: f.description,
        match: f.match?.slice(0, 80) || "",
        fix_type: "CLAUDE_FIX",
      })));
      stats.escalated++;
      if (logP) logP("AUTO_FIX", "⚠️", `${task.id}: 无可用修复器 (${scannerId})，升级为 CLAUDE_FIX`);
      continue;
    }

    // ── 逐文件修复 ──
    const modifiedFiles = [];
    const escalatedFindings = [];

    for (const target of (task.scope?.targets || [])) {
      const filePath = target.file;
      if (!filePath) continue;

      const absPath = resolve(rootDir, filePath);
      if (!exs(absPath)) {
        if (logP) logP("AUTO_FIX", "⚠️", `文件不存在: ${filePath}`);
        continue;
      }

      try {
        const content = rfs(absPath, "utf8");
        const fileFindings = (task.fix_findings || []).filter(f => f.file === filePath);
        if (fileFindings.length === 0) continue;

        const { modified, changes, escalated } = fixer(content, fileFindings, filePath, rootDir);

        if (escalated?.length) {
          escalatedFindings.push(...escalated);
        }

        if (changes > 0) {
          wfs(absPath, modified, "utf8");
          modifiedFiles.push(filePath);
          allModifiedFiles.push(filePath);
        }
      } catch (err) {
        const ff = (task.fix_findings || []).filter(f => f.file === filePath);
        escalatedFindings.push(...ff.map(f => ({
          file: f.file,
          line: f.line,
          reason: `修复异常: ${err.message}`,
        })));
        if (logP) logP("AUTO_FIX", "❌", `修复异常 ${filePath}: ${err.message}`);
      }
    }

    // ── 汇总升级项 ──
    if (escalatedFindings.length > 0) {
      allEscalatedTasks.push(...escalatedFindings.map(f => ({
        file: f.file,
        scanner_id: scannerId,
        severity: "MEDIUM",
        line: f.line,
        description: f.reason || f.description || `${scannerId} 自动修复失败`,
        match: f.match?.slice(0, 80) || "",
        fix_type: "CLAUDE_FIX",
      })));
      stats.escalated++;
    }

    // ── 校验 & 提交 ──
    if (modifiedFiles.length > 0) {
      const validation = await validateAutoFix(modifiedFiles, rootDir, efs);

      if (validation.passed) {
        stats.fixed++;
        hasAnyFix = true;

        if (commitFn && prdPath) {
          try {
            await commitFn(task, prdPath, modifiedFiles);
          } catch (e) {
            if (logP) logP("AUTO_FIX", "commit", `失败: ${e.message}`);
          }
        }

        if (logP) logP("AUTO_FIX", "✅", `${task.id}: ${modifiedFiles.length} 文件已修复`);
      } else {
        // 校验失败 → 回退并升级
        try {
          execFileSync("git", ["checkout", "--", ...modifiedFiles], {
            cwd: rootDir, encoding: "utf8", timeout: 15000,
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (rollbackErr) {
          if (logP) logP("AUTO_FIX", "❌", `回退失败: ${rollbackErr.message}`);
        }

        const findings = task.fix_findings || [];
        allEscalatedTasks.push(...findings.map(f => ({
          file: f.file,
          scanner_id: f.scanner_id,
          severity: f.severity || "MEDIUM",
          line: f.line,
          description: f.description,
          match: f.match?.slice(0, 80) || "",
          fix_type: "CLAUDE_FIX",
        })));
        stats.escalated++;

        if (logP) {
          logP("AUTO_FIX", "⚠️", `${task.id}: 校验失败，已回退并升级为 CLAUDE_FIX`);
          for (const err of (validation.errors || [])) {
            logP("AUTO_FIX", "   ", `[${err.source}] ${err.file}:${err.line} ${err.message}`);
          }
        }
      }
    } else {
      stats.unchanged++;
      if (logP) logP("AUTO_FIX", "—", `${task.id}: 无需修改（可能已修复）`);
    }
  }

  return {
    success: hasAnyFix,
    escalatedTasks: allEscalatedTasks.length > 0 ? allEscalatedTasks : undefined,
    modifiedFiles: [...new Set(allModifiedFiles)],
    stats,
  };
}
