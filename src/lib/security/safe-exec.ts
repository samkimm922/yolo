// security/safe-exec.ts — P12.I1: shell-injection chokepoint
//
// Single executor for all command execution in the runtime. Only accepts
// argv arrays (parsed by parseCommandToArgv, which rejects unquoted shell
// metacharacters). Untrusted command strings NEVER reach a shell.
//
// Why this exists:
//   Before P12.I1 the repo routed config/PRD/adapter-supplied commands
//   through `sh -c "<cmd>"` or `spawnSync(cmd, { shell: true })`. Any
//   untrusted input in those commands could inject. This module is the
//  咽喉: every externally-supplied command goes through execCommand,
//   which parses to argv and rejects metacharacters; the underlying
//   spawnSync never sets shell:true.
//
// Adversarial contract (covered by __tests__/p12-i1-safe-exec.test.ts):
//   - execCommand rejects $(), backticks, ;, |, >, <, newline outside quotes
//   - execArgv never invokes a shell (spawnSync without shell:true)
//   - commandExistsSync walks PATH via fs.accessSync, no `sh -c "command -v"`

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join, isAbsolute } from "node:path";
import { parseCommandToArgv } from "./command-guard.js";

export interface SafeExecOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding;
  maxBuffer?: number;
  stdio?: Array<"pipe" | "ignore" | "inherit" | null>;
}

export interface SafeExecResult {
  command: string;
  argv: string[];
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ok: boolean;
  timed_out: boolean;
  command_not_found: boolean;
  error?: string;
}

export interface ExecCommandResult extends SafeExecResult {
  rejected: boolean;
  reject_reason?: string;
  reject_detail?: string;
}

const NOT_FOUND_RE = /\b(command not found|no such file or directory|is not recognized)\b|\benoent\b/i;

function normalizeOptions(opts: SafeExecOptions): {
  cwd: string;
  timeout: number;
  env: NodeJS.ProcessEnv;
  encoding: BufferEncoding;
  maxBuffer?: number;
  stdio: Array<"pipe" | "ignore" | "inherit" | null>;
} {
  return {
    cwd: opts.cwd ?? process.cwd(),
    timeout: opts.timeout ?? 60000,
    env: opts.env ?? process.env,
    encoding: (opts.encoding ?? "utf8") as BufferEncoding,
    maxBuffer: opts.maxBuffer,
    stdio: opts.stdio ?? ["pipe", "pipe", "pipe"],
  };
}

function toStr(value: string | Buffer | undefined | null): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.toString();
}

function argvEmpty(): SafeExecResult {
  return {
    command: "",
    argv: [],
    exit_code: null,
    signal: null,
    stdout: "",
    stderr: "safe-exec: empty argv",
    ok: false,
    timed_out: false,
    command_not_found: false,
    error: "empty argv",
  };
}

function buildResult(
  argv: string[],
  result: ReturnType<typeof spawnSync> | null,
  error?: { stdout?: string | Buffer; stderr?: string | Buffer; message?: string; signal?: NodeJS.Signals; status?: number | null; code?: string } | null,
): SafeExecResult {
  const stdout = toStr(result?.stdout as string | Buffer | undefined) || toStr(error?.stdout as string | Buffer | undefined);
  const stderr = toStr(result?.stderr as string | Buffer | undefined) || toStr(error?.stderr as string | Buffer | undefined);
  const exitCode = Number.isInteger(result?.status) ? (result?.status as number) : (Number.isInteger(error?.status) ? (error!.status as number) : null);
  const signal = (result?.signal as NodeJS.Signals | null) || (error?.signal as NodeJS.Signals | null) || null;
  const output = `${stdout}\n${stderr}`;
  // spawnSync puts ENOENT on result.error.code (not thrown); catch'd error.code is for thrown cases.
  const errCode = (result?.error as { code?: string } | undefined)?.code || error?.code;
  const errMsg = (result?.error as { message?: string } | undefined)?.message || error?.message;
  const commandNotFound = errCode === "ENOENT" || NOT_FOUND_RE.test(stderr) || NOT_FOUND_RE.test(output);
  return {
    command: argv.join(" "),
    argv,
    exit_code: exitCode,
    signal,
    stdout,
    stderr,
    ok: exitCode === 0 && !signal,
    timed_out: signal === "SIGTERM" && Boolean(error || result?.error),
    command_not_found: commandNotFound,
    error: errMsg,
  };
}

/**
 * Execute an argv array directly via spawnSync. Never invokes a shell.
 * Use this when the caller already has an argv array (e.g. literal git subcommands).
 */
export function execArgv(argv: string[], opts: SafeExecOptions = {}): SafeExecResult {
  if (!Array.isArray(argv) || argv.length === 0) return argvEmpty();
  const norm = normalizeOptions(opts);
  try {
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: norm.cwd,
      timeout: norm.timeout,
      env: norm.env,
      encoding: norm.encoding,
      maxBuffer: norm.maxBuffer,
      stdio: norm.stdio,
      shell: false,
    });
    return buildResult(argv, result);
  } catch (error) {
    return buildResult(argv, null, error as { message?: string });
  }
}

/**
 * Parse a command string into argv (rejecting shell metacharacters) and execute it
 * without invoking a shell. Use this for any externally-supplied command string.
 *
 * If the command contains unquoted shell metacharacters (e.g. $(), ``, ;, |, >, newline),
 * execution is rejected with `rejected: true` and a clear reason — the command never runs.
 */
export function execCommand(command: unknown, opts: SafeExecOptions = {}): ExecCommandResult {
  const parsed = parseCommandToArgv(command);
  if (!parsed.ok) {
    return {
      command: String(command ?? ""),
      argv: [],
      exit_code: null,
      signal: null,
      stdout: "",
      stderr: `command rejected: ${parsed.detail}`,
      ok: false,
      timed_out: false,
      command_not_found: false,
      rejected: true,
      reject_reason: parsed.reason,
      reject_detail: parsed.detail,
      error: parsed.detail,
    };
  }
  const argv = parsed.argv ?? [];
  const executed = execArgv(argv, opts);
  return { ...executed, rejected: false };
}

/**
 * Walk PATH to check whether an executable exists. Replaces `sh -c "command -v X"`
 * patterns so that an untrusted command name cannot inject via the existence check.
 *
 * If `command` contains a path separator, it is resolved relative to cwd (or
 * absolute) and checked directly; otherwise each PATH entry is checked.
 */
export function commandExistsSync(command: string): boolean {
  if (!command || typeof command !== "string") return false;
  if (command.includes("/") || (process.platform === "win32" && command.includes("\\"))) {
    try {
      accessSync(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = isAbsolute(dir) ? join(dir, command) : join(process.cwd(), dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

/**
 * Drop-in replacement for node:child_process execSync that routes through
 * execCommand (parseCommandToArgv → execArgv, no shell). Throws on non-zero
 * exit with the same shape ({status, stdout, stderr, message}) so existing
 * try/catch blocks work unchanged.
 *
 * Use this as the default DI value anywhere a function accepts an execSync
 * seam for testability. Tests inject their own executor; production gets
 * safe-exec as the咽喉 default.
 */
export function safeExecSync(command: string, options: { cwd?: string; timeout?: number; encoding?: BufferEncoding; env?: NodeJS.ProcessEnv; stdio?: Array<"pipe" | "ignore" | "inherit" | null> } = {}): string {
  const result = execCommand(command, options);
  if (result.rejected || !result.ok) {
    const err: Error & { status: number | null; stdout: string; stderr: string; code?: string } = Object.assign(
      new Error(result.rejected ? `command rejected: ${result.reject_detail}` : (result.error || `exit ${result.exit_code}`)),
      {
        status: result.rejected ? 127 : result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.command_not_found ? "ENOENT" : undefined,
      },
    );
    throw err;
  }
  return result.stdout;
}

/**
 * Drop-in replacement for node:child_process execFileSync that routes through
 * execArgv (no shell). The first arg is the executable; the second is argv.
 * Same throw shape as safeExecSync.
 */
export function safeExecFileSync(executable: string, argv: string[] = [], options: { cwd?: string; timeout?: number; encoding?: BufferEncoding; env?: NodeJS.ProcessEnv; stdio?: Array<"pipe" | "ignore" | "inherit" | null>; maxBuffer?: number } = {}): string {
  const result = execArgv([executable, ...argv], options);
  if (!result.ok) {
    const err: Error & { status: number | null; stdout: string; stderr: string; code?: string } = Object.assign(
      new Error(result.error || `exit ${result.exit_code}`),
      {
        status: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.command_not_found ? "ENOENT" : undefined,
      },
    );
    throw err;
  }
  return result.stdout;
}
