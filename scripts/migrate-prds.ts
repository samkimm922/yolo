#!/usr/bin/env node
/**
 * migrate-prds.js — 一次性迁移脚本：PRD v1 → v2
 *
 * 将 data/ 和 closed-loop/ 下所有 PRD JSON 从 v1 格式迁移到 v2 格式。
 * 目标：全部通过 validate-prd.js --check-all 的 schema 校验。
 *
 * 处理的 v1 变体：
 *   1. 裸数组 (无顶层对象包装)
 *   2. 缺少 version / id / project / generated_by / generated_at / base_commit
 *   3. task.priority 为数字 (0-3) 而非字符串 (P0-P3)
 *   4. task.type 缺失；task_kind 替代 type 的旧格式
 *   5. task.status "done" → "completed"
 *   6. task.constraints → scope + pre_conditions + post_conditions + acceptance_criteria
 *   7. task.acceptance → acceptance_criteria
 *   8. condition 使用 condition+evaluator 而非 type+params
 *   9. 缺失 condition.id
 *   10. task id 格式不符合 ^[A-Z]+-[A-Z0-9-]+-[0-9]+$
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOLO_DIR = resolve(__dirname, '..');

const PRD_DIRS = [
  { dir: resolve(YOLO_DIR, 'data'),        pattern: (f) => f.startsWith('prd-') && f.endsWith('.json') },
  { dir: resolve(YOLO_DIR, 'closed-loop'), pattern: (f) => (f.startsWith('bugfix-prd-') || f.endsWith('-prd.json')) && f.endsWith('.json') },
];

// ── git commit ──
let baseCommit = '0000000';
try { baseCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: YOLO_DIR }).trim(); } catch {}

// ── 合法枚举值 ──
const VALID_GENERATED_BY = ['human', 'code-review-agent', 'security-review-agent', 'yolo-review-agent', 'other'];
const PRIORITY_MAP = { 0: 'P0', 1: 'P1', 2: 'P2', 3: 'P3' };
const TASK_KIND_TO_TYPE = {
  mechanical: 'bugfix',
  atomic_fix: 'bugfix',
  atomic_feature: 'feature',
  atomic_refactor: 'refactor',
  atomic_cleanup: 'cleanup',
};

// 旧 evaluator 名 → 新 condition type
const CONDITION_TYPE_MAP = {
  'line_count': 'file_lines_max',
  'code_line_count': 'file_lines_max',
  'file_line_count': 'file_lines_max',
  'function_line_count': 'file_lines_max',
  'max_lines': 'file_lines_max',
  'condition': 'code_contains', // fallback
};

// ── ID 生成 ──
let idCounter = 0;
function nextId() { idCounter++; return idCounter; }

function genPrdId(filename) {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const stem = filename.replace('.json', '').replace(/^prd-/, '').replace(/[^A-Z0-9]/g, '-').toUpperCase().slice(0, 20);
  return `PRD-${dateStr}-${stem}-${nextId()}`;
}

function genTaskId(existingId, type) {
  // 尝试修复已有 ID
  if (existingId && /^[A-Z]+-[A-Z0-9-]+-[0-9]+$/.test(existingId)) return existingId;

  // SH-01 → FIX-SH-01 (补前缀)
  if (existingId && /^[A-Z]+-[0-9]+$/.test(existingId)) {
    const parts = existingId.split('-');
    const prefix = (type || 'FIX').toUpperCase().slice(0, 6);
    return `${prefix}-${parts[0]}-${parts[1]}`;
  }

  // MECH-001-P1 → MECH-P1-001 (重新排列)
  if (existingId && /^[A-Z]+-[0-9]+-[A-Z0-9]+$/.test(existingId)) {
    const match = existingId.match(/^([A-Z]+)-([0-9]+)-([A-Z0-9]+)$/);
    if (match && /^[0-9]+$/.test(match[3])) {
      // 第三段纯数字 → 不需重排
      return existingId;
    }
    if (match && /^[0-9]+$/.test(match[2])) {
      // 第二段数字第三段非纯数字 → 交换
      return `${match[1]}-${match[3]}-${match[2]}`;
    }
  }

  // 兜底
  const prefix = (type || 'FIX').toUpperCase().slice(0, 6);
  return `${prefix}-TASK-${String(nextId()).padStart(3, '0')}`;
}

function genConditionId(role, localId, index) {
  if (localId && /^(PRE|POST|AUTO)-[A-Z0-9_-]+$/.test(localId)) return localId;
  const num = localId ? localId.replace(/[^0-9]/g, '') || String(index + 1) : String(index + 1);
  return `${role}-${num}`;
}

// ── 条件格式修复：condition+evaluator → type+params ──
function fixConditionFormat(cond, role, index) {
  if (!cond || typeof cond !== 'object') return cond;

  const fixed = { ...cond };

  // 修复 id
  fixed.id = genConditionId(role, fixed.id, index);

  // condition → type
  if (!fixed.type && fixed.condition) {
    fixed.type = fixed.condition;
    delete fixed.condition;
  }
  if (!fixed.type && fixed.evaluator) {
    fixed.type = fixed.evaluator;
    delete fixed.evaluator;
  }

  // 旧 evaluator 名 → 新 condition type
  if (fixed.type && CONDITION_TYPE_MAP[fixed.type]) {
    fixed.type = CONDITION_TYPE_MAP[fixed.type];
  }

  // evaluator 字段移除（v2 不使用）
  delete fixed.evaluator;

  // 确保 params 存在
  if (!fixed.params) {
    fixed.params = {};
    // 从旧字段迁移 common params
    if (fixed.file) { fixed.params.file = fixed.file; delete fixed.file; }
    if (fixed.text) { fixed.params.text = fixed.text; delete fixed.text; }
    if (fixed.pattern) { fixed.params.pattern = fixed.pattern; delete fixed.pattern; }
  }

  // 确保 severity
  if (!fixed.severity) fixed.severity = 'FAIL';

  // 清理 v1 残余字段
  delete fixed.file;
  delete fixed.text;
  delete fixed.pattern;
  delete fixed.condition;

  return fixed;
}

// ── constraints → scope + pre/post_conditions ──
function convertConstraints(task) {
  if (!task.constraints) return task;

  const c = task.constraints;

  // scope
  if (!task.scope) {
    const targets = [];
    if (c.target_file) {
      targets.push({ file: c.target_file });
    }
    if (c.target_files && Array.isArray(c.target_files)) {
      for (const f of c.target_files) {
        targets.push({ file: typeof f === 'string' ? f : f.file });
      }
    }
    task.scope = {
      targets: targets.length > 0 ? targets : [{ file: 'src/' }],
      max_files: c.max_files || 5,
      max_lines_per_file: c.max_lines || 150,
    };
  }

  // must_use → post_conditions
  if (c.must_use && Array.isArray(c.must_use) && c.must_use.length > 0) {
    task.post_conditions = task.post_conditions || [];
    c.must_use.forEach((pattern, i) => {
      task.post_conditions.push({
        id: `POST-MUST-${i + 1}`,
        type: 'code_contains',
        params: { text: pattern, file: c.target_file || '' },
        severity: 'FAIL',
      });
    });
  }

  // must_not_use → pre_conditions (should NOT be there before fix)
  if (c.must_not_use && Array.isArray(c.must_not_use) && c.must_not_use.length > 0) {
    task.pre_conditions = task.pre_conditions || [];
    c.must_not_use.forEach((pattern, i) => {
      task.pre_conditions.push({
        id: `PRE-MUSTNOT-${i + 1}`,
        type: 'code_not_contains',
        params: { text: pattern, file: c.target_file || '' },
        severity: 'FAIL',
      });
    });
  }

  // acceptance → acceptance_criteria
  if (c.acceptance && Array.isArray(c.acceptance) && c.acceptance.length > 0) {
    task.acceptance_criteria = task.acceptance_criteria || [];
    // 合并去重
    const existing = new Set(task.acceptance_criteria);
    for (const a of c.acceptance) {
      if (!existing.has(a)) {
        task.acceptance_criteria.push(a);
        existing.add(a);
      }
    }
  }

  delete task.constraints;
  return task;
}

// ── 修复单个 task ──
function fixTask(task) {
  // priority: 数字→字符串
  if (typeof task.priority === 'number') {
    task.priority = PRIORITY_MAP[task.priority] || 'P2';
  }
  if (!task.priority || !['P0', 'P1', 'P2', 'P3'].includes(task.priority)) {
    task.priority = 'P2';
  }

  // type
  if (!task.type) {
    if (task.task_kind && TASK_KIND_TO_TYPE[task.task_kind]) {
      task.type = TASK_KIND_TO_TYPE[task.task_kind];
    } else {
      task.type = 'bugfix';
    }
  }
  if (!['bugfix', 'feature', 'refactor', 'cleanup', 'security'].includes(task.type)) {
    task.type = 'bugfix';
  }

  // status
  if (task.status === 'done') task.status = 'completed';
  if (!task.status || !['pending', 'completed', 'invalid', 'skipped', 'stuck', 'failed', 'merged_into'].includes(task.status)) {
    task.status = 'pending';
  }

  // 截断过长 title（schema maxLength: 100）
  if (task.title && typeof task.title === 'string' && task.title.length > 100) {
    task.title = task.title.slice(0, 97) + '...';
  }

  // 修复 task id
  task.id = genTaskId(task.id, task.type);

  // constraints → scope + conditions (v1 核心差异)
  convertConstraints(task);

  // acceptance → acceptance_criteria (旧字段)
  if (task.acceptance && Array.isArray(task.acceptance)) {
    task.acceptance_criteria = task.acceptance_criteria || [];
    const existing = new Set(task.acceptance_criteria);
    for (const a of task.acceptance) {
      if (!existing.has(a)) {
        task.acceptance_criteria.push(a);
        existing.add(a);
      }
    }
    delete task.acceptance;
  }

  // 确保 scope 存在
  if (!task.scope || !task.scope.targets || task.scope.targets.length === 0) {
    task.scope = {
      targets: [{ file: 'src/' }],
      max_files: 5,
      max_lines_per_file: 150,
    };
  }

  // 修复条件格式：字符串→acceptance_criteria；对象→修复字段
  const preStrings = (task.pre_conditions || []).filter(c => typeof c === 'string');
  const postStrings = (task.post_conditions || []).filter(c => typeof c === 'string');
  const allStrings = [...preStrings, ...postStrings];
  if (allStrings.length > 0) {
    task.acceptance_criteria = task.acceptance_criteria || [];
    const existing = new Set(task.acceptance_criteria);
    for (const s of allStrings) {
      if (!existing.has(s)) { task.acceptance_criteria.push(s); existing.add(s); }
    }
  }
  task.pre_conditions = (task.pre_conditions || []).filter(c => typeof c !== 'string').map((c, i) => fixConditionFormat(c, 'PRE', i));
  task.post_conditions = (task.post_conditions || []).filter(c => typeof c !== 'string').map((c, i) => fixConditionFormat(c, 'POST', i));

  // 清理旧字段
  delete task.task_kind;
  delete task.phase;
  delete task.updatedAt;
  delete task.failReason;
  delete task.retry;  // v1 retry count number → 由 defaults.retry 或 task.retry object 处理

  return task;
}

// ── 迁移单个文件 ──
function migrateFile(filePath, fileName) {
  let prd;
  try {
    prd = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    return { file: fileName, ok: false, error: `JSON 解析失败: ${e.message}` };
  }

  // 1. 裸数组 → 包装
  if (Array.isArray(prd)) {
    prd = {
      tasks: prd,
    };
  }

  // 2. findings 格式 → 跳过
  if (prd.findings && !prd.tasks) {
    return { file: fileName, ok: false, skip: true, reason: 'findings 格式，非 PRD' };
  }

  // 3. 已经是 v2 → 跳过
  if (prd.version === '2.0' && prd.id && prd.project && prd.generated_by && prd.base_commit) {
    // 仍修复 tasks 内部格式（可能部分 task 有问题）
    let fixedAny = false;
    if (Array.isArray(prd.tasks)) {
      const originalTasks = JSON.stringify(prd.tasks);
      prd.tasks = prd.tasks.map(fixTask);
      if (JSON.stringify(prd.tasks) !== originalTasks) fixedAny = true;
    }
    if (!fixedAny) {
      // 仍修复 generated_by 和 base_commit（即使已是 v2 也可能不合法）
      if (!VALID_GENERATED_BY.includes(prd.generated_by)) {
        prd.generated_by = 'other';
        fixedAny = true;
      }
      if (!/^[a-f0-9]{7,40}$/.test(prd.base_commit || '')) {
        prd.base_commit = baseCommit;
        fixedAny = true;
      }
    }
    if (!fixedAny) {
      return { file: fileName, ok: true, skip: true, reason: '已是 v2' };
    }
    // 有修复，继续写入
  } else {
    // 4. v1 → v2 完整迁移

    // 顶层字段
    prd.$schema = prd.$schema || 'https://yolo.dev/schemas/prd-v2.schema.json';
    prd.version = '2.0';
    prd.id = prd.id || genPrdId(fileName);

    // 确保 ID 符合 pattern
    if (!/^[A-Z]+-[0-9]+-[A-Z0-9-]+$/.test(prd.id)) {
      prd.id = genPrdId(fileName);
    }

    prd.title = prd.title || 'PRD Migration';
    if (typeof prd.title !== 'string') prd.title = String(prd.title);

    prd.project = prd.project || { name: 'SamKimTest', language: 'typescript' };
    if (!prd.project.name) prd.project.name = 'SamKimTest';
    if (!prd.project.language) prd.project.language = 'typescript';

    prd.generated_by = prd.generated_by || 'other';
    if (!VALID_GENERATED_BY.includes(prd.generated_by)) {
      prd.generated_by = 'other';
    }

    prd.generated_at = prd.generated_at || new Date().toISOString();
    prd.base_commit = prd.base_commit || baseCommit;

    // 确保 base_commit 格式（pattern: ^[a-f0-9]{7,40}$）
    if (!/^[a-f0-9]{7,40}$/.test(prd.base_commit)) {
      prd.base_commit = baseCommit;
    }

    // 清理 v1 残余
    delete prd.source;
    delete prd.updatedAt;
  }

  // 处理 tasks
  if (!Array.isArray(prd.tasks) || prd.tasks.length === 0) {
    return { file: fileName, ok: false, error: 'tasks 为空或非数组' };
  }
  prd.tasks = prd.tasks.map(fixTask);

  // 写入
  writeFileSync(filePath, JSON.stringify(prd, null, 2) + '\n');
  return { file: fileName, ok: true, migrated: true };
}

// ── 执行 ──
console.log('[migrate-prds] PRD v1 → v2 迁移\n');

let total = 0;
let migrated = 0;
let skipped = 0;
let failed = 0;

for (const { dir, pattern } of PRD_DIRS) {
  if (!existsSync(dir)) {
    console.log(`  目录不存在: ${dir}`);
    continue;
  }

  const dirName = dir.replace(YOLO_DIR + '/', '');
  console.log(`[${dirName}/]`);

  for (const entry of readdirSync(dir)) {
    if (!pattern(entry)) continue;
    if (entry === 'package.json') continue;
    total++;

    const path = resolve(dir, entry);
    const result = migrateFile(path, entry);

    if (result.error) {
      console.log(`  ✗ ${entry}: ${result.error}`);
      failed++;
    } else if (result.skip) {
      console.log(`  - ${entry} (${result.reason})`);
      skipped++;
    } else {
      console.log(`  ✓ ${entry}`);
      migrated++;
    }
  }
}

console.log(`\n─────────────────────────────`);
console.log(`  合计: ${total}  迁移: ${migrated}  跳过: ${skipped}  失败: ${failed}`);
console.log(`─────────────────────────────`);
