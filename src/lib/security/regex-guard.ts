// security/regex-guard.ts — P10.S4: user-supplied regex safety chokepoint
//
// Gate conditions like no_forbidden_patterns and type_errors_contain construct
// RegExp objects from PRD/config-supplied strings. A malicious pattern such as
// `(a+)+$` can cause catastrophic backtracking (ReDoS) when matched against
// ordinary build output. This module validates patterns before they are used.
//
// Adversarial contract:
//   - reject patterns with nested quantifiers (e.g. (a+)+, (a*)*, (a+)?)
//   - reject empty or syntactically invalid patterns
//   - accept common safe patterns (literal text, simple character classes,
//     single-level quantifiers like /^foo|bar$/)

export interface RegexValidationResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate that a user-supplied regex pattern is safe to execute.
 * Returns { ok: true } if the pattern passes syntax and safety checks,
 * or { ok: false, reason } explaining why it was rejected.
 */
export function validateRegexPattern(pattern: unknown): RegexValidationResult {
  const input = String(pattern ?? "").trim();
  if (input.length === 0) {
    return { ok: false, reason: "regex pattern is empty" };
  }

  try {
    new RegExp(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `invalid regex: ${message}` };
  }

  if (hasNestedQuantifiers(input)) {
    return { ok: false, reason: "regex contains nested quantifiers that can cause catastrophic backtracking" };
  }

  return { ok: true };
}

/**
 * Construct a RegExp from a pattern only if it passes safety validation.
 * Returns null for unsafe or invalid patterns.
 */
export function safeRegExp(pattern: string, flags = ""): RegExp | null {
  const validation = validateRegexPattern(pattern);
  if (!validation.ok) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

const QUANTIFIER_CHARS = new Set(["+", "*", "?"]);

function isQuantifierChar(ch: string): boolean {
  return QUANTIFIER_CHARS.has(ch);
}

function isRepetitionStart(pattern: string, index: number): boolean {
  const rest = pattern.slice(index + 1);
  return /^\d+(?:,\d*)?\}/.test(rest);
}

function isEscaped(pattern: string, index: number): boolean {
  let count = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (pattern[i] === "\\") count++;
    else break;
  }
  return count % 2 === 1;
}

/**
 * Detect nested quantifiers that are the hallmark of catastrophic backtracking.
 * Specifically: a group that contains a quantified atom and is itself quantified.
 * Examples: (a+)+, (a*)*, (a+)*, (a+)?, ([a-z]+)+
 *
 * This is intentionally conservative: it rejects the dangerous class of patterns
 * while allowing the simple regexes used by yolo gates.
 */
function hasNestedQuantifiers(pattern: string): boolean {
  // Stack frame tracks whether the group currently contains any quantified atom.
  const stack: { hasQuantifiedAtom: boolean }[] = [];
  let escaped = false;
  let inCharClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (inCharClass) {
      if (ch === "]" && !isEscaped(pattern, i)) {
        inCharClass = false;
      }
      continue;
    }

    if (ch === "[" && !isEscaped(pattern, i)) {
      inCharClass = true;
      continue;
    }

    if (ch === "(") {
      stack.push({ hasQuantifiedAtom: false });
      continue;
    }

    if (ch === ")") {
      const group = stack.pop();
      if (group?.hasQuantifiedAtom) {
        const next = pattern[i + 1];
        if (next && isQuantifierChar(next) && !isEscaped(pattern, i + 1)) {
          return true;
        }
        if (next === "{" && isRepetitionStart(pattern, i + 1) && !isEscaped(pattern, i + 1)) {
          return true;
        }
        // A quantified group counts as a quantified atom for its parent group.
        if (stack.length > 0) {
          stack[stack.length - 1].hasQuantifiedAtom = true;
        }
      }
      continue;
    }

    if (isQuantifierChar(ch) || (ch === "{" && isRepetitionStart(pattern, i))) {
      if (stack.length > 0) {
        stack[stack.length - 1].hasQuantifiedAtom = true;
      }
      continue;
    }
  }

  return false;
}
