#!/usr/bin/env node
// pre-tool-lifecycle-gate.ts — PreToolUse hook: block source-file writes
// unless the yolo lifecycle check stage has passed.
//
// Closes the BUG-C gap: `yolo check` returning blocked must MACHINE-BLOCK
// Write/Edit/Bash against project source, not just report a warning. The
// hook reads `.yolo/lifecycle/status.json` on every call — the per-call read
// IS the authorization (no separate approval stamp; TOCTOU-safe because the
// hook re-reads each invocation).
//
// Exit 2 = block (Claude Code will not execute the tool). Exit 0 = allow.
//
// Scope: source files under the project root, EXCLUDING harness/state/config
// dirs (.yolo, .claude, node_modules, dist, .git, coverage, ...). Writes to
// .yolo/ are handled by pre-tool-block-yolo-write.ts; this hook early-exits
// on .yolo/ and .claude/ paths to avoid double-gating and install self-deadlock.
//
// Authorization: the `check` stage in status.json must be "completed" or
// "warning" (non-fatal). Blocked/pending/active/missing → fail-closed.

import { resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";

const EXCLUDE_DIR_SEGMENTS = new Set([
  ".yolo", ".claude", ".codex", ".agents",
  "node_modules", "dist", "build", ".git", "coverage",
  ".next", ".cache", ".turbo", ".parcel-cache", "out",
]);

let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    block("LIFECYCLE_GATE_INVALID_JSON", "PreToolUse payload is invalid JSON; blocking fail-closed.");
    return;
  }

  const toolName = String(data.tool_name || "").toLowerCase();

  // Bash: detect write-to-source commands (>, >>, sed -i, tee, perl -i, git checkout/restore to paths).
  if (toolName === "bash") {
    const command = String(data.tool_input?.command || "");
    if (command && bashWritesToSource(command)) {
      // Still authorize via lifecycle even for Bash source writes.
      if (!writesAuthorized()) {
        block(
          "LIFECYCLE_WRITE_NOT_AUTHORIZED",
          "Bash command writes to project source, but yolo check has not passed. Run `yolo check` until it passes before writing source.",
          command,
        );
        return;
      }
    }
    process.exit(0);
    return;
  }

  if (!isWriteLikeTool(toolName)) {
    process.exit(0);
    return;
  }

  const filePath = data.tool_input?.file_path || data.tool_input?.path || data.tool_input?.notebook_path || "";
  if (!filePath) {
    block("LIFECYCLE_GATE_MISSING_PATH", "Write-like tool payload is missing file_path/path; blocking fail-closed.");
    return;
  }

  // Early-exit: harness/state/config dirs are not gated here (another hook or
  // install path owns them). Prevents install self-deadlock on .claude/settings.json.
  if (pathUnderExcludedDir(filePath)) {
    process.exit(0);
    return;
  }

  // Only gate source files under the project root.
  if (!isProjectSourceFile(filePath)) {
    process.exit(0);
    return;
  }

  if (!writesAuthorized()) {
    block(
      "LIFECYCLE_WRITE_NOT_AUTHORIZED",
      "Write to project source is blocked because yolo check has not passed. Run `yolo check` until the check stage is completed or warning before writing source files.",
      filePath,
    );
    return;
  }

  process.exit(0);
});

function isWriteLikeTool(toolName) {
  return ["write", "edit", "multiedit", "notebookedit"].includes(toolName);
}

function canonicalizePath(filePath) {
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

function projectRootCanonical() {
  return canonicalizePath(process.cwd());
}

function pathSegments(filePath) {
  return String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
}

function pathUnderExcludedDir(filePath) {
  const segments = pathSegments(filePath);
  return segments.some((segment) => EXCLUDE_DIR_SEGMENTS.has(segment));
}

function isProjectSourceFile(filePath) {
  const resolved = canonicalizePath(filePath);
  if (!resolved) return false;
  const root = projectRootCanonical();
  if (!root) return false;
  return resolved === root || resolved.startsWith(`${root}/`);
}

function statusJsonPath() {
  // Read from the real, CASE-PRESERVING cwd. canonicalizePath lowercases paths
  // for case-insensitive *comparison* (isProjectSourceFile), but a lowercased
  // path breaks file I/O on case-sensitive filesystems (Linux CI), where the
  // status.json read would miss and fail-closed even on a passing check.
  let root;
  try {
    root = realpathSync(process.cwd()).replace(/\\/g, "/");
  } catch {
    root = String(process.cwd()).replace(/\\/g, "/");
  }
  return `${root}/.yolo/lifecycle/status.json`;
}

// Authorization = check stage completed or warning. Fail-closed on missing,
// unreadable, or any other status (pending/blocked/active).
function writesAuthorized() {
  const path = statusJsonPath();
  if (!existsSync(path)) return false;
  let state;
  try {
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  const stages = Array.isArray(state.stages) ? state.stages : [];
  const checkStage = stages.find((stage) => stage && stage.id === "check");
  if (!checkStage) return false;
  const status = String(checkStage.status || "").toLowerCase();
  return status === "completed" || status === "warning";
}

// Bash write-to-source heuristics. Conservative: only flag clear write surface.
function bashWritesToSource(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return false;
  // Yolo CLI calls are allowed to touch anything.
  if (isYoloCliInvocation(trimmed)) return false;

  // Redirection to a path: `cmd > path` / `cmd >> path` / `> path`.
  // Capture the token after > or >> and check if it's a source file.
  const redirectMatch = trimmed.match(/(?:>>?)\s*(&?\S+)/);
  if (redirectMatch) {
    const target = redirectMatch[1].replace(/^&/, "");
    if (target && !/^\d+$/.test(target) && isProjectSourceFile(target) && !pathUnderExcludedDir(target)) {
      return true;
    }
  }

  // In-place edit commands targeting source files.
  if (/\b(?:sed|perl|awk|ruby)\b(?:\s+\S+)*\s+-i\b/.test(trimmed)) return true;

  // tee to a source path.
  const teeMatch = trimmed.match(/\btee\s+(?:(?:-[a-zA-Z]+)\s+)*(\S+)/);
  if (teeMatch && isProjectSourceFile(teeMatch[1]) && !pathUnderExcludedDir(teeMatch[1])) return true;

  return false;
}

function isYoloCliInvocation(command) {
  const tokens = String(command || "").split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i += 1;
  if (isYoloScriptPath(tokens[i])) return true;
  if (!/(?:^|\/)node$/.test(tokens[i])) return false;
  for (let j = i + 1; j < tokens.length; j += 1) {
    const t = tokens[j];
    if (t.startsWith("-")) continue;
    if (/^[A-Z_][A-Z0-9_]*=/.test(t)) continue;
    return isYoloScriptPath(t);
  }
  return false;
}

function isYoloScriptPath(token) {
  const segments = String(token || "").split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  return /^yolo(\.js|\.mjs|\.cjs|\.ts|\.tsx)?$/.test(last);
}

function block(code, message, file = null) {
  console.error(JSON.stringify({ status: "blocked", code, message, file }));
  process.exit(2);
}
