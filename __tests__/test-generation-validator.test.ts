import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("test-generation warnings block execution", () => {
    const result = validateTestGeneration({ test_generation: { mode: "add_minimal", max_new_test_files: 1 } }, {
      changedFiles: changed("__tests__/needs-reason.test.js"),
    });

    assert.equal(result.status, "warning");
    assert.equal(result.blocks_execution, true);
    assert.equal(result.next_action, "blocked");
    assert.equal(result.warnings[0].code, "MISSING_TEST_GENERATION_REASON");
  });

  test("git status failures block execution instead of passing as no test changes", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-test-generation-no-git-"));
    try {
      const result = validateTestGeneration({ test_generation: { mode: "reuse_existing" } }, { cwd: root });

      assert.equal(result.status, "fail");
      assert.equal(result.blocks_execution, true);
      assert.equal(result.failures[0].code, "TEST_GENERATION_GIT_STATUS_UNAVAILABLE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("git diff failures block max line validation instead of counting zero added lines", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-test-generation-diff-fail-"));
    try {
      const result = validateTestGeneration({
        test_generation: {
          mode: "add_minimal",
          reason: "Validate diff failure handling.",
          max_test_lines_changed: 1,
        },
      }, {
        cwd: root,
        changedFiles: [{ file: "__tests__/existing.test.js", status: " M", isNew: false }],
      });

      assert.equal(result.status, "fail");
      assert.equal(result.blocks_execution, true);
      assert.ok(result.failures.some((failure) => failure.code === "TEST_GENERATION_DIFF_UNAVAILABLE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test("add_minimal blocks new test files outside allowed_test_files", () => {
    const result = validateTestGeneration({
      test_generation: {
        mode: "add_minimal",
        reason: "scoped allowlist",
        allowed_test_files: ["__tests__/allowed.test.js"],
        max_new_test_files: 1,
      },
    }, { changedFiles: changed("__tests__/not-on-allowlist.test.js") });
    assert.equal(result.status, "fail");
    assert.equal(result.blocks_execution, true);
    assert.equal(result.failures[0].code, "TEST_FILE_OUT_OF_ALLOWLIST");
  });

  test("add_minimal blocks test files exceeding max_test_lines_changed", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-test-gen-lines-"));
    try {
      mkdirSync(join(root, "__tests__"), { recursive: true });
      writeFileSync(join(root, "__tests__", "big.test.js"), `${Array(10).fill("const x = 1;").join("\n")}\n`);
      const result = validateTestGeneration({
        scope: { allow_new_files: true, targets: [{ file: "__tests__/big.test.js" }] },
        test_generation: { mode: "add_minimal", reason: "line budget", max_test_lines_changed: 3 },
      }, {
        cwd: root,
        changedFiles: [{ file: "__tests__/big.test.js", status: "A", isNew: true }],
      });
      assert.equal(result.status, "fail");
      assert.ok(result.failures.some((failure) => failure.code === "TEST_LINES_CHANGED_LIMIT"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
