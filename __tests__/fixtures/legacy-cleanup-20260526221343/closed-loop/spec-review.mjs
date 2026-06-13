#!/usr/bin/env node

/**
 * Spec Review — PRD 约束后验检查
 *
 * 在全部 task 完成后运行，验证每个 completed task 的 PRD 约束是否真正被满足。
 * 纯规则检查，不调用 AI，1-2 秒完成。
 * 发现问题时输出警告，但不阻塞流程。
 *
 * 用法:
 *   node scripts/yolo/closed-loop/spec-review.mjs <prd.json>
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', B = '\x1b[1m', X = '\x1b[0m';

// ── 加载 PRD ──
function loadPrd(prdPath) {
  if (!existsSync(prdPath)) return null;
  try {
    return JSON.parse(readFileSync(prdPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ── 加载 State ──
function loadState() {
  const statePath = join(__dirname, 'yolo-state.json');
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

// ── 检查 must_use ──
function checkMustUse(content, patterns) {
  const missing = [];
  for (const pattern of (patterns || [])) {
    if (pattern.length <= 3) continue;
    if (!content.includes(pattern)) {
      missing.push(pattern);
    }
  }
  return missing;
}

// ── 检查 must_not_use ──
function checkMustNotUse(content, patterns) {
  const violations = [];
  for (const pattern of (patterns || [])) {
    if (content.includes(pattern)) {
      violations.push(pattern);
    }
  }
  return violations;
}

// ── 检查 acceptance criteria ──
function checkAcceptance(task, content) {
  const failures = [];
  const acceptance = task.acceptanceCriteria || task.constraints?.acceptance || [];

  for (const ac of acceptance) {
    // 解析 grep 规则："grep -n 'xxx' file.ts 无结果" 或 "grep -n 'xxx' file.ts no result"
    const noResultMatch = ac.match(/grep\s+(?:-\w+\s+)*['"]([^'"]+)['"]\s+(\S+)\s+(?:无结果|no\s+result|not\s+found|empty)/i);
    if (noResultMatch) {
      try {
        const result = execSync(
          `grep -n '${noResultMatch[1]}' ${noResultMatch[2]} 2>/dev/null || true`,
          { encoding: 'utf-8', cwd: PROJECT_ROOT }
        );
        if (result.trim()) {
          failures.push(`acceptance 未满足: ${ac} (grep 仍有结果)`);
        }
      } catch {
        // grep 失败 = 文件不存在或语法错误，不算失败
      }
      continue;
    }

    // 解析 grep 规则："grep -n 'xxx' file.ts 有结果"
    const hasResultMatch = ac.match(/grep\s+(?:-\w+\s+)*['"]([^'"]+)['"]\s+(\S+)\s+有结果/);
    if (hasResultMatch) {
      try {
        const result = execSync(
          `grep -n '${hasResultMatch[1]}' ${hasResultMatch[2]} 2>/dev/null || true`,
          { encoding: 'utf-8', cwd: PROJECT_ROOT }
        );
        if (!result.trim()) {
          failures.push(`acceptance 未满足: ${ac} (grep 无结果)`);
        }
      } catch {
        failures.push(`acceptance 未满足: ${ac} (grep 执行失败)`);
      }
      continue;
    }
  }

  return failures;
}

// ── 检查单个 task ──
function checkTaskSpec(task) {
  const issues = [];
  const targetFile = task.constraints?.target_file;

  if (!targetFile) {
    // 无目标文件的任务（如 config 类型），跳过
    return issues;
  }

  const filePath = join(PROJECT_ROOT, targetFile);
  if (!existsSync(filePath)) {
    issues.push(`目标文件不存在: ${targetFile}`);
    return issues;
  }

  const content = readFileSync(filePath, 'utf-8');

  // 检查 must_use
  const missingMustUse = checkMustUse(content, task.constraints?.must_use);
  for (const m of missingMustUse) {
    issues.push(`must_use 缺失: "${m}" 在 ${targetFile} 中未找到`);
  }

  // 检查 must_not_use
  const violations = checkMustNotUse(content, task.constraints?.must_not_use);
  for (const v of violations) {
    issues.push(`must_not_use 违规: "${v}" 在 ${targetFile} 中存在`);
  }

  // 检查 acceptance criteria
  const acFailures = checkAcceptance(task, content);
  issues.push(...acFailures);

  return issues;
}

// ── 主函数 ──
function main() {
  const args = process.argv.slice(2);
  const prdPath = args.find(a => !a.startsWith('--')) || join(PROJECT_ROOT, 'prd.json');
  const prd = loadPrd(prdPath);
  const state = loadState();

  console.log(`\n${C}${B}═══ Spec Review ═══${X}`);
  console.log(`PRD: ${prdPath}`);

  if (!prd) {
    console.log(`${Y}⚠ 无法加载 PRD，跳过 Spec Review${X}`);
    process.exit(0);
  }

  const tasks = prd.userStories || prd.tasks || [];

  // 只检查 completed 且不是被预过滤跳过的任务
  // 优先从 state 加载，state 不存在时直接从 PRD 的 status 字段判断
  const completedTasks = tasks.filter(t => {
    const s = state?.tasks?.[t.id];
    if (s) {
      return s.status === 'completed' && !s.skipped_by_pre_filter && !s.skipped_by_fixed_index;
    }
    // 无 state 时，从 PRD 的 status 字段判断
    return t.status === 'completed';
  });

  console.log(`总任务: ${tasks.length} | 实际完成: ${completedTasks.length}\n`);

  if (completedTasks.length === 0) {
    console.log(`${Y}⚠ 无实际完成的 task，跳过 Spec Review${X}\n`);
    process.exit(0);
  }

  let totalIssues = 0;
  const taskIssues = [];

  for (const task of completedTasks) {
    const issues = checkTaskSpec(task);
    if (issues.length > 0) {
      console.log(`${R}✗${X} ${task.id}: ${task.title}`);
      for (const issue of issues) {
        console.log(`   ${R}- ${issue}${X}`);
      }
      totalIssues += issues.length;
      taskIssues.push({ task_id: task.id, issues });
    }
  }

  // 写报告
  const report = {
    timestamp: new Date().toISOString(),
    prd_path: prdPath,
    total_tasks: tasks.length,
    completed_tasks: completedTasks.length,
    issues_found: totalIssues,
    task_issues: taskIssues,
  };

  const reportPath = join(__dirname, 'spec-review-report.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  if (totalIssues === 0) {
    console.log(`\n${G}✅ 所有 completed task 的 PRD 约束均已满足${X}\n`);
    process.exit(0);
  } else {
    console.log(`\n${Y}⚠ 发现 ${totalIssues} 个问题，报告已保存: ${reportPath}${X}`);
    console.log(`${Y}建议: 检查上述未满足的约束，确认是否需要回修${X}\n`);
    // 不阻塞，exit 0
    process.exit(0);
  }
}

main();
