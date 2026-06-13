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
    if (typeof command === "string" && commandTouchesYoloState(command)) {
      block(
        "YOLO_STATE_BASH_WRITE_BLOCKED",
        "Direct Bash access to .yolo state is blocked. Use yolo CLI commands to interact with lifecycle state.",
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

// Used for clean file paths from Write/Edit tools.
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

// ── Bash branch: deny-by-default per subcommand ──

const YOLO_PATH_RE = /(?<![A-Za-z0-9_.])\.yolo(?=\/|$|['"\s);&|])/;

function commandTouchesYoloState(command) {
  const subcommands = splitSubcommands(command);
  for (const sub of subcommands) {
    const trimmed = sub.trim();
    if (!trimmed) continue;
    if (isYoloCliInvocation(trimmed)) continue;
    if (YOLO_PATH_RE.test(trimmed)) return true;
  }
  return false;
}

function splitSubcommands(command) {
  const subs = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === "&" && next === "&") {
        if (current.trim()) subs.push(current.trim());
        current = "";
        i += 1;
        continue;
      }
      if (ch === "|" && next === "|") {
        if (current.trim()) subs.push(current.trim());
        current = "";
        i += 1;
        continue;
      }
      if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
        if (current.trim()) subs.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) subs.push(current.trim());
  return subs.length > 0 ? subs : [command.trim()];
}

// Whitelist: only direct yolo CLI entrypoints and `node … <yolo-script>` are allowed
// to reference .yolo paths. Everything else is denied.
function isYoloCliInvocation(command) {
  const tokens = splitShellTokens(command);
  if (tokens.length === 0) return false;

  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) {
    i += 1;
  }

  // Direct entrypoint: yolo, ./yolo, /path/to/yolo, yolo.js/mjs/cjs/ts/tsx
  if (isYoloScriptPath(tokens[i])) return true;

  // node … yolo CLI: the first non-flag, non-env positional argument after node
  // must be a yolo script. Inline eval/print/check is never a CLI invocation.
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
