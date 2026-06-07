import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendJsonlRecord,
  appendRunEvent,
  appendStateEvent,
  buildEvidenceArtifact,
  buildLedgerRecord,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_SCHEMA_VERSION,
  evidenceArtifactDigest,
  LEDGER_EVENT_SCHEMA,
  ledgerRecordHash,
  validateLedgerChain,
  validateEvidenceArtifact,
  validateLedgerRecord,
  writeJsonArtifact,
} from "../src/runtime/evidence/ledger.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "yolo-ledger-"));
}

function readJsonl(filePath) {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("evidence ledger", () => {
  test("appendJsonlRecord appends timestamped records", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "state", "events.jsonl");
      const payload = appendJsonlRecord(filePath, { event: "task_started", task_id: "FIX-P36-001" }, {
        now: "2026-05-24T15:00:00.000Z",
      });

      assert.deepEqual({ ...payload, record_hash: "<hash>" }, {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        schema: LEDGER_EVENT_SCHEMA,
        ts: "2026-05-24T15:00:00.000Z",
        ledger: "state",
        event: "task_started",
        source: "yolo",
        prev_hash: null,
        task_id: "FIX-P36-001",
        record_hash: "<hash>",
      });
      assert.equal(payload.record_hash, ledgerRecordHash(payload));
      assert.deepEqual(validateLedgerRecord(payload), { ok: true, errors: [] });
      assert.deepEqual(readJsonl(filePath), [payload]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appendStateEvent and appendRunEvent write canonical state ledgers", () => {
    const root = tempDir();
    try {
      appendStateEvent(root, "gate_passed", { task_id: "FIX-P36-001" }, {
        now: "2026-05-24T15:00:00.000Z",
      });
      appendRunEvent(root, "run_end", { passed: 1, failed: 0 }, {
        now: "2026-05-24T15:00:01.000Z",
      });

      const stateEvents = readJsonl(join(root, "events.jsonl"));
      const runEvents = readJsonl(join(root, "runs.jsonl"));
      assert.deepEqual(stateEvents.map((entry) => ({ ...entry, record_hash: "<hash>" })), [{
        schema_version: EVIDENCE_SCHEMA_VERSION,
        schema: LEDGER_EVENT_SCHEMA,
        ts: "2026-05-24T15:00:00.000Z",
        ledger: "state",
        event: "gate_passed",
        source: "yolo",
        prev_hash: null,
        task_id: "FIX-P36-001",
        record_hash: "<hash>",
      }]);
      assert.deepEqual(runEvents.map((entry) => ({ ...entry, record_hash: "<hash>" })), [{
        schema_version: EVIDENCE_SCHEMA_VERSION,
        schema: LEDGER_EVENT_SCHEMA,
        ts: "2026-05-24T15:00:01.000Z",
        ledger: "run",
        event: "run_end",
        source: "yolo",
        prev_hash: null,
        passed: 1,
        failed: 0,
        record_hash: "<hash>",
      }]);
      assert.equal(stateEvents[0].record_hash, ledgerRecordHash(stateEvents[0]));
      assert.equal(runEvents[0].record_hash, ledgerRecordHash(runEvents[0]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writeJsonArtifact creates parent directories and writes stable JSON", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "state", "evidence", "FIX-P36-001", "artifact.json");
      assert.equal(writeJsonArtifact(filePath, { status: "PASS", task_id: "FIX-P36-001" }), filePath);
      assert.equal(
        readFileSync(filePath, "utf8"),
        `${JSON.stringify({ status: "PASS", task_id: "FIX-P36-001" }, null, 2)}\n`.trimEnd(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("schema helpers build and validate canonical ledger records and artifacts", () => {
    const record = buildLedgerRecord("gate.failed", {
      task_id: "FIX-P36-002",
      status: "fail",
    }, {
      now: "2026-05-24T15:00:02.000Z",
      ledger: "state",
      source: "gate",
    });
    const artifact = buildEvidenceArtifact("gate.failure", {
      status: "fail",
      task_id: "FIX-P36-002",
    }, {
      now: "2026-05-24T15:00:03.000Z",
      source: "gate",
    });

    assert.equal(record.schema_version, EVIDENCE_SCHEMA_VERSION);
    assert.equal(record.schema, LEDGER_EVENT_SCHEMA);
    assert.equal(record.source, "gate");
    assert.equal(record.prev_hash, null);
    assert.equal(record.record_hash, ledgerRecordHash(record));
    assert.deepEqual(validateLedgerRecord(record), { ok: true, errors: [] });
    assert.equal(artifact.schema_version, EVIDENCE_SCHEMA_VERSION);
    assert.equal(artifact.schema, EVIDENCE_ARTIFACT_SCHEMA);
    assert.equal(artifact.artifact_type, "gate.failure");
    assert.equal(artifact.artifact_digest, evidenceArtifactDigest(artifact));
    assert.deepEqual(validateEvidenceArtifact(artifact), { ok: true, errors: [] });
  });

  test("appendJsonlRecord chains prev_hash and validateLedgerChain detects tampering", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "state", "events.jsonl");
      const first = appendJsonlRecord(filePath, { event: "first" }, { now: "2026-05-24T15:00:00.000Z" });
      const second = appendJsonlRecord(filePath, { event: "second" }, { now: "2026-05-24T15:00:01.000Z" });

      assert.equal(second.prev_hash, first.record_hash);
      assert.equal(validateLedgerChain(readJsonl(filePath)).status, "pass");

      const tampered = [{ ...first, event: "changed" }, second];
      const validation = validateLedgerChain(tampered);
      assert.equal(validation.status, "fail");
      assert.ok(validation.errors.some((error) => error.code === "LEDGER_RECORD_INVALID"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validateLedgerChain can validate a retained ledger segment whose head points to archived records", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "state", "events.jsonl");
      appendJsonlRecord(filePath, { event: "first" }, { now: "2026-05-24T15:00:00.000Z" });
      const second = appendJsonlRecord(filePath, { event: "second" }, { now: "2026-05-24T15:00:01.000Z" });
      const retained = [second];

      assert.equal(validateLedgerChain(retained).status, "fail");
      assert.equal(validateLedgerChain(retained, { allowExternalHead: true }).status, "pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
