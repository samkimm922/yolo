import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const LOGS_DIR = join(ROOT, 'logs')
const RETRY_FILE = join(ROOT, 'retry-count.json')
const OUTPUT_FILE = join(ROOT, 'observability-data.json')

// ── CLI ──────────────────────────────────────────────
const lastN = parseLastArg(process.argv.slice(2))

function parseLastArg(args) {
  const idx = args.findIndex(a => a.startsWith('--last='))
  if (idx === -1) return Infinity
  const n = Number(args[idx].split('=')[1])
  return Number.isFinite(n) && n > 0 ? n : Infinity
}

// ── 主逻辑 ───────────────────────────────────────────
async function main() {
  let filenames
  try {
    filenames = await readdir(LOGS_DIR)
  } catch { filenames = [] }

  const v2Files = filenames
    .filter(f => f.startsWith('gate-v2-') && f.endsWith('.json'))
    .sort()
    .slice(-lastN)

  if (v2Files.length === 0) {
    console.log('暂无观测数据')
    return
  }

  const runs = await Promise.all(
    v2Files.map(async f => {
      try {
        const raw = await readFile(join(LOGS_DIR, f), 'utf-8')
        return JSON.parse(raw)
      } catch {
        console.warn(`[warn] 跳过损坏的日志文件: ${f}`)
        return null
      }
    })
  ).then(rs => rs.filter(Boolean))

  let retries = {}
  try { retries = JSON.parse(await readFile(RETRY_FILE, 'utf-8')) } catch {}

  const report = buildReport(runs, retries)
  printReport(report)
  await appendData(report)
}

// ── 聚合 ─────────────────────────────────────────────
function buildReport(runs, retries) {
  const total = runs.length
  const passed = runs.filter(r => r.result === 'PASS').length
  const failed = total - passed

  // 首次通过 = PASS 且重试次数 <= 1
  const firstPass = runs.filter(r => {
    const attempts = retries[r.task_id] ?? retries['unknown'] ?? 1
    return r.result === 'PASS' && attempts <= 1
  }).length
  const failThenPass = passed - firstPass

  const retryValues = Object.values(retries)
  const avgRetry = retryValues.length
    ? (retryValues.reduce((a, b) => a + b, 0) / retryValues.length).toFixed(1)
    : '0.0'

  // 闸门级统计
  const gateMap = {}
  for (const run of runs) {
    for (let i = 0; i < run.gates.length; i++) {
      const g = run.gates[i]
      const key = `${i}|${g.name}`
      if (!gateMap[key]) gateMap[key] = { step: i + 1, name: g.name, total: 0, passed: 0, durSum: 0 }
      gateMap[key].total++
      if (g.passed) gateMap[key].passed++
      gateMap[key].durSum += g.duration_ms
    }
  }

  const gateStats = Object.values(gateMap).map(g => ({
    ...g,
    rate: g.total ? ((g.passed / g.total) * 100).toFixed(0) : '0',
    avgMs: g.total ? Math.round(g.durSum / g.total) : 0,
  }))

  // Top 3 触发（通过率 < 100% 的，按失败次数降序）
  const triggered = gateStats
    .filter(g => g.passed < g.total)
    .sort((a, b) => (b.total - b.passed) - (a.total - a.passed))
    .slice(0, 3)

  return { total, passed, failed, firstPass, failThenPass, avgRetry, gateStats, triggered, timestamp: new Date().toISOString() }
}

// ── 终端输出 ─────────────────────────────────────────
function printReport(r) {
  const pct = r.total ? ((r.firstPass / r.total) * 100).toFixed(0) : '0'
  console.log('═══ 闭环观测报告 ═══')
  console.log(`统计范围: ${r.total} 次运行\n`)

  console.log('  任务指标:')
  console.log(`    总任务: ${r.total} | 首次通过: ${r.firstPass} (${pct}%) | 失败后通过: ${r.failThenPass}`)
  console.log(`    平均重试: ${r.avgRetry} 次\n`)

  console.log('  闸门通过率:')
  console.log('    Step | 闸门名                              | 通过率 | 平均耗时')
  console.log('    ─────┼─────────────────────────────────────┼───────┼──────────')
  for (const g of r.gateStats) {
    const name = g.name.padEnd(36)
    const dur = g.avgMs >= 1000 ? `${(g.avgMs / 1000).toFixed(1)}s` : `${g.avgMs}ms`
    console.log(`     ${String(g.step).padStart(3)}  | ${name} | ${String(g.rate).padStart(4)}% | ${dur.padStart(8)}`)
  }

  if (r.triggered.length > 0) {
    console.log('\n  Top 3 触发闸门:')
    r.triggered.forEach((g, i) => {
      const fails = g.total - g.passed
      console.log(`    ${i + 1}. Step ${g.step}: ${g.name} (触发 ${fails} 次)`)
    })
  } else {
    console.log('\n  Top 3 触发闸门: (无)')
  }
  console.log()
}

// ── 追加持久化 ───────────────────────────────────────
async function appendData(report) {
  const entry = { timestamp: report.timestamp, summary: { total: report.total, firstPass: report.firstPass, avgRetry: report.avgRetry }, gateStats: report.gateStats, triggered: report.triggered }

  let existing = []
  try { existing = JSON.parse(await readFile(OUTPUT_FILE, 'utf-8')) } catch {}
  if (!Array.isArray(existing)) existing = []
  existing.push(entry)
  await writeFile(OUTPUT_FILE, JSON.stringify(existing, null, 2), 'utf-8')
}

main().catch(e => { console.error('报告生成失败:', e.message); process.exit(1) })
