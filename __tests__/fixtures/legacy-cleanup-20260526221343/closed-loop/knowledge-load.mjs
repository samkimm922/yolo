#!/usr/bin/env node
// knowledge-load.mjs — 加载知识库，输出可注入 agent prompt 的文本
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KB_PATH = resolve(__dirname, 'knowledge-base.jsonl')

const args = process.argv.slice(2)
const getArg = (prefix) => {
  const a = args.find(a => a.startsWith(`--${prefix}=`))
  return a ? a.slice(prefix.length + 3) : null
}
const limit = parseInt(getArg('limit') || '5', 10)
const typeFilter = getArg('type')
const filesFilter = getArg('files')
const gateFilter = getArg('gate')

// 读取知识库
let records = []
try {
  const raw = readFileSync(KB_PATH, 'utf-8')
  records = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
} catch { /* 空库或文件不存在 */ }

// 只取 active
records = records.filter(r => r.status === 'active')

// 按 gate 精确匹配（重试注入策略）
if (gateFilter) {
  records = records.filter(r => {
    // 优先匹配 auto_analysis.failed_gate
    if (r.auto_analysis?.failed_gate && r.auto_analysis.failed_gate.includes(gateFilter)) return true
    // 回退匹配 content 中包含 gate 名
    if (r.content && r.content.includes(gateFilter)) return true
    return false
  })
  // 重试时取 top 3，更聚焦
  records.sort((a, b) => b.confidence - a.confidence)
  records = records.slice(0, Math.min(limit, 3))
} else {
  // 首次注入：按类型 + 文件匹配

  // 按类型筛选（根据 related_files 路径推断任务类型）
  if (typeFilter) {
    const typeMap = {
      service: ['src/services/'],
      page: ['src/pages/'],
      component: ['src/components/'],
      bugfix: []  // bugfix 匹配所有
    }
    const paths = typeMap[typeFilter] || []
    if (paths.length > 0) {
      records = records.filter(r =>
        (r.related_files || []).some(f => paths.some(p => f.startsWith(p) || f.includes(p)))
      )
    }
  }

  // 按涉及文件匹配
  if (filesFilter) {
    const targets = filesFilter.split(',').map(f => f.trim())
    records = records.filter(r =>
      targets.some(t => (r.related_files || []).some(f => f.includes(t) || t.includes(f)))
    )
  }

  // 按 confidence 降序
  records.sort((a, b) => b.confidence - a.confidence)

  // 限制条数
  records = records.slice(0, limit)
}

// 无匹配则静默退出
if (records.length === 0) process.exit(0)

// 输出
const typeLabels = { error: '错误', pattern: '模式', trap: '陷阱', decision: '决策', gate: '闸门' }
const contextLabel = gateFilter ? `闸门 [${gateFilter}]` : (typeFilter || '全部')
console.log(`\n═══ 前序知识（${records.length} 条 | ${contextLabel}）═══\n`)

for (const r of records) {
  const label = typeLabels[r.type] || r.type
  console.log(`[${r.id}] ${label} (置信度 ${r.confidence}/10): ${r.content}`)
  if (r.source_task && r.source_task !== 'import') {
    console.log(`  来源任务: ${r.source_task}`)
  }
  if (r.related_files && r.related_files.length > 0) {
    console.log(`  相关文件: ${r.related_files.join(', ')}`)
  }
  if (r.auto_analysis?.failed_gate) {
    console.log(`  失败闸门: ${r.auto_analysis.failed_gate} (${r.auto_analysis.failure_count}次)`)
  }
  console.log()
}
