import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeSourceFingerprint } from "../src/runtime/evidence/source-fingerprint.js";
import { verifyArtifactIntegrity } from "../src/runtime/evidence/artifact-integrity.js";

describe("evidence verification fails closed", () => {
  test("missing fingerprint source is explicitly unverifiable instead of an accepted empty map", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-fingerprint-missing-"));
    try {
      const result = computeSourceFingerprint(root, ["src/missing.ts"]);

      assert.equal(result.status, "unverifiable");
      assert.deepEqual(result.files, {});
      assert.deepEqual(result.unverifiable_paths, ["src/missing.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("existing non-source artifact without expected digest is not silently passed", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-artifact-unverified-"));
    try {
      const artifact = join(root, "report.json");
      writeFileSync(artifact, "{}\n", "utf8");

      const result = verifyArtifactIntegrity([artifact], { rootDir: root });

      assert.equal(result.status, "fail");
      assert.equal(result.unverified.length, 1);
      assert.equal(result.unverified[0].path, "report.json");
      assert.equal(result.unverified[0].issue, "expected_digest_missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
