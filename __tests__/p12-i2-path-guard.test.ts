// P12.I2 adversarial tests — resolveWithinRoot咽喉 + path containment
// Asserts:
//   1. resolveWithinRoot rejects ../ traversal that escapes root.
//   2. resolveWithinRoot rejects absolute paths outside root.
//   3. resolveWithinRoot rejects null bytes.
//   4. resolveWithinRoot accepts legit relative paths and paths within root.
//   5. resolveWithinRoot accepts root itself.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveWithinRoot } from "../src/lib/security/path-guard.js";

describe("P12.I2 resolveWithinRoot rejects path escapes", () => {
  test("rejects ../ traversal that escapes root", () => {
    const r = resolveWithinRoot("/project", "../../etc/passwd");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "path_escape");
    assert.match(r.detail || "", /resolves outside root/);
  });

  test("rejects absolute path outside root", () => {
    const r = resolveWithinRoot("/project", "/etc/passwd");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "path_escape");
  });

  test("rejects null byte injection", () => {
    const r = resolveWithinRoot("/project", "src/a.ts\0/../../etc/passwd");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "null_byte");
  });

  test("rejects empty string", () => {
    const r = resolveWithinRoot("/project", "");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "empty");
  });

  test("rejects null/undefined input", () => {
    assert.equal(resolveWithinRoot("/project", null).ok, false);
    assert.equal(resolveWithinRoot("/project", undefined).ok, false);
  });
});

describe("P12.I2 resolveWithinRoot accepts legit paths", () => {
  test("accepts simple relative path", () => {
    const r = resolveWithinRoot("/project", "src/a.ts");
    assert.equal(r.ok, true);
    assert.equal(r.path, "/project/src/a.ts");
  });

  test("accepts nested relative path", () => {
    const r = resolveWithinRoot("/project", "src/lib/file.ts");
    assert.equal(r.ok, true);
    assert.equal(r.path, "/project/src/lib/file.ts");
  });

  test("accepts .. that stays within root", () => {
    const r = resolveWithinRoot("/project", "src/../lib/file.ts");
    assert.equal(r.ok, true);
    assert.equal(r.path, "/project/lib/file.ts");
  });

  test("accepts root itself (edge case)", () => {
    const r = resolveWithinRoot("/project", ".");
    assert.equal(r.ok, true);
  });

  test("accepts absolute path inside root", () => {
    const r = resolveWithinRoot("/project", "/project/src/a.ts");
    assert.equal(r.ok, true);
    assert.equal(r.path, "/project/src/a.ts");
  });

  test("accepts file with spaces in name", () => {
    const r = resolveWithinRoot("/project", "src/my file.ts");
    assert.equal(r.ok, true);
    assert.equal(r.path, "/project/src/my file.ts");
  });
});
