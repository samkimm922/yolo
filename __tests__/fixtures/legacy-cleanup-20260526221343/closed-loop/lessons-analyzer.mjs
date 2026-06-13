#!/usr/bin/env node
// lessons-analyzer.mjs — 从 lessons.jsonl 和 gate logs 中提炼失败模式，生成知识条目

import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LESSONS_PATH = resolve(__dirname, 'lessons.jsonl')
const KB_PATH = resolve(__dirname, 'knowledge-base.jsonl')
const LOGS_DIR = resolve(__dirname, 'logs')

// ===== 工具函数 =====
function hash(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 8)
}

function getDirPrefix(targetFile) {
  if (!targetFile || typeof targetFile !== 'string') return 'unknown'
  if (targetFile.startsWith('src/hooks/')) return 'src/hooks/'
  if (targetFile.startsWith('src/services/')) return 'src/services/'
  if (targetFile.startsWith('src/pages/')) return 'src/pages/'
  if (targetFile.startsWith('src/components/')) return 'src/components/'
  if (targetFile.startsWith('src/types/')) return 'src/types/'
  return 'other'
}

function inferTaskType(taskId, description) {
  const desc = (description || '').toLowerCase()
  if (taskId.startsWith('BUG') || desc.includes('bug') || desc.includes('修复')) return 'bugfix'
  if (taskId.startsWith('CONFIG') || desc.includes('config') || desc.includes('配置')) return 'config'
  if (desc.includes('feature') || desc.includes('功能') || desc.includes('新增')) return 'feature'
  return 'other'
}

function extractFailedGate(knowledge) {
  if (!knowledge) return 'Unknown'
  // knowledge 字段格式如 "File Scope Guard: 代码文件数 6 > 5..."
  const m = knowledge.match(/^([^:]+)/)
  return m ? m[1].trim() : 'Unknown'
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

function loadKnowledgeBase() {
  if (!existsSync(KB_PATH)) return []
  try {
    const raw = readFileSync(KB_PATH, 'utf-8')
    return raw.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

// ===== 主逻辑 =====
async function main() {
  const lessons = loadLessons()
  const kb = loadKnowledgeBase()

  if (lessons.length === 0) {
    console.log('lessons.jsonl 为空，无需分析')
    process.exit(0)
  }

  console.log(`📊 加载了 ${lessons.length} 条 lessons 记录`)

  // 只关注失败记录（result 为 PARTIAL 或 FAIL）
  const failures = lessons.filter(l => l.result === 'PARTIAL' || l.result === 'FAIL')
  console.log(`  其中失败记录: ${failures.length} 条`)

  if (failures.length === 0) {
    console.log('没有失败记录，无需生成新知识')
    process.exit(0)
  }

  // 聚类统计
  const clusters = new Map() // key: "dir|type|gate" -> { count, records }

  for (const record of failures) {
    const dirPrefix = getDirPrefix(record.target_file)
    const taskType = inferTaskType(record.task_id, record.description)
    const failedGate = extractFailedGate(record.knowledge)
    const key = `${dirPrefix}|${taskType}|${failedGate}`

    if (!clusters.has(key)) {
      clusters.set(key, { count: 0, records: [], dirPrefix, taskType, failedGate })
    }
    clusters.get(key).count++
    clusters.get(key).records.push(record)
  }

  // 找出高频失败模式（>= 2 次）
  const highFreqPatterns = Array.from(clusters.values()).filter(c => c.count >= 2)
  console.log(`  高频失败模式 (>=2次): ${highFreqPatterns.length} 种`)

  let added = 0
  const today = new Date().toISOString().slice(0, 10)

  for (const pattern of highFreqPatterns) {
    const { dirPrefix, taskType, failedGate, count, records } = pattern

    // 收集该模式下的具体错误信息（去重）
    const errorSamples = [...new Set(records.map(r => r.knowledge).filter(Boolean))].slice(0, 3)

    // 生成建议
    let suggestion = ''
    if (failedGate.includes('File Scope')) {
      suggestion = '拆分任务，每个子任务不超过 150 行改动，严格控制文件数量 ≤ 5'
    } else if (failedGate.includes('PRD Constraints')) {
      suggestion = '实现前仔细核对 must_use/must_not_use 约束，确保约束中的每个要求都在代码中落实'
    } else if (failedGate.includes('tsc')) {
      suggestion = '修改前先运行 tsc --noEmit 确认类型安全，注意 import 路径和循环依赖'
    } else if (failedGate.includes('ESLint')) {
      suggestion = '使用 pnpm lint:fix 自动修复风格问题，避免手动改引入新错误'
    } else if (failedGate.includes('Tests')) {
      suggestion = '修改后先本地跑测试确认通过，注意边界条件和异步处理'
    } else if (failedGate.includes('Build')) {
      suggestion = '检查 Taro 构建配置，删除 dist/ 后重试，避免缓存问题'
    } else {
      suggestion = '仔细分析闸门错误详情，针对性修复，不要猜测'
    }

    // 生成 content
    const dirLabel = dirPrefix === 'other' ? '其他目录' : dirPrefix.replace(/\/$/, '')
    const content = `${dirLabel}下的${taskType === 'bugfix' ? 'bug修复' : taskType === 'config' ? '配置' : taskType === 'feature' ? '功能开发' : '任务'}近期常因${failedGate}失败（${count}次），建议${suggestion}`

    // 去重检查：如果 knowledge-base 里已有包含同样目录 + 同样失败闸门的条目，跳过
    const isDuplicate = kb.some(k => {
      if (!k.content) return false
      const hasSameDir = k.content.includes(dirLabel) ||
        (k.related_files || []).some(f => f.startsWith(dirPrefix))
      const hasSameGate = k.content.includes(failedGate)
      return hasSameDir && hasSameGate
    })

    if (isDuplicate) {
      console.log(`  ⏭ 跳过重复知识: ${dirLabel} + ${failedGate}`)
      continue
    }

    const knowledgeEntry = {
      id: `KN-AUTO-${Date.now()}-${hash(content)}`,
      type: 'pattern',
      content,
      source_task: 'auto-analysis',
      confidence: 6,
      verified_count: 0,
      last_used: today,
      status: 'active',
      related_files: dirPrefix === 'other' ? [] : [dirPrefix],
      auto_analysis: {
        dir_prefix: dirPrefix,
        task_type: taskType,
        failed_gate: failedGate,
        failure_count: count,
        error_samples: errorSamples,
        generated_at: today,
      },
    }

    appendFileSync(KB_PATH, JSON.stringify(knowledgeEntry) + '\n', 'utf-8')
    kb.push(knowledgeEntry) // 更新内存数组，防止同次运行重复生成
    added++
    console.log(`  ✓ 新增知识: ${knowledgeEntry.id} (${dirLabel} | ${taskType} | ${failedGate} | ${count}次)`)
  }

  console.log(`\n═══ 分析完成 ═══`)
  console.log(`新增知识条目: ${added}`)
  console.log(`知识库路径: ${KB_PATH}`)
}

main().catch(e => {
  console.error('分析失败:', e.message)
  process.exit(1)
})
