import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readJsonlTail } from "../../lib/bounded-read.js";
import {
  buildLedgerRecord,
  buildEvidenceArtifact,
  evidenceArtifactDigest,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_HASH_ALGORITHM,
  EVIDENCE_SCHEMA_VERSION,
  LEDGER_EVENT_SCHEMA,
  UNSIGNED_DEVELOPMENT_WARNING,
  ledgerRecordHash,
  sha256Evidence,
  stableEvidenceJson,
  validateEvidenceArtifact,
  validateLedgerRecord,
} from "./schema.js";
import type { EvidenceLedgerRecord } from "./schema.js";
import { redactDeep } from "../../lib/security/redact.js";

const DEFAULT_LEDGER_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LEDGER_LOCK_STALE_MS = 120_000;
const DEFAULT_LEDGER_READ_MAX_BYTES = 8 * 1024 * 1024;
const LEDGER_LOCK_OWNER_PREFIX = "owner.";
const LEDGER_LOCK_OWNER_SUFFIX = ".json";

interface LedgerRecord extends Record<string, unknown> {
  code?: string;
  message?: string;
  prev_hash?: string | null;
  record_hash?: string;
  errors?: LedgerChainError[];
}
type LedgerOptions = Record<string, unknown>;

interface LedgerChainError extends LedgerRecord {
  index: number;
  code: string;
  message: string;
}

function isRecord(value: unknown): value is LedgerRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asPositiveNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function ledgerAppendError(code: string, message: string, details: Record<string, unknown> = Object(), cause: unknown = undefined) {
  const error = new Error(message);
  return Object.assign(error, {
    code,
    ...details,
    ...(cause ? { cause } : {}),
  });
}

function allowUnsignedDevelopment(options: LedgerOptions = Object()): boolean {
  return options.allowUnsignedDevelopment === true || options.allow_unsigned_development === true;
}

function explicitLedgerHmacKey(options: LedgerOptions = Object()): string | undefined {
  const value = typeof options.hmacKey === "string" ? options.hmacKey
    : typeof options.hmac_key === "string" ? options.hmac_key
    : undefined;
  return value && value.trim().length > 0 ? value : undefined;
}

function optionStateRoot(options: LedgerOptions = Object()): string | undefined {
  return typeof options.stateRoot === "string" ? options.stateRoot
    : typeof options.state_root === "string" ? options.state_root
    : undefined;
}

function fsErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code || "") : "";
}

function ledgerReadMaxBytes(options: LedgerOptions = Object()): number {
  return asPositiveNumber(options.maxBytes ?? options.max_bytes, DEFAULT_LEDGER_READ_MAX_BYTES);
}

function ledgerReadErrorRecord(code: string, message: string, details: LedgerRecord = Object()): LedgerRecord {
  return {
    ledger_read_error: true,
    status: "fail",
    code,
    message,
    ...details,
  };
}

function ledgerReadError(code: string, message: string, details: LedgerRecord = Object(), cause: unknown = undefined) {
  const error = new Error(message);
  return Object.assign(error, {
    code,
    ...details,
    ...(cause ? { cause } : {}),
  });
}

function ledgerLockPath(filePath: string) {
  return `${filePath}.lock`;
}

function ledgerLockOwnerPath(lockPath: string, ownerToken: string) {
  return join(lockPath, `${LEDGER_LOCK_OWNER_PREFIX}${ownerToken}${LEDGER_LOCK_OWNER_SUFFIX}`);
}

function ledgerLockOwnerFiles(lockPath: string): string[] {
  try {
    return readdirSync(lockPath)
      .filter((entry) => entry.startsWith(LEDGER_LOCK_OWNER_PREFIX) && entry.endsWith(LEDGER_LOCK_OWNER_SUFFIX));
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") return [];
    throw error;
  }
}

function readLockAgeMs(lockPath: string, nowMs: number): number | null {
  try {
    return nowMs - statSync(lockPath).mtimeMs;
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function removeStaleLedgerLock(lockPath: string, filePath: string, staleMs: number, nowMs: number): boolean {
  const lockAgeMs = readLockAgeMs(lockPath, nowMs);
  if (lockAgeMs === null || lockAgeMs < staleMs) return false;
  const ownerFiles = ledgerLockOwnerFiles(lockPath);
  if (ownerFiles.length !== 1) return false;
  const ownerPath = join(lockPath, ownerFiles[0]);
  try {
    unlinkSync(ownerPath);
    rmdirSync(lockPath);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(fsErrorCode(error))) return false;
    throw ledgerAppendError("LEDGER_APPEND_LOCK_STALE_CLEANUP_FAILED", "Failed to clean stale evidence ledger append lock.", {
      ledger_path: filePath,
      lock_path: lockPath,
      stale_ms: staleMs,
      lock_age_ms: lockAgeMs,
    }, error);
  }
}

function acquireLedgerAppendLock(filePath: string, options: LedgerOptions = Object()): () => void {
  const timeoutMs = asPositiveNumber(options.lockTimeoutMs ?? options.lock_timeout_ms, DEFAULT_LEDGER_LOCK_TIMEOUT_MS);
  const staleMs = asPositiveNumber(options.lockStaleMs ?? options.lock_stale_ms, DEFAULT_LEDGER_LOCK_STALE_MS);
  const lockPath = ledgerLockPath(filePath);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  mkdirSync(dirname(filePath), { recursive: true });

  while (Date.now() <= deadline) {
    attempts += 1;
    try {
      const ownerToken = randomUUID();
      mkdirSync(lockPath);
      writeFileSync(ledgerLockOwnerPath(lockPath, ownerToken), JSON.stringify({
        owner_token: ownerToken,
        pid: process.pid,
        created_at: new Date().toISOString(),
      }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          unlinkSync(ledgerLockOwnerPath(lockPath, ownerToken));
          rmdirSync(lockPath);
        } catch (error) {
          if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(fsErrorCode(error))) return;
          throw ledgerAppendError("LEDGER_APPEND_LOCK_RELEASE_FAILED", "Failed to release evidence ledger append lock.", {
            ledger_path: filePath,
            lock_path: lockPath,
          }, error);
        }
      };
    } catch (error) {
      const code = fsErrorCode(error);
      if (code !== "EEXIST") {
        if (code.startsWith("LEDGER_APPEND_")) throw error;
        throw ledgerAppendError("LEDGER_APPEND_LOCK_ACQUIRE_FAILED", "Failed to acquire evidence ledger append lock.", {
          ledger_path: filePath,
          lock_path: lockPath,
        }, error);
      }

      if (removeStaleLedgerLock(lockPath, filePath, staleMs, Date.now())) continue;
      throw ledgerAppendError("LEDGER_APPEND_LOCK_BUSY", "Evidence ledger append lock is held; refusing to block the event loop.", {
        ledger_path: filePath,
        lock_path: lockPath,
        timeout_ms: timeoutMs,
        stale_ms: staleMs,
        attempts,
      });
    }
  }

  throw ledgerAppendError("LEDGER_APPEND_LOCK_TIMEOUT", "Timed out waiting for evidence ledger append lock.", {
    ledger_path: filePath,
    lock_path: lockPath,
    timeout_ms: timeoutMs,
    stale_ms: staleMs,
    attempts,
  });
}

function readJsonlRecords(filePath: string, options: LedgerOptions = Object()): unknown[] {
  if (!existsSync(filePath)) return [];
  const maxBytes = ledgerReadMaxBytes(options);
  const sizeBytes = statSync(filePath).size;
  if (sizeBytes > maxBytes) {
    const details = {
      ledger_path: filePath,
      size_bytes: sizeBytes,
      max_bytes: maxBytes,
      truncated: true,
    };
    const message = `Evidence ledger exceeds bounded read limit (${sizeBytes} > ${maxBytes} bytes).`;
    if (options.throwOnReadError || options.throw_on_read_error) {
      throw ledgerReadError("LEDGER_READ_SIZE_LIMIT_EXCEEDED", message, details);
    }
    return [ledgerReadErrorRecord("LEDGER_READ_SIZE_LIMIT_EXCEEDED", message, details)];
  }
  // Keep malformed/truncated JSONL lines visible as integrity errors instead of
  // throwing or silently dropping them. Dropping a bad middle line can preserve
  // a valid-looking hash chain over the remaining records and produce a false
  // green integrity result.
  return readFileSync(filePath, "utf8")
    .split("\n")
    .flatMap((line, index) => {
      if (line.trim().length === 0) return [];
      try {
        return [JSON.parse(line)];
      } catch (error) {
        return [ledgerReadErrorRecord("LEDGER_JSONL_MALFORMED_LINE", "Evidence ledger contains a malformed JSONL line.", {
          ledger_path: filePath,
          line_number: index + 1,
          parse_error: error instanceof Error ? error.message : String(error),
        })];
      }
    });
}

// L6: previousRecordHash previously read the WHOLE file (readJsonlRecords) and
// scanned from the end — O(N) in ledger size on every append. The head hash is
// always in the most recent records, so a bounded tail read is sufficient and
// O(1)-ish in the file size. Fall back to a full read only if the tail window
// somehow lacks a record_hash (e.g. a long run of hash-less records).
function previousRecordHash(filePath: string): unknown {
  const tail = readJsonlTail(filePath, { maxEntries: 64, maxBytes: 256 * 1024 });
  if (tail && Array.isArray(tail.entries)) {
    for (let index = tail.entries.length - 1; index >= 0; index -= 1) {
      const record = tail.entries[index];
      if (isRecord(record) && record.record_hash) return record.record_hash;
    }
  }
  // Fallback: full read (rare — only when the tail window has no hash).
  const records = readJsonlRecords(filePath, { throwOnReadError: true });
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (isRecord(record) && record.record_hash) return record.record_hash;
  }
  return null;
}

// Resolve the project-rooted HMAC key used for ledger record signing. The key
// lives at <stateRoot>/keys/ledger.hmac. Callers that produce or accept formal
// evidence use requireLedgerHmacKey so missing, empty, or unreadable keys fail
// closed; this resolver remains non-throwing for structured validation reports.
export const LEDGER_HMAC_KEY_REL = "keys/ledger.hmac";
export function resolveLedgerHmacKey(stateRoot?: string): string | undefined {
  if (!stateRoot) return undefined;
  const keyPath = join(stateRoot, LEDGER_HMAC_KEY_REL);
  if (!existsSync(keyPath)) return undefined;
  try {
    const key = readFileSync(keyPath, "utf8").trim();
    return key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

function discoverLedgerHmacStateRoot(filePath: string): string | undefined {
  let current = dirname(filePath);
  while (true) {
    if (existsSync(join(current, LEDGER_HMAC_KEY_REL))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function requireLedgerHmacKey(stateRoot?: string, options: LedgerOptions = Object()): string | undefined {
  const key = explicitLedgerHmacKey(options) || resolveLedgerHmacKey(stateRoot);
  if (key) return key;
  if (allowUnsignedDevelopment(options)) return undefined;
  const keyPath = stateRoot ? join(stateRoot, LEDGER_HMAC_KEY_REL) : null;
  throw ledgerAppendError(
    "LEDGER_HMAC_KEY_REQUIRED",
    `Evidence ledger HMAC key is required${keyPath ? ` at ${keyPath}` : " via hmacKey or stateRoot"}; refusing unsigned production evidence. Run \`yolo init\` to (re)generate the project ledger HMAC key.`,
    {
      hmac_key_path: keyPath,
      production_ready: false,
      recovery: "Run `yolo init` to provision the project ledger HMAC key, or pass --force to regenerate a missing/empty/corrupted key.",
    },
  );
}

export function provisionLedgerHmacKey(
  stateRoot: string,
  options: { force?: boolean } = Object(),
): { key_path: string; created: boolean } {
  const keyPath = join(stateRoot, LEDGER_HMAC_KEY_REL);
  // Fast path: an existing non-empty key is authoritative. Never overwrite a
  // valid key, even under force — only missing/empty/corrupted keys are
  // recoverable. This preserves the wx exclusivity guarantee for good keys.
  if (existsSync(keyPath)) {
    const existing = readLedgerHmacKeyFile(keyPath);
    if (existing) return { key_path: keyPath, created: false };
    // The key file exists but is empty/whitespace/unreadable. Without force we
    // still fail safe and leave the (already broken) file alone so the caller
    // can decide; with force we fall through to regenerate it.
    if (!options.force) return { key_path: keyPath, created: false };
  }
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    // When regenerating an existing-but-invalid key under force, overwrite the
    // broken file in place. For fresh keys, wx keeps creation exclusive so two
    // concurrent provisions cannot clobber each other.
    writeFileSync(keyPath, randomBytes(32).toString("hex"), {
      encoding: "utf8",
      flag: options.force && existsSync(keyPath) ? "w" : "wx",
      mode: 0o600,
    });
    return { key_path: keyPath, created: true };
  } catch (error) {
    if (fsErrorCode(error) === "EEXIST") return { key_path: keyPath, created: false };
    throw error;
  }
}

// Read and validate the on-disk HMAC key. Returns the trimmed key only when it
// is non-empty; an empty/whitespace-only/unreadable file yields undefined so
// callers can treat it as "missing" and (when force is set) regenerate it.
function readLedgerHmacKeyFile(keyPath: string): string | undefined {
  try {
    const value = readFileSync(keyPath, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function validateLedgerChain(records: unknown[] = [], options: LedgerOptions = Object()) {
  const errors: LedgerChainError[] = [];
  const allowExternalHead = options.allowExternalHead === true || options.allow_external_head === true;
  // Every production record must have a verifiable record_sig. The only
  // unsigned path is the explicit development option, which returns a visibly
  // non-production result and requires the marker embedded by the writer.
  const hmacKey = explicitLedgerHmacKey(options) || resolveLedgerHmacKey(optionStateRoot(options));
  const unsignedDevelopment = !hmacKey && allowUnsignedDevelopment(options);
  if (!hmacKey && !unsignedDevelopment) {
    errors.push({
      index: -1,
      code: "LEDGER_HMAC_KEY_REQUIRED",
      message: "Evidence ledger HMAC key is required; unsigned records cannot satisfy production evidence validation.",
      production_ready: false,
    });
  }
  let previousHash = allowExternalHead && isRecord(records[0]) && records[0].prev_hash ? records[0].prev_hash : null;
  records.forEach((record, index) => {
    const validation = validateLedgerRecord(record, hmacKey
      ? { hmacKey }
      : unsignedDevelopment
        ? { allowUnsignedDevelopment: true }
        : Object());
    for (const error of validation.errors) {
      errors.push({ index, code: "LEDGER_RECORD_INVALID", message: error });
    }
    // validateLedgerRecord above already rejected null/non-object records with
    // a structured LEDGER_RECORD_INVALID error. Skip the chain-continuity check
    // for those records — accessing `record.prev_hash`/`record.record_hash`
    // would crash on null/number/string. The chain is already broken; we just
    // need to report it without throwing. Mirror the boundary that readJsonl
    // (report.ts) and #70/#82 already defend.
    if (!isRecord(record)) {
      previousHash = null;
      return;
    }
    if (record.prev_hash !== previousHash) {
      errors.push({
        index,
        code: "LEDGER_PREV_HASH_MISMATCH",
        message: `prev_hash must match previous record_hash at index ${index}`,
        expected: previousHash,
        actual: record.prev_hash ?? null,
      });
    }
    previousHash = record.record_hash || null;
  });
  return {
    ok: errors.length === 0,
    status: errors.length > 0 ? "fail" : unsignedDevelopment ? "non_production" : "pass",
    production_ready: errors.length === 0 && Boolean(hmacKey),
    ...(unsignedDevelopment ? { notices: [UNSIGNED_DEVELOPMENT_WARNING] } : {}),
    checked_count: records.length,
    head_hash: previousHash,
    errors,
  };
}

export function readLedgerJsonl(filePath: string, options: LedgerOptions = Object()): LedgerRecord[] {
  return readJsonlRecords(filePath, options) as LedgerRecord[];
}

export function withLedgerAppendLock<T>(filePath: string, options: LedgerOptions, append: () => T): T {
  let release: (() => void) | undefined;
  let appendError: unknown;
  try {
    release = acquireLedgerAppendLock(filePath, options);
    return append();
  } catch (error) {
    appendError = error;
    const code = fsErrorCode(error);
    if (code.startsWith("LEDGER_APPEND_") || code.startsWith("LEDGER_READ_")) throw error;
    throw ledgerAppendError("LEDGER_APPEND_FAILED", "Failed to append evidence ledger record.", {
      ledger_path: filePath,
    }, error);
  } finally {
    if (release) {
      try {
        release();
      } catch (releaseError) {
        if (!appendError) throw releaseError;
      }
    }
  }
}

export function appendJsonlRecord<TRecord extends LedgerRecord>(filePath: string, record: TRecord, options: LedgerOptions = Object()): EvidenceLedgerRecord & TRecord {
  const hmacKey = requireLedgerHmacKey(optionStateRoot(options) || discoverLedgerHmacStateRoot(filePath), options);
  const unsignedDevelopment = !hmacKey && allowUnsignedDevelopment(options);
  return withLedgerAppendLock(filePath, options, () => {
    const now = options.now || new Date().toISOString();
    mkdirSync(dirname(filePath), { recursive: true });
    // P10.S3: redact credential patterns before building the record (which
    // computes record_hash) so the hash is self-consistent with the redacted
    // payload. Readers see only redacted data; the chain integrity is preserved.
    const safeRecord = redactDeep(record || Object());
    // Resolve the project HMAC key before writing. Missing keys already failed
    // above unless the caller explicitly selected unsigned development mode.
    const payload = buildLedgerRecord(safeRecord?.event, safeRecord, {
      ...options,
      now,
      ledger: safeRecord?.ledger || options.ledger,
      prevHash: options.prevHash ?? options.prev_hash ?? safeRecord?.prev_hash ?? previousRecordHash(filePath),
      hmacKey,
      allowUnsignedDevelopment: unsignedDevelopment,
    });
    const validation = validateLedgerRecord(payload, hmacKey ? { hmacKey } : { allowUnsignedDevelopment: true });
    if (!validation.ok) {
      throw ledgerAppendError("LEDGER_APPEND_RECORD_INVALID", `Invalid evidence ledger record: ${validation.errors.join("; ")}`, {
        ledger_path: filePath,
        validation_errors: validation.errors,
      });
    }
    appendFileSync(filePath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
    return payload;
  });
}

export function appendStateEvent<TData extends LedgerRecord>(stateDir: string, event: unknown, data: TData = Object() as TData, options: LedgerOptions = Object()) {
  return appendJsonlRecord(join(stateDir, "events.jsonl"), { ...data, event, ledger: "state" }, {
    stateRoot: optionStateRoot(options) || (resolveLedgerHmacKey(stateDir) ? stateDir : dirname(stateDir)),
    ...options,
  });
}

export function appendRunEvent<TData extends LedgerRecord>(stateDir: string, event: unknown, data: TData = Object() as TData, options: LedgerOptions = Object()) {
  return appendJsonlRecord(join(stateDir, "runs.jsonl"), { ...data, event, ledger: "run" }, {
    stateRoot: optionStateRoot(options) || (resolveLedgerHmacKey(stateDir) ? stateDir : dirname(stateDir)),
    ...options,
  });
}

export function writeJsonArtifact(filePath: string, payload: unknown): string {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  return filePath;
}

export function createEvidenceLedger({ stateDir }: { stateDir?: string }) {
  if (!stateDir) {
    throw new Error("createEvidenceLedger requires stateDir");
  }
  return {
    appendStateEvent: (event: unknown, data: LedgerRecord = Object(), options: LedgerOptions = Object()) => appendStateEvent(stateDir, event, data, options),
    appendRunEvent: (event: unknown, data: LedgerRecord = Object(), options: LedgerOptions = Object()) => appendRunEvent(stateDir, event, data, options),
    buildEvidenceArtifact,
    buildLedgerRecord,
    evidenceArtifactDigest,
    ledgerRecordHash,
    readLedgerJsonl,
    sha256Evidence,
    stableEvidenceJson,
    validateEvidenceArtifact,
    validateLedgerChain,
    validateLedgerRecord,
    writeJsonArtifact: (filePath: string, payload: unknown) => writeJsonArtifact(filePath, payload),
  };
}

export {
  buildEvidenceArtifact,
  buildLedgerRecord,
  evidenceArtifactDigest,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_HASH_ALGORITHM,
  EVIDENCE_SCHEMA_VERSION,
  LEDGER_EVENT_SCHEMA,
  UNSIGNED_DEVELOPMENT_WARNING,
  ledgerRecordHash,
  sha256Evidence,
  stableEvidenceJson,
  validateEvidenceArtifact,
  validateLedgerRecord,
};
