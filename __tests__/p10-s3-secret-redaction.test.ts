// P10.S3 adversarial tests — secret redaction before persistence
// Asserts that known credential patterns are masked before being written
// to evidence artifacts, task logs, and review findings.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { redact, redactDeep } from "../src/lib/security/redact.js";

// ── redact unit tests ──────────────────────────────────────────

describe("P10.S3 redact", () => {
  test("masks sk- API keys", () => {
    const out = redact("Key: sk-1234567890abcdefGHIJ");
    assert.ok(!out.includes("sk-1234567890abcdefGHIJ"));
    assert.ok(out.includes("[REDACTED"));
  });

  test("masks Bearer tokens", () => {
    const out = redact("Authorization: Bearer abc123def456ghi789");
    assert.ok(!out.includes("abc123def456ghi789"));
    assert.ok(out.includes("[REDACTED"));
  });

  test("masks AWS access key IDs", () => {
    const out = redact("aws_key: AKIAIOSFODNN7EXAMPLE");
    assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"));
  });

  test("masks GitHub tokens", () => {
    const out = redact("gh_token: ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    assert.ok(!out.includes("ghp_1234567890abcdefghijklmnopqrstuvwxyz"));
  });

  test("masks generic credential assignments", () => {
    const out = redact('api_key: "mysecret123abc"');
    assert.ok(!out.includes("mysecret123abc"));
  });

  test("masks private key blocks", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    const out = redact(key);
    assert.ok(!out.includes("MIIEpAIIBAAKCAQEA"));
    assert.ok(out.includes("[REDACTED"));
  });

  test("preserves non-secret text", () => {
    const out = redact("npm test passed, 42 files checked");
    assert.equal(out, "npm test passed, 42 files checked");
  });

  test("redactDeep masks strings in nested objects", () => {
    const input = {
      stdout: "error: sk-test1234567890abcd",
      nested: { token: "Bearer xyz1234567890abc" },
      count: 42,
    };
    const out = redactDeep(input);
    assert.ok(!out.stdout.includes("sk-test1234567890abcd"));
    assert.ok(!out.nested.token.includes("xyz1234567890abc"));
    assert.equal(out.count, 42);
  });
});

// ── task-logger redaction on bash output ───────────────────────

describe("P10.S3 task-logger redacts bash output", () => {
  let mod: any;
  let tmpRoot: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "yolo-p10-s3-tasklog-"));
  });

  after(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  test.before(async () => {
    mod = await import("../src/runtime/logging/task-logger.js");
    mod.setTaskLogsDir(tmpRoot);
  });

  test("bash output with sk- key is masked in log file", () => {
    mod.logTaskBash("TASK-REDACT", "echo test", "pass", "stdout: sk-1234567890abcdefGHIJ");
    const content = readFileSync(join(tmpRoot, "TASK-REDACT.jsonl"), "utf8");
    const entry = JSON.parse(content.trim());
    assert.ok(!entry.output.includes("sk-1234567890abcdefGHIJ"), "secret must be masked");
    assert.ok(entry.output.includes("[REDACTED"));
  });

  test("bash output with Bearer token is masked", () => {
    mod.logTaskBash("TASK-BEARER", "curl", "pass", "Authorization: Bearer s3cret123token456");
    const content = readFileSync(join(tmpRoot, "TASK-BEARER.jsonl"), "utf8");
    const entry = JSON.parse(content.trim());
    assert.ok(!entry.output.includes("s3cret123token456"));
  });

  test("writeTaskLog redacts secrets across cmd detail stack and review message fields", () => {
    mod.writeTaskLog("TASK-DEEP-REDACT", {
      type: "ERROR",
      cmd: "curl -H 'Authorization: Bearer cmdsecret1234567890'",
      detail: {
        stderr: "api_key=mysecret123abc",
        review: { message: "token=reviewsecret12345" },
      },
      stack: "Error: sk-stack1234567890abcdef",
    });
    mod.logReviewIssue(
      "HIGH",
      "src/secrets.ts",
      7,
      "review message leaked ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      { detail: "password=reviewpassword123" },
    );

    const taskEntry = JSON.parse(readFileSync(join(tmpRoot, "TASK-DEEP-REDACT.jsonl"), "utf8").trim());
    const reviewEntries = readFileSync(join(tmpRoot, "_review.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const combined = JSON.stringify({ taskEntry, reviewEntries });

    for (const leaked of [
      "cmdsecret1234567890",
      "mysecret123abc",
      "reviewsecret12345",
      "sk-stack1234567890abcdef",
      "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      "reviewpassword123",
    ]) {
      assert.equal(combined.includes(leaked), false, `${leaked} must be redacted before persistence`);
    }
    assert.equal(taskEntry.cmd.includes("[REDACTED"), true);
    assert.equal(taskEntry.detail.review.message.includes("[REDACTED"), true);
  });
});

// ── scanner findings redaction ─────────────────────────────────

describe("P10.S3 scanner redacts hardcoded credentials in findings", () => {
  let scannerMod: any;
  let tmpRoot: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "yolo-p10-s3-scanner-"));
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "src", "secrets.ts"),
      'const apiKey = "sk-leaked1234567890abcdefghij";\n',
      "utf8",
    );
  });

  after(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  test.before(async () => {
    scannerMod = await import("../src/review/scanner.js");
  });

  test("findings match does not contain full secret", () => {
    const findings = scannerMod.scanFile(join(tmpRoot, "src", "secrets.ts"), { root: tmpRoot });
    // Find any finding that touched the secrets.ts file
    const secretFindings = findings.filter((f: any) => f.file && f.file.includes("secrets.ts"));
    for (const f of secretFindings) {
      const json = JSON.stringify(f);
      assert.ok(
        !json.includes("sk-leaked1234567890abcdefghij"),
        `finding for ${f.scanner_id} must not contain the full secret`,
      );
    }
  });
});
