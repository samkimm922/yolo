import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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

  test("git status inspection expands untracked directories to generated test files", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-test-generation-untracked-dir-"));
    const task = {
      scope: { allow_new_files: true, targets: [{ file: "test/acceptance.test.js" }] },
      post_conditions: [{ type: "tests_pass", params: { command: "npm test", require_tests: true } }],
      test_generation: {
        mode: "add_minimal",
        reason: "Synthetic acceptance coverage.",
        allowed_test_files: ["test/acceptance.test.js"],
        max_new_test_files: 1,
      },
    };
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({
        type: "module",
        scripts: { test: "node --test" },
      }), "utf8");
      writeFileSync(join(root, "test", "acceptance.test.js"), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('generated acceptance', () => assert.equal(1, 1));",
      ].join("\n"), "utf8");

      const result = validateTestGeneration(task, { cwd: root });

      assert.equal(result.status, "pass");
      assert.deepEqual(result.changed_test_files, ["test/acceptance.test.js"]);
      assert.deepEqual(result.new_test_files, ["test/acceptance.test.js"]);
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
      changedFiles: [{ file: "src/app.ts", status: " M", isNew: false }],
      failureHistory: [
        { kind: "test_compile_error", key: "__tests__/a.test.js:TS1005" },
        { kind: "test_compile_error", key: "__tests__/a.test.js:TS1005" },
      ],
    });
    assert.equal(result.blocks_execution, true);
    assert.equal(result.failures[0].code, "TEST_FAILURE_LOOP_BLOCKED");
  });

  test("authenticity contract blocks fake-green tests and enforces declared assertion floor", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-test-gen-authenticity-"));
    const task = {
      scope: { allow_new_files: true, targets: [{ file: "tests/acceptance.test.js" }] },
      post_conditions: [{ type: "tests_pass", params: { command: "project test command", require_tests: true } }],
      test_generation: {
        mode: "add_minimal",
        reason: "Executor owns tests; yolo validates declared authenticity.",
        allowed_test_files: ["tests/acceptance.test.js"],
        max_new_test_files: 1,
      },
      verification_contract: {
        authenticity: {
          required: true,
          methods: [
            {
              type: "assertion_count",
              files: ["tests/acceptance.test.js"],
              minimum: 2,
              markers: [{ pattern: "\\bassert\\." }, { pattern: "\\bexpect\\s*\\(" }],
            },
            {
              type: "forbidden_pattern",
              files: ["tests/acceptance.test.js"],
              patterns: [{ text: "tests.length > 0" }],
            },
          ],
        },
      },
    };
    try {
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests", "acceptance.test.js"), [
        "test('fake green', () => {",
        "  const tests = ['case'];",
        "  assert.equal(tests.length > 0, true);",
        "});",
      ].join("\n"), "utf8");

      let result = validateTestGeneration(task, {
        cwd: root,
        changedFiles: changed("tests/acceptance.test.js"),
      });

      assert.equal(result.status, "fail");
      assert.ok(result.failures.some((failure) => failure.code === "AUTHENTICITY_ASSERTION_COUNT_BELOW_MINIMUM"));
      assert.ok(result.failures.some((failure) => failure.code === "AUTHENTICITY_FORBIDDEN_PATTERN"));

      writeFileSync(join(root, "tests", "acceptance.test.js"), [
        "test('real contract', () => {",
        "  assert.equal(renderReport().title, 'Weekly');",
        "  assert.match(renderReport().body, /Total commits/);",
        "});",
      ].join("\n"), "utf8");

      result = validateTestGeneration(task, {
        cwd: root,
        changedFiles: changed("tests/acceptance.test.js"),
      });

      assert.equal(result.status, "pass", JSON.stringify(result.failures, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  test("require_tests task blocks missing or empty target test files", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-test-gen-target-"));
    const task = {
      scope: { allow_new_files: true, targets: [{ file: "test/git-weekly-cli.test.ts" }] },
      post_conditions: [{ type: "tests_pass", params: { command: "npm test", require_tests: true } }],
      test_generation: {
        mode: "add_minimal",
        reason: "Synthetic acceptance coverage.",
        allowed_test_files: ["test/git-weekly-cli.test.ts"],
        max_new_test_files: 1,
      },
    };
    try {
      let result = validateTestGeneration(task, {
        cwd: root,
        changedFiles: [{ file: "test/git-weekly-cli.test.ts", status: "A", isNew: true }],
      });
      assert.equal(result.status, "fail");
      assert.ok(result.failures.some((failure) => failure.code === "TEST_TARGET_MISSING"));

      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/git-weekly-cli.test.ts"), "", "utf8");
      result = validateTestGeneration(task, {
        cwd: root,
        changedFiles: [{ file: "test/git-weekly-cli.test.ts", status: "A", isNew: true }],
      });
      assert.equal(result.status, "fail");
      assert.ok(result.failures.some((failure) => failure.code === "TEST_TARGET_EMPTY"));

      writeFileSync(join(root, "test/git-weekly-cli.test.ts"), "export const value = 1;\n", "utf8");
      result = validateTestGeneration(task, {
        cwd: root,
        changedFiles: [{ file: "test/git-weekly-cli.test.ts", status: "A", isNew: true }],
      });
      assert.equal(result.status, "fail");
      assert.ok(result.failures.some((failure) => failure.code === "TEST_TARGET_NO_TEST_DECLARATION"));

      writeFileSync(join(root, "test/git-weekly-cli.test.ts"), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('git-weekly smoke', () => assert.equal(1, 1));",
      ].join("\n"), "utf8");
      result = validateTestGeneration(task, {
        cwd: root,
        changedFiles: [{ file: "test/git-weekly-cli.test.ts", status: "A", isNew: true }],
      });
      assert.equal(result.status, "pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("require_tests task blocks console.assert in node:test targets", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-test-gen-console-assert-"));
    const task = {
      scope: { allow_new_files: true, targets: [{ file: "test/git-weekly-cli.test.ts" }] },
      post_conditions: [{ type: "tests_pass", params: { command: "npm test", require_tests: true } }],
      test_generation: {
        mode: "add_minimal",
        reason: "Synthetic acceptance coverage.",
        allowed_test_files: ["test/git-weekly-cli.test.ts"],
        max_new_test_files: 1,
      },
    };
    try {
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({
        type: "module",
        scripts: { test: "node --test" },
      }), "utf8");
      writeFileSync(join(root, "test/git-weekly-cli.test.ts"), [
        "import test from 'node:test';",
        "test('git-weekly smoke', () => console.assert(false, 'should fail'));",
      ].join("\n"), "utf8");

      const result = validateTestGeneration(task, {
        cwd: root,
        changedFiles: [{ file: "test/git-weekly-cli.test.ts", status: "A", isNew: true }],
      });
      assert.equal(result.status, "fail");
      assert.ok(result.failures.some((failure) => failure.code === "TEST_TARGET_CONSOLE_ASSERT"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("require_tests task blocks node:test targets without node:test imports", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-test-gen-node-target-"));
    const task = {
      scope: { allow_new_files: true, targets: [{ file: "test/git-weekly-cli.test.ts" }] },
      post_conditions: [{ type: "tests_pass", params: { command: "npm test", require_tests: true } }],
      test_generation: {
        mode: "add_minimal",
        reason: "Synthetic acceptance coverage.",
        allowed_test_files: ["test/git-weekly-cli.test.ts"],
        max_new_test_files: 1,
      },
    };
    try {
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({
        type: "module",
        scripts: { test: "node --test" },
      }), "utf8");
      writeFileSync(join(root, "test/git-weekly-cli.test.ts"), [
        "function test(_name: string, _fn: () => void) {}",
        "test('fake local helper only', () => {});",
      ].join("\n"), "utf8");

      let result = validateTestGeneration(task, {
        cwd: root,
        changedFiles: [{ file: "test/git-weekly-cli.test.ts", status: "A", isNew: true }],
      });
      assert.equal(result.status, "fail");
      assert.ok(result.failures.some((failure) => failure.code === "TEST_TARGET_NO_NODE_TEST_IMPORT"));

      writeFileSync(join(root, "test/git-weekly-cli.test.ts"), [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('git-weekly smoke', () => assert.equal(1, 1));",
      ].join("\n"), "utf8");
      result = validateTestGeneration(task, {
        cwd: root,
        changedFiles: [{ file: "test/git-weekly-cli.test.ts", status: "A", isNew: true }],
      });
      assert.equal(result.status, "pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("acceptance coverage manifest fails closed and validates named tests plus markers", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-test-gen-coverage-"));
    const task = (criteria = undefined) => ({
      atomicity: { source: "synthetic_automated_acceptance" }, scope: { allow_new_files: true, targets: [{ file: "test/acceptance.test.js" }] },
      post_conditions: [{ type: "tests_pass", params: { command: "npm test", require_tests: true } }],
      test_generation: { mode: "add_minimal", reason: "Synthetic acceptance coverage.", allowed_test_files: ["test/acceptance.test.js"], max_new_test_files: 1, ...(criteria ? { acceptance_coverage: { schema: "yolo.test_generation.acceptance_coverage.v1", required_test_file: "test/acceptance.test.js", criteria } } : {}) },
    });
    const writeTest = (lines) => {
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }), "utf8");
      writeFileSync(join(root, "test/acceptance.test.js"), ["import test from 'node:test';", "import assert from 'node:assert/strict';", ...lines].join("\n"), "utf8");
    };
    const validate = (value) => validateTestGeneration(value, { cwd: root, changedFiles: changed("test/acceptance.test.js") });
    try {
      writeTest(["test('[AC-001] smoke', () => assert.equal(1, 1));"]);
      let result = validate(task());
      assert.equal(result.status, "fail");
      assert.ok(result.failures.some((failure) => failure.code === "ACCEPTANCE_COVERAGE_MANIFEST_MISSING"));

      const criteria = [{ criterion_id: "AC-001", required_test_name: "[AC-001] stdout and file output match" }, { criterion_id: "AC-002", required_test_name: "[AC-002] invalid input exits non-zero" }];
      writeTest(["test('[AC-001] stdout and file output match', () => assert.equal(1, 1));"]);
      result = validate(task(criteria));
      assert.equal(result.status, "fail");
      assert.ok(result.failures.some((failure) =>
        failure.code === "ACCEPTANCE_CRITERION_TEST_MISSING" && failure.detail.includes("AC-002")
      ));

      writeTest([
        "test('[AC-001] stdout and file output match', () => assert.equal(1, 1));",
        "test('[AC-002] invalid input exits non-zero', () => assert.notEqual(1, 0));",
      ]);
      result = validate(task(criteria));
      assert.equal(result.status, "pass");

      const markerCriteria = [{ criterion_id: "AC-STATS", required_test_name: "[AC-STATS] fixture ground truth stats are exact", required_markers: [{ text: "expectedStats" }, { pattern: "assert\\.equal\\(fileMarkdown, stdoutMarkdown" }], forbidden_patterns: [{ pattern: "\\bgit\\s+log\\b" }, { text: "--numstat" }] }];
      writeTest(["test('[AC-STATS] fixture ground truth stats are exact', () => { const expectedStats = { totalCommits: 2 }; const stdoutMarkdown = 'x'; const fileMarkdown = 'x'; const recompute = 'git log --numstat'; assert.equal(stdoutMarkdown, fileMarkdown); assert.equal(expectedStats.totalCommits, 2); });"]);
      result = validate(task(markerCriteria));
      assert.equal(result.status, "fail");
      assert.ok(result.failures.some((failure) => failure.code === "ACCEPTANCE_CRITERION_MARKER_MISSING"));
      assert.ok(result.failures.some((failure) => failure.code === "ACCEPTANCE_CRITERION_FORBIDDEN_PATTERN"));

      writeTest(["test('[AC-STATS] fixture ground truth stats are exact', () => { const expectedStats = { totalCommits: 2 }; const stdoutMarkdown = 'x'; const fileMarkdown = 'x'; assert.equal(fileMarkdown, stdoutMarkdown); assert.equal(expectedStats.totalCommits, 2); });"]);
      result = validate(task(markerCriteria));
      assert.equal(result.status, "pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires_manual_test acceptance criteria block validator pass-through", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-test-gen-manual-rule-"));
    try {
      const coverage = {
        schema: "yolo.test_generation.acceptance_coverage.v1",
        required_test_file: "test/acceptance.test.js",
        criteria: [{
          criterion_id: "AC-FUTURE",
          required_test_name: "[AC-FUTURE] future rule",
          requires_manual_test: true,
          rules: ["future_ai_oracle_rule"],
        }],
      };

      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test", "acceptance.test.js"), "import test from 'node:test';\ntest('[AC-FUTURE] future rule', () => {});\n", "utf8");

      const result = validateTestGeneration({
        scope: { allow_new_files: true, targets: [{ file: "test/acceptance.test.js" }] },
        post_conditions: [{ type: "tests_pass", params: { command: "node --test", require_tests: true } }],
        test_generation: { mode: "add_minimal", reason: "manual fallback must block", acceptance_coverage_required: true, acceptance_coverage: coverage },
      }, { cwd: root, changedFiles: changed("test/acceptance.test.js") });

      assert.equal(result.status, "fail");
      assert.ok(result.failures.some((failure) => failure.code === "ACCEPTANCE_CRITERION_REQUIRES_MANUAL_TEST"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
