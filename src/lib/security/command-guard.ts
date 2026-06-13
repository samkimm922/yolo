// security/command-guard.ts — P10.S1: untrusted command execution guard
// Parses PRD/config-supplied commands into argv and rejects shell metacharacters
// outside quoting so that sh -c is never needed for untrusted input.

export interface ArgvParseOK {
  ok: true;
  argv: string[];
}

export interface ArgvParseFail {
  ok: false;
  reason: "shell_metachar" | "unclosed_quote" | "empty";
  detail: string;
}

export type ArgvParseResult = ArgvParseOK | ArgvParseFail;

// Shell metacharacters that are dangerous when unquoted.
const DANGEROUS_CHARS = new Set([
  ";", "|", "&", ">", "<", "$", "`", "(", ")", "{", "}", "!", "#", "~",
  "\n", "\r", "\\",
]);

/**
 * Parse a command string into an argv array, respecting single/double quotes.
 * Rejects unquoted shell metacharacters to prevent injection.
 *
 * Returns {ok, argv} on success, or {ok: false, reason, detail} on failure.
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
  const match = result.detail.match(/"(.+?)"/);
  return match ? [match[1]] : [];
}
