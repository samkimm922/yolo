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
  LEDGER_EVENT_SCHEMA,
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

      assert.deepEqual(payload, {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        schema: LEDGER_EVENT_SCHEMA,
        ts: "2026-05-24T15:00:00.000Z",
        ledger: "state",
        event: "task_started",
        source: "yolo",
        task_id: "FIX-P36-001",
      });
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

      assert.deepEqual(readJsonl(join(root, "events.jsonl")), [{
        schema_version: EVIDENCE_SCHEMA_VERSION,
        schema: LEDGER_EVENT_SCHEMA,
        ts: "2026-05-24T15:00:00.000Z",
        ledger: "state",
        event: "gate_passed",
        source: "yolo",
        task_id: "FIX-P36-001",
      }]);
      assert.deepEqual(readJsonl(join(root, "runs.jsonl")), [{
        schema_version: EVIDENCE_SCHEMA_VERSION,
        schema: LEDGER_EVENT_SCHEMA,
        ts: "2026-05-24T15:00:01.000Z",
        ledger: "run",
        event: "run_end",
        source: "yolo",
        passed: 1,
        failed: 0,
      }]);
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
    assert.deepEqual(validateLedgerRecord(record), { ok: true, errors: [] });
    assert.equal(artifact.schema_version, EVIDENCE_SCHEMA_VERSION);
    assert.equal(artifact.schema, EVIDENCE_ARTIFACT_SCHEMA);
    assert.equal(artifact.artifact_type, "gate.failure");
    assert.deepEqual(validateEvidenceArtifact(artifact), { ok: true, errors: [] });
  });
});
