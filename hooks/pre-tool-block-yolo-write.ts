#!/usr/bin/env node
// pre-tool-block-yolo-write.ts — PreToolUse hook: block LLM Write/Edit of .yolo state
// States must be written through yolo CLI, not directly by LLM agents.
// Exit 2 = block (Claude Code will not execute the tool).
//
// Scope: only the .yolo directory under the current project root (process.cwd()).
// External .yolo paths such as /tmp/.yolo are not project state and are allowed.

import { resolve, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// CR4.2: the canonical install root for this hook. The yolo CLI/scripts live
// alongside the hook (in dist/bin/, dist/, or hooks/). A `yolo`/`node yolo.ts`
// invocation is only trusted if its script resolves under THIS install root —
// not merely because its basename is `yolo.ts` (the old check allowed any
// on-disk file named yolo.ts, e.g. `node scratch/yolo.ts`).
const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
function installRoot(): string {
  // hooks/ sits at the repo/install root; canonicalize so comparisons are stable.
  return canonicalizePath(resolve(HOOK_DIR, ".."));
}

// PreToolUse payload shape consumed by this hook. The hook is fail-closed
// (invalid JSON → block), so unknown fields are tolerated via Record.
interface PreToolUsePayload {
  tool_name?: unknown;
  tool_input?: {
    command?: unknown;
    file_path?: unknown;
    path?: unknown;
    notebook_path?: unknown;
  };
}

let input = "";
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let data: PreToolUsePayload;
  try {
    data = JSON.parse(input) as PreToolUsePayload;
  } catch {
    block("YOLO_HOOK_INVALID_JSON", "PreToolUse payload is invalid JSON; blocking fail-closed.");
    return;
  }

  const toolName = String(data.tool_name || '').toLowerCase();
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

  const filePath = String(data.tool_input?.file_path || data.tool_input?.path || data.tool_input?.notebook_path || '');
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

function isWriteLikeTool(toolName: string) {
  return ["write", "edit", "multiedit", "notebookedit"].includes(toolName);
}

function canonicalizePath(filePath: unknown) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (!normalized) return "";
  if (!normalized.startsWith("/")) {
    return resolve(normalized).replace(/\\/g, "/").toLowerCase();
  }
  let prefix = normalized;
  const remaining = [];
  while (prefix) {
    try {
      const realPrefix = realpathSync(prefix).replace(/\\/g, "/");
      const suffix = remaining.length > 0 ? remaining.reverse().join("/") : "";
      return suffix ? `${realPrefix}/${suffix}`.toLowerCase() : realPrefix.toLowerCase();
    } catch {
      const parts = prefix.split("/").filter(Boolean);
      if (parts.length === 0) break;
      remaining.push(parts.pop());
      prefix = parts.length === 0 ? "/" : `/${parts.join("/")}`;
    }
  }
  return normalized.toLowerCase();
}

function projectStateRoot() {
  return `${canonicalizePath(process.cwd())}/.yolo`;
}

function isUnderProjectStateRoot(filePath: unknown) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (!normalized) return false;
  if (!/(?:^|\/)\.yolo(?:\/|$)/i.test(normalized)) return false;
  const resolved = canonicalizePath(normalized);
  if (!resolved) return false;
  const stateRoot = projectStateRoot();
  return resolved === stateRoot || resolved.startsWith(`${stateRoot}/`);
}

// Used for clean file paths from Write/Edit tools.
function pathTouchesYoloState(filePath: unknown) {
  return isUnderProjectStateRoot(filePath);
}

function block(code: string, message: string, file: string | null = null) {
  console.error(JSON.stringify({
    status: "blocked",
    code,
    message,
    file,
  }));
  process.exit(2);
}

// ── Bash branch: deny-by-default per subcommand ──

const YOLO_SEGMENT_RE = /(?<![A-Za-z0-9_.])\.yolo(?=\/|$|['"\s);&|])/gi;

function commandTouchesYoloState(command: string) {
  const subcommands = splitSubcommands(command);
  for (const sub of subcommands) {
    const trimmed = sub.trim();
    if (!trimmed) continue;
    if (isYoloCliInvocation(trimmed)) continue;
    if (subcommandTouchesProjectYolo(trimmed)) return true;
    // CR4.4: deny-by-default for bash that cannot be statically resolved.
    // Variable assignment/expansion and quote-concatenation can hide `.yolo`
    // (e.g. D=".yo""lo"; cat $D/state). If a subcommand uses shell variables or
    // quote-concatenation AND looks state-adjacent, block rather than risk the
    // literal-token regex missing an evaded `.yolo`.
    if (commandEvadesLiteralYoloDetection(trimmed)) return true;
  }
  return false;
}

function subcommandTouchesProjectYolo(command: string) {
  for (const token of splitShellTokens(command)) {
    const stripped = token.replace(/^['"]+|['"]+$/g, "");
    if (!stripped) continue;
    for (const candidate of extractYoloPaths(stripped)) {
      if (isUnderProjectStateRoot(candidate)) return true;
    }
    // CR4.4: also test the quote-stripped form so `".yo""lo"` -> `.yolo` is seen.
    for (const candidate of extractYoloPaths(stripped.replace(/"/g, ""))) {
      if (isUnderProjectStateRoot(candidate)) return true;
    }
  }
  return false;
}

// CR4.4: detect bash that can evade the literal `.yolo` token regex. We cannot
// statically expand variables or quote-concatenation, so if a subcommand uses
// either AND touches a path-like token that looks state-adjacent, deny.
function commandEvadesLiteralYoloDetection(command: string): boolean {
  // Variable assignment (FOO=…) or expansion ($FOO / ${FOO}) that we can't resolve.
  const usesVariables = /(^|\s|[;&|])([A-Za-z_][A-Za-z0-9_]*)=|\$\{?[A-Za-z_]/.test(command);
  // Quote-concatenation: adjacent string fragments like ".yo""lo" or '.yo'lo.
  const usesQuoteConcatenation = /""|''|"\s*"|'\s*'/.test(command) && /\.yo|\.yolo/i.test(command);
  if (!usesVariables && !usesQuoteConcatenation) return false;
  // Only deny if the command is plausibly aiming at state (a `.yo`-ish fragment
  // or a variable that could hold it). Bare variable use elsewhere is common and
  // benign, so require a state-adjacency signal.
  return /\.yo/i.test(command) || /\.(yo|yolo)/i.test(command.replace(/['"]/g, ""));
}

function extractYoloPaths(str: string): string[] {
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = YOLO_SEGMENT_RE.exec(str)) !== null) {
    let start = match.index;
    while (start > 0 && /[A-Za-z0-9._\-/~]/.test(str[start - 1])) start -= 1;
    let end = match.index + match[0].length;
    while (end < str.length && /[A-Za-z0-9._\-/]/.test(str[end])) end += 1;
    paths.push(str.slice(start, end));
  }
  return paths;
}

function splitSubcommands(command: string): string[] {
  const subs: string[] = [];
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
      // CR4.3: descend into $(…) command substitutions so a hidden subshell
      // command is also checked. `yolo state read $(rm -rf .yolo)` must NOT be
      // trusted as a whole just because the outer command is a yolo CLI call.
      if (ch === "$" && next === "(") {
        const inner = captureBalanced(command, i + 2, "(", ")");
        if (inner !== null) {
          // The subshell content is its own command(s) — recurse so its own
          // subcommands/pipes are split and inspected.
          for (const sub of splitSubcommands(inner)) subs.push(sub);
          i += inner.length + 2; // skip past "$(…)"
          continue;
        }
      }
      // CR4.3: descend into backtick command substitutions too.
      if (ch === "`") {
        const inner = captureUntilBacktick(command, i + 1);
        if (inner !== null) {
          for (const sub of splitSubcommands(inner)) subs.push(sub);
          i += inner.length + 1; // skip past "…`"
          continue;
        }
      }
    }
    current += ch;
  }
  if (current.trim()) subs.push(current.trim());
  return subs.length > 0 ? subs : [command.trim()];
}

// Capture the content of a $(…) group starting just after the opening "(" at
// `start`, honoring nested parens and quotes. Returns null if unbalanced.
function captureBalanced(str: string, start: number, open: string, close: string): string | null {
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return str.slice(start, i);
    }
  }
  return null; // unbalanced — caller treats the token literally (safer to not trust)
}

function captureUntilBacktick(str: string, start: number): string | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = start; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (inSingle || inDouble) continue;
    if (ch === "`") return str.slice(start, i);
  }
  return null;
}

// Whitelist: only direct yolo CLI entrypoints and `node … <yolo-script>` are allowed
// to reference .yolo paths. Everything else is denied.
function isYoloCliInvocation(command: string) {
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

// CR4.2: a token is a trusted yolo script only if its basename is yolo(.js/…)
// AND it resolves under the canonical install root. The basename-only check let
// any on-disk file named yolo.ts masquerade as the trusted CLI
// (e.g. `node scratch/yolo.ts` -> allowed).
function isYoloScriptPath(token: unknown) {
  const raw = String(token || "").trim();
  if (!raw) return false;
  const segments = raw.split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  if (!/^yolo(\.js|\.mjs|\.cjs|\.ts|\.tsx)?$/.test(last)) return false;
  // Bare `yolo` (no path) resolves via PATH to the installed bin — trust it.
  if (segments.length === 1 && !raw.includes("/")) return true;
  // A path-prefixed token must resolve under the install root.
  const resolved = canonicalizePath(raw);
  if (!resolved) return false;
  const root = installRoot();
  return resolved === root || resolved.startsWith(`${root}/`);
}

function splitShellTokens(command: string): string[] {
  const tokens: string[] = [];
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
