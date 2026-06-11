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
    block("YOLO_HOOK_INVALID_JSON", "PreToolUse payload is invalid JSON; blocking fail-closed.");
    return;
  }

  const toolName = (data.tool_name || '').toLowerCase();
  if (toolName === 'bash') {
    const command = data.tool_input?.command || '';
    if (typeof command === "string" && commandWritesYoloState(command)) {
      block(
        "YOLO_STATE_BASH_WRITE_BLOCKED",
        "Direct Bash writes to .yolo state are blocked. Use yolo CLI commands to modify lifecycle state.",
        command,
      );
      return;
    }
    process.exit(0);
    return;
  }

  if (!isWriteLikeTool(toolName)) {
    process.exit(0);
    return;
  }

  const filePath = data.tool_input?.file_path || data.tool_input?.path || data.tool_input?.notebook_path || '';
  if (!filePath) {
    block("YOLO_HOOK_MISSING_PATH", "Write-like tool payload is missing file_path/path; blocking fail-closed.");
    return;
  }

  // Block if any segment is exactly ".yolo"
  if (pathTouchesYoloState(filePath)) {
    block(
      "YOLO_STATE_DIRECT_WRITE_BLOCKED",
      "Direct LLM write to .yolo state is blocked. Use yolo CLI commands to modify lifecycle state.",
      filePath,
    );
    return;
  }

  process.exit(0);
});

function isWriteLikeTool(toolName) {
  return ["write", "edit", "multiedit", "notebookedit"].includes(toolName);
}

function pathTouchesYoloState(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, '/');
  return normalized.split('/').includes('.yolo');
}

function block(code, message, file = null) {
  console.error(JSON.stringify({
    status: "blocked",
    code,
    message,
    file,
  }));
  process.exit(2);
}

function commandWritesYoloState(command) {
  return redirectsToYoloState(command)
    || teeWritesYoloState(command)
    || sedInPlaceTouchesYoloState(command);
}

function redirectsToYoloState(command) {
  const pattern = /(?:^|[\s;&|])\d*>{1,2}\s*(["']?)([^"'\s;&|]+)\1/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    if (pathTouchesYoloState(match[2])) return true;
  }
  return false;
}

function teeWritesYoloState(command) {
  const pattern = /(?:^|[\s;&|])tee(?:\s+-[A-Za-z]+)*\s+(["']?)([^"'\s;&|]+)\1/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    if (pathTouchesYoloState(match[2])) return true;
  }
  return false;
}

function sedInPlaceTouchesYoloState(command) {
  return /(?:^|[\s;&|])sed\b[\s\S]*\s-i\b[\s\S]*\.yolo(?:\/|$)/.test(command.replace(/\\/g, "/"));
}
