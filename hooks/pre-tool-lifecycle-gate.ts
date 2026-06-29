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

// Lifecycle status.json shape (only the fields this hook reads). Unknown
// stages/fields are tolerated; authorization fails closed on anything missing.
interface LifecycleStage {
  id?: unknown;
  status?: unknown;
}
interface LifecycleState {
  stages?: unknown;
}

const EXCLUDE_DIR_SEGMENTS = new Set([
  ".yolo", ".claude", ".codex", ".agents",
  "node_modules", "dist", "build", ".git", "coverage",
  ".next", ".cache", ".turbo", ".parcel-cache", "out",
]);

let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  let data: PreToolUsePayload;
  try {
    data = JSON.parse(input) as PreToolUsePayload;
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

  const filePath = String(data.tool_input?.file_path || data.tool_input?.path || data.tool_input?.notebook_path || "");
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
  const remaining: string[] = [];
  while (prefix) {
    try {
      const realPrefix = realpathSync(prefix).replace(/\\/g, "/");
      const suffix = remaining.length > 0 ? remaining.reverse().join("/") : "";
      return suffix ? `${realPrefix}/${suffix}`.toLowerCase() : realPrefix.toLowerCase();
    } catch {
      const parts = prefix.split("/").filter(Boolean);
      if (parts.length === 0) break;
      remaining.push(parts.pop() as string);
      prefix = parts.length === 0 ? "/" : `/${parts.join("/")}`;
    }
  }
  return normalized.toLowerCase();
}

function projectRootCanonical() {
  return canonicalizePath(process.cwd());
}

function pathSegments(filePath: unknown): string[] {
  return String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
}

// CR4.1: lexically collapse "." and ".." segments BEFORE checking excluded
// directories. The previous naive split("/") let `.yolo/../src/x.ts` match the
// `.yolo` exclude segment and early-exit(0) (allowing the write) even though the
// resolved target is a real source file. A proper stack-based collapse cancels
// `.yolo` against the following `..`, so the exclude check sees the real target
// (`src/x.ts`). A leading `..` (escaping above root) is preserved so callers
// can detect the escape.
function collapseDots(segments: string[]): string[] {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop(); // cancel the previous segment (e.g. .yolo/.. -> nothing)
      } else {
        out.push(".."); // escape above root — preserve for escape detection
      }
      continue;
    }
    out.push(segment);
  }
  return out;
}

function pathUnderExcludedDir(filePath: unknown) {
  const segments = collapseDots(pathSegments(filePath));
  return segments.some((segment) => EXCLUDE_DIR_SEGMENTS.has(segment));
}

function isProjectSourceFile(filePath: unknown) {
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
  let state: LifecycleState;
  try {
    state = JSON.parse(readFileSync(path, "utf8")) as LifecycleState;
  } catch {
    return false;
  }
  const stages = Array.isArray(state.stages) ? (state.stages as LifecycleStage[]) : [];
  const checkStage = stages.find((stage) => stage && stage.id === "check");
  if (!checkStage) return false;
  const status = String(checkStage.status || "").toLowerCase();
  return status === "completed" || status === "warning";
}

// Bash write-to-source heuristics. Conservative: only flag clear write surface.
function bashWritesToSource(command: unknown) {
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

  // tee to source path(s): handle multiple targets, e.g. `echo x | tee a.ts b.ts`
  // — the SECOND target must not escape detection (the old single-capture regex
  // only inspected the first operand).
  if (teeWritesToSource(trimmed)) return true;

  if (interpreterEvalWritesToSource(trimmed)) return true;
  if (fileCommandWritesToSource(trimmed)) return true;

  return false;
}

function shellWords(command: unknown): string[] {
  const words: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of String(command || "")) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function commandBaseName(token: unknown): string {
  const cleaned = String(token || "").split("/").pop() || "";
  return cleaned.toLowerCase();
}

function nonOptionOperands(tokens: string[]): string[] {
  return tokens.filter((token) => token && !String(token).startsWith("-"));
}

function sourcePathFromToken(token: unknown): boolean {
  const value = String(token || "").replace(/^['"]|['"]$/g, "");
  if (!value || pathUnderExcludedDir(value)) return false;
  return isProjectSourceFile(value);
}

// H5: tee can fan out to multiple targets (`echo x | tee a.ts b.ts` / `-a`).
// Capture EVERY operand path, not just the first, and block if any targets a
// project source file. Skips `tee` option flags (-a, -i, -p) and `-`.
function teeWritesToSource(command: unknown): boolean {
  const tokens = shellWords(command);
  for (let index = 0; index < tokens.length; index += 1) {
    if (commandBaseName(tokens[index]) !== "tee") continue;
    const operands = nonOptionOperands(tokens.slice(index + 1).filter((token) => token !== "|"));
    if (operands.some(sourcePathFromToken)) return true;
  }
  return false;
}

function fileCommandWritesToSource(command: unknown): boolean {
  const tokens = shellWords(command);
  let index = 0;
  while (index < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[index])) index += 1;
  const executable = commandBaseName(tokens[index]);
  const args = tokens.slice(index + 1);
  if (!executable) return false;

  if (executable === "cp") {
    const operands = nonOptionOperands(args);
    const target = operands[operands.length - 1];
    return sourcePathFromToken(target);
  }
  if (executable === "mv") {
    return nonOptionOperands(args).some(sourcePathFromToken);
  }
  if (executable === "touch" || executable === "rm") {
    return nonOptionOperands(args).some(sourcePathFromToken);
  }
  // H5: `ln -sf TARGET LINK` writes the link operand (last). Same target rule
  // as cp/mv: the destination operand is what mutates a source file.
  if (executable === "ln") {
    const operands = nonOptionOperands(args);
    const target = operands[operands.length - 1];
    return sourcePathFromToken(target);
  }
  // H5: `install -m 644 SRC DST` copies SRC→DST; dst (last operand) is the write.
  if (executable === "install") {
    const operands = nonOptionOperands(args);
    const target = operands[operands.length - 1];
    return sourcePathFromToken(target);
  }
  // H5: rsync writes destination path(s) (the trailing operand without a
  // trailing slash). rsync has many option forms; treat the last non-option
  // operand as the destination.
  if (executable === "rsync") {
    const operands = nonOptionOperands(args);
    const target = operands[operands.length - 1];
    return sourcePathFromToken(target);
  }
  // H5: patch mutates files in place. Operands may be the target file or a
  // patch; treat a source-path operand as a write surface.
  if (executable === "patch") {
    return nonOptionOperands(args).some(sourcePathFromToken);
  }
  // H5: git subcommands that write to working-tree source: apply, checkout --,
  // restore. These overwrite/modify tracked source files.
  if (executable === "git") {
    return gitWritesToSource(args);
  }
  return false;
}

// H5: `git apply`, `git checkout -- <path>`, `git restore <path>` overwrite
// working-tree files. `git checkout`/`git restore` with no path or a branch
// operand are NOT writes. We require a `--` or a source-path operand to the
// known write subcommands.
function gitWritesToSource(args: string[]): boolean {
  const subcommand = args.find((arg) => !String(arg).startsWith("-"));
  const rest = args.slice(args.indexOf(subcommand || "") + 1);
  const pathArgs = rest.filter((arg) => !String(arg).startsWith("-") && arg !== "--");
  const mentionsSource = pathArgs.some(sourcePathFromToken);
  if (subcommand === "apply") return mentionsSource;
  if (subcommand === "restore") return mentionsSource;
  if (subcommand === "checkout") {
    // checkout restores files only when `--` is present (disambiguating from
    // branch switching) or a source path is named.
    return rest.includes("--") || mentionsSource;
  }
  return false;
}

function quotedStrings(text: unknown): string[] {
  const values: string[] = [];
  const pattern = /(['"])(.*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(String(text || ""))) !== null) {
    values.push(match[2]);
  }
  return values;
}

function commandMentionsSourcePath(text: unknown): boolean {
  const candidates: string[] = [];
  for (const value of [String(text || ""), ...quotedStrings(text)]) {
    candidates.push(value);
    candidates.push(...(value.match(/(?:\/|\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+/g) || []));
  }
  return candidates.some(sourcePathFromToken);
}

function interpreterEvalWritesToSource(command: unknown): boolean {
  const tokens = shellWords(command);
  let index = 0;
  while (index < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[index])) index += 1;
  const executable = commandBaseName(tokens[index]);
  const args = tokens.slice(index + 1);
  // H5: cover all eval-capable interpreters, not just node/python. Adding
  // ruby -e, perl -e, php -r, pwsh/powershell -c/-Command, and osascript.
  const isEvalInterpreter = (
    (["node", "nodejs", "bun", "deno"].includes(executable) && args.some((arg) => arg === "-e" || arg === "--eval"))
    || (/^python(?:\d+(?:\.\d+)?)?$/.test(executable) && args.includes("-c"))
    || (executable === "ruby" && args.some((arg) => arg === "-e"))
    || (executable === "perl" && args.some((arg) => arg === "-e"))
    || (executable === "php" && args.some((arg) => arg === "-r"))
    || ((executable === "pwsh" || executable === "powershell") && args.some((arg) => arg === "-c" || arg === "-command"))
    || (executable === "osascript")
  );
  if (!isEvalInterpreter) return false;
  const text = String(command || "");
  // H5: detect write/remove surfaces including fs.promises.writeFile and
  // dynamically constructed names like 'write'+'FileSync' or "write"+"File".
  // `compacted` strips quote-concat (`'a'+'b'`) and all whitespace, so the
  // osascript delegation `do shell script "..."` is matched as `doshellscript`.
  const compacted = text.replace(/['"]\s*\+\s*['"]/g, "").replace(/\s+/g, "");
  const writeSurface = /\b(writeFileSync|appendFileSync|createWriteStream|rmSync|unlinkSync|mkdirSync|open|write_text|unlink|remove|rmtree|promises\.writeFile|promises\.appendFile|Set-Content|Add-Content|Out-File|doshellscript|File\.write)\b/i.test(compacted);
  if (!writeSurface) return false;
  return commandMentionsSourcePath(command);
}

function isYoloCliInvocation(command: unknown) {
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

function isYoloScriptPath(token: unknown) {
  const segments = String(token || "").split("/").filter(Boolean);
  const last = segments[segments.length - 1] || "";
  return /^yolo(\.js|\.mjs|\.cjs|\.ts|\.tsx)?$/.test(last);
}

function block(code: string, message: string, file: string | null = null) {
  console.error(JSON.stringify({ status: "blocked", code, message, file }));
  process.exit(2);
}
