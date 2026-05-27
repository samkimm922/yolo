#!/usr/bin/env node
/**
 * YOLO Prompt 生成器 v6 — pure v2 契约格式 + narrower 重试
 *
 * v6 变更:
 * - 纯 v2 scope / pre_conditions / post_conditions
 * - 移除所有 v1 constraints 回退
 * - 重试时解析 gate JSON 日志，只注入失败条件（narrower）
 */

import { readFileSync, existsSync, statSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { buildExperiencePackText } from "../runtime/learning/center.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOLO_ROOT = resolve(__dirname, "..", "..");
const DEFAULT_ROOT = resolve(YOLO_ROOT, "..", "..");
let ROOT = DEFAULT_ROOT;

// --- CLI 参数解析 ---
function getArg(argv, prefix) {
  const arg = argv.find((item) => item.startsWith(prefix));
  if (!arg) return null;
  return arg.slice(prefix.length) || null;
}

export function parsePromptArgs(argv = process.argv.slice(2), env = process.env) {
  return {
    taskId: getArg(argv, "--task="),
    prdPath: getArg(argv, "--prd="),
    isFix: argv.includes("--fix"),
    includeTscContext: argv.includes("--include-tsc-context") || env.YOLO_PROMPT_TSC_CONTEXT === "1",
    learningsText: getArg(argv, "--learnings="),
    attempt: getArg(argv, "--attempt=") || "1",
    gate: getArg(argv, "--gate="),
    cwd: getArg(argv, "--cwd="),
    stateRoot: getArg(argv, "--state-root="),
    noExperiencePack: argv.includes("--no-experience-pack"),
    experienceLimit: getArg(argv, "--experience-limit="),
  };
}

function normalizeCondition(c) {
  if (typeof c === "string") {
    return { id: "AUTO", severity: "FAIL", message: c, type: "acceptance_criteria" };
  }
  return c;
}

export function findPromptTask(prd, taskId) {
  return (prd.tasks || []).find((t) => t.id === taskId)
    // splitTask 子任务回退：AUDIT-004-F1-A → AUDIT-004-F1, AUDIT-002-F1-P1 → AUDIT-002-F1
    || (() => {
      const parentId = taskId.replace(/(-[A-Z]-\d+)$/, '').replace(/(-[A-Z])$/, '').replace(/(-P\d+)$/, '');
      return parentId !== taskId ? (prd.tasks || []).find((t) => t.id === parentId) : null;
    })();
}

// ── 解析 gate JSON 日志获取失败条件（narrower 重试）──────────────
function loadFailedConditions(taskId) {
  const logDir = join(YOLO_ROOT, "state", "runtime");
  if (!existsSync(logDir)) return null;
  try {
    const files = readdirSync(logDir)
      .filter((f) => f.startsWith(`gate-${taskId}-`) && f.endsWith(".json"))
      .sort();
    if (!files.length) return null;
    const latest = files[files.length - 1];
    const data = JSON.parse(readFileSync(join(logDir, latest), "utf8"));
    const failed = (data.gates || []).filter((g) => !g.passed);
    const passed = (data.gates || []).filter((g) => g.passed);
    return { failed, passed };
  } catch {
    return null;
  }
}

// ── Workflow 指令加载 ──────────────────────────────────────────────
function loadWorkflow(type) {
  const workflowPath = join(YOLO_ROOT, "workflows", `${type}.md`);
  try {
    return readFileSync(workflowPath, "utf8");
  } catch {
    return null;
  }
}

// ── 项目规则 ──────────────────────────────────────────────────────
const PROJECT_RULES = [
  "R1: 只修改 PRD scope 允许的目标文件，除非 scope.allow_new_files 明确允许新增 sibling 文件",
  "R2: 保持最小 diff，不顺手重构、不改无关行为、不扩大任务范围",
  "R3: 禁止用 as any 或 as unknown as 掩盖类型问题；优先收窄类型、补完整数据结构或调整调用点",
  "R4: 禁止硬编码密钥、token、密码、私有路径或环境专属值",
  "R5: 禁止留下 console/debug 日志，除非目标项目已有明确 logger 约定并且本任务要求",
  "R6: 不绕过测试、lint、typecheck、gate 或 PRD post_conditions",
  "R7: 单文件行数必须满足 scope.max_lines_per_file；超过上限先拆分再修复",
  "R8: 不修改测试断言来掩盖业务 bug，除非 PRD 明确要求更新测试契约",
  "R9: 新增 public API、配置、权限、数据库或部署变更时必须有 PRD 证据支持",
  "R10: 修改后自查 import、类型签名、错误处理、边界条件和目标文件行数",
];

// ── 文件上下文收集（同 v4，保持不变）─────────────────────────────

function parseImports(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8");
  const imports = [];
  const re = /import\b[^'"]*?from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    imports.push({ path: m[1], raw: m[0] });
  }
  return imports;
}

function resolveImportPath(importPath, fromFile) {
  if (!importPath.startsWith(".")) return null;
  const fromDir = dirname(fromFile);
  const candidates = [
    resolve(fromDir, importPath + ".ts"),
    resolve(fromDir, importPath + ".tsx"),
    resolve(fromDir, importPath, "index.ts"),
    resolve(fromDir, importPath, "index.tsx"),
    resolve(fromDir, importPath),
  ];
  for (const c of candidates) {
    if (existsSync(c) && !statSync(c).isDirectory()) return c;
  }
  return null;
}

function readFileSafe(filePath, maxLines = 300) {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    if (lines.length <= maxLines) return { content, lines: lines.length, truncated: false };
    return {
      content: lines.slice(0, maxLines).join("\n") + `\n// ... (截断，共 ${lines.length} 行)`,
      lines: lines.length,
      truncated: true,
    };
  } catch {
    return null;
  }
}

function gatherContext(targetFile) {
  const sections = [];
  if (!targetFile || !existsSync(resolve(ROOT, targetFile))) {
    if (targetFile) {
      sections.push(`## 📁 目标文件（需新建）\n\n文件 \`${targetFile}\` 当前不存在，需要创建。`);
    }
    return sections.join("\n\n");
  }

  const absPath = resolve(ROOT, targetFile);
  if (!existsSync(absPath) || statSync(absPath).isDirectory()) return "";

  const fileData = readFileSafe(absPath);
  if (!fileData) return "";

  const remaining = 150 - fileData.lines;
  const warning = remaining < 10
    ? `\n⚠️ 警告：只剩 ${remaining} 行空间！如果要加超过 ${remaining} 行代码，必须先拆分文件。`
    : remaining < 30
      ? `\n⚡ 注意：仅剩 ${remaining} 行空间，紧凑修改。`
      : "";

  sections.push(`## 📁 目标文件: ${targetFile}\n\n当前 ${fileData.lines} 行 | 上限 150 行 | 剩余 ${remaining} 行${warning}\n\n\`\`\`typescript\n${fileData.content}\n\`\`\``);

  // 收集类型文件和服务文件
  const imports = parseImports(absPath);
  const typeFiles = [];
  const serviceFiles = [];

  for (const imp of imports) {
    const resolved = resolveImportPath(imp.path, absPath);
    if (!resolved) continue;
    const relPath = resolved.replace(ROOT + "/", "");
    if (resolved.includes("/types/") || resolved.endsWith(".d.ts")) {
      const d = readFileSafe(resolved, 150);
      if (d) typeFiles.push({ path: relPath, ...d });
    } else if (resolved.includes("/services/") || resolved.includes("/hooks/")) {
      const d = readFileSafe(resolved, 80);
      if (d) serviceFiles.push({ path: relPath, ...d });
    }
  }

  if (typeFiles.length > 0) {
    sections.push("## 📁 相关类型定义");
    for (const tf of typeFiles) {
      sections.push(`### ${tf.path}\n\n\`\`\`typescript\n${tf.content}\n\`\`\``);
    }
  }

  if (serviceFiles.length > 0) {
    sections.push("## 📁 依赖的 Service/Hooks");
    for (const sf of serviceFiles) {
      sections.push(`### ${sf.path}\n\n\`\`\`typescript\n${sf.content}\n\`\`\``);
    }
  }

  return sections.join("\n\n");
}

function gatherReadonlyContext(files = []) {
  const sections = [];
  for (const file of files) {
    const absPath = resolve(ROOT, file);
    if (!existsSync(absPath) || statSync(absPath).isDirectory()) continue;
    const data = readFileSafe(absPath, 120);
    if (!data) continue;
    sections.push(`### ${file}（只读参考，不可修改）\n\n\`\`\`typescript\n${data.content}\n\`\`\``);
  }
  return sections.length ? `## 📚 只读参考文件\n\n${sections.join("\n\n")}` : "";
}

function isR9TestSplitTask(task, targets) {
  const text = `${task.title || ""}\n${task.description || ""}`;
  const ids = (task.source_findings || task.fix_findings || []).map(f => f.scanner_id || f.rule_id);
  const targetFiles = (targets || []).map(t => t.file || "").filter(Boolean);
  return ids.includes("R9-file-length") &&
    targetFiles.length === 1 &&
    targetFiles.every(file => file.includes("/__tests__/") || /\.(test|spec)\.[tj]sx?$/.test(file));
}

function renderR9TestSplitContract(task, targets, scope) {
  const target = targets[0]?.file || "目标测试文件";
  const maxFiles = scope.max_files || 5;
  const maxNewFiles = Math.max(0, maxFiles - 1);
  const splitPlan = renderR9StaticSplitPlan(target, scope);
  return [
    "## R9 测试文件拆分快路径",
    "",
    `目标: 把 \`${target}\` 拆到 ≤ ${scope.max_lines_per_file || 150} 行，最多新增 ${maxNewFiles} 个 sibling 测试文件。`,
    "",
    splitPlan,
    "",
    "固定策略:",
    "1. 先只分析本文件的 import、mock/setup、top-level describe/it 分布，不做全仓探索。",
    "2. 优先按 top-level describe 分组拆；如果只有一个 describe，就按内层 describe 或相关 it 用例组拆。",
    "3. 新文件命名用 `<原文件名去掉 .test>.xxx.test.ts` 或 `<原文件名去掉 .test>.xxx.cases.ts`，放在同目录。",
    "4. 每个新文件必须保留运行所需 import/mock/setup，测试名称、断言、业务语义逐字保留。",
    "5. 原文件不能删除；保留必要用例或共享入口，但最终必须 ≤ 行数上限。",
    "6. 禁止改业务实现文件，禁止为了过 gate 改测试断言。",
    "",
    "停止条件:",
    `- \`${target}\` ≤ ${scope.max_lines_per_file || 150} 行。`,
    `- 总修改代码文件数 ≤ ${maxFiles}。`,
    "- 不新增 TSC 错误。",
    "- 如果拆分无法在这些限制内完成，停止并说明需要进一步拆 task，不要扩大范围。",
    "",
  ].join("\n");
}

function countBraceDelta(line) {
  const stripped = line
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "")
    .replace(/\/\/.*$/, "");
  return (stripped.match(/\{/g) || []).length - (stripped.match(/\}/g) || []).length;
}

function blockName(line) {
  const m = line.match(/\b(?:describe|it|test)\s*\(\s*['"`]([^'"`]+)['"`]/);
  return m ? m[1] : line.trim().slice(0, 80);
}

function collectTestBlocks(lines, desiredDepth) {
  const blocks = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startsBlock = depth === desiredDepth && /^\s*(describe|it|test)\s*\(/.test(line);
    if (startsBlock) {
      let end = i;
      let localDepth = 0;
      for (let j = i; j < lines.length; j++) {
        localDepth += countBraceDelta(lines[j]);
        if (j > i && localDepth <= 0) {
          end = j;
          break;
        }
      }
      blocks.push({
        start: i + 1,
        end: end + 1,
        lines: end - i + 1,
        name: blockName(line),
      });
    }
    depth += countBraceDelta(line);
  }
  return blocks;
}

function renderR9StaticSplitPlan(target, scope) {
  const absPath = resolve(ROOT, target);
  if (!existsSync(absPath)) return "静态拆分计划: 目标文件不存在，跳过。";
  const lines = readFileSync(absPath, "utf8").split("\n");
  const maxLines = scope.max_lines_per_file || 150;
  const maxFiles = scope.max_files || 5;
  const baseName = target.replace(/\.test\.[tj]sx?$/, "");
  const ext = target.endsWith(".tsx") ? "tsx" : "ts";
  let blocks = collectTestBlocks(lines, 0);
  if (blocks.length <= 1) blocks = collectTestBlocks(lines, 1);
  const candidates = [...blocks].sort((a, b) => b.lines - a.lines).slice(0, Math.max(0, maxFiles - 1));
  let remaining = lines.length;
  const selected = [];
  for (const block of candidates) {
    if (remaining <= maxLines) break;
    selected.push(block);
    remaining -= block.lines;
  }
  const rows = candidates.slice(0, 8).map((block, index) =>
    `- ${index + 1}. lines ${block.start}-${block.end} (${block.lines} 行): ${block.name}`,
  );
  const moves = selected.map((block, index) =>
    `- 移动 lines ${block.start}-${block.end} 到 \`${baseName}.part${index + 1}.test.${ext}\`，预计原文件约 ${Math.max(1, remaining)} 行`,
  );
  return [
    "静态拆分计划:",
    `- 当前文件约 ${lines.length} 行，目标 ≤ ${maxLines} 行。`,
    rows.length ? "- 候选测试块:" : "- 未识别到可拆测试块；先人工按 describe/it 分组。",
    ...rows,
    selected.length ? "- 建议优先移动:" : "- 建议优先移动: 无，说明只需精简原文件或手动选择小块。",
    ...moves,
  ].join("\n");
}

function formatCondition(c) {
  const bits = [`- **${c.id}** [${c.severity}]: ${c.message || c.type}`];
  const params = c.params || {};
  const paramLines = [];
  for (const key of ["file", "function", "text", "texts", "all_texts", "pattern", "callee", "max", "count"]) {
    if (params[key] !== undefined) {
      const value = Array.isArray(params[key]) ? params[key].join(", ") : String(params[key]);
      paramLines.push(`  - ${key}: \`${value.slice(0, 500)}\``);
    }
  }
  if (paramLines.length > 0) bits.push(...paramLines);
  return bits.join("\n");
}

// ── 组装 prompt ──────────────────────────────────────────────────

export function generatePrompt(input = {}) {
  const taskId = input.taskId;
  const prdPath = input.prdPath;
  const isFix = input.isFix === true || input.fix === true;
  const includeTscContext = input.includeTscContext === true;
  const learningsText = input.learningsText || "";
  const attempt = input.attempt || "1";
  const gateFilter = input.gate || null;
  const stateRoot = input.stateRoot || input.state_root || null;
  ROOT = resolve(input.cwd || input.projectRoot || DEFAULT_ROOT);

  if (!taskId || !prdPath) {
    throw new Error("用法: prompt.js --task=<id> --prd=<path> [--fix] [--learnings=<text>] [--attempt=N]");
  }

  let prd;
  try {
    prd = JSON.parse(readFileSync(resolve(prdPath), "utf-8"));
  } catch (error) {
    throw new Error(`无法加载 PRD 文件: ${prdPath}\n${error.message}`);
  }

  const task = findPromptTask(prd, taskId);
  if (!task) {
    throw new Error(`任务 ${taskId} 不存在于 PRD`);
  }

  const scope = task.scope || {};
  const TARGET_FILE = scope.targets?.[0]?.file || "";
  const targets = scope.targets || (TARGET_FILE ? [{ file: TARGET_FILE }] : []);
  const readonlyFiles = scope.readonly_files || [];
  const preConditions = (task.pre_conditions || []).map(normalizeCondition);
  const postConditions = (task.post_conditions || []).map(normalizeCondition);
  const contextSections = targets.map((target) => gatherContext(target.file)).filter(Boolean).join("\n\n");
  const readonlyContextSections = gatherReadonlyContext(readonlyFiles);

// 重试模式: 从 gate JSON 日志提取失败条件
const gateResult = isFix ? loadFailedConditions(taskId) : null;

// 指令块
const analysisBlock = isFix
  ? [
      "## 🔄 第 " + attempt + " 次重试",
      "",
      "上一次修改没有通过 gate 检查。下面是**失败的条件**和当前代码。",
      "",
      "### 这次务必做到：",
      "1. **先看上面的完整代码**，找到根因位置",
      "2. 对照下面「失败条件」逐条分析：我的上次修改改了什么 → 为什么导致这个失败",
      "3. 用 Edit 工具精确修改，不改其他文件",
      "4. 改完后再检查：类型对不对、import 有没有多余、行数有没有超标",
      "5. 一个 task 只做一个文件操作",
      "",
    ]
  : [
      "## 🔧 修复指令",
      "",
      "### 步骤",
      "1. **先读上面「目标文件完整代码」**，理解当前代码结构",
      "2. 对照「问题描述」定位根因",
      "3. 用 Edit 工具做最小修改",
      "4. 改完后检查：文件行数 ≤ 150、类型匹配、import 无多余",
      "",
      "### 禁止",
      "- 禁止不读代码直接改",
      "- 禁止输出分析文本而不实际改代码",
      "- 禁止修改不相关的文件",
      "- 禁止顺手优化、重构、加注释",
      "- 禁止改动后文件超过 150 行",
      "- 禁止一个任务同时创建新文件又修改已有文件",
      "",
    ];

// ── 注入 workflow 指令 ──────────────────────────────────────────────
const workflowType = isFix ? "fix-bug-retry" : "fix-bug";
const workflowContent = loadWorkflow(workflowType);

const parts = [];

if (workflowContent) {
  parts.push(
    "<workflow>",
    workflowContent,
    "</workflow>",
    "",
  );
}

parts.push(
  `# ${task.id} — ${task.title}`,
  "",
  "---",
  "",
  ...analysisBlock,
  "---",
  "",
  contextSections,
  readonlyContextSections,
  "",
);

// ── 注入相关经验包（非阻塞、失败静默跳过）───────────────────────────
try {
  if (!input.noExperiencePack) {
    const experiencePack = buildExperiencePackText({
      projectRoot: ROOT,
      stateRoot,
      task,
      gate: gateFilter,
      lastGateError: learningsText,
      limit: Number(input.experienceLimit || input.experience_limit || 5),
    });
    if (experiencePack) {
      parts.push(experiencePack, "");
    }
  }
} catch {
  // Experience retrieval must never block prompt generation.
}

// ── v2 契约：pre_conditions / post_conditions ────────────────────
if (preConditions.length > 0) {
  parts.push("## 📋 修前条件（pre_conditions）");
  parts.push("");
  parts.push("> 修前验证：确认 bug 模式仍然存在。以下条件全部 PASS → 执行修复。");
  for (const c of preConditions) {
    parts.push(formatCondition(c));
  }
  parts.push("");
}

if (postConditions.length > 0) {
  const failConditions = postConditions.filter((c) => c.severity === "FAIL");
  const warnConditions = postConditions.filter((c) => c.severity === "WARN");

  // 重试模式: 只展示失败的条件
  if (gateResult && gateResult.failed.length > 0) {
    parts.push("## ❌ 上次失败的条件（必须修复）");
    parts.push("");
      for (const g of gateResult.failed) {
        parts.push(`- **${g.name}** [${g.severity}]: ${g.detail?.slice(0, 150) || g.name}`);
    }
    parts.push("");

    if (gateResult.passed.length > 0) {
      parts.push("## ✅ 已通过的条件（不要动）");
      parts.push("");
      for (const g of gateResult.passed) {
        parts.push(`- ${g.name} ✓`);
      }
      parts.push("");
    }
  } else {
    // 非重试: 展示所有条件
    if (failConditions.length > 0) {
      parts.push("## 📋 修后条件 — 必须通过（post_conditions FAIL）");
      parts.push("");
      for (const c of failConditions) {
        parts.push(formatCondition(c));
      }
      parts.push("");
    }
    if (warnConditions.length > 0) {
      parts.push("## 📋 修后条件 — 最好做到（post_conditions WARN）");
      parts.push("");
      for (const c of warnConditions) {
        parts.push(formatCondition(c));
      }
      parts.push("");
    }
  }
}

// ── 修改范围约束 ──────────────────────────────────────────────────
parts.push("## 📐 修改范围约束");
parts.push("");
if (targets.length > 0) {
  parts.push(`- 目标文件: ${targets.map((t) => t.file).join(", ")}`);
}
parts.push(`- 最多修改 ${scope.max_files || 5} 个代码文件`);
parts.push(`- 单文件不超过 ${scope.max_lines_per_file || 150} 行`);
if (scope.allow_new_files) {
  parts.push("- 允许创建新文件");
  // 检测是否为文件拆分任务
  const desc = ((task.description || "") + " " + (task.title || "")).toLowerCase();
  const isSplit = /拆分|split|提取/.test(desc) ||
    (desc.includes("超") && desc.includes("行")) ||
    (desc.includes("超过") && desc.includes("行"));
  if (isSplit) {
    if (isR9TestSplitTask(task, targets)) {
      parts.push("");
      parts.push(renderR9TestSplitContract(task, targets, scope));
    }
    parts.push("");
    parts.push("## 文件拆分操作（必须严格按顺序执行）");
    parts.push("1. 用 Read 读取原文件全部内容");
    parts.push("2. 用 Write 工具创建每个新文件（写入拆分后的内容）");
    parts.push("   ⛔ **逐字复制原文件的 describe/it 测试名和测试代码，不可改写、不可重命名、不可省略任何测试**");
    if (scope.allow_delete_files) {
      parts.push("3. **必须**用 Bash 工具执行 `rm <原文件路径>` 删除原文件");
      parts.push("4. 用 Bash 执行 `ls <目录>` 确认原文件已删除、新文件已创建");
    } else {
      parts.push("3. **禁止删除原文件**：原目标文件仍会被 post_conditions 检查，必须保留且压到行数上限内");
      parts.push("4. 原文件可以改成精简入口/分组文件，但不能只新增 sibling 文件后让原文件继续超行");
      parts.push("5. 用 Bash 执行 `wc -l <原文件路径>` 确认原文件未超过行数上限");
    }
    parts.push("");
    if (scope.allow_delete_files) {
      parts.push("⚠️ 不执行第 3 步 rm 删除原文件 = 任务必定失败 ⚠️");
    } else {
      parts.push("⚠️ 删除原文件或让原文件继续超行 = post_conditions 必定失败 ⚠️");
    }
    parts.push("⚠️ 改写/重命名测试名 = gate code_contains 检查必定失败 ⚠️");
  }
}
parts.push("");

// ── 禁止模式 ──────────────────────────────────────────────────────
if (scope.forbidden_patterns && scope.forbidden_patterns.length > 0) {
  parts.push("## 🚫 禁止模式（diff 新增行不得包含）");
  parts.push("");
  for (const fp of scope.forbidden_patterns) {
    const desc = fp.description ? ` — ${fp.description}` : "";
    parts.push(`- \`${fp.pattern}\` [${fp.severity}]${desc}`);
  }
  parts.push("");
}

parts.push(
  "---",
  "",
  "## 🎯 问题描述",
  task.description || task.title,
  "",
);

// 验收标准
parts.push(
  "## ✅ 验收标准",
  (task.acceptance_criteria || []).length > 0
    ? task.acceptance_criteria.map((a) => typeof a === "string" ? `- ${a}` : `- ${a.description || a.message || ""}`).join("\n")
    : "按描述执行，通过 tsc + eslint + vitest",
  "",
);

// 前端任务硬性约束（FE-*）
const FRONTEND_RULES = taskId.startsWith("FE-") ? [
  "",
  "## 🎨 前端代码硬性约束（必须遵守）",
  "1. 所有 import 必须使用 ES6 语法（`import x from '...'`），禁止使用 `require()`",
  "2. import 路径必须使用正确的相对路径（`../../` / `../` / `./`）或 `@/` 别名",
  "3. 创建新文件后，必须确认 import 的路径指向真实存在的文件",
  "4. 代码写完后，先运行 `pnpm tsc --noEmit` 检查新文件是否有 TS 错误，有错误先修复再结束",
  "5. 再运行 `pnpm eslint --fix` 检查 lint 错误，有错误先修复再结束",
  "",
] : [];

// 项目规则
parts.push(
  "## 📏 项目代码规则（违反会被 gate 拦截）",
  PROJECT_RULES.map((r) => `- ${r}`).join("\n"),
  ...FRONTEND_RULES,
);

// ── 底线 ──────────────────────────────────────────────────────────
const scopedTargetFiles = targets.map(t => t.file).filter(Boolean);

parts.push(
  "## ⚠️ 底线",
  "1. **必须实际产出目标代码 diff**：worktree 中 `git status` 必须显示 PRD scope 目标文件改动；仅改 docs/SESSION/SNAPSHOT/DELIVERY_LOG 视为失败",
  scopedTargetFiles.length > 0
    ? `2. **必须创建/修改这些目标文件**：${scopedTargetFiles.join(', ')}（如不存在则用 Write 创建）`
    : "2. 必须实际修改代码文件（无修改 = 失败）",
  "3. 改动文件数 ≤ 5",
  `4. 改动后目标文件 ≤ ${scope.max_lines_per_file || 150} 行`,
  "5. 不改不相关的文件",
  "6. 文档同步（SESSION/SNAPSHOT/DELIVERY_LOG）由 runner 自动处理，**不要手动改这三个文档**",
);

// ── 注入目标文件的 TSC 编译错误上下文 ──
const tscTargetFiles = scopedTargetFiles.filter(f => f.endsWith('.ts') || f.endsWith('.tsx'));
if (includeTscContext && tscTargetFiles.length > 0) {
  try {
    const tscOut = execSync('pnpm exec tsc --noEmit 2>&1', {
      cwd: ROOT, encoding: 'utf8', timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // tsc 无错误 → 不注入
  } catch (e) {
    const output = (e.stdout || '') + (e.stderr || '');
    const relevantErrors = output.split('\n').filter(l => {
      if (!/error TS\d+:/.test(l)) return false;
      return tscTargetFiles.some(tf => l.includes(tf.replace(/^\.\//, '')));
    });
    if (relevantErrors.length > 0) {
      parts.push("", "## 🔴 目标文件的 TSC 编译错误（必须全部修复）", "");
      parts.push(`以下 ${relevantErrors.length} 条 TSC 错误涉及你的目标文件，修复时必须同时解决：`);
      parts.push("```");
      parts.push(...relevantErrors.slice(0, 30)); // 最多显示 30 条
      if (relevantErrors.length > 30) parts.push(`... 共 ${relevantErrors.length} 条错误`);
      parts.push("```", "");
    }
  }
}

// 重试时追加失败信息（旧格式兼容）
if (learningsText && !gateResult) {
  parts.push("", "---", "", "## ❌ 上次失败信息", "", learningsText);
}

  return parts.join("\n");
}

export function runPromptCli(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const output = generatePrompt(parsePromptArgs(argv, process.env));
    stdout.write(`${output}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exit(runPromptCli());
