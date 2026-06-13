#!/usr/bin/env node
/**
 * 从 review-code.json + review-service.json + review-security.json
 * 生成完整 bugfix PRD，过滤信息性条目，按文件分组合并
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const CODE = JSON.parse(readFileSync(resolve('scripts/yolo/closed-loop/review-code-quality.json'), 'utf-8'));
const SERVICE = JSON.parse(readFileSync(resolve('scripts/yolo/closed-loop/review-service-layer.json'), 'utf-8'));
const SECURITY = JSON.parse(readFileSync(resolve('scripts/yolo/closed-loop/review-security.json'), 'utf-8'));

// ── 1. 合并所有 findings ──
const allFindings = [
  ...(CODE.findings || []),
  ...(SERVICE.findings || []),
  ...(SECURITY.findings || []),
];

// ── 2. 过滤信息性/合规确认条目 ──
const infoKeywords = [
  '不存在.*风险',
  '符合规范',
  '使用.*符合',
  '架构上可接受',
  '不存在.*问题',
  '不存在.*绑定',
  '测试覆盖正确',
  '正确防御',
  '处理.*正确',
  '不违反 R12',
  '不是数据库操作',
  '这是.*API',
  '这是 Taro 框架',
  '这是常量引用',
  '通过 hooks 访问',
  '属于 service 层封装',
  '这是本地存储',
  '这是文件解析',
  '这是云存储',
];
const infoRegex = new RegExp(infoKeywords.join('|'), 'i');

const realFindings = allFindings.filter(f => {
  const desc = f.description || '';
  // 过滤信息性条目
  if (infoRegex.test(desc)) return false;
  // 过滤 MEDIUM/LOW（如果有）
  if (f.severity === 'MEDIUM' || f.severity === 'LOW') return false;
  // 过滤已不存在的文件（如 crypto.ts、inventory-mutation.ts）
  if (f.file?.includes('crypto.ts') && desc.includes('crypto 全局对象')) return false;
  return true;
});

// ── 3. 去重：同一文件 + 同一问题描述（前 60 字符相同）视为重复 ──
const seen = new Set();
const uniqueFindings = [];
for (const f of realFindings) {
  const key = `${f.file}::${(f.description || '').slice(0, 60)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  uniqueFindings.push(f);
}

// ── 4. 按文件分组 ──
const byFile = new Map();
for (const f of uniqueFindings) {
  const file = f.file || 'unknown';
  if (!byFile.has(file)) byFile.set(file, []);
  byFile.get(file).push(f);
}

// ── 5. 生成 tasks ──
let taskNum = 0;
const tasks = [];

for (const [file, findings] of byFile.entries()) {
  // 估算改动量：每个 finding 约 2-5 行改动
  const estimatedLines = findings.length * 4;
  const maxFindingsPerTask = 8; // File Scope Guard 限制

  if (findings.length <= maxFindingsPerTask) {
    // 单个 task
    taskNum++;
    const criticalCount = findings.filter(f => f.severity === 'CRITICAL').length;
    const highCount = findings.filter(f => f.severity === 'HIGH').length;
    const descLines = findings.map((f, i) =>
      `  ${i+1}. [${f.severity}] 第${f.line}行: ${f.description}`
    ).join('\n');

    tasks.push({
      id: `BUG-FULL-${String(taskNum).padStart(3, '0')}`,
      title: `[${criticalCount > 0 ? 'CRITICAL' : 'HIGH'}] 修复 ${file} (${findings.length}个问题)`,
      description: `文件 ${file} 存在以下问题，需全部修复:\n${descLines}`,
      type: 'bugfix',
      priority: criticalCount > 0 ? 1 : 2,
      constraints: {
        target_file: file,
        must_use: findings.some(f => f.suggestion?.includes('logger')) ? ['logger.error'] : [],
        must_not_use: [],
        max_lines: Math.min(estimatedLines + 10, 50),
      },
      acceptance: ['所有 listed 问题全部修复', '通过 gate-chain-v2'],
    });
  } else {
    // 拆分为多个 task
    const chunks = [];
    for (let i = 0; i < findings.length; i += maxFindingsPerTask) {
      chunks.push(findings.slice(i, i + maxFindingsPerTask));
    }
    for (let i = 0; i < chunks.length; i++) {
      taskNum++;
      const chunk = chunks[i];
      const criticalCount = chunk.filter(f => f.severity === 'CRITICAL').length;
      const descLines = chunk.map((f, j) =>
        `  ${j+1}. [${f.severity}] 第${f.line}行: ${f.description}`
      ).join('\n');

      tasks.push({
        id: `BUG-FULL-${String(taskNum).padStart(3, '0')}`,
        title: `[${criticalCount > 0 ? 'CRITICAL' : 'HIGH'}] 修复 ${file} (批次 ${i+1}/${chunks.length})`,
        description: `文件 ${file} 存在以下问题（批次 ${i+1}/${chunks.length}）:\n${descLines}`,
        type: 'bugfix',
        priority: criticalCount > 0 ? 1 : 2,
        constraints: {
          target_file: file,
          must_use: chunk.some(f => f.suggestion?.includes('logger')) ? ['logger.error'] : [],
          must_not_use: [],
          max_lines: 50,
        },
        acceptance: ['所有 listed 问题全部修复', '通过 gate-chain-v2'],
      });
    }
  }
}

// ── 6. 按优先级排序 ──
tasks.sort((a, b) => a.priority - b.priority);

// ── 7. 输出 PRD ──
const prd = {
  title: `全量审查 Bugfix — ${uniqueFindings.length} 个问题 / ${tasks.length} 个任务`,
  description: `基于 review-code(121) + review-service(198) + review-security(6) 合并去重后，过滤信息性条目，实际需修复 ${uniqueFindings.length} 个问题`,
  tasks,
};

const outPath = resolve('scripts/yolo/closed-loop/bugfix-prd-full.json');
writeFileSync(outPath, JSON.stringify(prd, null, 2), 'utf-8');
console.log(`生成完成: ${outPath}`);
console.log(`  原始 findings: ${allFindings.length}`);
console.log(`  过滤后: ${uniqueFindings.length}`);
console.log(`  生成任务: ${tasks.length}`);
console.log(`  CRITICAL: ${uniqueFindings.filter(f => f.severity === 'CRITICAL').length}`);
console.log(`  HIGH: ${uniqueFindings.filter(f => f.severity === 'HIGH').length}`);
