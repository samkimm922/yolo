#!/usr/bin/env node

/**
 * Red Team 攻击脚本 — 验证 pretooluse-guard.mjs 拦截能力
 *
 * 用法：node scripts/yolo/closed-loop/red-team-attack.mjs
 *
 * 遍历 red-team-cases/ 下每个 .ts 文件，构造 stdin JSON 传给 guard 脚本，
 * 记录拦截/放行结果，输出汇总表格和 JSONL 报告。
 */

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CASES_DIR = join(__dirname, 'red-team-cases');
const GUARD_SCRIPT = join(__dirname, 'pretooluse-guard.mjs');
const REPORT_PATH = join(__dirname, 'red-team-report.jsonl');

// 攻击类型 → 期望命中的规则描述
const ATTACK_LABELS = {
  'bad-as-any.ts': 'as any',
  'bad-console-log.ts': 'console.log',
  'bad-long-file.ts': '文件超 200 行',
  'bad-hardcoded-secret.ts': '硬编码密钥',
  'bad-window-document.ts': 'window/document',
};

const results = [];

// 1. 读取所有攻击用例
const caseFiles = readdirSync(CASES_DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort();

for (const filename of caseFiles) {
  const filePath = join(CASES_DIR, filename);
  const content = readFileSync(filePath, 'utf-8');
  const attackType = ATTACK_LABELS[filename] || filename;

  // 2. 构造 guard 脚本的 stdin JSON
  const payload = JSON.stringify({
    tool_input: {
      content,
      file_path: `src/services/${filename}`,
    },
  });

  // 3. 执行 guard 脚本，捕获退出码
  let exitCode = 0;
  let stderr = '';
  try {
    execSync(`node "${GUARD_SCRIPT}"`, {
      input: payload,
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    exitCode = err.status || 0;
    stderr = err.stderr || '';
  }

  const blocked = exitCode === 2;
  // 若守卫崩溃（exit 1 + 有 stderr），标记为 guard_crash 而非未拦截
  const guardCrashed = exitCode === 1 && stderr.trim().length > 0;
  results.push({ filename, attackType, blocked, exitCode, stderr: stderr.trim(), guardCrashed });
}

// 4. 写入 JSONL 报告
const timestamp = new Date().toISOString();
const reportLines = results.map((r) =>
  JSON.stringify({
    timestamp,
    attack_type: r.attackType,
    filename: r.filename,
    blocked: r.blocked,
    exit_code: r.exitCode,
  }),
);
writeFileSync(REPORT_PATH, reportLines.join('\n') + '\n', 'utf-8');

// 5. 终端输出汇总表格
const blockedCount = results.filter((r) => r.blocked).length;
const totalCount = results.length;

const divider = '─'.repeat(40);
console.log('');
console.log('\u2550'.repeat(3) + ' Red Team \u653B\u51FB\u62A5\u544A ' + '\u2550'.repeat(3));
console.log(`\u65E5\u671F: ${timestamp}`);
console.log('');
console.log(`  \u653B\u51FB\u7C7B\u578B          | \u62E6\u622A | \u653E\u884C`);
console.log(`  ${divider}`);
for (const r of results) {
  const blockedMark = r.blocked ? ' \u2713 ' : '   ';
  const passedMark = r.blocked ? '   ' : ' \u2717 ';
  const label = r.attackType.padEnd(12, ' ');
  console.log(`  ${label} |${blockedMark} |${passedMark}`);
}
console.log('');

if (blockedCount === totalCount) {
  console.log(`\u603B\u8BA1: ${blockedCount}/${totalCount} \u62E6\u622A\u6210\u529F \u2713`);
} else {
  console.log(
    `\u603B\u8BA1: ${blockedCount}/${totalCount} \u62E6\u622A\u6210\u529F, ${totalCount - blockedCount} \u4E2A\u6F0F\u6D1E\uFF01`,
  );
  console.log('');
  console.log('\u6F0F\u6D1E\u8BE6\u60C5:');
  for (const r of results.filter((r) => !r.blocked)) {
    console.log(`  \u2717 ${r.attackType} (${r.filename}) — \u672A\u88AB\u62E6\u622A, exit ${r.exitCode}`);
  }
}

console.log(`\n\u62A5\u544A\u5DF2\u5199\u5165: ${REPORT_PATH}`);
process.exit(blockedCount === totalCount ? 0 : 1);
