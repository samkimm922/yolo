#!/usr/bin/env node

/**
 * PreToolUse Hook — 闭环系统实时拦截
 *
 * 在 AI 调用 Write/Edit 时自动检查：
 *   1. 文件行数 ≤ 200 行
 *   2. 禁止模式：as any, console.log, window., document.
 *   3. 硬编码密钥检测
 *
 * 安装：在 .claude/settings.json 的 PreToolUse 中添加：
 *   { "matcher": "Write|Edit|MultiEdit", "command": "node scripts/yolo/closed-loop/pretooluse-guard.mjs" }
 *
 * 通过：exit 0，输出原始内容
 * 拦截：exit 2，输出错误信息
 */

const MAX_LINES = 200;

const FORBIDDEN_PATTERNS = [
  { pattern: /\bas\s+any\b/, message: '禁止 as any，使用具体类型' },
  { pattern: /\bconsole\.(log|warn|error|debug)\s*\(/, message: '禁止 console.log，使用日志工具' },
  { pattern: /\bwindow\./, message: '禁止 window（小程序无 DOM）' },
  { pattern: /\bdocument\./, message: '禁止 document（小程序无 DOM）' },
  { pattern: /api[_-]?key\s*[:=]\s*['"][^'"]{8,}/i, message: '疑似硬编码 API key' },
  { pattern: /password\s*[:=]\s*['"][^'"]{4,}/i, message: '疑似硬编码密码' },
];

// 读取 stdin（Claude Code 传入 JSON）
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const content = data.tool_input?.content || data.tool_input?.new_string || '';
    const filePath = data.tool_input?.file_path || data.tool_input?.path || '';

    // 检查 1：文件行数
    const lines = content.split('\n');
    if (lines.length > MAX_LINES) {
      console.error(`[闭环拦截] 文件行数 ${lines.length} > ${MAX_LINES} 行限制`);
      console.error(`[闭环拦截] 请拆分为更小的模块`);
      process.exit(2);
    }

    // 检查 2：禁止模式（只在 .ts/.tsx 文件中检查）
    if (/\.(ts|tsx|js|jsx)$/.test(filePath)) {
      const violations = [];
      for (const { pattern, message } of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(message);
        }
      }
      if (violations.length > 0) {
        console.error(`[闭环拦截] 检测到禁止模式:`);
        for (const v of violations) {
          console.error(`  ✗ ${v}`);
        }
        console.error(`[闭环拦截] 请修复后重试`);
        process.exit(2);
      }
    }

    // 通过
    process.stdout.write(input);
  } catch (e) {
    // JSON 解析失败，放行（不影响正常操作）
    process.stdout.write(input);
  }
});
