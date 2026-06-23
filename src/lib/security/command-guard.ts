// security/command-guard.ts — P10.S1: untrusted command execution guard
// Parses PRD/config-supplied commands into argv and rejects shell metacharacters
// outside quoting so that sh -c is never needed for untrusted input.

export interface ArgvParseResult {
  ok: boolean;
  argv?: string[];
  reason?: string;
  detail?: string;
}

// Shell metacharacters that are dangerous when unquoted.
const DANGEROUS_CHARS = new Set([
  ";", "|", "&", ">", "<", "$", "`", "(", ")", "{", "}", "!", "#", "~",
  "\n", "\r", "\\",
]);

const SHELL_EXECUTABLES = new Set([
  "sh", "bash", "dash", "zsh", "ksh", "fish", "csh", "tcsh",
  "cmd", "powershell", "pwsh",
]);

function executableName(command: string): string {
  const name = String(command || "").replace(/\\/g, "/").split("/").pop() || "";
  return name.toLowerCase().replace(/\.exe$/, "");
}

function isEnvAssignment(arg: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg);
}

function envTargetIndex(argv: string[]): { ok: true; index: number } | { ok: false; detail: string } {
  let index = 1;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--") {
      index += 1;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") break;
    if (arg === "-S" || arg === "--split-string" || arg.startsWith("--split-string=")) {
      return { ok: false, detail: "env -S/--split-string can re-parse a command string" };
    }
    if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir" ||
      arg === "--block-signal" || arg === "--ignore-signal" || arg === "--default-signal") {
      index += 2;
      continue;
    }
    if (arg === "-i" || arg === "-0" || arg === "--ignore-environment" || arg === "--null" ||
      arg.startsWith("--unset=") || arg.startsWith("--chdir=") ||
      arg.startsWith("--block-signal=") || arg.startsWith("--ignore-signal=") ||
      arg.startsWith("--default-signal=")) {
      index += 1;
      continue;
    }
    return { ok: false, detail: `unsupported env option "${arg}" before command target` };
  }
  while (index < argv.length && isEnvAssignment(argv[index])) index += 1;
  return { ok: true, index };
}

function isShellCommandFlag(shell: string, arg: string): boolean {
  const flag = String(arg || "").toLowerCase();
  if (shell === "cmd") return flag === "/c" || flag === "/k";
  if (shell === "powershell" || shell === "pwsh") {
    return flag === "-command" || flag === "-c" || flag === "-encodedcommand" || flag === "-enc" ||
      flag.startsWith("-command:") || flag.startsWith("-encodedcommand:");
  }
  return /^-[a-z]*c[a-z]*$/i.test(arg) || flag === "--command" || flag.startsWith("--command=");
}

function shellCommandModeRejection(argv: string[]): ArgvParseResult | null {
  if (argv.length === 0) return null;
  let commandIndex = 0;
  if (executableName(argv[0]) === "env") {
    const envTarget = envTargetIndex(argv);
    if (envTarget.ok === false) {
      return { ok: false, reason: "shell_command", detail: envTarget.detail };
    }
    commandIndex = envTarget.index;
  }

  const shell = executableName(argv[commandIndex] || "");
  if (!SHELL_EXECUTABLES.has(shell)) return null;
  const shellArgs = argv.slice(commandIndex + 1);
  if (shellArgs.some((arg) => isShellCommandFlag(shell, arg))) {
    return {
      ok: false,
      reason: "shell_command",
      detail: `shell command mode via "${shell}" is not allowed`,
    };
  }
  return null;
}

/**
 * Parse a command string into an argv array, respecting single/double quotes.
 * Rejects unquoted shell metacharacters to prevent injection.
 *
 * Returns {ok: true, argv} on success, or {ok: false, reason, detail} on failure.
 */
export function parseCommandToArgv(command: unknown): ArgvParseResult {
  const input = String(command ?? "").trim();
  if (!input) return { ok: false, reason: "empty", detail: "command is empty" };

  const argv: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") { inSingle = false; }
      else { current += ch; }
      continue;
    }
    if (inDouble) {
      if (ch === '"') { inDouble = false; }
      else if (ch === "$" || ch === "`") {
        return {
          ok: false,
          reason: "shell_metachar",
          detail: `shell expansion "${ch}" inside double quotes at position ${i}`,
        };
      }
      else { current += ch; }
      continue;
    }

    if (ch === "'") { inSingle = true; hasToken = true; continue; }
    if (ch === '"') { inDouble = true; hasToken = true; continue; }

    if (ch === " " || ch === "\t") {
      if (hasToken) { argv.push(current); current = ""; hasToken = false; }
      continue;
    }

    if (DANGEROUS_CHARS.has(ch)) {
      const label = ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch;
      return {
        ok: false,
        reason: "shell_metachar",
        detail: `unquoted shell metacharacter "${label}" at position ${i}`,
      };
    }

    current += ch;
    hasToken = true;
  }

  if (inSingle || inDouble) {
    return { ok: false, reason: "unclosed_quote", detail: "unterminated quote in command" };
  }

  if (hasToken) argv.push(current);

  if (argv.length === 0) {
    return { ok: false, reason: "empty", detail: "command parsed to empty argv" };
  }

  const shellRejection = shellCommandModeRejection(argv);
  if (shellRejection) return shellRejection;

  return { ok: true, argv };
}

/**
 * Returns true if the command string contains unquoted shell metacharacters.
 * Use for compile-time validation where argv parsing is not yet needed.
 */
export function hasUnquotedShellMetacharacters(command: unknown): boolean {
  return !parseCommandToArgv(command).ok;
}

/**
 * Returns the set of dangerous unquoted metacharacters found in the command.
 * Useful for error messages.
 */
export function unquotedShellMetacharactersIn(command: unknown): string[] {
  const result = parseCommandToArgv(command);
  if (result.ok || result.reason !== "shell_metachar") return [];
  const match = (result.detail || "").match(/"(.+?)"/);
  return match ? [match[1]] : [];
}
