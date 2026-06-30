import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJsonEvidence } from "../src/runtime/adapters/evidence-collector.js";

// H10/H11: verify readJsonEvidence is bounded (8MiB) and TOCTOU-safe (reads
// from an fd, closing the existsSync→readFileSync race).

describe("readJsonEvidence size limit (H10) and fd read (H11)", () => {
  test("oversized evidence yields a structured size-limit error, not a crash", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-h10-size-"));
    try {
      const evPath = join(root, "huge.json");
      // 9 MiB file (> 8 MiB cap).
      writeFileSync(evPath, "{ \"" + "x".repeat(9 * 1024 * 1024) + "\": 1 }", "utf8");
      const rec = readJsonEvidence(evPath);
      assert.ok(rec, "oversized evidence must return an error record, not null");
      const flagged = Boolean(rec.size_limit_exceeded) || String(rec.parse_error || "").includes("exceeds") || String(rec.parse_error || "").includes("limit");
      assert.ok(flagged, `oversized evidence should surface a size-limit signal; got ${JSON.stringify(rec).slice(0, 200)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("small legit evidence parses normally (negative)", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-h10-small-"));
    try {
      const evPath = join(root, "small.json");
      writeFileSync(evPath, "{\"ok\":true,\"value\":42}", "utf8");
      const rec = readJsonEvidence(evPath);
      assert.deepEqual(rec, { ok: true, value: 42 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlinked evidence path is read via fd without a TOCTOU crash (H11)", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-h11-symlink-"));
    try {
      const target = join(root, "real.json");
      writeFileSync(target, "{\"ok\":true}", "utf8");
      const link = join(root, "link.json");
      try {
        symlinkSync(target, link);
      } catch {
        return; // symlink creation unavailable (privileges) — skip gracefully
      }
      const rec = readJsonEvidence(link);
      // The fd-read resolves the symlink content; must not crash.
      assert.deepEqual(rec, { ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
