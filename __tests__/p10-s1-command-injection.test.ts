// P10.S1 adversarial tests — command injection elimination
// Asserts that untrusted verify_command / params.command / custom_command
// inputs with shell metacharacters are rejected, and that legitimate commands still pass.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCommandToArgv } from "../src/lib/security/command-guard.js";

// ── parseCommandToArgv unit tests ─────────────────────────────

describe("P10.S1 parseCommandToArgv", () => {
  test("happy path: simple command parses to argv", () => {
    const r = parseCommandToArgv("npm test");
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.argv, ["npm", "test"]);
  });

  test("happy path: quoted arguments preserve special chars", () => {
    const r = parseCommandToArgv('"node" -e "process.exit(0)"');
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.argv, ["node", "-e", "process.exit(0)"]);
  });

  test("happy path: single quotes preserved", () => {
    const r = parseCommandToArgv("echo 'hello world'");
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.argv, ["echo", "hello world"]);
  });

  test("rejects $() command substitution outside quotes", () => {
    const r = parseCommandToArgv('test "$(printf X)" = X');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "shell_metachar");
  });

  test("rejects backtick substitution outside quotes", () => {
    const r = parseCommandToArgv("test `printf X`");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "shell_metachar");
  });

  test("rejects semicolon outside quotes", () => {
    const r = parseCommandToArgv("npm test; curl evil");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "shell_metachar");
  });

  test("rejects pipe outside quotes", () => {
    const r = parseCommandToArgv("npm test | grep PASS");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "shell_metachar");
  });

  test("rejects newline injection", () => {
    const r = parseCommandToArgv("npm test\ncurl evil");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "shell_metachar");
  });

  test("rejects sh -c command mode even when payload is quoted", () => {
    const r = parseCommandToArgv("sh -c 'touch owned'");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "shell_command");
  });

  test("rejects env shell wrapper bypass", () => {
    const r = parseCommandToArgv("env NODE_ENV=test sh -c 'touch owned'");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "shell_command");
  });

  test("rejects redirect < outside quotes", () => {
    const r = parseCommandToArgv("npm test < /etc/passwd");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "shell_metachar");
  });

  test("rejects redirect > outside quotes", () => {
    const r = parseCommandToArgv("npm test > output.txt");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "shell_metachar");
  });

  test("rejects logical AND (&&)", () => {
    const r = parseCommandToArgv("npm test && curl evil");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "shell_metachar");
  });

  test("rejects empty command", () => {
    const r = parseCommandToArgv("");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "empty");
  });

  test("rejects shell interpreters with -c argv escape", () => {
    for (const command of ["sh -c 'echo unsafe'", "bash -lc 'echo unsafe'", "zsh -c 'echo unsafe'"]) {
      const r = parseCommandToArgv(command);
      assert.equal(r.ok, false, command);
      if (!r.ok) assert.equal(r.reason, "shell_command");
    }
  });
});

// ── contract.ts acceptance_criteria verify_command ─────────────

describe("P10.S1 contract acceptance_criteria verify_command", () => {
  let engine: any;
  let tmpRoot: string;

  test.before(async () => {
    engine = await import("../src/prd/contract.js");
    tmpRoot = mkdtempSync(join(tmpdir(), "yolo-p10-s1-contract-"));
  });

  test.after(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  test("happy path: safe verify_command passes when exit 0", () => {
    const result = engine.evaluatePostConditions({
      id: "T",
      scope: {},
      post_conditions: [{
        id: "ACC-SAFE",
        type: "acceptance_criteria",
        severity: "FAIL",
        params: { text: "safe", verify_command: `"${process.execPath}" -e "process.exit(0)"` },
        message: "",
      }],
    }, {});
    const r = result.results.find((c: any) => c.id === "ACC-SAFE");
    assert.ok(r);
    assert.equal(r.passed, true);
  });

  test("rejects $() command substitution", () => {
    const result = engine.evaluatePostConditions({
      id: "T",
      scope: {},
      post_conditions: [{
        id: "ACC-INJ-DOLLAR",
        type: "acceptance_criteria",
        severity: "FAIL",
        params: { text: "inj", verify_command: 'test "$(printf X)" = X' },
        message: "",
      }],
    }, {});
    const r = result.results.find((c: any) => c.id === "ACC-INJ-DOLLAR");
    assert.ok(r);
    assert.equal(r.passed, false);
    assert.ok(r.detail.includes("拒绝") || r.detail.includes("rejected"));
  });

  test("rejects backtick substitution", () => {
    const result = engine.evaluatePostConditions({
      id: "T",
      scope: {},
      post_conditions: [{
        id: "ACC-INJ-BACKTICK",
        type: "acceptance_criteria",
        severity: "FAIL",
        params: { text: "inj", verify_command: "test `printf X`" },
        message: "",
      }],
    }, {});
    const r = result.results.find((c: any) => c.id === "ACC-INJ-BACKTICK");
    assert.ok(r);
    assert.equal(r.passed, false);
  });

  test("rejects newline injection", () => {
    const result = engine.evaluatePostConditions({
      id: "T",
      scope: {},
      post_conditions: [{
        id: "ACC-INJ-NEWLINE",
        type: "acceptance_criteria",
        severity: "FAIL",
        params: { text: "inj", verify_command: "npm test\ncurl evil" },
        message: "",
      }],
    }, {});
    const r = result.results.find((c: any) => c.id === "ACC-INJ-NEWLINE");
    assert.ok(r);
    assert.equal(r.passed, false);
  });
});

// ── runtime-check.ts evalTestsPass params.command ──────────────

describe("P10.S1 runtime-check evalTestsPass injection rejection", () => {
  let mod: any;
  let engine: any;
  let tmpRoot: string;

  function outsideParentNodeTestContext<T>(run: () => T): T {
    const parentContext = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    try {
      return run();
    } finally {
      if (parentContext === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = parentContext;
    }
  }

  test.before(async () => {
    mod = await import("../src/lib/evaluators/runtime-check.js");
    engine = await import("../src/prd/contract.js");
    tmpRoot = mkdtempSync(join(tmpdir(), "yolo-p10-s1-runtime-"));
  });

  test.after(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  test("happy path: safe command passes when exit 0", () => {
    const result = mod.evalTestsPass({
      command: `"${process.execPath}" -e "process.exit(0)"`,
      timeout_ms: 30000,
    }, {}, tmpRoot);
    assert.equal(result.passed, true);
  });

  test("require_tests fails closed for successful unittest output with zero tests and no declaration", () => {
    const result = mod.evalTestsPass({
      command: `"${process.execPath}" -e "console.error('Ran 0 tests in 0.000s'); console.error('OK')"`,
      timeout_ms: 30000,
      require_tests: true,
    }, {}, tmpRoot);
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(result.detail, /test_count|声明|declaration/i);
  });

  test("require_tests fails closed for successful pytest output with no executed tests and no declaration", () => {
    const result = mod.evalTestsPass({
      command: `"${process.execPath}" -e "console.log('no tests ran in 0.01s')"`,
      timeout_ms: 30000,
      require_tests: true,
    }, {}, tmpRoot);
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(result.detail, /test_count|声明|declaration/i);
  });

  test("task authenticity test_count rejects zero, accepts a real count, and fails extraction closed", () => {
    const testCount = {
      type: "test_count",
      minimum: 1,
      pattern: String.raw`^Ran\s+(?<count>\d+)\s+tests?`,
      flags: "m",
    };
    const task = (command: string) => ({
      id: "T-TEST-COUNT",
      scope: { expected_zero_business_code: true },
      verification_contract: {
        authenticity: {
          required: true,
          methods: [
            { type: "required_marker", files: ["tests/example.test"], markers: [{ text: "behavior" }] },
            testCount,
          ],
        },
      },
      post_conditions: [{
        id: "POST-TEST-COUNT",
        type: "tests_pass",
        severity: "FAIL",
        params: { command, timeout_ms: 30000, require_tests: true },
      }],
    });

    const zero = engine.evaluatePostConditions(task(
      `"${process.execPath}" -e "console.error('Ran 0 tests in 0.000s'); console.error('OK')"`,
    ), {}, { root: tmpRoot });
    assert.equal(zero.allPass, false, JSON.stringify(zero.results));
    assert.equal(zero.results[0].found, 0);

    const nonzero = engine.evaluatePostConditions(task(
      `"${process.execPath}" -e "console.error('Ran 2 tests in 0.001s'); console.error('OK')"`,
    ), {}, { root: tmpRoot });
    assert.equal(nonzero.allPass, true, JSON.stringify(nonzero.results));
    assert.equal(nonzero.results[0].found, 2);

    const missing = engine.evaluatePostConditions(task(
      `"${process.execPath}" -e "console.log('no tests ran in 0.01s')"`,
    ), {}, { root: tmpRoot });
    assert.equal(missing.allPass, false, JSON.stringify(missing.results));
    assert.match(missing.results[0].detail, /提取|extract/i);
  });

  test("project config test_count applies the same fail-closed extraction contract", () => {
    const task = (command: string) => ({
      id: "T-CONFIG-TEST-COUNT",
      scope: { expected_zero_business_code: true },
      post_conditions: [{
        id: "POST-CONFIG-TEST-COUNT",
        type: "tests_pass",
        severity: "FAIL",
        params: { command, timeout_ms: 30000, require_tests: true },
      }],
    });
    const options = {
      root: tmpRoot,
      config: {
        build: {
          test_count: {
            minimum: 1,
            pattern: String.raw`^(?<count>\d+)\s+passed`,
            flags: "m",
          },
        },
      },
    };

    const missing = engine.evaluatePostConditions(task(
      `"${process.execPath}" -e "console.log('no tests ran in 0.01s')"`,
    ), {}, options);
    assert.equal(missing.allPass, false, JSON.stringify(missing.results));

    const nonzero = engine.evaluatePostConditions(task(
      `"${process.execPath}" -e "console.log('2 passed in 0.01s')"`,
    ), {}, options);
    assert.equal(nonzero.allPass, true, JSON.stringify(nonzero.results));
    assert.equal(nonzero.results[0].found, 2);

    const ambiguous = engine.evaluatePostConditions(task(
      `"${process.execPath}" -e "console.log('2 passed'); console.log('0 passed')"`,
    ), {}, options);
    assert.equal(ambiguous.allPass, false, JSON.stringify(ambiguous.results));
    assert.match(ambiguous.results[0].detail, /multiple|多个|歧义/i);
  });

  test("node:test built-in adapter rejects an empty suite and accepts a real test", () => {
    const emptyRoot = join(tmpRoot, "node-empty");
    mkdirSync(emptyRoot, { recursive: true });
    const empty = outsideParentNodeTestContext(() => mod.evalTestsPass({
      command: `"${process.execPath}" --test`,
      timeout_ms: 30000,
      require_tests: true,
    }, {}, emptyRoot));
    assert.equal(empty.passed, false, JSON.stringify(empty));

    const testRoot = join(tmpRoot, "node-positive");
    mkdirSync(testRoot, { recursive: true });
    writeFileSync(join(testRoot, "sample.test.mjs"), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('real node test', () => {",
      "  console.log('business summary: 0 tests commits');",
      "  assert.equal(1, 1);",
      "});",
    ].join("\n"), "utf8");
    const nonzero = outsideParentNodeTestContext(() => mod.evalTestsPass({
      command: `"${process.execPath}" --test sample.test.mjs`,
      timeout_ms: 30000,
      require_tests: true,
    }, {}, testRoot));
    assert.equal(nonzero.passed, true, JSON.stringify(nonzero));
  });

  test("node:test built-in adapter rejects contradictory flags that disable test mode", () => {
    for (const flag of ["--no-test", "--no-test=true", "--no_test", "--no_test=true"]) {
      const result = outsideParentNodeTestContext(() => mod.evalTestsPass({
        command: `"${process.execPath}" --test ${flag} --import "data:text/javascript,console.log('%23 tests 1')"`,
        timeout_ms: 30000,
        require_tests: true,
      }, {}, tmpRoot));
      assert.equal(result.passed, false, `${flag}: ${JSON.stringify(result)}`);
      assert.match(result.detail, /test_count|声明|declaration/i);
    }
  });

  test("node:test built-in adapter rejects underscore aliases for custom reporters", () => {
    const reporterRoot = join(tmpRoot, "node-custom-reporter");
    mkdirSync(reporterRoot, { recursive: true });
    writeFileSync(join(reporterRoot, "fake-reporter.mjs"), [
      "import { Transform } from 'node:stream';",
      "export default new Transform({",
      "  writableObjectMode: true,",
      "  transform(_event, _encoding, callback) { callback(); },",
      "  flush(callback) { this.push('# tests 1\\n'); callback(); },",
      "});",
    ].join("\n"), "utf8");
    const result = outsideParentNodeTestContext(() => mod.evalTestsPass({
      command: `"${process.execPath}" --test --test_reporter=./fake-reporter.mjs`,
      timeout_ms: 30000,
      require_tests: true,
    }, {}, reporterRoot));
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(result.detail, /test_count|声明|declaration/i);
  });

  test("require_tests rejects console.assert failures from a real node:test command", () => {
    const testRoot = join(tmpRoot, "node-console-assert");
    mkdirSync(testRoot, { recursive: true });
    writeFileSync(join(testRoot, "console-assert.test.mjs"), [
      "import test from 'node:test';",
      "test('console assert is not a test failure', () => {",
      "  console.assert(false, 'should have author name');",
      "});",
    ].join("\n"), "utf8");
    const result = outsideParentNodeTestContext(() => mod.evalTestsPass({
      command: `"${process.execPath}" --test console-assert.test.mjs`,
      timeout_ms: 30000,
      require_tests: true,
    }, {}, testRoot));
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.match(result.detail, /Assertion failed/);
  });

  test("rejects $() in params.command", () => {
    const result = mod.evalTestsPass({
      command: 'test "$(printf X)" = X',
      timeout_ms: 5000,
    }, {}, tmpRoot);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("rejected"));
  });

  test("rejects semicolon injection in params.command", () => {
    const result = mod.evalTestsPass({
      command: "npm test; curl evil",
      timeout_ms: 5000,
    }, {}, tmpRoot);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("rejected"));
  });

  test("rejects backtick injection in params.command", () => {
    const result = mod.evalTestsPass({
      command: "npm test `curl evil`",
      timeout_ms: 5000,
    }, {}, tmpRoot);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("rejected"));
  });

  test("rejects sh -c in params.command and does not run payload", () => {
    const marker = join(tmpRoot, "p10-sh-c-owned");
    const result = mod.evalTestsPass({
      command: "sh -c 'touch p10-sh-c-owned'",
      timeout_ms: 5000,
    }, {}, tmpRoot);
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("rejected"));
    assert.equal(existsSync(marker), false);
  });
});

// ── provider-adapter custom_command model substitution ────────

describe("P10.S1 provider-adapter custom_command model injection", () => {
  let mod: any;

  test.before(async () => {
    mod = await import("../src/runtime/execution/provider-adapter.js");
  });

  test("happy path: safe model value substitutes correctly", () => {
    const inv = mod.buildProviderInvocation({
      provider: "shell",
      config: { ai: { custom_command: "node agent.js --model ${model}", model: "gpt-4" } },
      workDir: "/repo",
      rootDir: "/repo",
      runtimeDir: "/repo/state",
    });
    assert.equal(inv.customCommand, "node agent.js --model gpt-4");
  });

  test("rejects model with semicolon injection", () => {
    assert.throws(() => {
      mod.buildProviderInvocation({
        provider: "shell",
        config: { ai: { custom_command: "node agent.js --model ${model}", model: "; curl evil" } },
        workDir: "/repo",
        rootDir: "/repo",
        runtimeDir: "/repo/state",
      });
    }, /shell metacharacter/);
  });

  test("rejects model with $() injection", () => {
    assert.throws(() => {
      mod.buildProviderInvocation({
        provider: "shell",
        config: { ai: { custom_command: "node agent.js --model ${model}", model: "$(curl evil)" } },
        workDir: "/repo",
        rootDir: "/repo",
        runtimeDir: "/repo/state",
      });
    }, /shell metacharacter/);
  });
});
