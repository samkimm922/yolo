// P10.S3 adversarial test — read-side redaction defense-in-depth
// Verifies that read functions in progress/server.ts apply redactDeep
// even when the underlying JSONL files contain unredacted secrets.
// This tests the defense-in-depth layer: if write-time redaction fails,
// read-time redaction still catches leaked credentials.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SECRETS = {
  apiKey: "sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  bearer: "Bearer bbbbbbbbbbbbbbbbbbbbbbbbb",
  awsKey: "AKIAIOSFODNN7EXAMPLE",
  githubToken: "ghp_cccccccccccccccccccccccccccccccccccccccc",
  password: "superSecretPassw0rd!",
};

function unredactedEntry(overrides = {}) {
  return {
    type: "bash",
    cmd: `echo ${SECRETS.apiKey}`,
    output: `stdout: ${SECRETS.bearer}`,
    detail: {
      review: { message: `aws_key=${SECRETS.awsKey}` },
      stderr: `token=${SECRETS.githubToken}`,
    },
    stack: `Error: password=${SECRETS.password}`,
    ...overrides,
  };
}

describe("P10.S3 progress-server read-side redaction", () => {
  let mod: any;
  let tmpRoot: string;
  let taskId: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "yolo-p10-s3-read-redact-"));
    taskId = "sec-read-redact-test";
  });

  after(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  test.before(async () => {
    mod = await import("../src/runtime/progress/server.js");
    mod.setTaskLogsDir(tmpRoot);

    // Write an unredacted task log entry (simulating a write-time redaction failure)
    const entry = unredactedEntry();
    const line = JSON.stringify(entry) + "\n";
    writeFileSync(join(tmpRoot, `${taskId}.jsonl`), line, "utf8");

    // Write an unredacted review log entry
    const reviewEntry = {
      type: "review",
      round: 1,
      bugs_found: 0,
      message: `leaked: ${SECRETS.apiKey}`,
    };
    writeFileSync(join(tmpRoot, "_review.jsonl"), JSON.stringify(reviewEntry) + "\n", "utf8");
  });

  test("readTaskLogEntries redacts all secret patterns", () => {
    const entries = mod.readTaskLogEntries(taskId);
    assert.ok(entries, "must return entries");
    assert.equal(entries.length, 1, "must have 1 entry");
    const json = JSON.stringify(entries[0]);

    for (const [label, secret] of Object.entries(SECRETS)) {
      assert.equal(
        json.includes(secret),
        false,
        `${label} (${secret}) must be redacted in readTaskLogEntries output`,
      );
    }
    assert.ok(json.includes("[REDACTED"), "must contain [REDACTED] markers");
  });

  test("readReviewTaskLog redacts secrets", () => {
    const entries = mod.readReviewTaskLog();
    assert.ok(entries, "must return entries");
    assert.equal(entries.length, 1, "must have 1 entry");
    const json = JSON.stringify(entries[0]);

    assert.equal(json.includes(SECRETS.apiKey), false, "secret must be redacted in review log");
    assert.ok(json.includes("[REDACTED"), "must contain [REDACTED] markers");
  });

  test("readTaskLogIncremental redacts secrets", () => {
    const filePath = join(tmpRoot, `${taskId}.jsonl`);
    const result = mod.readTaskLogIncremental(filePath, 0);
    assert.ok(result, "must return result");
    assert.ok(result.entries.length > 0, "must have entries");
    const json = JSON.stringify(result.entries[0]);

    for (const [label, secret] of Object.entries(SECRETS)) {
      assert.equal(
        json.includes(secret),
        false,
        `${label} (${secret}) must be redacted in readTaskLogIncremental output`,
      );
    }
    assert.ok(json.includes("[REDACTED"), "must contain [REDACTED] markers");
  });
});
