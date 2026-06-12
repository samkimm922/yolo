#!/usr/bin/env node

/**
 * yolo-task-prompt.mjs — 为 claude -p 生成完整 prompt
 *
 * 用法:
 *   node scripts/yolo/closed-loop/yolo-task-prompt.mjs --task=CL-SYS-001 --prd=scripts/yolo/closed-loop/closed-loop-prd.json
 *   node scripts/yolo/closed-loop/yolo-task-prompt.mjs --task=CL-SYS-001 --prd=... --fix --attempt=2 --error-log="scripts/yolo/closed-loop/fix-error-CL-SYS-001.md"
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

const args = process.argv.slice(2)
const getArg = (name) => { const a = args.find(a => a.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null }
const hasFlag = (f) => args.includes(`--${f}`)

const taskId = getArg('task')
const prdPath = getArg('prd')
const isFix = hasFlag('fix')
const errorLogPath = getArg('error-log')
const attempt = parseInt(getArg('attempt') || '1', 10)

if (!taskId || !prdPath) {
  console.error('用法: yolo-task-prompt.mjs --task=CL-SYS-001 --prd=closed-loop-prd.json')
  process.exit(1)
}

// 加载 PRD，找到目标任务
const prd = JSON.parse(readFileSync(resolve(prdPath), 'utf-8'))
const task = (prd.userStories || prd.tasks || [])?.find(t => t.id === taskId)
if (!task) { console.error(`任务不存在: ${taskId}`); process.exit(1) }

// 加载前序知识
let knowledge = ''
try {
  const typeMap = { config: 'service', infrastructure: 'service', testing: 'service' }
  knowledge = execSync(
    `node scripts/yolo/closed-loop/knowledge-load.mjs --type=${typeMap[task.type] || task.type} --limit=5`,
    { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
  )
} catch { /* 无知识 */ }

// 加载同文件的失败知识（陷阱类）
let failureKnowledge = ''
if (task.constraints?.target_file) {
  try {
    failureKnowledge = execSync(
      `node scripts/yolo/closed-loop/knowledge-load.mjs --files=${task.constraints.target_file} --limit=3`,
      { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
    )
  } catch { /* 无知识 */ }
}

// 约束格式化
const c = task.constraints || {}
const constraintsText = [
  c.target_file ? `参考文件（问题最可能出现的位置）: ${c.target_file}` : '',
  c.must_use?.length ? `必须使用: ${c.must_use.join(', ')}` : '',
  c.must_not_use?.length ? `禁止使用: ${c.must_not_use.join(', ')}` : '',
  c.max_lines ? `最大行数: ${c.max_lines}` : '',
].filter(Boolean).join('\n')

// 验收标准（兼容两种格式：PRD 顶层 acceptanceCriteria，或嵌套在 constraints.acceptance）
const acceptanceRaw = task.acceptanceCriteria || c.acceptance || []
const acceptance = acceptanceRaw.map((a, i) => `${i + 1}. ${a}`).join('\n')

// 组装 prompt
const parts = [
  `[闭环执行器 — 任务 ${task.id}]\n`,
  `## 任务信息`,
  `ID: ${task.id}`,
  `标题: ${task.title}`,
  `金句: ${task.golden_sentence}`,
  `类型: ${task.type}\n`,
  `## 约束`,
  constraintsText || '无特殊约束',
  `\n## 验收标准`,
  acceptance || '无明确验收标准',
];

// 前序知识（独立 push，不在上一个数组内）
const allKnowledge = [knowledge, failureKnowledge].filter(Boolean).join('\n');
if (allKnowledge.trim()) {
  parts.push(`\n## 前序知识\n${allKnowledge}`);
}

// 执行要求
parts.push(
  `\n## 执行要求`,
  `0. 参考文件是提示，不是约束。如果根因在其他文件，改其他文件。`,
  `1. 只创建/修改与任务相关的文件（≤ 5 个文件，≤ 200 行新增）`,
  `2. 如果预计改动超过 200 行，请主动将任务拆分为多个独立子任务，`,
  `   每个子任务不超过 200 行，按依赖顺序执行。`,
  `3. 拆分方式：输出 "SPLIT_TASK:" 后跟子任务列表（JSON 格式），`,
  `   例如：SPLIT_TASK: [{"title":"修复 Part 1","target":"src/...","description":"...","must_use":[],"must_not_use":[],"acceptance":["..."]}]`,
  `4. 子任务必须完全独立，每个子任务改完后能独立通过 gate`,
  `5. 必须遵守约束中的 must_use 和 must_not_use`,
  `6. 完成后运行: node scripts/yolo/closed-loop/gate-chain-v2.mjs --task=${task.id}`,
  `7. 闸门不过就修，最多修 3 次。如果 3 次都因为行数超限，输出 SPLIT_TASK 标记请求拆分`,
  `8. 全部通过后执行 git add 和 git commit`,
)

// 修复模式追加
if (isFix) {
  let errorDetail = ''
  if (errorLogPath && existsSync(errorLogPath)) {
    errorDetail = readFileSync(errorLogPath, 'utf-8')
  }

  parts.push(
    `\n## 修复信息`,
    `这是第 ${attempt} 次重试`,
    `\n## 上次闸门失败详情`,
    errorDetail || '（无详细错误信息）',
    `\n## 修复要求`,
    `根据上面的错误详情，精准定位问题并修复。不要猜测，根据具体错误信息修改。`,
  )
}

console.log(parts.join('\n'))
