import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildLedgerRecord,
  buildEvidenceArtifact,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_SCHEMA_VERSION,
  LEDGER_EVENT_SCHEMA,
  validateEvidenceArtifact,
  validateLedgerRecord,
} from "./schema.js";

export function appendJsonlRecord(filePath, record, options = {}) {
  const now = options.now || new Date().toISOString();
  mkdirSync(dirname(filePath), { recursive: true });
  const payload = buildLedgerRecord(record?.event, record, { ...options, now, ledger: record?.ledger || options.ledger });
  const validation = validateLedgerRecord(payload);
  if (!validation.ok) {
    throw new Error(`Invalid evidence ledger record: ${validation.errors.join("; ")}`);
  }
  appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

export function appendStateEvent(stateDir, event, data = {}, options = {}) {
  return appendJsonlRecord(join(stateDir, "events.jsonl"), { ...data, event, ledger: "state" }, options);
}

export function appendRunEvent(stateDir, event, data = {}, options = {}) {
  return appendJsonlRecord(join(stateDir, "runs.jsonl"), { ...data, event, ledger: "run" }, options);
}

export function writeJsonArtifact(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

export {
  buildEvidenceArtifact,
  buildLedgerRecord,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_SCHEMA_VERSION,
  LEDGER_EVENT_SCHEMA,
  validateEvidenceArtifact,
  validateLedgerRecord,
};
