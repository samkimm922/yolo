#!/usr/bin/env node
// prompt-evolve.mjs — 追踪 prompt 措辞成功率，生成优化建议报告

import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STATE_PATH = resolve(__dirname, 'yolo-state.json')
const LESSONS_PATH = resolve(__dirname, 'lessons.jsonl')
const REPORT_PATH = resolve(__dirname, 'prompt-effectiveness-report.json')
const PROMPT_PATH = resolve(__dirname, 'yolo-task-prompt.mjs')

// ===== 工具函数 =====
function loadState() {
  if (!existsSync(STATE_PATH)) return null
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
  } catch {
    return null
  }
}

function loadLessons() {
  if (!existsSync(LESSONS_PATH)) return []
  try {
    const raw = readFileSync(LESSONS_PATH, 'utf-8')
    return raw.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

function loadPromptTemplate() {
  if (!existsSync(PROMPT_PATH)) return ''
  try {
    return readFileSync(PROMPT_PATH, 'utf-8')
  } catch {
    return ''
  }
}

function extractPhrases(promptText) {
  // 提取 prompt 中的关键措辞/限制条件
  const phrases = []

  // 行数限制措辞
  const lineMatches = promptText.match(/≤\s*(\d+)\s*行/g)
  if (lineMatches) {
    for (const m of [...new Set(lineMatches)]) {
      phrases.push(m)
    }
  }

  // 文件数限制
  const fileMatches = promptText.match(/≤\s*(\d+)\s*个文件/g)
  if (fileMatches) {
    for (const m of [...new Set(fileMatches)]) {
      phrases.push(m)
    }
  }

  // 其他关键措辞
  const keywordPatterns = [
    { pattern: /SPLIT_TASK/g, label: '包含 SPLIT_TASK 拆分指令' },
    { pattern: /must_use/g, label: '包含 must_use 约束提醒' },
    { pattern: /must_not_use/g, label: '包含 must_not_use 约束提醒' },
    { pattern: /git add.*git commit/g, label: '包含 git 提交指令' },
    { pattern: /分析根因/g, label: '包含根因分析要求' },
    { pattern: /禁止直接猜测/g, label: '包含禁止猜测要求' },
    { pattern: /tsc --noEmit/g, label: '包含类型检查指令' },
    { pattern: /ESLint/g, label: '包含 ESLint 检查指令' },
    { pattern: /≤ 150 行/g, label: '150行限制' },
    { pattern: /≤ 200 行/g, label: '200行限制' },
    { pattern: /≤ 100 行/g, label: '100行限制' },
    { pattern: /≤ 50 行/g, label: '50行限制' },
  ]

  for (const { pattern, label } of keywordPatterns) {
    if (pattern.test(promptText)) {
      phrases.push(label)
    }
  }

  return [...new Set(phrases)]
}

// ===== 主逻辑 =====
function main() {
  const state = loadState()
  const lessons = loadLessons()
  const promptText = loadPromptTemplate()

  console.log(`📊 Prompt 效果分析报告`)
  console.log(`═══════════════════════════════════════\n`)

  let tasks, totalTasks, completedTasks, failedTasks, overallSuccessRate;

  if (state && state.tasks && Object.keys(state.tasks).length > 0) {
    // 从 state.tasks 统计
    tasks = Object.entries(state.tasks);
    totalTasks = tasks.length;
    completedTasks = tasks.filter(([, v]) => v.status === 'completed').length;
    failedTasks = tasks.filter(([, v]) => v.status === 'failed').length;
    overallSuccessRate = totalTasks > 0 ? completedTasks / totalTasks : 0;
  } else if (lessons.length > 0) {
    // fallback: 从 lessons.jsonl 推导任务统计
    const taskSet = new Map();
    for (const l of lessons) {
      if (!taskSet.has(l.task_id) || new Date(l.timestamp) > new Date(taskSet.get(l.task_id).timestamp)) {
        taskSet.set(l.task_id, l);
      }
    }
    tasks = Array.from(taskSet.entries());
    totalTasks = tasks.length;
    completedTasks = tasks.filter(([, v]) => v.result === 'PASS').length;
    failedTasks = tasks.filter(([, v]) => v.result === 'FAIL').length;
    overallSuccessRate = totalTasks > 0 ? completedTasks / totalTasks : 0;
  } else {
    console.log('状态文件为空且无 lessons 数据，无法分析');
    process.exit(0);
  }

  console.log(`任务统计:`)
  console.log(`  总任务数: ${totalTasks}`)
  console.log(`  成功: ${completedTasks}`)
  console.log(`  失败: ${failedTasks}`)
  console.log(`  整体成功率: ${(overallSuccessRate * 100).toFixed(1)}%`)
  console.log()

  // 2. 从 lessons 统计按尝试次数的成功率
  // 按 task_id 分组，取每个任务的最终结果
  const taskResults = new Map()
  for (const lesson of lessons) {
    const existing = taskResults.get(lesson.task_id)
    if (!existing || new Date(lesson.timestamp) > new Date(existing.timestamp)) {
      taskResults.set(lesson.task_id, lesson)
    }
  }

  const finalResults = Array.from(taskResults.values())
  const passCount = finalResults.filter(r => r.result === 'PASS').length
  const partialCount = finalResults.filter(r => r.result === 'PARTIAL').length
  const failCount = finalResults.filter(r => r.result === 'FAIL').length
  const lessonsTotal = finalResults.length

  console.log(`Lessons 统计（按任务最终状态）:`)
  console.log(`  总任务数: ${lessonsTotal}`)
  console.log(`  PASS: ${passCount}`)
  console.log(`  PARTIAL: ${partialCount}`)
  console.log(`  FAIL: ${failCount}`)
  console.log(`  成功率(PASS): ${lessonsTotal > 0 ? ((passCount / lessonsTotal) * 100).toFixed(1) : 0}%`)
  console.log(`  成功率(PASS+PARTIAL): ${lessonsTotal > 0 ? (((passCount + partialCount) / lessonsTotal) * 100).toFixed(1) : 0}%`)
  console.log()

  // 3. 分析 prompt 措辞效果
  const phrases = extractPhrases(promptText)
  console.log(`当前 Prompt 包含的关键措辞:`)
  for (const p of phrases) {
    console.log(`  - ${p}`)
  }
  console.log()

  // 4. 按失败闸门统计
  const gateFailures = {}
  for (const lesson of lessons) {
    if (lesson.result !== 'PASS' && lesson.knowledge) {
      const gate = extractFailedGate(lesson.knowledge)
      gateFailures[gate] = (gateFailures[gate] || 0) + 1
    }
  }

  const sortedGates = Object.entries(gateFailures)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  console.log(`最常见的失败闸门 (Top 5):`)
  for (const [gate, count] of sortedGates) {
    console.log(`  ${gate}: ${count} 次`)
  }
  console.log()

  // 5. 生成建议
  const recommendations = []

  // 基于失败率生成建议
  const actualFailRate = lessonsTotal > 0 ? (partialCount + failCount) / lessonsTotal : 0
  if (actualFailRate > 0.3) {
    recommendations.push(`当前失败率 ${(actualFailRate * 100).toFixed(0)}% 偏高，建议加强前置约束检查`)
  }

  // 基于最常见的失败闸门生成建议
  if (sortedGates.length > 0) {
    const topGate = sortedGates[0][0]
    const topGateCount = sortedGates[0][1]
    if (topGate.includes('File Scope')) {
      recommendations.push(`"File Scope Guard" 失败 ${topGateCount} 次，建议放宽行数限制到 ≤ 200 行或加强拆分提示`)
    } else if (topGate.includes('PRD Constraints')) {
      recommendations.push(`"PRD Constraints" 失败 ${topGateCount} 次，建议在 prompt 中更突出 must_use/must_not_use 约束`)
    } else if (topGate.includes('tsc')) {
      recommendations.push(`类型检查失败 ${topGateCount} 次，建议要求 AI 修改前先运行 tsc --noEmit`)
    }
  }

  // 基于尝试次数生成建议
  const multiAttemptTasks = tasks.filter(([, v]) => v.attempts > 1)
  if (multiAttemptTasks.length > 0) {
    const multiAttemptRate = multiAttemptTasks.length / totalTasks
    recommendations.push(`${multiAttemptTasks.length} 个任务需要多次尝试(${((multiAttemptRate)*100).toFixed(0)}%)，建议增强首次 prompt 的精确度`)
  }

  // 检查 prompt 是否包含根因分析
  if (!promptText.includes('分析根因') && !promptText.includes('根本原因')) {
    recommendations.push('当前 prompt 未要求根因分析，建议添加"修改前必须先分析根本原因"的指令')
  }

  console.log(`优化建议:`)
  for (const rec of recommendations) {
    console.log(`  • ${rec}`)
  }
  console.log()

  // 6. 模拟 phrase 成功率统计（基于当前数据）
  // 由于我们没有历史 prompt 版本，用当前 prompt 中的关键词做模拟分析
  const phraseStats = []

  // 行数限制分析
  const lineLimitMatch = promptText.match(/≤\s*(\d+)\s*行/)
  if (lineLimitMatch) {
    const limit = lineLimitMatch[1]
    // 统计超过该限制相关的失败
    const lineRelatedFailures = lessons.filter(l => {
      if (l.result === 'PASS') return false
      return l.knowledge && (l.knowledge.includes('行数') || l.knowledge.includes('行限制') || l.knowledge.includes('File Scope'))
    }).length
    const lineRelatedTotal = lessons.filter(l =>
      l.knowledge && (l.knowledge.includes('行数') || l.knowledge.includes('行限制') || l.knowledge.includes('File Scope'))
    ).length

    phraseStats.push({
      phrase: `≤ ${limit} 行`,
      used_count: lineRelatedTotal,
      success_rate: lineRelatedTotal > 0 ? (lineRelatedTotal - lineRelatedFailures) / lineRelatedTotal : 1,
    })
  }

  // must_use 约束分析
  const hasMustUse = promptText.includes('must_use')
  if (hasMustUse) {
    const constraintFailures = lessons.filter(l => {
      if (l.result === 'PASS') return false
      return l.knowledge && l.knowledge.includes('PRD Constraints')
    }).length
    const constraintTotal = lessons.filter(l =>
      l.knowledge && l.knowledge.includes('PRD Constraints')
    ).length

    phraseStats.push({
      phrase: '包含 must_use/must_not_use 约束提醒',
      used_count: constraintTotal,
      success_rate: constraintTotal > 0 ? (constraintTotal - constraintFailures) / constraintTotal : 1,
    })
  }

  // SPLIT_TASK 分析
  const hasSplitTask = promptText.includes('SPLIT_TASK')
  if (hasSplitTask) {
    phraseStats.push({
      phrase: '包含 SPLIT_TASK 拆分指令',
      used_count: lessonsTotal,
      success_rate: overallSuccessRate,
    })
  }

  // 根因分析要求
  const hasRootCause = promptText.includes('分析根因')
  if (hasRootCause) {
    phraseStats.push({
      phrase: '包含根因分析要求',
      used_count: lessonsTotal,
      success_rate: overallSuccessRate,
    })
  }

  console.log(`关键措辞效果统计:`)
  for (const stat of phraseStats) {
    console.log(`  "${stat.phrase}": 使用 ${stat.used_count} 次, 成功率 ${(stat.success_rate * 100).toFixed(1)}%`)
  }
  console.log()

  // 7. 写入报告文件
  const report = {
    timestamp: new Date().toISOString(),
    summary: {
      total_tasks: totalTasks,
      completed: completedTasks,
      failed: failedTasks,
      overall_success_rate: parseFloat(overallSuccessRate.toFixed(3)),
    },
    lessons_summary: {
      total: lessonsTotal,
      pass: passCount,
      partial: partialCount,
      fail: failCount,
      pass_rate: lessonsTotal > 0 ? parseFloat((passCount / lessonsTotal).toFixed(3)) : 0,
    },
    phrases: phraseStats.map(s => ({
      ...s,
      success_rate: parseFloat(s.success_rate.toFixed(3)),
    })),
    top_failure_gates: sortedGates.map(([gate, count]) => ({ gate, count })),
    recommendations,
    prompt_snapshot: {
      has_split_task: hasSplitTask || false,
      has_must_use: hasMustUse || false,
      has_root_cause: hasRootCause || false,
      line_limit: lineLimitMatch ? parseInt(lineLimitMatch[1], 10) : null,
    },
  }

  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8')
  console.log(`报告已保存: ${REPORT_PATH}`)
  console.log(`\n⚠️  本报告仅做分析，不自动修改 yolo-task-prompt.mjs。`)
  console.log(`   请人工审阅建议后，再决定是否手动调整 prompt 模板。`)
}

function extractFailedGate(knowledge) {
  if (!knowledge) return 'Unknown'
  const m = knowledge.match(/^([^:]+)/)
  return m ? m[1].trim() : 'Unknown'
}

main()
