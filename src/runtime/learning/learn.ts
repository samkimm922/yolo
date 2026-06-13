#!/usr/bin/env node
// learn.js — Learning 读写脚本
// --load: 读 progress.txt 最近 5 条 → stdout
// --record --task=ID --result=pass|fail --gate=闸门名 --message="错误信息"
// --escalate: 输出 ≥5 次 WARN 的条件（JSON 数组），供 gate 升级为 FAIL

import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLearningRecord } from './center.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_YOLO_ROOT = resolve(__dirname, "../../..");

// ── helpers ──────────────────────────────────────────────────────────
function readJSON(fp) {
  if (!existsSync(fp)) return {};
  try { return JSON.parse(readFileSync(fp, 'utf8')); } catch { return {}; }
}
function writeJSON(fp, obj) { writeFileSync(fp, JSON.stringify(obj, null, 2), 'utf8'); }

function parseArgs(argv) {
  const args = { mode: null, task: '', result: '', gate: '', message: '', projectRoot: '', stateRoot: '' };
  for (const a of argv) {
    if (a === '--load') args.mode = 'load';
    else if (a === '--record') args.mode = 'record';
    else if (a === '--escalate') args.mode = 'escalate';
    else if (a.startsWith('--task=')) args.task = a.slice(7);
    else if (a.startsWith('--result=')) args.result = a.slice(9);
    else if (a.startsWith('--gate=')) args.gate = a.slice(7);
    else if (a.startsWith('--message=')) args.message = a.slice(10);
    else if (a.startsWith('--project-root=')) args.projectRoot = a.slice(15);
    else if (a.startsWith('--state-root=')) args.stateRoot = a.slice(13);
  }
  return args;
}

function resolveLearnPaths(args = Object()) {
  const projectRoot = resolve(args.projectRoot || DEFAULT_YOLO_ROOT);
  const stateRoot = resolve(args.stateRoot || DEFAULT_YOLO_ROOT);
  const stateDir = join(stateRoot, 'state');
  const runtimeDir = join(stateDir, 'runtime');
  return {
    projectRoot,
    stateRoot,
    stateDir,
    runtime: runtimeDir,
    progress: join(runtimeDir, 'progress.txt'),
    stats: join(runtimeDir, 'learn-stats.json'),
    rules: args.stateRoot ? join(stateDir, 'learned-rules.json') : join(projectRoot, 'learned-rules.json'),
    conditionStats: join(runtimeDir, 'condition-stats.json'),
  };
}

// ── --load ───────────────────────────────────────────────────────────
function load(paths) {
  let progressContent = '';
  if (existsSync(paths.progress)) {
    const raw = readFileSync(paths.progress, 'utf8');
    const headerEnd = raw.indexOf('---\n');
    const body = headerEnd >= 0 ? raw.slice(headerEnd + 4) : '';
    const entries = body.split(/\n---\n?/).filter(e => e.trim());
    const last5 = entries.slice(-5).join('\n---\n');
    progressContent = last5.trim();
  }
  // 不再输出 learned-rules.json，规则学习统一走 knowledge-base.jsonl 闭环
  // const rules = readJSON(RULES);
  // const rulesContent = Object.values(rules).map(r => `- ${r.rule}`).join('\n');

  // WARN→FAIL 升级提示
  const condStats = readJSON(paths.conditionStats);
  const escalatedWarns = Object.entries(condStats)
    .filter(([, v]) => Object.assign(Object(), v).warn_count >= 3)
    .map(([name, v]) => {
      const stats = Object.assign(Object(), v);
      if (stats.warn_count >= 5) {
        return `- ⛔ **${name}**: WARN 已出现 ${stats.warn_count} 次，升级为 FAIL — 必须修复`;
      }
      return `- ⚠️ **${name}**: WARN 已出现 ${stats.warn_count} 次 — 即将升级（累计 ${stats.warn_count}/5）`;
    });
  const escalateSection = escalatedWarns.length > 0
    ? ['## 🔁 重复 WARN 升级提示', ...escalatedWarns, ''].join('\n')
    : '';

  const out = [
    '## 历史经验',
    progressContent || '（暂无记录）',
    '',
    escalateSection,
  ].join('\n');
  process.stdout.write(out);
}

// ── 追踪 condition 级别 WARN（从 gate JSON 日志）─────────────────
function trackConditionWarns(taskId, paths) {
  const logDir = paths.runtime;
  if (!existsSync(logDir)) return;
  try {
    const files = readdirSync(logDir)
      .filter((f) => f.startsWith(`gate-${taskId}-`) && f.endsWith('.json'))
      .sort();
    if (!files.length) return;
    const latest = files[files.length - 1];
    const data = JSON.parse(readFileSync(join(logDir, latest), 'utf8'));
    const warnGates = (data.gates || []).filter((g) => !g.passed && g.severity === 'WARN');
    if (!warnGates.length) return;

    const stats = readJSON(paths.conditionStats);
    for (const g of warnGates) {
      if (!stats[g.name]) stats[g.name] = { warn_count: 0, last_seen: '' };
      stats[g.name].warn_count++;
      stats[g.name].last_seen = new Date().toISOString().slice(0, 10);
    }
    mkdirSync(dirname(paths.conditionStats), { recursive: true });
    writeJSON(paths.conditionStats, stats);
  } catch { /* 非关键 */ }
}

// ── --record ─────────────────────────────────────────────────────────
function record(args, paths) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `## [${date}] ${args.task}`,
    `- 结果: ${args.result}`,
  ];
  if (args.result === 'fail') {
    lines.push(`- 闸门: ${args.gate}`);
    lines.push(`- 踩坑: ${args.message}`);
    try {
      appendLearningRecord({
        type: 'failure',
        source: 'learn_cli',
        task_id: args.task,
        gate: args.gate,
        lesson: args.message,
        prevention: args.message,
        confidence: 5,
        status: 'advisory',
        tags: ['gate_failure'],
      }, { projectRoot: paths.projectRoot, stateRoot: paths.stateRoot });
    } catch { /* learning ledger is best-effort */ }
  } else {
    lines.push(`- 备注: ${args.message}`);
  }
  lines.push('---');
  mkdirSync(dirname(paths.progress), { recursive: true });
  appendFileSync(paths.progress, '\n' + lines.join('\n') + '\n', 'utf8');

  // 防止 progress.txt 无限增长：超过 800 行保留下半截
  try {
    const raw = readFileSync(paths.progress, 'utf8');
    const allLines = raw.split('\n');
    if (allLines.length > 800) {
      // 找到前 200 行的第一个完整条目后截断
      const headerIdx = allLines.findIndex((l, i) => i > 200 && l.trim() === '---');
      if (headerIdx > 0) {
        writeFileSync(paths.progress, allLines.slice(headerIdx).join('\n'), 'utf8');
      }
    }
  } catch { /* 非关键，忽略 */ }

  // 统计同类 gate 失败次数
  if (args.result === 'fail' && args.gate) {
    const stats = readJSON(paths.stats);
    const key = args.gate;
    stats[key] = (stats[key] || 0) + 1;
    mkdirSync(dirname(paths.stats), { recursive: true });
    writeJSON(paths.stats, stats);
    // 追踪 condition 级别的 WARN（WARN→FAIL 升级）
    if (args.task) trackConditionWarns(args.task, paths);
    // ≥2 次同步提炼规则写入 learned-rules.json
    if (stats[key] >= 2) {
      recordRule(args.gate, args.message, paths);
    }
  }
}

// 从失败信息提炼规则关键词
function extractRule(gate, message) {
  const clean = message.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 200);
  if (clean.includes('TS') || clean.includes('tsc')) return { source: 'tsc', rule: `类型错误: ${clean.slice(0, 80)}` };
  const gateRules = { '文件范围': '改动文件数或行数超标', '断言密度': '测试断言密度不足', '危险模式': '代码包含危险模式' };
  for (const [gateName, ruleText] of Object.entries(gateRules)) {
    if (clean.includes(gateName)) return { source: gateName, rule: ruleText };
  }
  return { source: gate, rule: clean.slice(0, 80) };
}

// 同类失败 ≥2 次 → 提炼规则写入 learned-rules.json
function recordRule(gate, message, paths) {
  const rules = readJSON(paths.rules);
  const { source, rule } = extractRule(gate, message);
  // 安全防护：禁止污染原型链
  if (source === '__proto__' || source === 'constructor' || source === 'prototype') return;
  // 去重：同 source 不重复写入
  if (rules[source]) return;
  rules[source] = { rule, strategy: rule, gate, since: new Date().toISOString().slice(0, 10), learned_at: new Date().toISOString().slice(0, 10) };
  mkdirSync(dirname(paths.rules), { recursive: true });
  writeJSON(paths.rules, rules);
}

// ── --escalate ───────────────────────────────────────────────────────
function escalate(paths) {
  const stats = readJSON(paths.conditionStats);
  const escalated = Object.entries(stats)
    .filter(([, v]) => Object.assign(Object(), v).warn_count >= 5)
    .map(([name, v]) => {
      const item = Object.assign(Object(), v);
      return { name, warn_count: item.warn_count, last_seen: item.last_seen };
    });
  process.stdout.write(JSON.stringify(escalated));
  process.exitCode = escalated.length > 0 ? 0 : 1;
}

// ── main ─────────────────────────────────────────────────────────────
export function runLearnCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const paths = resolveLearnPaths(args);
  if (!args.mode) {
    console.error('用法: node learn.js --load | --record --task=ID --result=pass|fail [--gate=闸门名] [--message="错误信息"] | --escalate [--project-root=<path>] [--state-root=<path>]');
    process.exitCode = 1;
    return { status: "error", code: "MISSING_MODE" };
  }
  if (args.mode === 'load') load(paths);
  if (args.mode === 'record') record(args, paths);
  if (args.mode === 'escalate') escalate(paths);
  return { status: "ok", mode: args.mode };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runLearnCli();
