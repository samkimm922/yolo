import { createHash } from "node:crypto";

export const EVIDENCE_SCHEMA_VERSION = "1.0";
export const LEDGER_EVENT_SCHEMA = "yolo.ledger.event.v1";
export const EVIDENCE_ARTIFACT_SCHEMA = "yolo.evidence.artifact.v1";
export const EVIDENCE_HASH_ALGORITHM = "sha256";

export type EvidenceObject = Record<string, unknown>;

export interface EvidenceValidationResult {
  ok: boolean;
  errors: string[];
}

export interface EvidenceLedgerRecord extends EvidenceObject {
  schema_version: string;
  schema: string;
  ts: unknown;
  ledger: unknown;
  event: unknown;
  source: unknown;
  prev_hash: unknown;
  record_hash: string;
}

export interface EvidenceArtifactRecord extends EvidenceObject {
  schema_version: string;
  schema: string;
  artifact_type: unknown;
  generated_at: unknown;
  source: unknown;
  artifact_digest: string;
  schema_check?: EvidenceValidationResult;
  status?: unknown;
  missing_expected_artifacts?: unknown;
}

const VALID_LEDGER_KINDS: ReadonlySet<unknown> = new Set(["state", "run", "artifact", "custom"]);

function nowIso(): string {
  return new Date().toISOString();
}

function requiredString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (!value || typeof value !== "object") return value;
  const record = value as EvidenceObject;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, normalizeForHash(record[key])]),
  );
}

export function stableEvidenceJson(value: unknown): string {
  return JSON.stringify(normalizeForHash(value));
}

export function sha256Evidence(value: unknown): string {
  return createHash(EVIDENCE_HASH_ALGORITHM).update(stableEvidenceJson(value)).digest("hex");
}

function omitHashFields(value: EvidenceObject = Object(), fields: string[] = []): EvidenceObject {
  const omitted = new Set(fields);
  return Object.fromEntries(Object.entries(value || {}).filter(([key]) => !omitted.has(key)));
}

export function ledgerRecordHash(record: EvidenceObject = Object()): string {
  return sha256Evidence(omitHashFields(record, ["record_hash"]));
}

export function evidenceArtifactDigest(artifact: EvidenceObject = Object()): string {
  return sha256Evidence(omitHashFields(artifact, ["artifact_digest", "schema_check"]));
}

export function buildLedgerRecord<TData extends EvidenceObject = EvidenceObject>(
  event: unknown,
  data: TData = Object() as TData,
  options: EvidenceObject = Object(),
): EvidenceLedgerRecord & TData {
  if (!requiredString(event)) {
    throw new Error("buildLedgerRecord requires event");
  }
  const sourceData: EvidenceObject = data || {};
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
  } = sourceData;
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
  } as EvidenceLedgerRecord & TData;
}

export function buildEvidenceArtifact<TPayload extends EvidenceObject = EvidenceObject>(
  artifactType: unknown,
  payload: TPayload = Object() as TPayload,
  options: EvidenceObject = Object(),
): EvidenceArtifactRecord & TPayload {
  if (!requiredString(artifactType)) {
    throw new Error("buildEvidenceArtifact requires artifactType");
  }
  const sourcePayload: EvidenceObject = payload || {};
  const {
    schema_version: _schemaVersion,
    schema: _schema,
    artifact_type: _artifactType,
    generated_at: payloadGeneratedAt,
    source: payloadSource,
    artifact_digest: _artifactDigest,
    ...rest
  } = sourcePayload;
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
  } as EvidenceArtifactRecord & TPayload;
}

export function validateLedgerRecord(record: unknown = Object()): EvidenceValidationResult {
  const errors: string[] = [];
  // ledger.jsonl files live on disk and may be corrupted by partial flushes,
  // SIGKILL mid-write, or external edits (the same boundary that readJsonl in
  // report.ts already defends against). A line that parses as valid JSON but
  // is `null`, a number, a string, or an array would otherwise crash on
  // `record.schema_version` / `"prev_hash" in record` below. Reject these
  // structurally rather than throwing — validateLedgerChain calls this per
  // record and the SDK exposes both functions publicly via createEvidenceLedger.
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    errors.push("record must be a plain object");
    return { ok: false, errors };
  }
  const ledgerRecord = record as EvidenceObject;
  if (ledgerRecord.schema_version !== EVIDENCE_SCHEMA_VERSION) errors.push("schema_version must be 1.0");
  if (ledgerRecord.schema !== LEDGER_EVENT_SCHEMA) errors.push(`schema must be ${LEDGER_EVENT_SCHEMA}`);
  if (!requiredString(ledgerRecord.ts)) errors.push("ts is required");
  if (!requiredString(ledgerRecord.ledger)) errors.push("ledger is required");
  else if (!VALID_LEDGER_KINDS.has(ledgerRecord.ledger)) errors.push(`unsupported ledger: ${ledgerRecord.ledger}`);
  if (!requiredString(ledgerRecord.event)) errors.push("event is required");
  if (!requiredString(ledgerRecord.source)) errors.push("source is required");
  if (!("prev_hash" in ledgerRecord)) errors.push("prev_hash is required");
  else if (ledgerRecord.prev_hash !== null && !requiredString(ledgerRecord.prev_hash)) errors.push("prev_hash must be null or a hash string");
  if (!requiredString(ledgerRecord.record_hash)) errors.push("record_hash is required");
  else if (ledgerRecord.record_hash !== ledgerRecordHash(ledgerRecord)) errors.push("record_hash does not match record payload");
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function validateEvidenceArtifact(artifact: unknown = Object()): EvidenceValidationResult {
  const errors: string[] = [];
  // Evidence artifact JSON files on disk may parse as valid JSON but not be a
  // plain object — `null` after a truncated flush, an array or scalar from an
  // external edit, etc. Accessing `artifact.schema_version` below would then
  // throw a TypeError instead of returning a structured rejection. Mirror the
  // null/non-object guard that validateLedgerRecord already has (#70/#82);
  // createEvidenceLedger exposes both validators symmetrically to SDK callers.
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
    errors.push("artifact must be a plain object");
    return { ok: false, errors };
  }
  const evidenceArtifact = artifact as EvidenceObject;
  if (evidenceArtifact.schema_version !== EVIDENCE_SCHEMA_VERSION) errors.push("schema_version must be 1.0");
  if (evidenceArtifact.schema !== EVIDENCE_ARTIFACT_SCHEMA) errors.push(`schema must be ${EVIDENCE_ARTIFACT_SCHEMA}`);
  if (!requiredString(evidenceArtifact.artifact_type)) errors.push("artifact_type is required");
  if (!requiredString(evidenceArtifact.generated_at)) errors.push("generated_at is required");
  if (!requiredString(evidenceArtifact.source)) errors.push("source is required");
  if (!requiredString(evidenceArtifact.artifact_digest)) errors.push("artifact_digest is required");
  else if (evidenceArtifact.artifact_digest !== evidenceArtifactDigest(evidenceArtifact)) errors.push("artifact_digest does not match artifact payload");
  return {
    ok: errors.length === 0,
    errors,
  };
}
