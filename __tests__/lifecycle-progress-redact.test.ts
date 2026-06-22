import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";

describe("lifecycle stage report secret redaction", () => {
  test("writeLifecycleStageReport redacts secrets from blocker messages and report clone", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-lifecycle-redact-"));
    try {
      const report = {
        status: "blocked",
        blockers: [
          { message: "API key sk-my-test-api-key-12345abcdef was rejected" },
          { message: "GitHub token ghp_testGitHubToken123456789012345678901 is invalid" },
          { message: "normal error message without secrets" },
        ],
        summary: "this contains sk-another-key-to-verify-clone-redaction",
      };
      const result = writeLifecycleStageReport("idea", report, {
        stateRoot: dir,
        skipSequenceCheck: true,
        now: "2025-01-01T00:00:00.000Z",
      });

      const artifact = JSON.parse(readFileSync(result.artifact_path, "utf8"));

      // ── Blocker messages must be redacted ──
      const blockerMessages = artifact.blockers.map((b) => b.message);

      assert.ok(
        blockerMessages.some((m) => m.includes("[REDACTED:sk-key]")),
        "API key should be redacted in blocker messages",
      );
      assert.ok(
        !blockerMessages.some((m) => m.includes("sk-my-test-api-key-12345abcdef")),
        "Raw API key should not leak in blocker messages",
      );

      assert.ok(
        blockerMessages.some((m) => m.includes("[REDACTED:gh-token]")),
        "GitHub token should be redacted in blocker messages",
      );
      assert.ok(
        !blockerMessages.some((m) => m.includes("ghp_testGitHubToken")),
        "Raw GitHub token should not leak in blocker messages",
      );

      // ── Non-secret messages must pass through unchanged ──
      assert.ok(
        blockerMessages.some((m) => m === "normal error message without secrets"),
        "Non-secret messages should not be modified",
      );

      // ── The deep-cloned report must also be redacted ──
      const clonedReport = artifact.report;
      assert.ok(
        clonedReport.blockers[0].message.includes("[REDACTED:sk-key]"),
        "Cloned report blockers should also be redacted",
      );
      assert.ok(
        !clonedReport.blockers[0].message.includes("sk-my-test-api-key"),
        "Raw API key should not appear in cloned report blockers",
      );
      assert.ok(
        clonedReport.summary.includes("[REDACTED:sk-key]"),
        "Summary field in cloned report should be redacted",
      );
      assert.ok(
        !clonedReport.summary.includes("sk-another-key-to-verify"),
        "Raw API key should not appear in cloned report summary",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeLifecycleStageReport redacts secrets from evidence paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-lifecycle-redact-evidence-"));
    try {
      const report = {
        status: "blocked",
        blockers: [{ message: "blocked" }],
        evidence: [
          { path: "/tmp/secret-sk-evidence-key-file.log" },
        ],
      };
      const result = writeLifecycleStageReport("idea", report, {
        stateRoot: dir,
        skipSequenceCheck: true,
        now: "2025-01-01T00:00:00.000Z",
      });

      const artifact = JSON.parse(readFileSync(result.artifact_path, "utf8"));

      // Evidence paths containing secret patterns should be redacted
      const evidencePaths = artifact.evidence.map((e) => e.path).filter(Boolean);
      for (const p of evidencePaths) {
        assert.ok(
          !p.includes("sk-evidence-key"),
          "Evidence paths should not contain raw secret patterns",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
