// scanner-to-task.js — 将 scanner 发现转换为 v2 PRD 任务
// 输入: review-scanner.js 的输出 findings 数组
// 输出: { autoFixTasks, claudeFixTasks, infoCount }

// ── Severity → Priority 映射 ─────────────────────────────────

function severityToPriority(severity) {
  switch (severity) {
    case 'CRITICAL': return 'P1';
    case 'HIGH':     return 'P2';
    case 'MEDIUM':   return 'P3';
    case 'LOW':      return 'P4';
    default:         return 'P4';
  }
}

// ── ID 序列生成器 ────────────────────────────────────────────

function createIdGenerator() {
  let seq = 0;
  return { nextId: () => { seq++; return String(seq).padStart(3, '0'); }, current: () => seq };
}

// ── 工具函数 ─────────────────────────────────────────────────

/** 取一组 findings 中最高的 severity → priority */
function maxPriority(findings) {
  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  let max = 'LOW';
  for (const f of findings) {
    if (order.indexOf(f.severity) < order.indexOf(max)) {
      max = f.severity;
    }
  }
  return severityToPriority(max);
}

/** 清理 scanner_id 为非字母数字下划线连字符的格式，用于 pre/post condition id */
function cleanScannerId(scanner_id) {
  return scanner_id.replace(/[^A-Z0-9_-]/gi, '');
}

// ── 主函数 ───────────────────────────────────────────────────

/**
 * @param {Array} findings - review-scanner.js 输出的 findings 数组
 * @param {number} [round=1] - 轮次号
 * @returns {{ autoFixTasks: Array, claudeFixTasks: Array, infoCount: number }}
 */
export function scannerToTasks(findings, round = 1) {
  const idGen = createIdGenerator();
  const autoFixTasks = [];
  const claudeFixTasks = [];

  // 分离 findings
  const infoFindings = findings.filter(f => f.fix_type === 'INFO');
  const autoFindings = findings.filter(f => f.fix_type === 'AUTO_FIX');
  const claudeFindings = findings.filter(f => f.fix_type === 'CLAUDE_FIX');

  // 1. AUTO_FIX: 按 scanner_id 分组（同一 rule → 1 个 task）
  const autoGroups = new Map();
  for (const f of autoFindings) {
    const key = f.scanner_id;
    if (!autoGroups.has(key)) autoGroups.set(key, []);
    autoGroups.get(key).push(f);
  }

  for (const [scanner_id, group] of autoGroups) {
    const seq = idGen.nextId();
    const files = [...new Set(group.map(f => f.file))];
    autoFixTasks.push({
      id: `AUTO-FIX-R${round}-${seq}`,
      title: `[AUTO] ${scanner_id}: ${group.length} instances across ${files.length} files`,
      type: 'cleanup',
      priority: maxPriority(group),
      status: 'pending',
      description: [
        `Auto-fix ${group.length} instances of ${scanner_id}.`,
        `Rule: ${group[0].description}`,
        'Files:',
        ...group.map(f => `- ${f.file}:${f.line}`),
      ].join('\n'),
      scope: {
        targets: [...new Set(group.map(f => ({ file: f.file })))],
        max_files: files.length + 2,
        max_lines_per_file: 200,
      },
      task_kind: 'review_fix',
      fix_type: 'AUTO_FIX',
      fix_rule: scanner_id,
      fix_findings: group,
      // AUTO_FIX 无 pre_conditions（确定性操作）
      post_conditions: [
        {
          id: 'POST-TSC',
          type: 'no_new_type_errors',
          params: {},
          severity: 'FAIL',
          message: '不能引入新 TSC 错误',
        },
        {
          id: 'POST-LINT',
          type: 'no_new_lint_errors',
          params: {},
          severity: 'FAIL',
          message: '不能引入新 lint 错误',
        },
      ],
      acceptance_criteria: [
        `${scanner_id} 模式已从所有目标文件移除`,
      ],
    });
  }

  // 2. CLAUDE_FIX: 按 file 分组（同一文件 → 1 个 task）
  const claudeGroups = new Map();
  for (const f of claudeFindings) {
    const key = f.file;
    if (!claudeGroups.has(key)) claudeGroups.set(key, []);
    claudeGroups.get(key).push(f);
  }

  for (const [file, group] of claudeGroups) {
    const seq = idGen.nextId();
    const count = group.length;
    claudeFixTasks.push({
      id: `FIX-R${round}-${seq}`,
      title: `[code] ${file}: ${count} 个代码问题`,
      type: count > 3 ? 'refactor' : 'bugfix',
      priority: maxPriority(group),
      status: 'pending',
      description: [
        `Fix ${count} issues in ${file}:`,
        '',
        ...group.map(f => {
          const matched = f.match ? f.match : '';
          return `  Line ${f.line}: [${f.scanner_id}] ${f.severity} — ${f.description} (matched: "${matched.slice(0, 80)}")`;
        }),
        '',
        'Fix ALL issues. Do NOT change unrelated code. Keep file <= 150 lines.',
      ].join('\n'),
      scope: {
        targets: [{ file }],
        max_files: 3,
        max_lines_per_file: 200,
      },
      pre_conditions: group.map(f => ({
        id: `PRE-${cleanScannerId(f.scanner_id)}-${f.line}`,
        type: 'code_contains',
        params: { file: f.file, text: f.match ? f.match.slice(0, 80) : '' },
        severity: 'FAIL',
      })),
      post_conditions: [
        {
          id: 'POST-TSC',
          type: 'no_new_type_errors',
          params: {},
          severity: 'FAIL',
          message: '不能引入新 TSC 错误',
        },
        {
          id: 'POST-LINT',
          type: 'no_new_lint_errors',
          params: {},
          severity: 'FAIL',
          message: '不能引入新 lint 错误',
        },
        ...group.map(f => ({
          id: `POST-${cleanScannerId(f.scanner_id)}-${f.line}`,
          type: 'code_not_contains',
          params: { file: f.file, text: f.match ? f.match.slice(0, 80) : '' },
          severity: 'WARN',
          message: `${f.scanner_id} 模式应移除`,
        })),
      ],
      acceptance_criteria: group.map(f =>
        `${f.file}:${f.line} ${f.scanner_id} 已修复`,
      ),
      task_kind: 'review_fix',
      fix_type: 'CLAUDE_FIX',
    });
  }

  return {
    autoFixTasks,
    claudeFixTasks,
    infoCount: infoFindings.length,
  };
}
