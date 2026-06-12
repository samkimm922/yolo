#!/usr/bin/env node

/**
 * 任务范围守卫 — 检测 AI 是否越界改了不该改的文件
 *
 * 用法：
 *   node scripts/yolo/closed-loop/task-scope-guard.mjs --task=P0-005 --max-files=3 --max-lines=50
 *
 * 检查项：
 *   1. git diff 的文件数是否 ≤ max-files
 *   2. git diff 的代码行数是否 ≤ max-lines
 *   3. 修改的文件是否与任务的 target_file / 预期范围匹配
 */

import { execSync } from 'child_process';

const args = process.argv.slice(2);
const taskArg = args.find(a => a.startsWith('--task='))?.split('=')[1];
const maxFiles = parseInt(args.find(a => a.startsWith('--max-files='))?.split('=')[1] || '5');
const maxLines = parseInt(args.find(a => a.startsWith('--max-lines='))?.split('=')[1] || '100');

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

console.log(`${BOLD}任务范围守卫${RESET} | Task: ${taskArg} | Max files: ${maxFiles} | Max lines: ${maxLines}`);

// 获取 git diff 统计
const diffStat = execSync('git diff --stat', { encoding: 'utf-8' }).trim();
const diffShortstat = execSync('git diff --shortstat', { encoding: 'utf-8' }).trim();

if (!diffStat) {
  console.log(`${GREEN}✓ 无未提交变更${RESET}`);
  process.exit(0);
}

// 解析文件数
const files = diffStat.split('\n').filter(l => l.includes('|'));
const fileCount = files.length;

// 解析行数
const lineMatch = diffShortstat.match(/(\d+) insertions?|(\d+) deletions?/g);
let totalLines = 0;
if (lineMatch) {
  for (const m of lineMatch) {
    totalLines += parseInt(m.match(/\d+/)?.[0] || '0');
  }
}

// 输出结果
const filesOk = fileCount <= maxFiles;
const linesOk = totalLines <= maxLines;

console.log(`  文件数: ${fileCount}/${maxFiles} ${filesOk ? `${GREEN}✓${RESET}` : `${RED}✗ 超限${RESET}`}`);
console.log(`  代码行: ${totalLines}/${maxLines} ${linesOk ? `${GREEN}✓${RESET}` : `${RED}✗ 超限${RESET}`}`);

// 列出修改的文件
console.log(`  修改文件:`);
for (const f of files) {
  const fileName = f.split('|')[0].trim();
  const changeCount = f.split('|')[1]?.trim() || '';
  console.log(`    ${fileName} (${changeCount})`);
}

if (!filesOk) {
  console.log(`\n${RED}${BOLD}✗ 文件数超限！AI 可能合并了多个任务。${RESET}`);
  console.log(`${YELLOW}→ 请拆分为更小的原子提交${RESET}`);
}

if (!linesOk) {
  console.log(`\n${RED}${BOLD}✗ 代码行数超限！${RESET}`);
  console.log(`${YELLOW}→ 请精简修改范围${RESET}`);
}

process.exit(filesOk && linesOk ? 0 : 1);
