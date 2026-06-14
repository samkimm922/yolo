import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { inspectSourceAssertionGuard } from "../scripts/ci-guard.js";

// B9: ci-guard that bans new assert.match(*Source, ...) in test files.
// Existing occurrences are allowlisted via baseline counts in ci-guard.ts.
// This test verifies the guard passes today AND catches a planted violation.

const VIOLATION_PATH = resolve(import.meta.dirname, ".tmp-ci-guard-violation.test.ts");
const VIOLATION_RELATIVE = "__tests__/.tmp-ci-guard-violation.test.ts";

describe("ci-guard source-assertion guard", () => {
  test("passes with current baseline (no new source-string assertions)", () => {
    const result = inspectSourceAssertionGuard();
    assert.equal(result.status, "pass", JSON.stringify(result.findings, null, 2));
  });

  test("catches a planted assert.match(*Source, ...) violation", () => {
    writeFileSync(
      VIOLATION_PATH,
      [
        'import assert from "node:assert/strict";',
        'import { readFileSync } from "node:fs";',
        'const fooSource = readFileSync("src/foo.ts", "utf8");',
        'assert.match(fooSource, /function bar/);',
        "",
      ].join("\n"),
    );
    try {
      const result = inspectSourceAssertionGuard();
      assert.equal(result.status, "fail");
      assert.ok(
        result.findings.some(
          (f) => f.file === VIOLATION_RELATIVE && f.code === "NEW_SOURCE_STRING_ASSERTION",
        ),
        JSON.stringify(result.findings, null, 2),
      );
    } finally {
      unlinkSync(VIOLATION_PATH);
    }
  });
});
