#!/usr/bin/env node
// pre-tool-block-yolo-write.ts — PreToolUse hook: block LLM Write/Edit of .yolo state
// States must be written through yolo CLI, not directly by LLM agents.
// Exit 2 = block (Claude Code will not execute the tool).

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    // Invalid input — let it through
    process.exit(0);
  }

  const toolName = (data.tool_name || '').toLowerCase();
  if (toolName !== 'write' && toolName !== 'edit') {
    process.exit(0);
  }

  const filePath = data.tool_input?.file_path || data.tool_input?.path || '';
  if (!filePath) process.exit(0);

  // Normalize to forward slashes for cross-platform matching
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');

  // Block if any segment is exactly ".yolo"
  if (segments.includes('.yolo')) {
    console.error(JSON.stringify({
      status: "blocked",
      code: "YOLO_STATE_DIRECT_WRITE_BLOCKED",
      message: `Direct LLM write to .yolo state is blocked. Use yolo CLI commands to modify lifecycle state.`,
      file: filePath,
    }));
    process.exit(2);
  }

  process.exit(0);
});
