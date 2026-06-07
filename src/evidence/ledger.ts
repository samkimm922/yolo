import {
  appendJsonlRecord,
  appendRunEvent,
  appendStateEvent,
  buildEvidenceArtifact,
  buildLedgerRecord,
  evidenceArtifactDigest,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_HASH_ALGORITHM,
  EVIDENCE_SCHEMA_VERSION,
  LEDGER_EVENT_SCHEMA,
  ledgerRecordHash,
  readLedgerJsonl,
  sha256Evidence,
  stableEvidenceJson,
  validateEvidenceArtifact,
  validateLedgerChain,
  validateLedgerRecord,
  writeJsonArtifact,
} from "../runtime/evidence/ledger.js";

export {
  appendJsonlRecord,
  appendRunEvent,
  appendStateEvent,
  buildEvidenceArtifact,
  buildLedgerRecord,
  evidenceArtifactDigest,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_HASH_ALGORITHM,
  EVIDENCE_SCHEMA_VERSION,
  LEDGER_EVENT_SCHEMA,
  ledgerRecordHash,
  readLedgerJsonl,
  sha256Evidence,
  stableEvidenceJson,
  validateEvidenceArtifact,
  validateLedgerChain,
  validateLedgerRecord,
  writeJsonArtifact,
};

export function createEvidenceLedger({ stateDir }) {
  if (!stateDir) {
    throw new Error("createEvidenceLedger requires stateDir");
  }
  return {
    appendStateEvent: (event, data = {}, options = {}) => appendStateEvent(stateDir, event, data, options),
    appendRunEvent: (event, data = {}, options = {}) => appendRunEvent(stateDir, event, data, options),
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
