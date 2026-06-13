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
  // Only the yolo CLI itself is allowed to mutate .yolo state via Bash.
  // Everything else that performs a write action against a .yolo path is blocked.
  if (isYoloCliInvocation(command)) return false;
  return commandHasYoloWriteAction(command);
}

// Whitelist: direct yolo CLI entrypoints and `node … <yolo-script>` invocations.
function isYoloCliInvocation(command) {
  const tokens = splitShellTokens(command);
  if (tokens.length === 0) return false;

  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) {
    i += 1;
  }

  // Direct entrypoint: yolo, ./yolo, /path/to/yolo, yolo.js, etc.
  if (isYoloScriptPath(tokens[i])) return true;

  // node … yolo CLI: the first non-flag, non-env positional argument after node
  // must be a yolo script. Inline eval/print/check is not a CLI invocation.
  if (!/(?:^|\/)node$/.test(tokens[i])) return false;

  for (let j = i + 1; j < tokens.length; j += 1) {
    const t = tokens[j];
    if (t.startsWith("-")) {
      if (NODE_INLINE_FLAGS.has(t)) return false;
      if (NODE_VALUE_FLAGS.has(t)) {
        j += 1; // skip the flag's value
      }
      continue;
    }
    if (/^[A-Z_][A-Z0-9_]*=/.test(t)) continue;
    return isYoloScriptPath(t);
  }

  return false;
}

const NODE_INLINE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "--check"]);
const NODE_VALUE_FLAGS = new Set([
  "-r", "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--input-type",
]);

function isYoloScriptPath(token) {
  const segments = String(token || "").split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  return /^yolo(\.js|\.mjs|\.cjs|\.ts|\.tsx)?$/.test(last);
}

function commandHasYoloWriteAction(command) {
  if (!pathTouchesYoloState(command)) return false;
  return redirectsToYoloState(command)
    || teeWritesYoloState(command)
    || sedInPlaceTouchesYoloState(command)
    || copiesOrMovesToYoloState(command)
    || curlDownloadsToYoloState(command)
    || ddWritesToYoloState(command)
    || nodeInlineWritesYoloState(command)
    || pythonInlineWritesYoloState(command);
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

function copiesOrMovesToYoloState(command) {
  const tokens = splitShellTokens(command);
  const programIndex = tokens.findIndex((t) => /(?:^|\/)cp$/.test(t) || /(?:^|\/)mv$/.test(t));
  if (programIndex === -1) return false;
  let targetDir = null;
  let lastPositional = null;
  for (let i = programIndex + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      if (t === "--target-directory" || t === "-t") {
        targetDir = tokens[i + 1] || null;
        i += 1;
      }
      continue;
    }
    if (/^[A-Z_][A-Z0-9_]*=/.test(t)) continue;
    lastPositional = t;
  }
  return (targetDir != null && pathTouchesYoloState(targetDir))
    || (lastPositional != null && pathTouchesYoloState(lastPositional));
}

function curlDownloadsToYoloState(command) {
  const tokens = splitShellTokens(command);
  const programIndex = tokens.findIndex((t) => /(?:^|\/)curl$/.test(t));
  if (programIndex === -1) return false;
  for (let i = programIndex + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === "-o" || t === "--output") {
      return pathTouchesYoloState(tokens[i + 1] || "");
    }
  }
  return false;
}

function ddWritesToYoloState(command) {
  const tokens = splitShellTokens(command);
  const programIndex = tokens.findIndex((t) => /(?:^|\/)dd$/.test(t));
  if (programIndex === -1) return false;
  for (let i = programIndex + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.startsWith("of=")) {
      return pathTouchesYoloState(t.slice(3));
    }
  }
  return false;
}

function nodeInlineWritesYoloState(command) {
  return /\bnode(?:\s+\S+)*\s+(?:-[ec]|--eval|--check)(?:=|\b)/.test(command)
    && pathTouchesYoloState(command);
}

function pythonInlineWritesYoloState(command) {
  return /\bpython3?(?:\s+\S+)*\s+-c(?:=|\b)/.test(command)
    && pathTouchesYoloState(command);
}

function splitShellTokens(command) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) { tokens.push(current); current = ""; }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}
