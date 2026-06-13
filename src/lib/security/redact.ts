// security/redact.ts — P10.S3: secret redaction before persistence
// Masks common credential patterns in text before writing to evidence/logs/reports.

const REDACTION_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  // OpenAI / Anthropic style API keys
  { pattern: /sk-[A-Za-z0-9_\-]{16,}/g, label: "[REDACTED:sk-key]" },
  // Bearer tokens
  { pattern: /Bearer\s+[A-Za-z0-9_\-\.=]+/gi, label: "Bearer [REDACTED:token]" },
  // AWS access key IDs
  { pattern: /AKIA[0-9A-Z]{16}/g, label: "[REDACTED:aws-key]" },
  // AWS secret access keys (40 chars of base64-ish after known prefix)
  { pattern: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi, label: "aws_secret_access_key=[REDACTED]" },
  // GitHub tokens (classic + fine-grained)
  { pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g, label: "[REDACTED:gh-token]" },
  // Generic key=value assignments for common secret names
  { pattern: /(?:api[_-]?key|secret|password|token|access[_-]?token|private[_-]?key)\s*[=:]\s*['"]?[A-Za-z0-9_\-\.\/+=]{8,}['"]?/gi, label: "[REDACTED:credential]" },
  // Private key blocks
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g, label: "[REDACTED:private-key-block]" },
];

/**
 * Mask known credential patterns in a text string.
 * Returns a new string with secrets replaced by placeholder labels.
 */
export function redact(text: unknown): string {
  const input = String(text ?? "");
  let result = input;
  for (const { pattern, label } of REDACTION_PATTERNS) {
    result = result.replace(pattern, label);
  }
  return result;
}

/**
 * Redact secrets in an arbitrary JSON-serializable value (object/array/string).
 * Returns a new value with all string fields redacted.
 */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
