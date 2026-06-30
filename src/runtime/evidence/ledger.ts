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
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  buildLedgerRecord,
  buildEvidenceArtifact,
  evidenceArtifactDigest,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_HASH_ALGORITHM,
  EVIDENCE_SCHEMA_VERSION,
  LEDGER_EVENT_SCHEMA,
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

function previousRecordHash(filePath: string): unknown {
  const records = readJsonlRecords(filePath, { throwOnReadError: true });
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (isRecord(record) && record.record_hash) return record.record_hash;
  }
  return null;
}

// H3: resolve an optional project-rooted HMAC key for ledger record signing.
// The key lives at <stateRoot>/keys/ledger.hmac (project-rooted, optional). When
// present, appended records carry a record_sig computed with this key, so
// append-only write access alone cannot forge a valid chain. Returns undefined
// when no key is configured (backward-compatible with existing unsigned chains).
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

export function validateLedgerChain(records: unknown[] = [], options: LedgerOptions = Object()) {
  const errors: LedgerChainError[] = [];
  const allowExternalHead = options.allowExternalHead === true || options.allow_external_head === true;
  // H3: HMAC key for record_sig verification (project-rooted, optional). When
  // present, every record's record_sig is verified; a forged append fails closed.
  const hmacKey = typeof options.hmacKey === "string" ? options.hmacKey : (typeof options.hmac_key === "string" ? options.hmac_key : undefined);
  let previousHash = allowExternalHead && isRecord(records[0]) && records[0].prev_hash ? records[0].prev_hash : null;
  records.forEach((record, index) => {
    const validation = validateLedgerRecord(record, hmacKey ? { hmacKey } : Object());
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
    status: errors.length === 0 ? "pass" : "fail",
    checked_count: records.length,
    head_hash: previousHash,
    errors,
  };
}

export function readLedgerJsonl(filePath: string, options: LedgerOptions = Object()): LedgerRecord[] {
  return readJsonlRecords(filePath, options) as LedgerRecord[];
}

function withLedgerAppendLock<T>(filePath: string, options: LedgerOptions, append: () => T): T {
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
  return withLedgerAppendLock(filePath, options, () => {
    const now = options.now || new Date().toISOString();
    mkdirSync(dirname(filePath), { recursive: true });
    // P10.S3: redact credential patterns before building the record (which
    // computes record_hash) so the hash is self-consistent with the redacted
    // payload. Readers see only redacted data; the chain integrity is preserved.
    const safeRecord = redactDeep(record || Object());
    // H3: resolve the project HMAC key (from explicit option or stateRoot) so
    // the appended record carries a record_sig when the project has committed
    // to HMAC-signed ledger chains.
    const hmacKey = typeof options.hmacKey === "string" ? options.hmacKey
      : typeof options.hmac_key === "string" ? options.hmac_key
      : resolveLedgerHmacKey(typeof options.stateRoot === "string" ? options.stateRoot : (typeof options.state_root === "string" ? options.state_root : undefined));
    const payload = buildLedgerRecord(safeRecord?.event, safeRecord, {
      ...options,
      now,
      ledger: safeRecord?.ledger || options.ledger,
      prevHash: options.prevHash ?? options.prev_hash ?? safeRecord?.prev_hash ?? previousRecordHash(filePath),
      hmacKey,
    });
    const validation = validateLedgerRecord(payload, hmacKey ? { hmacKey } : Object());
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
  return appendJsonlRecord(join(stateDir, "events.jsonl"), { ...data, event, ledger: "state" }, options);
}

export function appendRunEvent<TData extends LedgerRecord>(stateDir: string, event: unknown, data: TData = Object() as TData, options: LedgerOptions = Object()) {
  return appendJsonlRecord(join(stateDir, "runs.jsonl"), { ...data, event, ledger: "run" }, options);
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
  ledgerRecordHash,
  sha256Evidence,
  stableEvidenceJson,
  validateEvidenceArtifact,
  validateLedgerRecord,
};
