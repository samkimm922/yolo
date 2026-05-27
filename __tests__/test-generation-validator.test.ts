import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseStatusLine, validateTestGeneration } from "../src/runtime/gates/test-generation-validator.js";

const changed = (...files) => files.map((file) => ({ file, status: "A", isNew: true }));

describe("test generation validator", () => {
  test("default reuse_existing blocks new test files", () => {
    const result = validateTestGeneration({}, { changedFiles: changed("__tests__/new.test.js") });
    assert.equal(result.status, "fail");
    assert.equal(result.failures[0].code, "NEW_TESTS_NOT_ALLOWED");
  });

  test("preserves src prefix for modified test files from git porcelain", () => {
    const parsed = parseStatusLine(" M src/services/__tests__/card.service.search.test.ts");
    assert.equal(parsed.file, "src/services/__tests__/card.service.search.test.ts");
    assert.equal(parsed.isNew, false);
  });

  test("reuse_existing allows scoped sibling test split when allow_new_files is true", () => {
    const result = validateTestGeneration({
      scope: {
        targets: [{ file: "src/services/__tests__/import-template-validation.test.ts" }],
        allow_new_files: true,
      },
      test_generation: { mode: "reuse_existing", reason: "R9 文件长度拆分同目录测试文件" },
    }, {
      changedFiles: changed(
        "src/services/__tests__/import-template-validation.basic.test.ts",
        "src/services/__tests__/import-template-validation.edge.test.ts",
      ),
    });
    assert.equal(result.status, "pass");
  });

  test("forbid blocks any changed test file", () => {
    const result = validateTestGeneration({ test_generation: { mode: "forbid" } }, {
      changedFiles: [{ file: "src/foo.test.ts", status: " M", isNew: false }],
    });
    assert.equal(result.blocks_execution, true);
    assert.equal(result.failures[0].code, "TEST_CHANGES_FORBIDDEN");
  });

  test("add_minimal allows one allowlisted test file", () => {
    const result = validateTestGeneration({
      test_generation: {
        mode: "add_minimal",
        reason: "需要最小回归测试",
        allowed_test_files: ["__tests__/allowed.test.js"],
        max_new_test_files: 1,
      },
    }, { changedFiles: changed("__tests__/allowed.test.js") });
    assert.equal(result.status, "pass");
  });

  test("add_minimal blocks too many test files", () => {
    const result = validateTestGeneration({ test_generation: { mode: "add_minimal", max_new_test_files: 1 } }, {
      changedFiles: changed("__tests__/a.test.js", "__tests__/b.test.js"),
    });
    assert.equal(result.failures[0].code, "TOO_MANY_NEW_TEST_FILES");
  });

  test("repeated test failures block loops", () => {
    const result = validateTestGeneration({ test_generation: { mode: "reuse_existing", failure_policy: { same_failure_limit: 2 } } }, {
      changedFiles: [],
      failureHistory: [
        { kind: "test_compile_error", key: "__tests__/a.test.js:TS1005" },
        { kind: "test_compile_error", key: "__tests__/a.test.js:TS1005" },
      ],
    });
    assert.equal(result.blocks_execution, true);
    assert.equal(result.failures[0].code, "TEST_FAILURE_LOOP_BLOCKED");
  });
});
