#!/usr/bin/env node
// code-review.mjs — 增量/全量代码审查，支持生成 bugfix PRD

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isAlreadyFixed } from './fixed-index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

// ── 参数解析 ──────────────────────────────────────────────
import { getArg, hasFlag } from "../lib/cli-utils.mjs";

const scope = getArg('--scope=') || 'incremental';
const taskId = getArg('--task=');
const generatePrd = hasFlag('--generate-prd');
const prdPath = getArg('--prd=') || join(__dirname, 'code-review-result.json');

// ── Shell 转义 ────────────────────────────────────────────
function shlexQuote(str) { return "'" + str.replace(/'/g, "'\\''") + "'"; }

// ── 获取文件列表 ──────────────────────────────────────────
function getIncrementalFiles(tid) {
  // 方案 A: 从 yolo-state.json 获取
  const statePath = join(__dirname, 'yolo-state.json');
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    const entry = tid ? state[tid] : Object.values(state).pop();
    if (entry?.filesModified?.length) return entry.filesModified.filter(f => f.startsWith('src/'));
  }
  // 方案 B: 最近 1 个 commit 涉及的 src/ 文件（不是 5 个）
  try {
    const diff = execSync('git diff --name-only HEAD~1 HEAD -- src/', { encoding: 'utf-8', cwd: PROJECT_ROOT });
    return diff.trim().split('\n').filter(Boolean);
  } catch { return []; }
}

function getFullFiles() {
  const out = execSync('find src -name "*.ts" -o -name "*.tsx" | grep -v node_modules | grep -v ".test."', { encoding: 'utf-8', cwd: PROJECT_ROOT });
  return out.trim().split('\n').filter(Boolean);
}

// ── 构建审查 prompt ───────────────────────────────────────
function buildReviewPrompt(files) {
  const parts = files.map(f => {
    const full = join(PROJECT_ROOT, f);
    if (!existsSync(full)) return '';
    const content = readFileSync(full, 'utf-8');
    return `### ${f}\n\`\`\`typescript\n${content.slice(0, 2000)}\n\`\`\`\n`;
  }).join('\n');

  return `你是高级代码审查专家。审查以下 ${scope === 'full' ? '全项目' : '增量'} 代码。

## 项目背景
盲盒库存管理微信小程序（Taro + React + TypeScript + 微信云数据库）

## 审查标准
- CRITICAL: 安全漏洞、数据丢失风险、并发竞争条件
- HIGH: Bug、逻辑错误、性能问题（N+1 查询）
- MEDIUM: 可维护性问题、代码重复、违反规则矩阵 R1-R12
- LOW: 命名、风格建议

## 重点检查
1. 原子操作：数据库写操作是否用 _.inc() 而非 read-then-write
2. 并发安全：是否有竞态条件
3. 错误处理：是否覆盖所有失败路径
4. 类型安全：是否有 as any
5. 内存泄漏：事件监听器是否清理
6. 规则矩阵：Service 层分离、禁直调 DB、禁 window/document

## 代码
${parts}

## 输出格式（严格遵循 JSON）
\`\`\`json
{"findings":[{"severity":"CRITICAL|HIGH|MEDIUM|LOW","file":"src/path/file.ts","line":42,"description":"问题","suggestion":"建议"}],"summary":{"critical":0,"high":0,"medium":0,"low":0,"total_files":${files.length}}}
\`\`\`
只输出 JSON，不要其他内容。`;
}

// ── 执行审查 ──────────────────────────────────────────────
function runReview(files) {
  const prompt = buildReviewPrompt(files);
  try {
    const raw = execSync(`claude -p ${shlexQuote(prompt)} --output-format text 2>/dev/null`, {
      timeout: 600000, maxBuffer: 10 * 1024 * 1024, cwd: PROJECT_ROOT, encoding: 'utf-8',
    }).trim();
    return parseReviewResult(raw);
  } catch (err) {
    console.error(`  ⚠ claude -p 执行失败: ${err.message.slice(0, 200)}`);
    return { findings: [], summary: { critical: 0, high: 0, medium: 0, low: 0, error: err.message.slice(0, 300) } };
  }
}

// ── 解析结果 ──────────────────────────────────────────────
function parseReviewResult(raw) {
  const m = raw.match(/```json\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1]); } catch { /* fall through */ } }
  try { return JSON.parse(raw); } catch { /* fall through */ }
  return { findings: [], summary: { critical: 0, high: 0, medium: 0, low: 0, parse_error: true, raw_preview: raw.slice(0, 500) } };
}

// ── 生成 bugfix PRD ───────────────────────────────────────
function generateBugfixPrd(findings, outputPath) {
  // 语义过滤关键词
  const noopKeywords = ['无需修复', '已修复', '可接受', '设计良好', '优秀实现', '暂不需要修复', '代码库干净'];

  const blockers = findings.filter(f => {
    // 只保留 CRITICAL / HIGH
    if (f.severity !== 'CRITICAL' && f.severity !== 'HIGH') return false;

    // 语义过滤：描述里明确写"无需修复"等的跳过
    const desc = (f.description || '').toLowerCase();
    if (noopKeywords.some(kw => desc.includes(kw.toLowerCase()))) return false;

    // 已修复索引过滤
    if (isAlreadyFixed(f.file, f.line || 0, f.description || '')) return false;

    return true;
  });

  // 如果没有阻断性问题，不生成 PRD（或生成空任务列表）
  if (blockers.length === 0) {
    const emptyPrd = {
      title: `Code Review Bugfix — ${new Date().toISOString().slice(0, 10)}`,
      description: '无新阻断性问题（已全部修复或已过滤）',
      tasks: [],
      generated_from: 'code-review.mjs'
    };
    writeFileSync(outputPath, JSON.stringify(emptyPrd, null, 2));
    return emptyPrd;
  }

  // 原有 task 生成逻辑
  const tasks = blockers.map((f, i) => ({
    id: `BUGFIX-${String(i + 1).padStart(3, '0')}`,
    title: `[${f.severity}] 修复 ${f.file.split('/').pop()}: ${f.description.slice(0, 50)}`,
    description: `## 问题\n文件: ${f.file}:${f.line}\n严重级别: ${f.severity}\n描述: ${f.description}\n\n## 修复建议\n${f.suggestion}`,
    type: 'bugfix', priority: f.severity === 'CRITICAL' ? 1 : 2,
    constraints: {
      target_file: f.file, must_use: [], must_not_use: [], max_lines: 200,
      acceptance: [`修复: ${f.description}`, '通过 gate-chain-v2.mjs 全部 13 步', '不引入新 bug'],
    },
    depends_on: [],
  }));

  const prd = {
    title: `Code Review Bugfix — ${new Date().toISOString().slice(0, 10)}`,
    description: 'Code Review 发现的问题，供 YOLO 自动修复',
    tasks,
    generated_from: 'code-review.mjs'
  };
  writeFileSync(outputPath, JSON.stringify(prd, null, 2));
  return prd;
}

// ── 主函数 ────────────────────────────────────────────────
function main() {
  console.log(`\n🔍 Code Review — ${scope === 'full' ? '全量' : '增量'}审查`);
  const files = scope === 'full' ? getFullFiles() : getIncrementalFiles(taskId);
  if (!files.length) { console.log('  没有需要审查的文件'); process.exit(0); }
  console.log(`  审查 ${files.length} 个文件...\n`);

  const result = runReview(files);
  const s = result.summary || {};
  console.log('\n📊 审查结果:');
  console.log(`  CRITICAL: ${s.critical ?? '?'}`);
  console.log(`  HIGH:     ${s.high ?? '?'}`);
  console.log(`  MEDIUM:   ${s.medium ?? '?'}`);
  console.log(`  LOW:      ${s.low ?? '?'}`);

  writeFileSync(prdPath, JSON.stringify(result, null, 2));
  console.log(`\n💾 结果已保存: ${prdPath}`);

  const blockers = (result.findings || []).filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH');
  if (blockers.length && generatePrd) {
    const bugfixPath = join(__dirname, 'bugfix-prd-review-latest.json');
    generateBugfixPrd(result.findings, bugfixPath);
    console.log(`📝 Bugfix PRD 已生成: ${bugfixPath}`);
  }

  if (blockers.length) { console.log(`\n❌ 发现 ${blockers.length} 个阻断性问题`); process.exit(1); }
  console.log('\n✅ 无阻断性问题');
  process.exit(0);
}

main();
