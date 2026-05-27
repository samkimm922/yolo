#!/usr/bin/env node

/**
 * md2prd-v2.js — 模块深挖器 Markdown → YOLO PRD v2 JSON
 *
 * 用法:
 *   node md2prd-v2.js <深挖报告.md> [--project-name=xxx] [--language=typescript]
 *
 * 输出: stdout 写入 PRD v2 JSON
 *
 * 豁免规则：当 task title/description 包含以下关键词时，
 * 自动设置 scope.expected_zero_business_code = true
 *   - 交付 / 文档同步 / 更新 SESSION / 更新 DELIVERY_LOG
 *   - 备份 / 收尾 / 交付记录 / PROJECT_MAP / BUSINESS_RULES_RAW
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();

// ── 命令行参数 ──
const args = process.argv.slice(2);
const mdPath = args.find(a => a.endsWith('.md'));
const projectName = args.find(a => a.startsWith('--project-name='))?.split('=')[1] || 'unknown';
const language = args.find(a => a.startsWith('--language='))?.split('=')[1] || 'typescript';
const framework = args.find(a => a.startsWith('--framework='))?.split('=')[1] || 'generic';

if (!mdPath) {
  console.error('用法: node md2prd-v2.js <深挖报告.md> [--project-name=xxx] [--language=typescript]');
  process.exit(1);
}

const md = readFileSync(mdPath, 'utf-8');

// ── 豁免关键词 ──
const DOC_UPDATE_KEYWORDS = [
  '交付', '文档同步', '更新 SESSION', '更新 DELIVERY_LOG',
  '备份', '收尾', '交付记录', 'PROJECT_MAP', 'BUSINESS_RULES_RAW',
  'SESSION.md', 'DELIVERY_LOG.md'
];

function isDocUpdateTask(title = '', description = '') {
  const text = `${title} ${description}`;
  return DOC_UPDATE_KEYWORDS.some(kw => text.includes(kw));
}

// ── 解析工具 ──
function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fm;
}

function parseTable(text) {
  const lines = text.trim().split('\n');
  const headerIdx = lines.findIndex(l => l.startsWith('|'));
  if (headerIdx === -1) return [];
  const headers = lines[headerIdx].split('|').map(h => h.trim()).filter(Boolean);
  const results = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length === 0) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = cells[idx] || ''; });
    results.push(row);
  }
  return results;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function extractSection(md, heading) {
  const re = new RegExp(`#{2,4}\\s+${escapeRegex(heading)}[^\\n]*\\n+([\\s\\S]*?)(?=\\n#{2,4}\\s+|\\n#{1,2}\\s+|$)`, 'i');
  const m = md.match(re);
  return m ? m[1].trim() : '';
}

function extractModules(md) {
  const modules = [];
  const re = /###\s+(M\d+)\s*[·•]\s*(.+?)\s*\[(P[0-3])\]\s*\[依赖[：:]\s*(.+?)\]/g;
  let match;
  while ((match = re.exec(md)) !== null) {
    const [_, id, name, priority, depsRaw] = match;
    const deps = depsRaw === '无' ? [] : depsRaw.split(',').map(d => d.trim());
    const start = match.index;
    const nextRe = /###\s+M\d+\s*[·•]/g;
    nextRe.lastIndex = start + match[0].length;
    const nextMatch = nextRe.exec(md);
    const end = nextMatch ? nextMatch.index : md.length;
    modules.push({ id, name, priority, deps, section: md.slice(start, end) });
  }
  return modules;
}

// ── 构建 PRD ──
const fm = parseFrontmatter(md);
const now = new Date().toISOString();
let baseCommit = '0000000';
try { baseCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); } catch {}

const projectOverview = parseTable(extractSection(md, '项目概述'));
const projectInfo = {};
for (const row of projectOverview) projectInfo[row['属性']] = row['值'];

const moduleList = parseTable(extractSection(md, '模块列表'));
const modules = extractModules(md);

function inferTechStack(info) {
  const platform = (info['平台'] || '').toLowerCase();
  const stack = { language, framework, package_manager: 'pnpm' };
  if (platform.includes('小程序')) { stack.framework = 'taro'; stack.language = 'typescript'; }
  else if (platform.includes('web')) { stack.framework = framework === 'generic' ? 'react' : framework; }
  stack.type_checker = 'tsc --noEmit';
  stack.lint_tool = 'eslint';
  return stack;
}

const tech = inferTechStack(projectInfo);

function buildDataModelTask(mod) {
  const dataTable = parseTable(extractSection(mod.section, '数据模型'));
  if (dataTable.length === 0) return null;
  const fields = dataTable.map(r =>
    `- ${r['字段'] || ''}: ${r['类型'] || '文本'}${r['必填'] === '是' ? '，必填' : ''}${r['唯一'] === '是' ? '，唯一' : ''}${r['默认值'] && r['默认值'] !== '-' ? `，默认${r['默认值']}` : ''}`
  ).join('\n');

  const title = `${mod.name} — 数据模型`;
  const description = `定义 ${mod.name} 的数据字段和类型。\n\n字段清单：\n${fields}`;
  const scope = {
    targets: [{ file: `src/types/${mod.name.toLowerCase().replace(/\s+/g, '-')}.ts`, description: `${mod.name} 类型定义` }],
    allow_new_files: true,
    max_files: 3,
    max_lines_per_file: 150
  };
  if (isDocUpdateTask(title, description)) scope.expected_zero_business_code = true;

  return {
    id: `FEAT-${mod.id}-DATA`,
    title,
    priority: mod.priority,
    type: 'feature',
    status: 'pending',
    description,
    depends_on: mod.deps,
    scope,
    post_conditions: dataTable.map((r, i) => ({
      id: `POST-DATA-${i + 1}`,
      type: 'code_contains',
      params: { text: r['字段'] || `field_${i}` },
      severity: 'FAIL',
      description: `字段 ${r['字段']} 已定义（${r['类型']}，${r['必填'] === '是' ? '必填' : '可选'}）`
    }))
  };
}

function buildOperationsTask(mod) {
  const opsTable = parseTable(extractSection(mod.section, '操作清单'));
  if (opsTable.length === 0) return null;
  const ops = opsTable.map(r =>
    `- ${r['操作'] || ''}（${r['角色'] || '所有人'}）：${r['流程说明'] || ''}。异常：${r['异常处理'] || '无'}`
  ).join('\n');

  const title = `${mod.name} — 业务操作`;
  const description = `实现 ${mod.name} 的 CRUD 操作。\n\n操作清单：\n${ops}`;
  const scope = {
    targets: [
      { file: `src/services/${mod.name.toLowerCase().replace(/\s+/g, '-')}.service.ts`, description: `${mod.name} 业务逻辑` },
      { file: `src/hooks/use-${mod.name.toLowerCase().replace(/\s+/g, '-')}.ts`, description: `${mod.name} 数据 hook` }
    ],
    allow_new_files: true,
    max_files: 5,
    max_lines_per_file: 150
  };
  if (isDocUpdateTask(title, description)) scope.expected_zero_business_code = true;

  return {
    id: `FEAT-${mod.id}-OPS`,
    title,
    priority: mod.priority,
    type: 'feature',
    status: 'pending',
    description,
    depends_on: [...mod.deps, `FEAT-${mod.id}-DATA`],
    scope,
    post_conditions: [
      { id: 'POST-OPS-TSC', type: 'no_new_type_errors', params: {}, severity: 'FAIL' },
      { id: 'POST-OPS-LINT', type: 'no_new_lint_errors', params: {}, severity: 'FAIL' }
    ]
  };
}

function buildUITask(mod) {
  const displayTable = parseTable(extractSection(mod.section, '展示'));
  if (displayTable.length === 0) return null;
  const displayDesc = displayTable.map(r => {
    const parts = [];
    if (r['场景']) parts.push(`**${r['场景']}**`);
    if (r['排序']) parts.push(`排序：${r['排序']}`);
    if (r['筛选']) parts.push(`筛选：${r['筛选']}`);
    if (r['分页']) parts.push(`分页：${r['分页']}`);
    if (r['空状态']) parts.push(`空状态：${r['空状态']}`);
    if (r['备注']) parts.push(`备注：${r['备注']}`);
    return parts.join('，');
  }).join('\n');

  const title = `${mod.name} — 页面与交互`;
  const description = `实现 ${mod.name} 的页面和组件。\n\n展示规则：\n${displayDesc}`;
  const scope = {
    targets: [
      { file: `src/pages/${mod.name.toLowerCase().replace(/\s+/g, '-')}/index.tsx`, description: `${mod.name} 页面` },
      { file: `src/components/${mod.name.toLowerCase().replace(/\s+/g, '-')}/index.tsx`, description: `${mod.name} 组件` }
    ],
    allow_new_files: true,
    max_files: 8,
    max_lines_per_file: 150
  };
  if (isDocUpdateTask(title, description)) scope.expected_zero_business_code = true;

  return {
    id: `FEAT-${mod.id}-UI`,
    title,
    priority: mod.priority,
    type: 'feature',
    status: 'pending',
    description,
    depends_on: [...mod.deps, `FEAT-${mod.id}-OPS`],
    scope,
    post_conditions: [
      { id: 'POST-UI-TSC', type: 'no_new_type_errors', params: {}, severity: 'FAIL' },
      { id: 'POST-UI-LINT', type: 'no_new_lint_errors', params: {}, severity: 'FAIL' }
    ]
  };
}

// ── 组装 ──
const tasks = [];
for (const mod of modules) {
  const dataTask = buildDataModelTask(mod);
  if (dataTask) tasks.push(dataTask);
  const opsTask = buildOperationsTask(mod);
  if (opsTask) tasks.push(opsTask);
  const uiTask = buildUITask(mod);
  if (uiTask) tasks.push(uiTask);
}

// 无详情时从模块列表生成骨架
if (tasks.length === 0 && moduleList.length > 0) {
  for (const mod of moduleList) {
    const title = `${mod['模块名']} — 完整实现`;
    const description = `实现 ${mod['模块名']} 模块。依赖：${mod['依赖'] || '无'}。`;
    const scope = {
      targets: [{ file: 'src/', description: '项目源代码' }],
      allow_new_files: true,
      max_files: 10,
      max_lines_per_file: 150
    };
    if (isDocUpdateTask(title, description)) scope.expected_zero_business_code = true;

    tasks.push({
      id: `FEAT-${mod['编号']}-IMPL`,
      title,
      priority: mod['优先级'] || 'P1',
      type: 'feature',
      status: 'pending',
      description,
      depends_on: mod['依赖'] && mod['依赖'] !== '无' ? mod['依赖'].split(',').map(d => d.trim()) : [],
      scope,
      post_conditions: [
        { id: 'POST-TSC', type: 'no_new_type_errors', params: {}, severity: 'FAIL' },
        { id: 'POST-LINT', type: 'no_new_lint_errors', params: {}, severity: 'FAIL' }
      ]
    });
  }
}

const prdId = fm.deep_dive_id
  ? fm.deep_dive_id.replace('DD-', 'PRD-')
  : `PRD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-DEEP-DIVE`;

const prdTitle = (md.match(/^#\s+(.+)$/m) || [])[1] || '未命名';

const prd = {
  $schema: 'https://yolo.dev/schemas/prd-v2.schema.json',
  version: '2.0',
  id: prdId,
  title: prdTitle,
  description: `由模块深挖器生成。${fm.total_questions ? `共 ${fm.total_questions} 问。` : ''}模式：${fm.mode || 'guided'}。`,
  project: {
    name: projectName,
    language: tech.language,
    framework: tech.framework,
    package_manager: tech.package_manager || 'pnpm',
    test_framework: tech.test_framework,
    lint_tool: tech.lint_tool || 'eslint',
    type_checker: tech.type_checker
  },
  generated_by: 'module-deep-dive',
  generated_at: now,
  base_commit: baseCommit,
  tasks,
  defaults: {
    retry: { max_retries: 3, backoff_ms: 5000 },
    scope: {
      max_files: 5,
      max_lines_per_file: 150,
      allow_new_files: true,
      forbidden_patterns: [
        { pattern: 'as any', severity: 'FAIL', description: '禁止 as any 类型断言' },
        { pattern: 'console\\.log', severity: 'WARN', description: '避免遗留 console.log' }
      ]
    }
  },
  conflict_policy: {
    on_overlap: 'sequential',
    overlap_detection: 'file_only'
  }
};

console.log(JSON.stringify(prd, null, 2));
