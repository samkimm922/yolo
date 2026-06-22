// CWE-532 regression: lifecycle dashboard read-side redaction gap.
// Verifies that credential patterns in blocker messages and event data
// are redacted by readLifecycleDashboard before returning to callers.
//
// PR #91 covers WRITE-side lifecycle redaction (task-logger, evidence).
// This test covers the READ side (progress HTTP server data path).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("lifecycle-dashboard read-side redact", () => {
  let tmpRoot: string;

  const BLOCKER_SECRETS = [
    "sk-1234567890abcdefGHIJklmnopqrstuv",
    "xyz1234567890abcdef",
    "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  ];

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "yolo-lifecycle-redact-"));
    mkdirSync(join(tmpRoot, "lifecycle"), { recursive: true });
    mkdirSync(join(tmpRoot, "state"), { recursive: true });

    writeFileSync(
      join(tmpRoot, "lifecycle", "status.json"),
      JSON.stringify({
        current_stage: "test-stage",
        stages: [{ id: "test-stage", status: "active" }],
      }),
      "utf8",
    );

    // Stage report with credential patterns in blocker messages
    writeFileSync(
      join(tmpRoot, "state", "test-report.json"),
      JSON.stringify({
        stage: { id: "test-stage" },
        status: "blocked",
        blockers: [
          "API key sk-1234567890abcdefGHIJklmnopqrstuv in log output",
          { message: "Bearer xyz1234567890abcdef token used", source: "gate" },
          { code: "CRED", message: "ghp_1234567890abcdefghijklmnopqrstuvwxyz leaked" },
        ],
        issues: [
          {
            status: "blocked",
            message: "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          },
        ],
      }),
      "utf8",
    );

    // Event JSONL with credential pattern
    writeFileSync(
      join(tmpRoot, "state", "events.jsonl"),
      JSON.stringify({
        type: "error",
        message: "sk-testcredentialevent12345 occurred",
        created_at: "2026-01-01T00:00:00Z",
      }) + "\n",
      "utf8",
    );
  });

  after(() => {
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  });

  test("blocker messages are redacted", async () => {
    const mod = await import("../src/runtime/progress/lifecycle-dashboard.js");
    const result = mod.readLifecycleDashboard({ stateRoot: tmpRoot });

    assert.equal(result.exists, true);
    assert.ok(result.latest_reports.length >= 1);

    const report = result.latest_reports[0];
    const blockerMessages = report.blockers.map((b: any) => b.message);

    for (const leaked of BLOCKER_SECRETS) {
      assert.equal(
        blockerMessages.some((m: string) => m.includes(leaked)),
        false,
        `blocker message must not contain "${leaked}"`,
      );
    }

    assert.ok(
      blockerMessages.some((m: string) => m.includes("[REDACTED")),
      "at least one blocker message should be redacted",
    );
  });

  test("recent events are redacted", async () => {
    const mod = await import("../src/runtime/progress/lifecycle-dashboard.js");
    const result = mod.readLifecycleDashboard({ stateRoot: tmpRoot });

    assert.ok(result.recent_events.length >= 1);
    const allText = result.recent_events.map((e: any) => JSON.stringify(e)).join(" ");

    assert.equal(
      allText.includes("sk-testcredentialevent12345"),
      false,
      "event data must be redacted",
    );
    assert.ok(
      allText.includes("[REDACTED"),
      "event data should contain redaction labels",
    );
  });
});
