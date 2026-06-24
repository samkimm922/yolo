#!/usr/bin/env node
/**
 * YOLO Review — 用 claude -p 审查 src/ 目录，输出结构化 bug 列表
 *
 * 用法: node review.js [--round=N] [--output=PATH]
 * 退出码: 0=成功  1=claude 调用失败
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaudeSettings, YOLO_PACKAGE_ROOT } from '../runtime/execution/provider-adapter.js';
import { inspectAgentAdapterContract } from '../runtime/adapters/agent-contract.js';
import { redact, redactDeep } from '../lib/security/redact.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const LOG_DIR = join(__dirname, 'logs');

// --- 参数 ---
const args = process.argv.slice(2);
const roundArg = args.find(a => a.startsWith('--round='));
const round = roundArg ? parseInt(roundArg.split('=')[1], 10) : 1;
const outputArg = args.find(a => a.startsWith('--output='));
const outputPath = outputArg ? outputArg.split('=')[1] : null;

const claudeSettings = resolveClaudeSettings(ROOT, 'settings-minimal.json', { packageRoot: YOLO_PACKAGE_ROOT });
const adapterInspection = inspectAgentAdapterContract({
  provider: 'claude',
  rootDir: ROOT,
  workDir: ROOT,
  runtimeDir: join(ROOT, '.yolo', 'state', 'runtime'),
});

if (adapterInspection.blocks_execution) {
  console.error(`[yolo-review] claude adapter contract blocked execution: ${JSON.stringify(redactDeep(adapterInspection.blockers))}`);
  console.log('[]');
  process.exit(1);
}

// --- 审查 Prompt ---
const REVIEW_PROMPT = `你是一个高级代码审查员。审查整个项目的 src/ 目录，找出所有 bug 和安全问题。

审查维度：
1. TypeScript 类型错误（any、类型不匹配、缺失类型）
2. 运行时错误风险（null/undefined 访问、边界条件、竞态）
3. 安全问题（注入、硬编码密钥、XSS、未验证输入）
4. 逻辑错误（条件判断错误、循环边界、状态管理）
5. 性能问题（N+1 查询、内存泄漏、无限循环风险）
6. React/Taro 特有问题（hooks 误用、缺少 key、状态不可变）

## 任务粒度约束（必须遵守）

每个 bug 必须拆成独立的、最小粒度的修复任务：
1. 每个任务只改 1 个文件（最多 2 个，如果第二个只是类型导入）
2. 每个 fix 的 diff 净增不超过 30 行
3. 如果一个 bug 涉及多个文件，拆成多个独立 bug 条目，每个指向不同文件
4. 如果修复需要改接口/类型定义，把接口变更和调用方修修补分成两个 bug
5. 不要生成"重构"类建议，只报告可精确定位的 bug
6. 每个建议必须给出精确的修改方案（改哪行、改成什么），不要模糊描述

输出严格 JSON 数组格式（不要输出任何其他内容）：
[
  {
    "id": "BUG-R${round}-001",
    "severity": "CRITICAL|HIGH|MEDIUM",
    "file": "src/services/xxx.ts",
    "line": 42,
    "category": "runtime|security|type|logic|performance|react",
    "description": "精确描述问题 + 修改指令（必须包含：改哪行、改成什么代码，不要泛泛描述）",
    "suggestion": "可直接执行的修复代码片段（精确到行号和替换内容，diff 净增不超过 30 行）"
  }
]

只报告 CRITICAL 和 HIGH 级别的问题。不要报告风格、命名、注释等主观问题。
如果没有发现问题，输出空数组：[]`;

// --- JSON 提取 ---
function extractJsonArray(text: string) {
  if (!text || !text.trim()) return [];
  // 尝试直接解析
  try { const arr = JSON.parse(text); if (Array.isArray(arr)) return arr; } catch {}
  // 尝试提取 ```json ... ``` 或 ``` ... ``` 中的内容（贪婪匹配最后一个 code block）
  const mdMatches = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  for (let i = mdMatches.length - 1; i >= 0; i--) {
    try { const arr = JSON.parse(mdMatches[i][1]); if (Array.isArray(arr)) return arr; } catch {}
  }
  // 尝试提取最外层 [...] 数组（用括号平衡匹配，避免截断内部嵌套数组）
  const firstBracket = text.indexOf('[');
  if (firstBracket !== -1) {
    let depth = 0;
    for (let i = firstBracket; i < text.length; i++) {
      if (text[i] === '[') depth++;
      else if (text[i] === ']') depth--;
      if (depth === 0) {
        try { const arr = JSON.parse(text.slice(firstBracket, i + 1)); if (Array.isArray(arr)) return arr; } catch {}
        break;
      }
    }
  }
  // 尝试提取 {...} 单个对象（Claude 有时返回单个对象而非数组）
  const firstBrace = text.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    for (let i = firstBrace; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(firstBrace, i + 1));
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            // 单个对象可能是 review bug 条目
            if (obj.id && (obj.severity || obj.file || obj.description)) return [obj];
            // 也可能是 {bugs: [...]} 包装
            if (Array.isArray(obj.bugs)) return obj.bugs;
            if (Array.isArray(obj.issues)) return obj.issues;
            if (Array.isArray(obj.results)) return obj.results;
          }
        } catch {}
        break;
      }
    }
  }
  // 非空输出但全部解析失败 → 返回 null，由调用方判为工具失败
  return null;
}

// --- 调用 claude -p（全新窗口，10 分钟超时） ---
const result = spawnSync('claude', [
  '-p', REVIEW_PROMPT,
  '--settings', claudeSettings.value,
], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 600000,
  stdio: ['pipe', 'pipe', 'pipe'],
});

// --- 处理结果 ---
if (result.error) {
  const spawnError = Object.assign(Object(), result.error);
  if (spawnError.code === 'ETIMEDOUT') {
    console.error(`[yolo-review] claude 超时 (round ${round})`);
    console.log('[]');
    process.exit(2);
  }
  console.error(`[yolo-review] claude 调用失败: ${spawnError.message}`);
  console.log('[]');
  process.exit(1);
}

if (result.status !== 0 && result.status !== null) {
  console.error(`[yolo-review] claude 退出码 ${result.status} (round ${round})`);
  if (result.stderr) console.error(redact(result.stderr.slice(0, 500)));
  console.log('[]');
  process.exit(1);
}

if (result.signal) {
  console.error(`[yolo-review] claude 被信号 ${result.signal} 终止 (round ${round})`);
  if (result.stderr) console.error(redact(result.stderr.slice(0, 500)));
  console.log('[]');
  process.exit(1);
}

const rawOutput = result.stdout || '';
const bugs = extractJsonArray(rawOutput);
const safeBugs = bugs === null ? null : redactDeep(bugs);

// 写日志（包含原始输出，便于调试解析失败）
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const logFile = join(LOG_DIR, `review-round${round}-${Date.now()}.json`);
writeFileSync(
  logFile,
  JSON.stringify({ bugs: safeBugs, rawOutputLength: rawOutput.length, rawOutputPreview: redact(rawOutput.slice(0, 500)) }, null, 2),
  { encoding: "utf8", mode: 0o600 },
);

// 非空输出无法解析为 JSON → 工具失败，拒绝 []+exit0 的假绿
if (bugs === null) {
  console.error(`[yolo-review] claude 输出无法解析为 JSON (round ${round})，原始长度 ${rawOutput.length}`);
  console.error(`[yolo-review] preview: ${redact(rawOutput.slice(0, 200))}`);
  process.exit(1);
}

// 输出到 stdout（供 runner 读取）
console.log(JSON.stringify(safeBugs));

// 写到指定路径（如果 --output 参数存在）
if (outputPath) {
  const outDir = dirname(outputPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(safeBugs, null, 2), { encoding: "utf8", mode: 0o600 });
}
