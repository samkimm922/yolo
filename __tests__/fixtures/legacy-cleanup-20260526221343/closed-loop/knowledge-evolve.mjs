#!/usr/bin/env node
// knowledge-evolve.mjs — 知识进化：验证、降级、查询
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KB_PATH = resolve(__dirname, 'knowledge-base.jsonl')

const args = process.argv.slice(2)
const getArg = (prefix) => {
  const a = args.find(a => a.startsWith(`--${prefix}=`))
  return a ? a.slice(prefix.length + 3) : null
}
const hasFlag = (f) => args.includes(`--${f}`)

// 读取知识库
let records = []
try {
  records = readFileSync(KB_PATH, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
} catch { /* 空库 */ }

const save = () => {
  writeFileSync(KB_PATH, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8')
}
const now = Date.now()
const DAY = 86400000

if (getArg('verify')) {
  const id = getArg('verify')
  const r = records.find(r => r.id === id)
  if (!r) { console.error(`未找到知识: ${id}`); process.exit(1) }
  const old = r.confidence
  r.confidence = Math.min(10, r.confidence + 1)
  r.verified_count = (r.verified_count || 0) + 1
  r.last_used = new Date().toISOString().slice(0, 10)
  save()
  console.log(`\n═══ 知识进化报告 ═══\n`)
  console.log(`  验证: ${r.id} confidence ${old}→${r.confidence}`)
  const counts = { active: 0, dormant: 0, archived: 0 }
  records.forEach(r => counts[r.status] = (counts[r.status] || 0) + 1)
  console.log(`\n  总计: active=${counts.active}, dormant=${counts.dormant}, archived=${counts.archived}\n`)

} else if (hasFlag('decay')) {
  const actions = []
  for (const r of records) {
    if (!r.last_used || r.status === 'archived') continue
    const lastUsedTime = new Date(r.last_used).getTime();
    if (isNaN(lastUsedTime)) continue // 防无效日期
    const daysSince = (now - lastUsedTime) / DAY
    const oldStatus = r.status
    if (daysSince > 10 && r.status !== 'archived') r.status = 'archived'
    else if (daysSince > 5 && r.status === 'active') r.status = 'dormant'
    if (oldStatus !== r.status) actions.push({ id: r.id, from: oldStatus, to: r.status, days: Math.round(daysSince) })
  }
  save()
  console.log(`\n═══ 知识进化报告 ═══\n`)
  for (const a of actions) console.log(`  降级: ${a.id} ${a.from}→${a.to} (${a.days} 天未使用)`)
  if (actions.length === 0) console.log('  无降级操作')
  const counts = { active: 0, dormant: 0, archived: 0 }
  records.forEach(r => counts[r.status] = (counts[r.status] || 0) + 1)
  console.log(`\n  总计: active=${counts.active}, dormant=${counts.dormant}, archived=${counts.archived}\n`)

} else if (getArg('status') !== null || hasFlag('status')) {
  const status = getArg('status') || 'active'
  const filtered = records.filter(r => r.status === status)
  if (filtered.length === 0) { console.log(`\n无 ${status} 状态的知识\n`); process.exit(0) }
  console.log(`\n═══ ${status} 知识（${filtered.length} 条）═══\n`)
  for (const r of filtered) console.log(`  [${r.id}] (${r.type}, ${r.confidence}/10) ${r.content}`)
  console.log()

} else if (hasFlag('list')) {
  console.log(`\n═══ 知识库总览（${records.length} 条）═══\n`)
  const typeLabels = { error: '错误', pattern: '模式', trap: '陷阱', decision: '决策', gate: '闸门' }
  for (const r of records) {
    const label = typeLabels[r.type] || r.type
    console.log(`  [${r.id}] ${label} | ${r.status} | ${r.confidence}/10 | ${r.content.slice(0, 50)}${r.content.length > 50 ? '...' : ''}`)
  }
  const counts = { active: 0, dormant: 0, archived: 0 }
  records.forEach(r => counts[r.status] = (counts[r.status] || 0) + 1)
  console.log(`\n  总计: active=${counts.active}, dormant=${counts.dormant}, archived=${counts.archived}\n`)

} else {
  console.log('用法: knowledge-evolve.mjs --verify=KN-001 | --decay | --status=active | --list')
}
