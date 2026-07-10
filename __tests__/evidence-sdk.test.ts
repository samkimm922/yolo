import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendJsonlRecord,
  buildEvidenceArtifact,
  createEvidenceLedger,
  EVIDENCE_ARTIFACT_SCHEMA,
  EVIDENCE_SCHEMA_VERSION,
  evidenceArtifactDigest,
  LEDGER_EVENT_SCHEMA,
  ledgerRecordHash,
} from "../src/runtime/evidence/ledger.js";

describe("public evidence ledger facade", () => {
  test("appendJsonlRecord writes timestamped JSONL records", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-public-evidence-"));
    try {
      mkdirSync(join(root, "keys"), { recursive: true });
      writeFileSync(join(root, "keys", "ledger.hmac"), "public-evidence-test-ledger-key", "utf8");
      const filePath = join(root, "events.jsonl");
      const payload = appendJsonlRecord(filePath, { event: "spec.checked" }, { now: "2026-05-24T00:00:00.000Z" });

      assert.deepEqual({ ...payload, record_hash: "<hash>", record_sig: "<sig>" }, {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        schema: LEDGER_EVENT_SCHEMA,
        ts: "2026-05-24T00:00:00.000Z",
        ledger: "state",
        event: "spec.checked",
        source: "yolo",
        prev_hash: null,
        record_hash: "<hash>",
        record_sig: "<sig>",
      });
      assert.equal(payload.record_hash, ledgerRecordHash(payload));
      assert.equal(readFileSync(filePath, "utf8"), `${JSON.stringify(payload)}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createEvidenceLedger scopes state events and run events to one stateDir", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-public-evidence-"));
    try {
      mkdirSync(join(root, "keys"), { recursive: true });
      writeFileSync(join(root, "keys", "ledger.hmac"), "public-evidence-test-ledger-key", "utf8");
      const stateDir = join(root, "state");
      const ledger = createEvidenceLedger({ stateDir });
      ledger.appendStateEvent("spec.warning", { task_id: "FIX-SPEC-001" }, { now: "2026-05-24T00:00:00.000Z" });
      ledger.appendRunEvent("run.done", { run_id: "RUN-1" }, { now: "2026-05-24T00:00:01.000Z" });
      const artifact = ledger.buildEvidenceArtifact("spec.warning", { status: "warning" }, { now: "2026-05-24T00:00:02.000Z" });

      assert.match(readFileSync(join(stateDir, "events.jsonl"), "utf8"), /"event":"spec.warning"/);
      assert.match(readFileSync(join(stateDir, "runs.jsonl"), "utf8"), /"event":"run.done"/);
      assert.equal(artifact.schema_version, EVIDENCE_SCHEMA_VERSION);
      assert.equal(artifact.schema, EVIDENCE_ARTIFACT_SCHEMA);
      assert.equal(artifact.artifact_digest, evidenceArtifactDigest(artifact));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("public facade exports schema artifact builders", () => {
    const artifact = buildEvidenceArtifact("sdk.sample", {
      status: "pass",
    }, {
      now: "2026-05-24T00:00:03.000Z",
    });

    assert.equal(artifact.schema_version, EVIDENCE_SCHEMA_VERSION);
    assert.equal(artifact.artifact_type, "sdk.sample");
    assert.equal(artifact.artifact_digest, evidenceArtifactDigest(artifact));
  });

  test("createEvidenceLedger requires an explicit stateDir", () => {
    assert.throws(() => createEvidenceLedger({ stateDir: undefined }), /stateDir/);
  });
});
