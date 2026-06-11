import { createHash } from "node:crypto";

export const EVIDENCE_SCHEMA_VERSION = "1.0";
export const LEDGER_EVENT_SCHEMA = "yolo.ledger.event.v1";
export const EVIDENCE_ARTIFACT_SCHEMA = "yolo.evidence.artifact.v1";
export const EVIDENCE_HASH_ALGORITHM = "sha256";

const VALID_LEDGER_KINDS = new Set(["state", "run", "artifact", "custom"]);

function nowIso() {
  return new Date().toISOString();
}

function requiredString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeForHash(value) {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, normalizeForHash(value[key])]),
  );
}

export function stableEvidenceJson(value) {
  return JSON.stringify(normalizeForHash(value));
}

export function sha256Evidence(value) {
  return createHash(EVIDENCE_HASH_ALGORITHM).update(stableEvidenceJson(value)).digest("hex");
}

function omitHashFields(value = Object(), fields = []) {
  const omitted = new Set(fields);
  return Object.fromEntries(Object.entries(value || {}).filter(([key]) => !omitted.has(key)));
}

export function ledgerRecordHash(record = Object()) {
  return sha256Evidence(omitHashFields(record, ["record_hash"]));
}

export function evidenceArtifactDigest(artifact = Object()) {
  return sha256Evidence(omitHashFields(artifact, ["artifact_digest", "schema_check"]));
}

export function buildLedgerRecord(event, data = Object(), options = Object()) {
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
    prev_hash: payloadPrevHash,
    record_hash: _recordHash,
    ...rest
  } = data || {};
  const ledger = payloadLedger || options.ledger || "state";
  if (!VALID_LEDGER_KINDS.has(ledger)) {
    throw new Error(`Unsupported evidence ledger kind: ${ledger}`);
  }
  const record = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    schema: LEDGER_EVENT_SCHEMA,
    ts: payloadTs || options.now || nowIso(),
    ledger,
    event,
    source: payloadSource || options.source || "yolo",
    prev_hash: payloadPrevHash ?? options.prevHash ?? options.prev_hash ?? null,
    ...rest,
  };
  return {
    ...record,
    record_hash: ledgerRecordHash(record),
  };
}

export function buildEvidenceArtifact(artifactType, payload = Object(), options = Object()) {
  if (!requiredString(artifactType)) {
    throw new Error("buildEvidenceArtifact requires artifactType");
  }
  const {
    schema_version: _schemaVersion,
    schema: _schema,
    artifact_type: _artifactType,
    generated_at: payloadGeneratedAt,
    source: payloadSource,
    artifact_digest: _artifactDigest,
    ...rest
  } = payload || {};
  const artifact = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    schema: EVIDENCE_ARTIFACT_SCHEMA,
    artifact_type: artifactType,
    generated_at: payloadGeneratedAt || options.now || nowIso(),
    source: payloadSource || options.source || "yolo",
    ...rest,
  };
  return {
    ...artifact,
    artifact_digest: evidenceArtifactDigest(artifact),
  };
}

export function validateLedgerRecord(record = Object()) {
  const errors = [];
  if (record.schema_version !== EVIDENCE_SCHEMA_VERSION) errors.push("schema_version must be 1.0");
  if (record.schema !== LEDGER_EVENT_SCHEMA) errors.push(`schema must be ${LEDGER_EVENT_SCHEMA}`);
  if (!requiredString(record.ts)) errors.push("ts is required");
  if (!requiredString(record.ledger)) errors.push("ledger is required");
  else if (!VALID_LEDGER_KINDS.has(record.ledger)) errors.push(`unsupported ledger: ${record.ledger}`);
  if (!requiredString(record.event)) errors.push("event is required");
  if (!requiredString(record.source)) errors.push("source is required");
  if (!("prev_hash" in record)) errors.push("prev_hash is required");
  else if (record.prev_hash !== null && !requiredString(record.prev_hash)) errors.push("prev_hash must be null or a hash string");
  if (!requiredString(record.record_hash)) errors.push("record_hash is required");
  else if (record.record_hash !== ledgerRecordHash(record)) errors.push("record_hash does not match record payload");
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateEvidenceArtifact(artifact = Object()) {
  const errors = [];
  if (artifact.schema_version !== EVIDENCE_SCHEMA_VERSION) errors.push("schema_version must be 1.0");
  if (artifact.schema !== EVIDENCE_ARTIFACT_SCHEMA) errors.push(`schema must be ${EVIDENCE_ARTIFACT_SCHEMA}`);
  if (!requiredString(artifact.artifact_type)) errors.push("artifact_type is required");
  if (!requiredString(artifact.generated_at)) errors.push("generated_at is required");
  if (!requiredString(artifact.source)) errors.push("source is required");
  if (!requiredString(artifact.artifact_digest)) errors.push("artifact_digest is required");
  else if (artifact.artifact_digest !== evidenceArtifactDigest(artifact)) errors.push("artifact_digest does not match artifact payload");
  return {
    ok: errors.length === 0,
    errors,
  };
}
