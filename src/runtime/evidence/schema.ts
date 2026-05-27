export const EVIDENCE_SCHEMA_VERSION = "1.0";
export const LEDGER_EVENT_SCHEMA = "yolo.ledger.event.v1";
export const EVIDENCE_ARTIFACT_SCHEMA = "yolo.evidence.artifact.v1";

const VALID_LEDGER_KINDS = new Set(["state", "run", "artifact", "custom"]);

function nowIso() {
  return new Date().toISOString();
}

function requiredString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function buildLedgerRecord(event, data = {}, options = {}) {
  if (!requiredString(event)) {
    throw new Error("buildLedgerRecord requires event");
  }
  const {
    schema_version: _schemaVersion,
    schema: _schema,
    ts: payloadTs,
    ledger: payloadLedger,
    event: _event,
    source: payloadSource,
    ...rest
  } = data || {};
  const ledger = payloadLedger || options.ledger || "state";
  if (!VALID_LEDGER_KINDS.has(ledger)) {
    throw new Error(`Unsupported evidence ledger kind: ${ledger}`);
  }
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    schema: LEDGER_EVENT_SCHEMA,
    ts: payloadTs || options.now || nowIso(),
    ledger,
    event,
    source: payloadSource || options.source || "yolo",
    ...rest,
  };
}

export function buildEvidenceArtifact(artifactType, payload = {}, options = {}) {
  if (!requiredString(artifactType)) {
    throw new Error("buildEvidenceArtifact requires artifactType");
  }
  const {
    schema_version: _schemaVersion,
    schema: _schema,
    artifact_type: _artifactType,
    generated_at: payloadGeneratedAt,
    source: payloadSource,
    ...rest
  } = payload || {};
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    schema: EVIDENCE_ARTIFACT_SCHEMA,
    artifact_type: artifactType,
    generated_at: payloadGeneratedAt || options.now || nowIso(),
    source: payloadSource || options.source || "yolo",
    ...rest,
  };
}

export function validateLedgerRecord(record = {}) {
  const errors = [];
  if (record.schema_version !== EVIDENCE_SCHEMA_VERSION) errors.push("schema_version must be 1.0");
  if (record.schema !== LEDGER_EVENT_SCHEMA) errors.push(`schema must be ${LEDGER_EVENT_SCHEMA}`);
  if (!requiredString(record.ts)) errors.push("ts is required");
  if (!requiredString(record.ledger)) errors.push("ledger is required");
  else if (!VALID_LEDGER_KINDS.has(record.ledger)) errors.push(`unsupported ledger: ${record.ledger}`);
  if (!requiredString(record.event)) errors.push("event is required");
  if (!requiredString(record.source)) errors.push("source is required");
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateEvidenceArtifact(artifact = {}) {
  const errors = [];
  if (artifact.schema_version !== EVIDENCE_SCHEMA_VERSION) errors.push("schema_version must be 1.0");
  if (artifact.schema !== EVIDENCE_ARTIFACT_SCHEMA) errors.push(`schema must be ${EVIDENCE_ARTIFACT_SCHEMA}`);
  if (!requiredString(artifact.artifact_type)) errors.push("artifact_type is required");
  if (!requiredString(artifact.generated_at)) errors.push("generated_at is required");
  if (!requiredString(artifact.source)) errors.push("source is required");
  return {
    ok: errors.length === 0,
    errors,
  };
}
