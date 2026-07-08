import { spawn } from "node:child_process";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  readLedgerJsonl,
  validateLedgerChain,
  validateEvidenceArtifact,
  validateLedgerRecord,
  writeJsonArtifact,
} from "../src/runtime/evidence/ledger.js";
import { redact, redactDeep } from "../src/lib/security/redact.js";

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

function runConcurrentAppendWorker(filePath, worker) {
  const childCode = `
    import { appendJsonlRecord } from "./src/runtime/evidence/ledger.js";
    const deadline = Date.now() + 120000;
    let appended = false;
    while (Date.now() <= deadline) {
      try {
        appendJsonlRecord(process.env.LEDGER_PATH, {
          event: "concurrent.append",
          worker: Number(process.env.WORKER),
          ledger: "state",
          source: "test"
        }, { lockTimeoutMs: 5000 });
        appended = true;
        break;
      } catch (error) {
        if (!error || typeof error !== "object" || !["LEDGER_APPEND_LOCK_BUSY", "LEDGER_APPEND_LOCK_TIMEOUT"].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2 + Math.floor(Math.random() * 8)));
      }
    }
    if (!appended) throw new Error("timed out waiting for ledger append lock");
  `;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "-e", childCode], {
      cwd: resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        LEDGER_PATH: filePath,
        WORKER: String(worker),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(undefined);
      } else {
        reject(new Error(`ledger append worker ${worker} exited ${code}: ${stderr}`));
      }
    });
  });
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

  test("readLedgerJsonl fails closed on oversized ledgers without full read", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "state", "events.jsonl");
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify({ event: "oversized", payload: "x".repeat(2048) })}\n`, "utf8");

      const records = readLedgerJsonl(filePath, { maxBytes: 1024 });
      assert.equal(records.length, 1);
      assert.equal((records[0] as { code?: string }).code, "LEDGER_READ_SIZE_LIMIT_EXCEEDED");
      assert.equal(validateLedgerChain(records).status, "fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appendJsonlRecord refuses previous hash reads from oversized ledgers", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "state", "events.jsonl");
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify({ event: "oversized", payload: "x".repeat(9 * 1024 * 1024) })}\n`, "utf8");

      assert.throws(
        () => appendJsonlRecord(filePath, { event: "next" }),
        (error) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "LEDGER_READ_SIZE_LIMIT_EXCEEDED")
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appendJsonlRecord preserves the hash chain across concurrent processes", async () => {
    const root = tempDir();
    try {
      const filePath = join(root, "state", "events.jsonl");
      const workerCount = 80;

      await Promise.all(Array.from({ length: workerCount }, (_, index) => runConcurrentAppendWorker(filePath, index)));

      const records = readLedgerJsonl(filePath);
      const validation = validateLedgerChain(records);
      assert.equal(records.length, workerCount);
      assert.equal(validation.ok, true, JSON.stringify(validation.errors.slice(0, 3), null, 2));
      assert.equal(validation.status, "pass");
      for (const [index, record] of records.entries()) {
        assert.equal(record.prev_hash, index === 0 ? null : records[index - 1].record_hash);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appendJsonlRecord refuses ambiguous stale locks instead of force-removing possible fresh owners", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "state", "events.jsonl");
      const lockPath = `${filePath}.lock`;
      mkdirSync(lockPath, { recursive: true });
      writeFileSync(join(lockPath, "owner.stale.json"), "{}");
      writeFileSync(join(lockPath, "owner.fresh.json"), "{}");
      const old = new Date(Date.now() - 10_000);
      utimesSync(lockPath, old, old);

      assert.throws(
        () => appendJsonlRecord(filePath, { event: "next" }, {
          lockTimeoutMs: 25,
          lockRetryMs: 1,
          lockStaleMs: 1,
        }),
        (error) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "LEDGER_APPEND_LOCK_BUSY"),
      );
      assert.equal(existsSync(join(lockPath, "owner.fresh.json")), true);
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

  test("validateLedgerChain tolerates null/non-object records instead of crashing", () => {
    // ledger.jsonl files on disk may contain valid-JSON-but-non-object lines
    // (null, numbers, strings, arrays) after a partial flush, SIGKILL mid-
    // write, or external edit. validateLedgerChain must report a structured
    // LEDGER_RECORD_INVALID failure for those entries instead of throwing a
    // TypeError on `record.schema_version` / `"prev_hash" in record`.
    // Mirrors the readJsonl null/non-object defense in report.ts (#70/#82).
    const first = buildLedgerRecord("first", {}, {
      now: "2026-05-24T15:00:00.000Z", ledger: "state", source: "test",
    });

    // null record
    let validation = validateLedgerChain([null]);
    assert.equal(validation.status, "fail");
    assert.equal(validation.ok, false);
    assert.ok(validation.errors.some((error) => error.code === "LEDGER_RECORD_INVALID" && error.message.includes("plain object")));

    // Mixed: valid record followed by null, number, string, array
    validation = validateLedgerChain([first, null, 42, "bad", ["array"]]);
    assert.equal(validation.status, "fail");
    const invalidRecords = validation.errors.filter((error) => error.code === "LEDGER_RECORD_INVALID");
    assert.equal(invalidRecords.length, 4, "each non-object entry produces one LEDGER_RECORD_INVALID");
    assert.deepEqual(invalidRecords.map((error) => error.index), [1, 2, 3, 4]);

    // validateLedgerRecord mirrors the defense and stays fail-closed.
    assert.equal(validateLedgerRecord(null).ok, false);
    assert.equal(validateLedgerRecord(42).ok, false);
    assert.equal(validateLedgerRecord("bad").ok, false);
    assert.equal(validateLedgerRecord(["array"]).ok, false);
    assert.ok(validateLedgerRecord(null).errors.includes("record must be a plain object"));
  });

  test("validateEvidenceArtifact tolerates null/non-object artifacts instead of crashing", () => {
    // Evidence artifact JSON on disk may parse as valid JSON but not be a plain
    // object — `null` after a truncated flush, an array/scalar from a botched
    // external edit, etc. validateEvidenceArtifact must return a structured
    // failure instead of throwing TypeError on `artifact.schema_version`.
    // Symmetric with the validateLedgerRecord null/non-object guard (#70/#82);
    // createEvidenceLedger exposes both validators to SDK callers.
    assert.equal(validateEvidenceArtifact(null).ok, false);
    assert.equal(validateEvidenceArtifact(42).ok, false);
    assert.equal(validateEvidenceArtifact("bad").ok, false);
    assert.equal(validateEvidenceArtifact(["array"]).ok, false);
    assert.ok(validateEvidenceArtifact(null).errors.includes("artifact must be a plain object"));

    // A well-formed artifact still passes.
    const artifact = buildEvidenceArtifact("gate.failure", { status: "fail" }, {
      now: "2026-05-24T15:00:03.000Z", source: "test",
    });
    assert.equal(validateEvidenceArtifact(artifact).ok, true);
  });

  test("readLedgerJsonl preserves malformed/truncated JSONL lines as integrity errors", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "state", "events.jsonl");
      mkdirSync(dirname(filePath), { recursive: true });

      // Build a valid two-record chain using the normal append path.
      const first = appendJsonlRecord(filePath, { event: "first" }, { now: "2026-05-24T15:00:00.000Z" });
      const second = appendJsonlRecord(filePath, { event: "second" }, { now: "2026-05-24T15:00:01.000Z" });
      assert.equal(second.prev_hash, first.record_hash);

      // Corrupt the file with partial/truncated lines and an invalid JSON token.
      const original = readFileSync(filePath, "utf8").trimEnd();
      writeFileSync(filePath, `${original}\n{truncated\nnot-valid-json\n`, "utf8");

      // Reading must not throw, but malformed lines must stay visible in the
      // record stream so integrity checks cannot turn falsely green.
      const records = readLedgerJsonl(filePath);
      assert.equal(records.length, 4);
      assert.deepEqual(records.slice(0, 2), [first, second]);
      assert.deepEqual(records.slice(2).map((record) => record.code), [
        "LEDGER_JSONL_MALFORMED_LINE",
        "LEDGER_JSONL_MALFORMED_LINE",
      ]);
      assert.equal(validateLedgerChain(records).status, "fail");

      // Appending to a corrupted ledger must recover from the last good record
      // instead of crashing while computing prev_hash.
      const third = appendJsonlRecord(filePath, { event: "third" }, { now: "2026-05-24T15:00:02.000Z" });
      assert.equal(third.prev_hash, second.record_hash);
      assert.equal(validateLedgerChain(readLedgerJsonl(filePath)).status, "fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("P8.M4: JSON schema requires the same hash fields as the runtime validator", async () => {
    let Ajv;
    const ajvMod = await import("ajv");
    Ajv = ajvMod.default;
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "../schemas/evidence-ledger-v1.schema.json"), "utf8"));
    const validate = ajv.compile(schema);

    // Real ledger record and artifact built by the runtime must pass the schema.
    const record = buildLedgerRecord("gate.failed", { task_id: "T1" }, {
      now: "2026-05-24T15:00:02.000Z", ledger: "state", source: "gate",
    });
    const artifact = buildEvidenceArtifact("gate.failure", { status: "fail", task_id: "T1" }, {
      now: "2026-05-24T15:00:03.000Z", source: "gate",
    });
    assert.equal(validate(record), true, `real record should satisfy schema: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate(artifact), true, `real artifact should satisfy schema: ${JSON.stringify(validate.errors)}`);

    // Records missing the required hash fields must fail the schema, matching the runtime validator.
    const recordWithoutHashes = { ...record };
    delete recordWithoutHashes.prev_hash;
    delete recordWithoutHashes.record_hash;
    assert.equal(validate(recordWithoutHashes), false, "schema must reject record without prev_hash/record_hash");

    const recordWithoutPrevHash = { ...record };
    delete recordWithoutPrevHash.prev_hash;
    assert.equal(validate(recordWithoutPrevHash), false, "schema must reject record without prev_hash");

    const recordWithoutRecordHash = { ...record };
    delete recordWithoutRecordHash.record_hash;
    assert.equal(validate(recordWithoutRecordHash), false, "schema must reject record without record_hash");

    const artifactWithoutDigest = { ...artifact };
    delete artifactWithoutDigest.artifact_digest;
    assert.equal(validate(artifactWithoutDigest), false, "schema must reject artifact without artifact_digest");

    // Runtime validator must reject the same tampered payloads.
    assert.equal(validateLedgerRecord(recordWithoutHashes).ok, false);
    assert.equal(validateEvidenceArtifact(artifactWithoutDigest).ok, false);
  });

  test("P10.S3: appendJsonlRecord redacts credential patterns before write (CWE-532)", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "state", "events.jsonl");

      // append a record with a fake API key in the payload data
      const payload = appendJsonlRecord(filePath, {
        event: "task_log",
        task_id: "TEST-001",
        detail: "using key sk-fake-test-key-1234567890123456",
        cmd: "curl -H 'Authorization: Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' https://api.example.com",
        error_stack: "Error: connect ECONNREFUSED\n  at Object._errnoException (util.js:1)\n  at key sk-another-fake-key-9999999999999999",
      }, {
        now: "2026-06-21T12:00:00.000Z",
        source: "test-redact",
      });

      // The returned payload must have sensitive fields redacted
      assert.ok(payload.detail.includes("[REDACTED:sk-key]"),
        `detail should be redacted: ${payload.detail}`);
      assert.ok(!payload.detail.includes("sk-fake-test-key-1234567890123456"),
        "raw sk-key must not appear in returned payload");
      assert.ok(payload.error_stack.includes("[REDACTED:sk-key]"),
        "error_stack should be redacted");
      assert.ok(payload.cmd.includes("Bearer [REDACTED:token]"),
        `Bearer token should be redacted: ${payload.cmd}`);
      // The ghp_ token inside the Bearer value is consumed by the Bearer pattern
      // before the gh-token pattern runs, so the assertion is on the Bearer label:
      assert.ok(!payload.cmd.includes("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        "raw GitHub token must not appear");

      // The persisted record must match the returned (redacted) payload
      const persisted = readLedgerJsonl(filePath);
      assert.equal(persisted.length, 1);
      assert.deepEqual(persisted[0], payload);

      // Chain validation must pass — hash is computed on redacted data
      const chain = validateLedgerChain(persisted);
      assert.equal(chain.ok, true);
      assert.equal(chain.status, "pass");
      assert.equal(chain.checked_count, 1);
      assert.equal(chain.head_hash, payload.record_hash);
      assert.equal(chain.errors.length, 0);
      assert.equal(payload.record_hash, ledgerRecordHash(payload));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("P10.S3: appendStateEvent redacts secrets in event data (CWE-532)", () => {
    const root = tempDir();
    try {
      appendStateEvent(root, "test.event", {
        task_id: "TEST-002",
        api_key: "sk-test-key-9876543210987654",
        message: "Bearer ghp_testtoken98765432109876543210",
      }, {
        now: "2026-06-21T12:00:00.000Z",
        source: "test-redact",
      });

      const events = readJsonl(join(root, "events.jsonl"));
      assert.equal(events.length, 1);
      const event = events[0];
      // The credential fields in the payload should be redacted
      assert.ok(event.api_key.includes("[REDACTED:sk-key]"),
        `api_key should be redacted: ${event.api_key}`);
      assert.ok(!event.api_key.includes("sk-test-key-9876543210987654"),
        "raw sk-key must not appear in persisted data");
      assert.ok(event.message.includes("[REDACTED:gh-token]") || event.message.includes("Bearer [REDACTED:token]"),
        `message should contain redacted: ${event.message}`);
      assert.ok(!event.message.includes("ghp_testtoken98765432109876543210"),
        "raw token must not appear in persisted data");

      // Metadata fields must be preserved
      assert.equal(event.event, "test.event");
      assert.equal(event.ledger, "state");
      assert.equal(event.source, "test-redact");
      assert.equal(event.task_id, "TEST-002"); // task_id is not a credential pattern
      assert.equal(event.schema, LEDGER_EVENT_SCHEMA);
      assert.equal(event.record_hash, ledgerRecordHash(event));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
