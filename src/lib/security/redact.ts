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
  // Slack bot/user/app/restricted tokens
  { pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g, label: "[REDACTED:slack-token]" },
  // Google API keys
  { pattern: /AIza[0-9A-Za-z_-]{20,}/g, label: "[REDACTED:google-api-key]" },
  // Stripe live secret/restricted keys
  { pattern: /[sr]k_live_[A-Za-z0-9]{16,}/g, label: "[REDACTED:stripe-live-key]" },
  // JWT-shaped bearer material, including raw tokens without the Bearer prefix
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, label: "[REDACTED:jwt]" },
  // Bare high-entropy hex tokens and private digests
  { pattern: /\b[A-Fa-f0-9]{40,64}\b/g, label: "[REDACTED:hex-token]" },
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
 *
 * Integrity fields (content hashes / digests / fingerprints that the project
 * owner controls and that must round-trip byte-identically for re-verification)
 * are NOT redacted: a 64-char sha256 is indistinguishable from a high-entropy
 * secret to the hex-token pattern, but redacting it would void every signature
 * / integrity re-check (e.g. CR5's source_fingerprint recompute at ship).
 */
const INTEGRITY_KEY_RE = /(?:^|_)(?:hash|digest|fingerprint|sha256|sha512|md5)(?:_|$)|^source_fingerprint$|^record_hash$|^artifact_digest$|^prev_hash$/i;
function isIntegrityKey(key: string): boolean {
  return INTEGRITY_KEY_RE.test(key);
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Preserve integrity digests/hashes verbatim so re-verification works.
      out[k] = isIntegrityKey(k) ? v : redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}
