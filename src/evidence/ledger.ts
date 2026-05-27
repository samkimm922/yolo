import {
  appendJsonlRecord,
  appendRunEvent,
  appendStateEvent,
  buildEvidenceArtifact,
  buildLedgerRecord,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_SCHEMA_VERSION,
  LEDGER_EVENT_SCHEMA,
  validateEvidenceArtifact,
  validateLedgerRecord,
  writeJsonArtifact,
} from "../runtime/evidence/ledger.js";

export {
  appendJsonlRecord,
  appendRunEvent,
  appendStateEvent,
  buildEvidenceArtifact,
  buildLedgerRecord,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_SCHEMA_VERSION,
  LEDGER_EVENT_SCHEMA,
  validateEvidenceArtifact,
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
    validateEvidenceArtifact,
    validateLedgerRecord,
    writeJsonArtifact: (filePath, payload) => writeJsonArtifact(filePath, payload),
  };
}
