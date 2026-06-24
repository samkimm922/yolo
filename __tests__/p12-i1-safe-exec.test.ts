// P12.I1 adversarial tests — safe-exec chokepoint + ci-guard no-shell-injection gate
// Asserts:
//   1. execCommand rejects shell metacharacters ($(), ``, ;, |, >, newline) — never runs.
//   2. execArgv runs argv directly via spawnSync (no shell).
//   3. commandExistsSync walks PATH (no `sh -c "command -v X"`).
//   4. ci-guard no-shell-injection catches an introduced shell:true fixture.
//   5. ci-guard no-shell-injection passes on the clean tree (no false positives).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execArgv, execCommand, commandExistsSync } from "../src/lib/security/safe-exec.js";
import { runCiGuard } from "../scripts/ci-guard.js";

// ── execArgv: happy path + no-shell guarantee ──────────────────

describe("P12.I1 execArgv", () => {
  test("happy path: argv command runs and returns stdout", () => {
    const r = execArgv([process.execPath, "-e", "process.stdout.write('ok')"]);
    assert.equal(r.ok, true);
    assert.equal(r.stdout, "ok");
    assert.equal(r.exit_code, 0);
    assert.equal(r.signal, null);
  });

  test("happy path: argv reports non-zero exit without throwing", () => {
    const r = execArgv([process.execPath, "-e", "process.exit(2)"]);
    assert.equal(r.ok, false);
    assert.equal(r.exit_code, 2);
  });

  test("empty argv returns failure result, not exception", () => {
    const r = execArgv([]);
    assert.equal(r.ok, false);
    assert.equal(r.exit_code, null);
    assert.match(r.stderr, /empty argv/);
  });

  test("command_not_found when executable does not exist", () => {
    const r = execArgv(["__yolo_definitely_not_a_real_binary__"]);
    assert.equal(r.ok, false);
    assert.equal(r.command_not_found, true);
  });

  test("argv with shell metacharacters as ARGV (not parsed) runs literally — proves no shell", () => {
    // When argv is supplied directly, metacharacters are literal args — there is no
    // shell to interpret them. This proves execArgv never invokes sh.
    const r = execArgv([process.execPath, "-e", "process.stdout.write(process.argv[1])", "; echo INJECTED"]);
    assert.equal(r.ok, true);
    // The "; echo INJECTED" was passed as argv[1] to node -e, NOT executed by a shell.
    assert.equal(r.stdout, "; echo INJECTED");
  });
});

// ── execCommand: rejects shell metacharacters ─────────────────

describe("P12.I1 execCommand rejects shell metacharacters", () => {
  test("rejects $() command substitution", () => {
    const r = execCommand('node -e "process.exit(0)" "$(curl evil)"');
    assert.equal(r.rejected, true);
    assert.equal(r.ok, false);
    assert.equal(r.reject_reason, "shell_metachar");
    assert.match(r.stderr, /rejected/);
  });

  test("rejects backtick substitution", () => {
    const r = execCommand("node -e `curl evil`");
    assert.equal(r.rejected, true);
    assert.equal(r.reject_reason, "shell_metachar");
  });

  test("rejects semicolon chaining", () => {
    const r = execCommand("node -e 'process.exit(0)'; curl evil");
    assert.equal(r.rejected, true);
    assert.equal(r.reject_reason, "shell_metachar");
  });

  test("rejects pipe", () => {
    const r = execCommand("node -e 'process.exit(0)' | grep foo");
    assert.equal(r.rejected, true);
    assert.equal(r.reject_reason, "shell_metachar");
  });

  test("rejects redirect > ", () => {
    const r = execCommand("node -e 'process.exit(0)' > /tmp/x");
    assert.equal(r.rejected, true);
    assert.equal(r.reject_reason, "shell_metachar");
  });

  test("rejects newline injection", () => {
    const r = execCommand("node -e 'process.exit(0)'\ncurl evil");
    assert.equal(r.rejected, true);
    assert.equal(r.reject_reason, "shell_metachar");
  });

  test("rejects sh -c command mode and does not run payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-p12-sh-c-"));
    try {
      const marker = join(dir, "owned");
      const r = execCommand(`sh -c 'touch ${marker}'`, { cwd: dir, timeout: 5000 });
      assert.equal(r.rejected, true);
      assert.equal(r.reject_reason, "shell_command");
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects env shell wrapper bypass", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-p12-env-sh-c-"));
    try {
      const marker = join(dir, "owned");
      const r = execCommand(`env PATH=/bin:/usr/bin sh -c 'touch ${marker}'`, { cwd: dir, timeout: 5000 });
      assert.equal(r.rejected, true);
      assert.equal(r.reject_reason, "shell_command");
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("happy path: clean command parses and runs", () => {
    const r = execCommand(`${process.execPath} -e "process.stdout.write('clean')"`);
    assert.equal(r.rejected, false);
    assert.equal(r.ok, true);
    assert.equal(r.stdout, "clean");
  });

  test("happy path: quoted arguments with spaces preserved", () => {
    const r = execCommand(`${process.execPath} -e "process.stdout.write(process.argv[1])" "hello world"`);
    assert.equal(r.rejected, false);
    assert.equal(r.ok, true);
    assert.equal(r.stdout, "hello world");
  });
});

// ── commandExistsSync: PATH walk, no shell ────────────────────

describe("P12.I1 commandExistsSync", () => {
  test("returns true for node (always on PATH in test env)", () => {
    // node is the running interpreter; its binary exists somewhere reachable.
    // Use absolute path check as the robust happy-path.
    assert.equal(commandExistsSync(process.execPath), true);
  });

  test("returns false for nonexistent binary", () => {
    assert.equal(commandExistsSync("__yolo_definitely_not_a_real_binary__"), false);
  });

  test("returns false for empty string", () => {
    assert.equal(commandExistsSync(""), false);
  });
});

// ── ci-guard no-shell-injection gate ──────────────────────────

describe("P12.I1 ci-guard no-shell-injection gate", () => {
  test("passes on the clean tree (no false positives)", () => {
    const result = runCiGuard("shell-injection");
    assert.equal(result.status, "pass", `expected pass, got findings: ${JSON.stringify(result.checks.flatMap((c: any) => c.findings), null, 2)}`);
  });

  test("fails when shell:true is introduced in a non-allowlisted src file", () => {
    // Drop a fixture file with shell:true into src/lib/security/ temporarily.
    // ci-guard walks src/ — it must catch this and fail.
    const fixtureDir = join(process.cwd(), "src", "lib", "security");
    const fixturePath = join(fixtureDir, "__p12_i1_fixture_shell_true.ts");
    writeFileSync(fixturePath, [
      "// P12.I1 adversarial fixture — should trip ci-guard.",
      'import { spawnSync } from "node:child_process";',
      "export function bad() {",
      '  return spawnSync("echo", ["hi"], { shell: true });',
      "}",
      "",
    ].join("\n"));
    try {
      const result = runCiGuard("shell-injection");
      assert.equal(result.status, "fail", "expected ci-guard to catch shell:true fixture");
      const shellCheck = result.checks.find((c: any) => c.name === "shell-injection");
      assert.ok(shellCheck, "shell-injection check ran");
      const hit = (shellCheck.findings || []).some((f: any) => f.file.includes("__p12_i1_fixture_shell_true.ts"));
      assert.ok(hit, "fixture file flagged by ci-guard");
    } finally {
      rmSync(fixturePath, { force: true });
    }
    // After cleanup, gate is clean again.
    const after = runCiGuard("shell-injection");
    assert.equal(after.status, "pass", "fixture was not cleaned up");
  });

  test("fails when execSync(`template`) is introduced in a non-allowlisted src file", () => {
    const fixtureDir = join(process.cwd(), "src", "lib", "security");
    const fixturePath = join(fixtureDir, "__p12_i1_fixture_template.ts");
    writeFileSync(fixturePath, [
      "// P12.I1 adversarial fixture — should trip ci-guard.",
      'import { execSync } from "node:child_process";',
      "export function bad(cmd: string) {",
      "  return execSync(`${cmd} 2>&1`);",
      "}",
      "",
    ].join("\n"));
    try {
      const result = runCiGuard("shell-injection");
      assert.equal(result.status, "fail");
      const shellCheck = result.checks.find((c: any) => c.name === "shell-injection");
      const hit = (shellCheck.findings || []).some((f: any) => f.file.includes("__p12_i1_fixture_template.ts"));
      assert.ok(hit, "template-literal fixture flagged");
    } finally {
      rmSync(fixturePath, { force: true });
    }
  });
});

// ── integration: contract verify_command routes through safe-exec ──

describe("P12.I1 contract verify_command routes through safe-exec", () => {
  let engine: any;
  let tmpRoot: string;

  test.before(async () => {
    engine = await import("../src/prd/contract.js");
    tmpRoot = mkdtempSync(join(tmpdir(), "yolo-p12-i1-contract-"));
  });

  test.after(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  test("happy path: clean verify_command passes", () => {
    const result = engine.evaluatePostConditions({
      id: "T-P12-I1",
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

  test("rejects $() injection via verify_command", () => {
    const result = engine.evaluatePostConditions({
      id: "T-P12-I1",
      scope: {},
      post_conditions: [{
        id: "ACC-INJ",
        type: "acceptance_criteria",
        severity: "FAIL",
        params: { text: "inj", verify_command: 'node -e "0" "$(curl evil)"' },
        message: "",
      }],
    }, {});
    const r = result.results.find((c: any) => c.id === "ACC-INJ");
    assert.ok(r);
    assert.equal(r.passed, false);
    assert.match(r.detail, /拒绝|rejected/);
  });

  test("rejects newline injection via verify_command", () => {
    const result = engine.evaluatePostConditions({
      id: "T-P12-I1",
      scope: {},
      post_conditions: [{
        id: "ACC-NL",
        type: "acceptance_criteria",
        severity: "FAIL",
        params: { text: "nl", verify_command: "node -e '0'\ncurl evil" },
        message: "",
      }],
    }, {});
    const r = result.results.find((c: any) => c.id === "ACC-NL");
    assert.ok(r);
    assert.equal(r.passed, false);
  });
});
