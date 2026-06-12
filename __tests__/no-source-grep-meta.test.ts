import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CRITICAL_TEST_FILES,
  scanSourceGrepMeta,
  SOURCE_ONLY_ALLOWLIST,
} from "../scripts/source-grep-meta.js";

const REQUIRED_CRITICAL_FILES = [
  "__tests__/evidence-ledger.test.ts",
  "__tests__/evidence-report.test.ts",
  "__tests__/acceptance-report.test.ts",
  "__tests__/execution-baselines.test.ts",
  "__tests__/run-lifecycle-startup.test.ts",
  "__tests__/run-lifecycle-finalize.test.ts",
  "__tests__/worktree-session.test.ts",
  "__tests__/fixture-harness.test.ts",
  "__tests__/package-install-smoke.test.ts",
  "__tests__/no-source-grep-meta.test.ts",
];

describe("meta gate: critical tests are not source-grep theater", () => {
  test("source-grep meta scan passes for critical test coverage", () => {
    const result = scanSourceGrepMeta();

    assert.equal(result.status, "pass", JSON.stringify(result, null, 2));
    assert.deepEqual(result.unexpected, []);
    assert.deepEqual(result.stale_allowlist, []);
    assert.deepEqual(result.missing_paired_tests, []);
  });

  test("source-grep meta scan covers this worker's acceptance tests", () => {
    for (const file of REQUIRED_CRITICAL_FILES) {
      assert.equal(CRITICAL_TEST_FILES.includes(file), true, `${file} must stay in source-grep meta coverage`);
    }
    assert.ok(SOURCE_ONLY_ALLOWLIST.every((item) => item.pairedWith.length > 0));
  });
});
