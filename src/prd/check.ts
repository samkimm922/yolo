#!/usr/bin/env node
// PRD 预检脚本 v2 — 基于 scope + pre_conditions + post_conditions 验证 PRD
// 用法: node prd-check.js --prd=<path>
// 退出码: 0=通过, 1=有无效任务, 2=参数错误/文件不存在
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── 颜色输出 ────────────────────────────────────────────────────────
const G = "\x1b[32m"; // 绿 — PASS
const Y = "\x1b[33m"; // 黄 — WARN
const R = "\x1b[31m"; // 红 — FAIL
const B = "\x1b[1m"; // 粗体
const X = "\x1b[0m"; // 重置

// ── 解析参数 ────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const prdArg = argv.find((a) => a.startsWith("--prd="));
if (!prdArg) {
  console.error(`${R}用法: node prd-check.js --prd=<path>${X}`);
  process.exit(2);
}
const prdPath = resolve(prdArg.slice("--prd=".length));

if (!existsSync(prdPath)) {
  console.error(`${R}PRD 文件不存在: ${prdPath}${X}`);
  process.exit(2);
}

// ── 加载 PRD ────────────────────────────────────────────────────────
let prd;
try {
  prd = JSON.parse(readFileSync(prdPath, "utf8"));
} catch (e) {
  console.error(`${R}PRD JSON 解析失败: ${e.message}${X}`);
  process.exit(2);
}

// ── 确定项目根目录 ──────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const candidates = [
  resolve(prdPath, "..", "..", ".."),
  resolve(__dirname, "..", ".."),
];
const ROOT = candidates.find((d) => existsSync(join(d, "package.json")))
  || resolve(__dirname, "..", "..");

// ── 常量 ────────────────────────────────────────────────────────────
const VALID_CONDITION_TYPES = new Set([
  "code_contains",
  "code_not_contains",
  "file_exists",
  "file_not_exists",
  "no_new_type_errors",
  "no_new_lint_errors",
  "no_forbidden_patterns",
  "acceptance_criteria",
  "files_modified_max",
  "file_lines_max",
  "no_new_dead_code",
  "no_file_over_max_lines",
  "tests_pass",
  "build_pass",
  "business_code_min",
]);

const VALID_PRIORITIES = new Set(["P0", "P1", "P2", "P3", "P4"]);
const VALID_TASK_TYPES = new Set(["bugfix", "feature", "refactor", "review"]);

// bugfix 任务自动提取的已知坏模式
const BUG_PATTERNS = [
  "console.error",
  "console.warn",
  "console.log",
  "err.message",
  "errMsg",
  "error.message",
  "eval(",
  "innerHTML",
  "dangerouslySetInnerHTML",
  "as any",
];

// ── 工具函数 ────────────────────────────────────────────────────────
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 读文件内容，文件不存在返回 null
 */
function readFileSafe(absPath) {
  if (!existsSync(absPath)) return null;
  return readFileSync(absPath, "utf8");
}

/**
 * 统计文本在内容中出现的次数
 */
function countOccurrences(content, text) {
  if (!content || !text) return 0;
  const re = new RegExp(escapeRegex(text), "g");
  return (content.match(re) || []).length;
}

// ── 汇总判定 ────────────────────────────────────────────────────────
function aggregate(results) {
  const nonWarn = results.filter((r) => r.level !== "warn");
  if (nonWarn.some((r) => r.level === "invalid")) {
    return "invalid";
  }
  if (nonWarn.length > 0 && nonWarn.every((r) => r.level === "skip")) {
    return "skip";
  }
  return "keep";
}

// ── 验证单个任务 ────────────────────────────────────────────────────
function validateTask(task, allTaskIds) {
  const results = [];

  // 跳过已完成/已标记无效的任务
  if (task.status === "completed" || task.status === "invalid") {
    return { action: "keep", results: [] };
  }

  // ══════════════════════════════════════════════════════════════════
  // §1 结构校验（不依赖文件系统）
  // ══════════════════════════════════════════════════════════════════

  // 1a. priority 必须是 P0-P4
  if (task.priority !== undefined && !VALID_PRIORITIES.has(task.priority)) {
    results.push({
      level: "invalid",
      message: `无效 priority: "${task.priority}"，必须为 P0-P4`,
    });
  }

  // 1b. type 必须是已知枚举
  if (task.type !== undefined && !VALID_TASK_TYPES.has(task.type)) {
    results.push({
      level: "invalid",
      message: `无效 type: "${task.type}"，必须为 bugfix / feature / refactor / review`,
    });
  }

  // 1c. depends_on 必须引用同 PRD 内有效 task ID
  const dependsOn = task.depends_on || [];
  for (const depId of dependsOn) {
    if (!allTaskIds.has(depId)) {
      results.push({
        level: "invalid",
        message: `depends_on 引用无效任务 ID: "${depId}"（PRD 内不存在）`,
      });
    }
  }

  // 1d. 必须有 scope 且至少一个 target
  if (
    !task.scope ||
    !Array.isArray(task.scope.targets) ||
    task.scope.targets.length === 0
  ) {
    results.push({
      level: "invalid",
      message: "缺少 scope.targets — 每个任务至少需要一个目标文件",
    });
    return { action: "invalid", results };
  }

  // 1e. pre_conditions ID 必须唯一
  const preIds = new Set();
  for (const cond of task.pre_conditions || []) {
    if (!cond.id) continue;
    if (preIds.has(cond.id)) {
      results.push({
        level: "invalid",
        message: `pre_conditions ID 重复: "${cond.id}"`,
      });
    }
    preIds.add(cond.id);
  }

  // 1f. post_conditions ID 必须唯一
  const postIds = new Set();
  for (const cond of task.post_conditions || []) {
    if (!cond.id) continue;
    if (postIds.has(cond.id)) {
      results.push({
        level: "invalid",
        message: `post_conditions ID 重复: "${cond.id}"`,
      });
    }
    postIds.add(cond.id);
  }

  // 1g. 条件类型必须是合法枚举
  for (const cond of [
    ...(task.pre_conditions || []),
    ...(task.post_conditions || []),
  ]) {
    if (!VALID_CONDITION_TYPES.has(cond.type)) {
      results.push({
        level: "invalid",
        message: `无效条件类型 "${cond.type}"（${cond.id}），合法值: ${[...VALID_CONDITION_TYPES].join(", ")}`,
      });
    }
  }

  // 结构问题直接返回，不做文件级检查
  if (results.some((r) => r.level === "invalid")) {
    return { action: "invalid", results };
  }

  // ══════════════════════════════════════════════════════════════════
  // §2 文件级校验
  // ══════════════════════════════════════════════════════════════════

  const primaryTarget = task.scope.targets[0].file;
  const absPath = resolve(ROOT, primaryTarget);

  // 2a. 目标文件存在性
  if (!existsSync(absPath)) {
    results.push({
      level: "invalid",
      message: `scope.targets[0].file 不存在: ${primaryTarget}`,
    });
    return { action: "invalid", results };
  }

  const content = readFileSync(absPath, "utf8");
  const isBugfix = task.type === "bugfix";

  // ── 解析条件引用的文件内容（缓存） ──
  const fileCache = Object.create(null); // 无原型对象，防止 __proto__ 污染
  fileCache[primaryTarget] = content;

  function getFileContent(fileRel) {
    if (fileCache[fileRel] !== undefined) return fileCache[fileRel];
    const p = resolve(ROOT, fileRel);
    fileCache[fileRel] = readFileSafe(p);
    return fileCache[fileRel];
  }

  // ══════════════════════════════════════════════════════════════════
  // §2b. pre_conditions 可操作性
  //   code_contains: 模式必须存在于文件中（验证 bug 确实存在）
  //   如果不存在 → bug 已修复 → SKIP
  // ══════════════════════════════════════════════════════════════════
  for (const cond of task.pre_conditions || []) {
    if (cond.type !== "code_contains") continue;

    const file = cond.params?.file || primaryTarget;
    const text = cond.params?.text;
    if (!text) continue;

    const fc = getFileContent(file);
    if (fc === null) {
      results.push({
        level: "invalid",
        message: `pre_condition ${cond.id}: 文件不存在: ${file}`,
      });
      continue;
    }

    const minCount = cond.params?.count?.min ?? 1;
    const actual = countOccurrences(fc, text);

    if (actual < minCount) {
      results.push({
        level: "skip",
        message: `pre_condition ${cond.id}: "${text}" 在 ${file} 未找到（需要 ≥${minCount} 次，实际 ${actual} 次）— bug 可能已修复`,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // §2c. post_conditions 校验
  // ══════════════════════════════════════════════════════════════════

  for (const cond of task.post_conditions || []) {
    // ── 中文描述禁令（code_contains / code_not_contains 的 text 必须是代码标识符）──
    if (cond.type === "code_contains" || cond.type === "code_not_contains") {
      const text = cond.params?.text || "";
      if (/[\u4e00-\u9fff]/.test(text)) {
        results.push({
          level: "invalid",
          message: `post_condition ${cond.id} (${cond.type}) text 包含中文 "${text}" — 应改为代码标识符（函数名/变量名/关键字）`,
        });
        continue; // 跳过后续重复性检查
      }
    }

    // ── 非重复性检查：code_contains 已存在 → SKIP ──
    if (cond.type === "code_contains") {
      const file = cond.params?.file || primaryTarget;
      const text = cond.params?.text;
      if (!text || text.length <= 3) continue;

      const fc = getFileContent(file);
      if (fc === null) continue;

      if (fc.includes(text)) {
        results.push({
          level: "skip",
          message: `post_condition ${cond.id}: "${text}" 已存在于 ${file} — 条件已满足，任务可能已完成`,
        });
      }
    }

    // ── 非重复性检查：code_not_contains 已不存在 → SKIP ──
    if (cond.type === "code_not_contains") {
      const file = cond.params?.file || primaryTarget;
      const text = cond.params?.text;
      if (!text || text.length <= 3) continue;

      const fc = getFileContent(file);
      if (fc === null) continue;

      if (!fc.includes(text)) {
        results.push({
          level: "skip",
          message: `post_condition ${cond.id}: "${text}" 在 ${file} 中已不存在 — 条件已满足，任务可能已完成`,
        });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // §2d. bugfix 自动提取（从 description 提取已知坏模式，补充
  //      pre_conditions code_contains + post_conditions code_not_contains）
  // ══════════════════════════════════════════════════════════════════
  if (isBugfix && content) {
    const desc = task.description || task.title || "";
    const preConds = task.pre_conditions || [];
    const postConds = task.post_conditions || [];
    let added = false;

    for (const pattern of BUG_PATTERNS) {
      if (!desc.includes(pattern)) continue;
      if (!content.includes(pattern)) continue;

      const hasPre = preConds.some(
        (c) =>
          c.type === "code_contains" &&
          (c.params?.text === pattern || c.params?.text?.includes(pattern)),
      );
      const hasPost = postConds.some(
        (c) =>
          c.type === "code_not_contains" &&
          (c.params?.text === pattern || c.params?.text?.includes(pattern)),
      );

      if (!hasPre) {
        const newId = `PRE-AUTO-${String(preConds.length + 1).padStart(3, "0")}`;
        preConds.push({
          id: newId,
          type: "code_contains",
          params: {
            file: primaryTarget,
            text: pattern,
            count: { min: 1 },
          },
          message: `自动提取: 验证 bug 模式仍存在: ${pattern}`,
          severity: "FAIL",
        });
        results.push({
          level: "pass",
          message: `自动补充 pre_condition code_contains: ${pattern}`,
        });
        added = true;
      }

      if (!hasPost) {
        const newId = `POST-AUTO-${String(postConds.length + 1).padStart(3, "0")}`;
        postConds.push({
          id: newId,
          type: "code_not_contains",
          params: {
            file: primaryTarget,
            text: pattern,
          },
          message: `自动提取: 代码不再包含: ${pattern}`,
          severity: "FAIL",
        });
        results.push({
          level: "pass",
          message: `自动补充 post_condition code_not_contains: ${pattern}`,
        });
        added = true;
      }
    }

    if (added) {
      task.pre_conditions = preConds;
      task.post_conditions = postConds;
    }
  }

  // ── 汇总 ──────────────────────────────────────────────────────────
  const action = aggregate(results);
  return { action, results };
}

// ══════════════════════════════════════════════════════════════════════
// 执行验证
// ══════════════════════════════════════════════════════════════════════
const tasks = prd.tasks || [];

// 收集所有有效 task ID（用于 depends_on 校验）
const allTaskIds = new Set(tasks.map((t) => t.id).filter(Boolean));

const counters = { pass: 0, skip: 0, invalid: 0 };

for (const task of tasks) {
  // 跳过已标记的
  if (task.status === "completed" || task.status === "invalid") continue;

  const { action, results } = validateTask(task, allTaskIds);

  if (results.length === 0) {
    // 无约束条件 → 视为通过
    console.log(`${G}\u2713${X} ${task.id} \u2014 \u901A\u8FC7`);
    counters.pass++;
    continue;
  }

  // 按级别分组输出
  const failedResults = results.filter((r) => r.level === "invalid");
  const skipResults = results.filter((r) => r.level === "skip");
  const passResults = results.filter((r) => r.level === "pass");
  const warnResults = results.filter((r) => r.level === "warn");

  if (action === "invalid") {
    for (const r of failedResults) {
      console.log(`${R}\u2717${X} ${task.id} \u2014 invalid: ${r.message}`);
    }
    for (const r of skipResults) {
      console.log(`${Y}\u26A0${X} ${task.id} \u2014 skip: ${r.message}`);
    }
    for (const r of passResults) {
      console.log(`${G}\u2713${X} ${task.id} \u2014 ${r.message}`);
    }
    for (const r of warnResults) {
      console.log(`${Y}\u26A0${X} ${task.id} \u2014 WARN: ${r.message}`);
    }
    task.status = "invalid";
    counters.invalid++;
  } else if (action === "skip") {
    for (const r of skipResults) {
      console.log(`${Y}\u26A0${X} ${task.id} \u2014 skip: ${r.message}`);
    }
    for (const r of warnResults) {
      console.log(`${Y}\u26A0${X} ${task.id} \u2014 WARN: ${r.message}`);
    }
    task.status = "completed";
    counters.skip++;
  } else {
    for (const r of results) {
      console.log(`${G}\u2713${X} ${task.id} \u2014 ${r.message}`);
    }
    counters.pass++;
  }
}

// ── 回写 PRD（原子写入：tmp → rename） ─────────────────────────────
const prdTmp = prdPath + ".tmp";
writeFileSync(prdTmp, JSON.stringify(prd, null, 2) + "\n", "utf8");
renameSync(prdTmp, prdPath);

// ── 汇总输出 ────────────────────────────────────────────────────────
console.log("");
console.log(
  `${B}\u9884\u68C0\u5B8C\u6210${X}: ${G}${counters.pass} \u901A\u8FC7${X}, ${Y}${counters.skip} skip${X}, ${R}${counters.invalid} invalid${X}`,
);

process.exit(counters.invalid > 0 ? 1 : 0);
