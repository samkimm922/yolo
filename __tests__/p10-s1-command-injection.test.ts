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
  let tmpRoot: string;

  test.before(async () => {
    mod = await import("../src/lib/evaluators/runtime-check.js");
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

  test("require_tests rejects successful empty node:test output", () => {
    const result = mod.evalTestsPass({
      command: `"${process.execPath}" -e "console.log('# tests 0')"`,
      timeout_ms: 30000,
      require_tests: true,
    }, {}, tmpRoot);
    assert.equal(result.passed, false);
    assert.match(result.detail, /empty test suite|0 tests/i);
  });

  test("require_tests ignores business stdout that mentions 0 tests when runner summary is non-empty", () => {
    const result = mod.evalTestsPass({
      command: `"${process.execPath}" -e "console.log('business summary: 0 tests commits'); console.log('# tests 2')"`,
      timeout_ms: 30000,
      require_tests: true,
    }, {}, tmpRoot);
    assert.equal(result.passed, true);
  });

  test("require_tests rejects console.assert failures even when the command exits 0", () => {
    const result = mod.evalTestsPass({
      command: `"${process.execPath}" -e "console.error('Assertion failed: should have author name'); console.log('# tests 3')"`,
      timeout_ms: 30000,
      require_tests: true,
    }, {}, tmpRoot);
    assert.equal(result.passed, false);
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
