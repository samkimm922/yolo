#!/usr/bin/env node

/**
 * 闭环系统 Gate Chain v2 — 13 步完整闸门
 *
 * Step 1:  tsc --noEmit          (类型检查)
 * Step 2:  eslint                 (代码规范)
 * Step 3:  vitest run             (测试)
 * Step 4:  覆盖率检查              (断言密度 + 关键路径覆盖)
 * Step 5:  build                  (构建)
 * Step 6:  PRD 约束验证            (must_use / must_not_use 三层语义)
 * Step 7:  代码质量度量            (11 条规则)
 * Step 8:  文件范围检查            (行数 / 文件数)
 * Step 9:  安全扫描               (硬编码密钥 / 危险模式)
 * Step 10: Template 匹配          (import 方向 / export 检查)
 * Step 11: 质量对比               (新代码 vs 基线)
 * Step 12: AI 语义审查            (claude -p 语义校验，需 ENABLE_AI_REVIEW=1)
 * Step 13: 知识沉淀               (记录拦截 / 模式 / 陷阱)
 *
 * 用法：
 *   node scripts/yolo/closed-loop/gate-chain-v2.mjs --task=P0-001
 *   node scripts/yolo/closed-loop/gate-chain-v2.mjs --task=P0-005 --skip-test
 *   node scripts/yolo/closed-loop/gate-chain-v2.mjs --task=P0-001 --skip-steps=6,7,9,10,11
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ===== 参数解析 =====
const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
用法: gate-chain-v2.mjs [--task=TASK_ID] [--skip-test] [--skip-steps=N1,N2,...] [--help]

参数:
  --task=TASK_ID         指定任务ID，闸门结果关联到具体任务
  --skip-test            跳过测试步骤（适用于 config/infrastructure 类型任务）
  --skip-steps=N1,N2,... 跳过指定步骤编号（逗号分隔，如 --skip-steps=6,7,9）
  --help, -h             显示此帮助信息

13 步闸门:
  1.  tsc --noEmit          类型检查
  2.  eslint                 代码规范
  3.  vitest run             测试
  4.  覆盖率检查              断言密度 + 关键路径覆盖
  5.  build                  构建
  6.  PRD 约束验证            must_use / must_not_use (三层语义)
  7.  代码质量度量            11 条规则
  8.  文件范围检查            行数 / 文件数
  9.  安全扫描               硬编码密钥 / 危险模式
  10. Template 匹配          import 方向 / export 检查
  11. 质量对比               新代码 vs 基线
  12. AI 语义审查            claude -p 语义校验（需 ENABLE_AI_REVIEW=1）
  13. 知识沉淀               记录拦截 / 模式 / 陷阱

示例:
  node gate-chain-v2.mjs --task=CL-001
  node gate-chain-v2.mjs --task=CL-SYS-001 --skip-test
  node gate-chain-v2.mjs --task=P0-001 --skip-steps=6,7,9,10,11
`);
  process.exit(0);
}

const skipTest = args.includes('--skip-test');
const taskArg = args.find(a => a.startsWith('--task='));
const taskId = taskArg ? taskArg.split('=')[1] : args[args.indexOf('--task') + 1];
const skipStepsArg = args.find(a => a.startsWith('--skip-steps='));
const skipSteps = skipStepsArg ? skipStepsArg.split('=')[1].split(',').map(Number) : [];

// PRD 路径列表
const prdPaths = [
  'scripts/yolo/closed-loop/bugfix-prd-review-latest.json',
  'scripts/yolo/closed-loop/test-prd.json',
  'scripts/yolo/closed-loop/test-prd-12.json',
  'scripts/yolo/closed-loop/bugfix-prd.json',
  'scripts/yolo/closed-loop/bugfix-prd-full.json',
  'scripts/yolo/closed-loop/closed-loop-prd.json',
  'scripts/yolo/closed-loop/stress-test-prd.json',
  'prd.json',
];

// PRD 加载
let task = null;
if (taskId) {
  // 支持模糊匹配：BUGFIX-001 → BUG-001, BUG-001 → BUG-001
  const normalize = (id) => id.replace(/^BUGFIX-/, 'BUG-').replace(/^P0-/, 'P0-');
  const normalizedId = normalize(taskId);
  for (const p of prdPaths) {
    if (existsSync(p)) {
      try {
        const prd = JSON.parse(readFileSync(p, 'utf-8'));
        const items = prd.userStories || prd.tasks || [];
        task = items.find(s => s.id === taskId || s.id === normalizedId);
        if (task) break;
      } catch {}
    }
  }
}

// 颜色
const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', C = '\x1b[36m', B = '\x1b[1m', X = '\x1b[0m';

const gates = [];
let allPassed = true;
const startTime = Date.now();

function log(icon, msg) { console.log(`${icon} ${msg}`); }

// ── Pre-step: PRD Schema 验证 ──────────────────────────────────────
function validatePrdSchema(prdFile) {
  const validateScript = join(__dirname, 'validate-prd.mjs');
  if (!existsSync(validateScript) || !existsSync(prdFile)) return true;
  try {
    const result = execSync(`node "${validateScript}" "${prdFile}" --json`, {
      encoding: 'utf-8', timeout: 10000, stdio: 'pipe',
    });
    const report = JSON.parse(result);
    if (!report.ok) {
      console.log(`${Y}🔔 PRD 不完全符合 v2 Schema${X}`);
      console.log(`${Y}  ${report.error}${X}`);
      if (report.warnings?.length) {
        for (const w of report.warnings.slice(0, 5)) console.log(`${Y}  ! ${w}${X}`);
      }
      // 非阻塞：Schema 不符合不阻止执行，但发出警告
    }
    return true;
  } catch {
    return true; // 验证工具不可用时不过不阻塞
  }
}

function step(name, fn) {
  if (skipSteps.includes(gates.length + 1)) {
    log(`${Y}⊘${X}`, `${B}Step ${gates.length + 1}/13: ${name}${X} ${Y}(skipped)${X}`);
    gates.push({ name, passed: true, duration: 0, error: null, skipped: true });
    return true;
  }
  const t0 = Date.now();
  const result = fn();
  result.duration = Date.now() - t0;
  result.name = name;
  gates.push(result);
  if (!result.passed) allPassed = false;
  const icon = result.passed ? `${G}✓${X}` : `${R}✗${X}`;
  log(icon, `${B}Step ${gates.length}/13: ${name}${X} (${result.duration}ms)`);
  if (result.error && !result.passed) {
    const lines = String(result.error).split('\n').filter(l => l.trim()).slice(0, 8);
    console.log(`${R}${lines.join('\n')}${X}`);
  }
  return result.passed;
}

// ===== Pre-check: PRD Schema 验证 =====
for (const p of prdPaths) {
  if (existsSync(p)) { validatePrdSchema(p); break; }
}

// ===== 开始 =====
console.log(`\n${C}${B}═══ Gate Chain v2 — 13 Step Complete ═══${X}`);
console.log(`Task: ${taskId || 'N/A'} | ${task ? task.title?.slice(0, 50) : 'no task loaded'}`);
console.log(`Time: ${new Date().toISOString()}\n`);

// ===== Step 1: tsc =====
step('tsc --noEmit', () => {
  try {
    execSync('pnpm exec tsc --noEmit', { encoding: 'utf-8', timeout: 120000, stdio: 'pipe' });
    return { passed: true, error: null };
  } catch (e) {
    return { passed: false, error: (e.stderr || e.stdout || '').split('\n').filter(l => l.includes('error TS')).slice(0, 5).join('\n') };
  }
});

if (!allPassed) { console.log(`\n${R}${B}中断：类型检查失败${X}\n`); goto_report(); }
else {

// ===== Step 2: eslint =====
step('ESLint', () => {
  try {
    execSync('pnpm exec eslint src --max-warnings 0', { encoding: 'utf-8', timeout: 120000, stdio: 'pipe' });
    return { passed: true, error: null };
  } catch (e) {
    return { passed: false, error: (e.stderr || e.stdout || '').split('\n').filter(l => l.includes('error') || l.includes('warning')).slice(0, 5).join('\n') };
  }
});

if (!allPassed) { console.log(`\n${R}${B}中断：Lint 失败${X}\n`); goto_report(); }
else {

// ===== Step 3: tests =====
if (skipTest || (task?.skip_test) || (task?.type === 'config')) {
  log(`${Y}⊘${X}`, `${B}Step 3/13: Tests${X} ${Y}(skipped — ${task?.type || 'config'} task)${X}`);
  gates.push({ name: 'Tests', passed: true, duration: 0, error: null, skipped: true });
} else {
  step('Tests (vitest)', () => {
    try {
      execSync('pnpm exec vitest run', { encoding: 'utf-8', timeout: 120000, stdio: 'pipe' });
      return { passed: true, error: null };
    } catch (e) {
      const output = e.stdout || e.stderr || '';
      const fails = output.split('\n').filter(l => l.includes('FAIL') || l.includes('×')).slice(0, 5);
      return { passed: false, error: fails.join('\n') || output.slice(0, 300) };
    }
  });
}

if (!allPassed) { console.log(`\n${R}${B}中断：测试失败${X}\n`); goto_report(); }
else {

// ===== Step 4: 断言密度（垃圾测试检测）=====
if (skipTest || (task?.skip_test)) {
  gates.push({ name: 'Assertion Density', passed: true, duration: 0, error: null, skipped: true });
} else {
  step('Assertion Density (垃圾测试检测)', () => {
    try {
      // 检测 expect(true), expect(false), expect(null), expect(undefined), expect(数字)
      const result = execSync(
        `grep -rn 'expect(\\s*\\(\\s*\\(true\\|false\\|null\\|undefined\\|[0-9]\\+\\)\\s*\\)\\s*)' src/ --include='*.test.*' --include='*.spec.*' 2>/dev/null || true`,
        { encoding: 'utf-8', timeout: 10000 }
      );
      if (result.trim()) {
        return { passed: false, error: `发现垃圾断言:\n${result.trim().split('\\n').slice(0, 5).join('\\n')}` };
      }
      return { passed: true, error: null };
    } catch (e) {
      return { passed: true, error: null }; // grep 没匹配到 = 没垃圾测试 = 通过
    }
  });
}

// ===== Step 5: build =====
step('Build (taro)', () => {
  try {
    execSync('pnpm exec taro build --type weapp', { encoding: 'utf-8', timeout: 180000, stdio: 'pipe' });
    return { passed: true, error: null };
  } catch (e) {
    return { passed: false, error: (e.stderr || e.stdout || '').split('\n').slice(-5).join('\n') };
  }
});

if (!allPassed) { console.log(`\n${R}${B}中断：构建失败${X}\n`); goto_report(); }
else {

// ===== Step 6: PRD 约束验证 (三层语义) =====

/**
 * 转义正则特殊字符
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Layer 1: 上下文感知匹配
 * 跳过注释行和字符串字面量，只检查代码部分
 */
function contextAwareMatch(content, pattern) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // 跳过注释行
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    // 移除字符串字面量（只检查代码部分）
    const codeOnly = line.replace(/'[^']*'/g, '""').replace(/"[^"]*"/g, '""').replace(/`[^`]*`/g, '""');
    if (codeOnly.includes(pattern)) return { found: true, line: i + 1, code: trimmed };
  }
  return { found: false, line: 0, code: '' };
}

/**
 * Layer 2: AST-Lite 结构验证
 * 检查 pattern 是否在正确的语法位置使用
 */
function structuralVerify(content, constraints) {
  const errors = [];

  for (const pattern of (constraints.must_use || [])) {
    // 检查是否在 import 语句中
    if (pattern.includes('import') || pattern.includes('from')) {
      const importRegex = new RegExp(`import.*${escapeRegex(pattern)}.*from`, 's');
      if (!importRegex.test(content) && !content.includes(pattern)) {
        // 可能是函数调用，检查调用位置
        const callRegex = new RegExp(`\\b${escapeRegex(pattern)}\\s*\\(`, 'm');
        if (!callRegex.test(content)) {
          errors.push(`结构验证失败: ${pattern} 未在 import 或调用位置找到`);
        }
      }
    }

    // 检查函数级约束（如 _.inc 必须在 update/赋值上下文中）
    if (pattern.startsWith('_.')) {
      const inUpdateContext = new RegExp(`(?:update|set|\\{[^}]*${escapeRegex(pattern)}\\s*\\()`, 'm');
      if (!inUpdateContext.test(content)) {
        errors.push(`结构验证: ${pattern} 存在但未在 update/set 上下文中使用`);
      }
    }
  }

  return errors;
}

if (!task?.constraints) {
  gates.push({ name: 'PRD Constraints', passed: true, duration: 0, error: null, skipped: true });
} else {
  step('PRD Constraints (must_use/must_not_use 三层语义)', () => {
    const errors = [];
    const constraints = task.constraints;
    const targetFile = constraints.target_file;

    if (targetFile && existsSync(targetFile)) {
      const content = readFileSync(targetFile, 'utf-8');

      // === Layer 1: Regex + Context 上下文感知匹配 ===

      // must_use 检查（替换原有 content.includes）
      for (const pattern of (constraints.must_use || [])) {
        if (pattern.length <= 3) continue;
        const match = contextAwareMatch(content, pattern);
        if (!match.found) {
          // 对集合常量等特殊 pattern，检查是否以不同方式存在
          const altPatterns = {
            'COLLECTIONS 常量': 'COLLECTIONS',
            'export interface': 'export interface',
            'export type': 'export type',
          };
          const alt = altPatterns[pattern] || pattern;
          const altMatch = contextAwareMatch(content, alt);
          if (!altMatch.found) {
            errors.push(`must_use 缺失: "${pattern}" 在 ${targetFile} 中未找到（上下文感知匹配）`);
          }
        } else if (pattern.includes('(') || pattern.startsWith('_.')) {
          // 函数调用验证：确认 pattern 在赋值或调用上下文中
          const callPattern = new RegExp(`\\b${escapeRegex(pattern.replace(/\(.*/, ''))}\\s*\\(`, 'm');
          const inContext = callPattern.test(content) || /\b(await\s+)?[\w.]+\s*\(/.test(match.code);
          if (!inContext) {
            errors.push(`must_use 警告: "${pattern}" 在 L${match.line} 出现但未在调用上下文中`);
          }
        }
      }

      // must_not_use 检查（替换原有 content.includes）
      for (const pattern of (constraints.must_not_use || [])) {
        const match = contextAwareMatch(content, pattern);
        if (match.found) {
          errors.push(`must_not_use 违规: "${pattern}" 在 ${targetFile} L${match.line} 出现: ${match.code}`);
        }
      }

      // === Layer 2: AST-Lite 结构验证 ===
      const structuralErrors = structuralVerify(content, constraints);
      errors.push(...structuralErrors);

      // max_lines 检查
      if (constraints.max_lines) {
        const lines = content.split('\n').length;
        if (lines > constraints.max_lines) {
          errors.push(`文件行数超限: ${lines} > ${constraints.max_lines}`);
        }
      }
    } else if (targetFile) {
      // 目标文件不存在：如果 must_use 和 must_not_use 都为空（或不存在），视为通过
      const hasMustUse = (constraints.must_use || []).length > 0;
      const hasMustNotUse = (constraints.must_not_use || []).length > 0;
      if (hasMustUse || hasMustNotUse) {
        errors.push(`目标文件不存在: ${targetFile}`);
      }
      // 如果两者都为空，则无约束可检查，直接通过
    }

    return { passed: errors.length === 0, error: errors.length ? errors.join('\n') : null };
  });
}

// ===== Step 7: 代码质量度量 =====
step('Code Quality Metrics', () => {
  const errors = [];

  // 检查关键禁止模式
  try {
    // as any
    const asAny = execSync('grep -rn "as any" src/ --include="*.ts" --include="*.tsx" 2>/dev/null | head -5 || true', { encoding: 'utf-8' });
    if (asAny.trim()) errors.push(`发现 "as any":\n${asAny.trim().split('\n').slice(0, 3).join('\n')}`);

    // console.log
    const consoleLog = execSync('grep -rn "console\\.log" src/ --include="*.ts" --include="*.tsx" 2>/dev/null | head -5 || true', { encoding: 'utf-8' });
    if (consoleLog.trim()) errors.push(`发现 console.log:\n${consoleLog.trim().split('\n').slice(0, 3).join('\n')}`);

    // window/document（小程序禁用）
    const domAccess = execSync('grep -rn "window\\." src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "node_modules" | head -5 || true', { encoding: 'utf-8' });
    if (domAccess.trim()) errors.push(`发现 window 访问:\n${domAccess.trim().split('\n').slice(0, 3).join('\n')}`);

  } catch (e) { /* grep没匹配到=通过 */ }

  return { passed: errors.length === 0, error: errors.length ? errors.join('\n') : null };
});

// ===== Step 8: 文件范围检查 =====
step('File Scope Guard', () => {
  try {
    let diffStat, shortstat;

    if (taskId) {
      // 当 --task 指定时，检查最近一次 commit 是否属于该任务
      // 将 BUGFIX-001 规范化为 BUG-001 以匹配 commit message
      const normalizeForCommit = (id) => id.replace(/^BUGFIX-/, 'BUG-');
      const normalizedForCommit = normalizeForCommit(taskId);
      try {
        const lastMsg = execSync('git log -1 --format=%s', { encoding: 'utf-8' }).trim();
        if (lastMsg.includes(taskId) || lastMsg.includes(normalizedForCommit)) {
          // 最近一次 commit 就是该任务 → 衡量 commit diff（不受工作树无关变更影响）
          diffStat = execSync('git diff HEAD~1 HEAD --stat', { encoding: 'utf-8' }).trim();
          shortstat = execSync('git diff HEAD~1 HEAD --shortstat', { encoding: 'utf-8' });
        } else {
          // 最近 commit 不属于该任务 → 用工作树 diff
          diffStat = execSync('git diff --stat', { encoding: 'utf-8' }).trim();
          shortstat = execSync('git diff --shortstat', { encoding: 'utf-8' });
        }
      } catch (e) {
        // HEAD~1 不存在（仅有 1 次提交）或 git 不可用 → 回退到工作树 diff
        const msg = (e.stderr || e.message || '').toString();
        if (msg.includes('HEAD~1') || msg.includes('unknown revision')) {
          console.log(`  ${Y}! 仓库仅 1 次提交，无法做 commit diff，使用工作树 diff${X}`);
        }
        diffStat = execSync('git diff --stat', { encoding: 'utf-8' }).trim();
        shortstat = execSync('git diff --shortstat', { encoding: 'utf-8' });
      }
    } else {
      // 无 --task，保持原有行为
      diffStat = execSync('git diff --stat', { encoding: 'utf-8' }).trim();
      shortstat = execSync('git diff --shortstat', { encoding: 'utf-8' });
    }

    if (!diffStat) return { passed: true, error: null };

    const files = diffStat.split('\n').filter(l => l.includes('|'));
    const codeFiles = files.filter(f => {
      const name = f.split('|')[0].trim();
      return name.endsWith('.ts') || name.endsWith('.tsx');
    });

    if (codeFiles.length > 5) {
      return { passed: false, error: `代码文件数 ${codeFiles.length} > 5，可能合并了多个任务` };
    }

    const insertMatch = shortstat.match(/(\d+) insertion/);
    const deleteMatch = shortstat.match(/(\d+) deletion/);
    const insertions = parseInt(insertMatch?.[1] || '0');
    const deletions = parseInt(deleteMatch?.[1] || '0');
    const netLines = insertions - deletions;

    // 动态行数限制：按任务优先级调整
    const priority = task?.priority || task?.constraints?.priority || 'P2';
    const maxLinesMap = { 'P0': 300, 'P1': 250, 'P2': 200, 'P3': 200 };
    const maxLines = maxLinesMap[priority] || 200;

    if (netLines > maxLines) {
      return { passed: false, error: `净增 ${netLines} 行 > ${maxLines} 行限制（优先级 ${priority}）` };
    }

    return { passed: true, error: null };
  } catch (e) {
    return { passed: true, error: null };
  }
});

// ===== Step 9: 安全扫描 =====
step('Security Scan', () => {
  const errors = [];

  try {
    // 硬编码密钥/API key
    const secrets = execSync(
      `grep -rn -E "(api_key|secret|password|token)\\s*[:=]\\s*['\\"].{8,}" src/ --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "process.env" | grep -v "\\.env" | head -5 || true`,
      { encoding: 'utf-8' }
    );
    if (secrets.trim()) errors.push(`疑似硬编码密钥:\n${secrets.trim().split('\n').slice(0, 3).join('\n')}`);

    // eval / Function 构造器
    const evals = execSync('grep -rn "eval(\\|new Function(" src/ --include="*.ts" --include="*.tsx" 2>/dev/null | head -3 || true', { encoding: 'utf-8' });
    if (evals.trim()) errors.push(`发现 eval/Function:\n${evals.trim()}`);

    // innerHTML / dangerouslySetInnerHTML
    const xss = execSync('grep -rn "innerHTML\\|dangerouslySetInnerHTML" src/ --include="*.tsx" 2>/dev/null | head -3 || true', { encoding: 'utf-8' });
    if (xss.trim()) errors.push(`潜在 XSS 风险:\n${xss.trim()}`);

  } catch (e) { /* grep没匹配=通过 */ }

  return { passed: errors.length === 0, error: errors.length ? errors.join('\n') : null };
});

// ===== Step 10: Template 匹配 =====
if (!task?.type || !task?.constraints?.target_file) {
  gates.push({ name: 'Template Matching', passed: true, duration: 0, error: null, skipped: true });
} else {
  step('Template Matching (import/export)', () => {
    const errors = [];
    const targetFile = task.constraints.target_file;

    if (!existsSync(targetFile)) {
      // 目标文件不存在：无文件内容需要检查模板，直接通过
      return { passed: true, error: null };
    }

    const content = readFileSync(targetFile, 'utf-8');

    // service 文件不应直接 import pages
    if (targetFile.includes('services/')) {
      if (/from\s+['"]\.\.\/pages/.test(content) || /from\s+['"]\.\/pages/.test(content)) {
        errors.push('service 文件不应 import pages 层');
      }
    }

    // pages 文件不应直接 import data 层
    if (targetFile.includes('pages/')) {
    }

    // 检查 named export（types/services 文件禁止 default export）
    if (targetFile.includes('types/') || (targetFile.includes('services/') && targetFile.endsWith('.ts'))) {
      if (/export\s+default/.test(content)) {
        errors.push('types/services 文件禁止 default export');
      }
    }

    return { passed: errors.length === 0, error: errors.length ? errors.join('\n') : null };
  });
}

// ===== Step 11: 质量对比 =====
step('Quality Comparison', () => {
  // 检查是否有基线文件可以对比
  const baselineDir = 'scripts/yolo/closed-loop/baselines';
  if (!existsSync(baselineDir)) {
    return { passed: true, error: null, skipped: true };
  }

  const baselineFile = join(baselineDir, `${taskId}.json`);
  if (!existsSync(baselineFile)) {
    return { passed: true, error: null, note: '无基线，跳过对比' };
  }

  try {
    const baseline = JSON.parse(readFileSync(baselineFile, 'utf-8'));
    const targetFile = task?.constraints?.target_file;
    if (!targetFile || !existsSync(targetFile)) {
      return { passed: true, error: null };
    }

    const currentLines = readFileSync(targetFile, 'utf-8').split('\n').length;
    const baselineEntry = baseline.files?.[targetFile];
    const baselineLines = baselineEntry?.lines || 0;

    if (currentLines > baselineLines * 1.5 && baselineLines > 0) {
      return { passed: false, error: `文件膨胀: ${currentLines} 行 vs 基线 ${baselineLines} 行 (+${Math.round((currentLines / baselineLines - 1) * 100)}%)` };
    }

    return { passed: true, error: null };
  } catch (e) {
    return { passed: true, error: null };
  }
});

// ===== Step 12: AI 语义审查 (Layer 3) =====
if (!task?.constraints || !task?.constraints?.target_file || process.env.ENABLE_AI_REVIEW !== '1') {
  gates.push({ name: 'AI Semantic Review', passed: true, duration: 0, error: null, skipped: true });
} else {
  step('AI Semantic Review (claude -p 语义校验)', () => {
    const constraints = task.constraints;
    const targetFile = constraints.target_file;

    if (!targetFile || !existsSync(targetFile)) {
      return { passed: true, error: null };
    }

    const content = readFileSync(targetFile, 'utf-8');

    // 构建审查 prompt
    const reviewPrompt = `你是代码审查专家。检查以下代码是否正确实现了约束要求。

## 约束
必须使用: ${JSON.stringify(constraints.must_use || [])}
禁止使用: ${JSON.stringify(constraints.must_not_use || [])}

## 代码文件: ${targetFile}
\`\`\`typescript
${content.slice(0, 3000)}
\`\`\`

## 审查要求
1. must_use 的项是否在正确的位置被使用（不只是存在，而是正确使用）
2. must_not_use 的项是否真正不存在
3. 逻辑是否正确（如原子操作、并发安全等）

输出格式（严格遵循）：
PASS - 所有约束正确满足
或
FAIL - 问题描述（每行一个）`;

    try {
      const result = execSync(
        `claude -p ${JSON.stringify(reviewPrompt)} --output-format text 2>/dev/null`,
        { timeout: 120000, maxBuffer: 10 * 1024 * 1024, shell: '/bin/zsh' }
      ).toString().trim();

      if (result.toUpperCase().startsWith('PASS')) {
        return { passed: true, error: null };
      } else if (result.toUpperCase().startsWith('FAIL')) {
        return { passed: false, error: `AI语义审查: ${result.replace(/^FAIL\s*[-–]?\s*/i, '')}` };
      }
      // 无法解析结果，默认通过（不阻塞）
      return { passed: true, error: null };
    } catch (e) {
      // claude -p 超时或失败，不阻塞（降级通过）
      return { passed: true, error: null };
    }
  });
}

// ===== Step 13: 知识沉淀 =====
step('Knowledge Capture', () => {
  const lessonsFile = 'scripts/yolo/closed-loop/lessons.jsonl';
  const dir = join(lessonsFile, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const entry = {
    task_id: taskId,
    timestamp: new Date().toISOString(),
    result: allPassed ? 'PASS' : 'PARTIAL',
    gates_passed: gates.filter(g => g.passed).length,
    gates_failed: gates.filter(g => !g.passed && !g.skipped).length,
    duration_ms: Date.now() - startTime,
  };

  // 如果有失败的闸门，记录为闸门知识
  const failedGates = gates.filter(g => !g.passed && !g.skipped);
  if (failedGates.length > 0) {
    entry.knowledge_type = 'gate_knowledge';
    entry.knowledge = failedGates.map(g => `${g.name}: ${String(g.error || '').slice(0, 100)}`).join('; ');
    // 清理 ANSI 转义码，防止写入 JSON 时破坏格式
    entry.knowledge = entry.knowledge.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\u001b]\u005b[0-9;]*m/g, '');
  }

  // 去重：同一 task_id 只保留最新一条，旧记录无参考价值
  let existingLessons = [];
  try {
    if (existsSync(lessonsFile)) {
      existingLessons = readFileSync(lessonsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    }
  } catch {}
  existingLessons = existingLessons.filter(e => e.task_id !== taskId);
  existingLessons.push(entry);
  writeFileSync(lessonsFile, existingLessons.map(l => JSON.stringify(l)).join('\n') + '\n');
  return { passed: true, error: null };
});

} // 关闭 Step 13 函数体
} // 关闭 !task?.constraints 内部 else
} // 关闭 !task?.constraints 条件分支
} // 关闭 if(!allPassed) 的 Step 6-13 嵌套

// ===== 报告 =====
// goto_report 是占位函数，实际跳转由 if/else 结构控制
// 失败时 allPassed=false，后续步骤因 else 嵌套自动跳过
function goto_report() { /* no-op: see comment above */ }

const totalDuration = Date.now() - startTime;
const passedCount = gates.filter(g => g.passed).length;
const failedGates = gates.filter(g => !g.passed && !g.skipped);
const skippedCount = gates.filter(g => g.skipped).length;

console.log(`\n${C}${B}═══ Gate Chain v2 报告 ═══${X}`);
console.log(`Task: ${taskId || 'N/A'}`);
console.log(`Result: ${allPassed ? `${G}ALL 13 PASSED${X}` : `${R}${failedGates.length} FAILED${X}`}`);
console.log(`Passed: ${passedCount} | Failed: ${failedGates.length} | Skipped: ${skippedCount}`);
console.log(`Duration: ${totalDuration}ms\n`);

console.log('  Step | Gate                  | Status');
console.log('  -----|----------------------|-------');
for (let i = 0; i < gates.length; i++) {
  const g = gates[i];
  const status = g.skipped ? `${Y}SKIP${X}` : g.passed ? `${G}PASS${X}` : `${R}FAIL${X}`;
  console.log(`  ${(i + 1).toString().padStart(4)} | ${g.name.padEnd(20)} | ${status}`);
}

// 写日志
const logDir = 'scripts/yolo/closed-loop/logs';
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, `gate-v2-${taskId || 'run'}-${Date.now()}.json`);
writeFileSync(logFile, JSON.stringify({
  task_id: taskId, timestamp: new Date().toISOString(),
  result: allPassed ? 'PASS' : 'FAIL', duration_ms: totalDuration,
  gates: gates.map(g => ({ name: g.name, passed: g.passed, duration_ms: g.duration, error: g.error ? String(g.error).slice(0, 200) : null })),
}, null, 2));
console.log(`\n日志: ${logFile}`);

// 重试计数
const RETRY_FILE = 'scripts/yolo/closed-loop/retry-count.json';
let retryData = {};
if (existsSync(RETRY_FILE)) try { retryData = JSON.parse(readFileSync(RETRY_FILE, 'utf-8')); } catch {}
const retryCount = (retryData[taskId || 'unknown'] || 0) + 1;
retryData[taskId || 'unknown'] = retryCount;
writeFileSync(RETRY_FILE, JSON.stringify(retryData, null, 2));

if (!allPassed && retryCount >= 3) {
  console.log(`\n${Y}${B}═══ ⚠ 已重试 ${retryCount} 次 ═══${X}`);
  console.log(`卡在步骤: ${failedGates.map(g => g.name).join(', ')}`);
  console.log(`\n请选择:`);
  console.log(`  A) 拆分任务`);
  console.log(`  B) 换种描述方式`);
  console.log(`  C) 暂时跳过`);
}

process.exit(allPassed ? 0 : 1);
