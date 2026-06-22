import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { redactDeep } from "../../lib/security/redact.js";

const DEFAULT_LEDGER_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LEDGER_LOCK_STALE_MS = 120_000;
const DEFAULT_LEDGER_LOCK_RETRY_MS = 10;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function asPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function ledgerAppendError(code, message, details = Object(), cause = undefined) {
  const error = new Error(message);
  return Object.assign(error, {
    code,
    ...details,
    ...(cause ? { cause } : {}),
  });
}

function sleepSync(ms) {
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, Math.max(1, ms));
}

function ledgerLockPath(filePath) {
  return `${filePath}.lock`;
}

function readLockAgeMs(lockPath, nowMs) {
  try {
    return nowMs - statSync(lockPath).mtimeMs;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function removeStaleLedgerLock(lockPath, filePath, staleMs, nowMs) {
  const lockAgeMs = readLockAgeMs(lockPath, nowMs);
  if (lockAgeMs === null || lockAgeMs < staleMs) return false;
  try {
    rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    throw ledgerAppendError("LEDGER_APPEND_LOCK_STALE_CLEANUP_FAILED", "Failed to clean stale evidence ledger append lock.", {
      ledger_path: filePath,
      lock_path: lockPath,
      stale_ms: staleMs,
      lock_age_ms: lockAgeMs,
    }, error);
  }
}

function acquireLedgerAppendLock(filePath, options = Object()) {
  const timeoutMs = asPositiveNumber(options.lockTimeoutMs ?? options.lock_timeout_ms, DEFAULT_LEDGER_LOCK_TIMEOUT_MS);
  const staleMs = asPositiveNumber(options.lockStaleMs ?? options.lock_stale_ms, DEFAULT_LEDGER_LOCK_STALE_MS);
  const retryMs = asPositiveNumber(options.lockRetryMs ?? options.lock_retry_ms, DEFAULT_LEDGER_LOCK_RETRY_MS);
  const lockPath = ledgerLockPath(filePath);
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  mkdirSync(dirname(filePath), { recursive: true });

  while (Date.now() <= deadline) {
    attempts += 1;
    try {
      mkdirSync(lockPath);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch (error) {
          throw ledgerAppendError("LEDGER_APPEND_LOCK_RELEASE_FAILED", "Failed to release evidence ledger append lock.", {
            ledger_path: filePath,
            lock_path: lockPath,
          }, error);
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (error?.code?.startsWith?.("LEDGER_APPEND_")) throw error;
        throw ledgerAppendError("LEDGER_APPEND_LOCK_ACQUIRE_FAILED", "Failed to acquire evidence ledger append lock.", {
          ledger_path: filePath,
          lock_path: lockPath,
        }, error);
      }

      removeStaleLedgerLock(lockPath, filePath, staleMs, Date.now());
      if (Date.now() > deadline) break;
      sleepSync(retryMs);
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

function readJsonlRecords(filePath) {
  if (!existsSync(filePath)) return [];
  // Tolerate malformed/truncated JSONL lines (partial flush, SIGKILL mid-write,
  // botched external edit). A dropped line breaks the ledger chain, which
  // validateLedgerChain surfaces as LEDGER_PREV_HASH_MISMATCH — the corruption
  // stays visible instead of crashing every caller (report.ts mirrors this
  // defense; #70/#82 already hardened validateLedgerChain for null/non-object
  // records, but the raw read path here still threw on unparseable lines).
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function previousRecordHash(filePath) {
  const records = readJsonlRecords(filePath);
  return records.at(-1)?.record_hash || null;
}

export function validateLedgerChain(records = [], options = Object()) {
  const errors = [];
  const allowExternalHead = options.allowExternalHead === true || options.allow_external_head === true;
  let previousHash = allowExternalHead && records[0]?.prev_hash ? records[0].prev_hash : null;
  records.forEach((record, index) => {
    const validation = validateLedgerRecord(record);
    for (const error of validation.errors) {
      errors.push({ index, code: "LEDGER_RECORD_INVALID", message: error });
    }
    // validateLedgerRecord above already rejected null/non-object records with
    // a structured LEDGER_RECORD_INVALID error. Skip the chain-continuity check
    // for those records — accessing `record.prev_hash`/`record.record_hash`
    // would crash on null/number/string. The chain is already broken; we just
    // need to report it without throwing. Mirror the boundary that readJsonl
    // (report.ts) and #70/#82 already defend.
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
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

export function readLedgerJsonl(filePath) {
  return readJsonlRecords(filePath);
}

function withLedgerAppendLock(filePath, options, append) {
  let release;
  let appendError;
  try {
    release = acquireLedgerAppendLock(filePath, options);
    return append();
  } catch (error) {
    appendError = error;
    if (error?.code?.startsWith?.("LEDGER_APPEND_")) throw error;
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

export function appendJsonlRecord(filePath, record, options = Object()) {
  return withLedgerAppendLock(filePath, options, () => {
    const now = options.now || new Date().toISOString();
    mkdirSync(dirname(filePath), { recursive: true });
    // P10.S3: redact credential patterns before building the record (which
    // computes record_hash) so the hash is self-consistent with the redacted
    // payload. Readers see only redacted data; the chain integrity is preserved.
    const safeRecord = redactDeep(record || Object());
    const payload = buildLedgerRecord(safeRecord?.event, safeRecord, {
      ...options,
      now,
      ledger: safeRecord?.ledger || options.ledger,
      prevHash: options.prevHash ?? options.prev_hash ?? safeRecord?.prev_hash ?? previousRecordHash(filePath),
    });
    const validation = validateLedgerRecord(payload);
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

export function appendStateEvent(stateDir, event, data = Object(), options = Object()) {
  return appendJsonlRecord(join(stateDir, "events.jsonl"), { ...data, event, ledger: "state" }, options);
}

export function appendRunEvent(stateDir, event, data = Object(), options = Object()) {
  return appendJsonlRecord(join(stateDir, "runs.jsonl"), { ...data, event, ledger: "run" }, options);
}

export function writeJsonArtifact(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  return filePath;
}

export function createEvidenceLedger({ stateDir }) {
  if (!stateDir) {
    throw new Error("createEvidenceLedger requires stateDir");
  }
  return {
    appendStateEvent: (event, data = Object(), options = Object()) => appendStateEvent(stateDir, event, data, options),
    appendRunEvent: (event, data = Object(), options = Object()) => appendRunEvent(stateDir, event, data, options),
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
    writeJsonArtifact: (filePath, payload) => writeJsonArtifact(filePath, payload),
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
