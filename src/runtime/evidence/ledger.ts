import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

function readJsonlRecords(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
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

export function appendJsonlRecord(filePath, record, options = Object()) {
  const now = options.now || new Date().toISOString();
  mkdirSync(dirname(filePath), { recursive: true });
  const payload = buildLedgerRecord(record?.event, record, {
    ...options,
    now,
    ledger: record?.ledger || options.ledger,
    prevHash: options.prevHash ?? options.prev_hash ?? record?.prev_hash ?? previousRecordHash(filePath),
  });
  const validation = validateLedgerRecord(payload);
  if (!validation.ok) {
    throw new Error(`Invalid evidence ledger record: ${validation.errors.join("; ")}`);
  }
  appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

export function appendStateEvent(stateDir, event, data = Object(), options = Object()) {
  return appendJsonlRecord(join(stateDir, "events.jsonl"), { ...data, event, ledger: "state" }, options);
}

export function appendRunEvent(stateDir, event, data = Object(), options = Object()) {
  return appendJsonlRecord(join(stateDir, "runs.jsonl"), { ...data, event, ledger: "run" }, options);
}

export function writeJsonArtifact(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
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
