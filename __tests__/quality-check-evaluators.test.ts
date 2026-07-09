import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalNoNewTypeErrors, evalNoNewLintErrors, evalNoForbiddenPatterns, evalTypeErrorsContain } from "../src/lib/evaluators/quality-check.js";

function emptyRoot() {
  return mkdtempSync(join(tmpdir(), "yolo-qc-"));
}

describe("evalNoNewTypeErrors fail-closed on tool failure (P7.H1)", () => {
  test("non-zero exit with empty output → FAIL, not pass", () => {
    const root = emptyRoot();
    try {
      const exec = () => ({
        ok: false,
        out: "",
        err: "",
        commandNotFound: false,
        exitCode: 2,
      });
      const result = evalNoNewTypeErrors({ command: "node -e \"process.exit(2)\"" }, Object(), root, exec);
      assert.equal(result.passed, false);
      assert.match(result.detail, /异常退出/);
      assert.match(result.detail, /code 2/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exit 0 with clean output → pass", () => {
    const root = emptyRoot();
    try {
      const exec = () => ({ ok: true, out: "", commandNotFound: false, exitCode: 0 });
      const result = evalNoNewTypeErrors({ command: "tsc --noEmit" }, Object(), root, exec);
      assert.equal(result.passed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-zero exit with real parseable errors → reports new errors", () => {
    const root = emptyRoot();
    try {
      const exec = () => ({
        ok: false,
        out: "src/a.ts(1,1): error TS2322: bad",
        err: "",
        commandNotFound: false,
        exitCode: 1,
      });
      const result = evalNoNewTypeErrors({ command: "tsc --noEmit" }, Object(), root, exec);
      assert.equal(result.passed, false);
      assert.match(result.detail, /新增/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("evalNoNewLintErrors fail-closed on tool failure (P7.H2)", () => {
  test("non-zero exit with empty [] output → FAIL, not pass", () => {
    const root = emptyRoot();
    try {
      const exec = () => ({
        ok: false,
        out: "",
        err: "",
        commandNotFound: false,
        exitCode: 2,
      });
      const result = evalNoNewLintErrors({ command: "node -e 'process.stdout.write(\"[]\");process.exit(2)'" }, Object(), root, exec);
      assert.equal(result.passed, false);
      assert.match(result.detail, /异常退出/);
      assert.match(result.detail, /code 2/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exit 0 with clean [] output → pass", () => {
    const root = emptyRoot();
    try {
      const exec = () => ({ ok: true, out: "[]", commandNotFound: false, exitCode: 0 });
      const result = evalNoNewLintErrors({ command: "eslint --format json ." }, Object(), root, exec);
      assert.equal(result.passed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("arbitrary lint output is compared as a generic snapshot", () => {
    const root = emptyRoot();
    try {
      assert.ok(!existsSync(join(root, "scripts", "yolo", "state", "runtime", "eslint-baseline.json")));
      const exec = () => ({ ok: false, out: "src/a.py:1:2: F401 imported but unused", err: "", commandNotFound: false, exitCode: 1 });
      const result = evalNoNewLintErrors({ command: "ruff check ." }, Object(), root, exec);
      assert.equal(result.passed, false);
      assert.match(result.detail, /新增/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("declaration-driven type/lint snapshots", () => {
  test("mypy output passes when the same output is present in the generic baseline", () => {
    const root = emptyRoot();
    try {
      mkdirSync(join(root, "scripts/yolo/state/runtime"), { recursive: true });
      writeFileSync(join(root, "scripts/yolo/state/runtime/tsc-baseline.json"), JSON.stringify({
        keys: ["line:src/a.py:1: error: existing"],
      }), "utf8");
      const result = evalNoNewTypeErrors(
        { command: "mypy" },
        Object(),
        root,
        () => ({ ok: false, out: "src/a.py:1: error: existing", err: "", commandNotFound: false, exitCode: 1 }),
      );
      assert.equal(result.passed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ruff output uses declared rule IDs without an ESLint schema", () => {
    const root = emptyRoot();
    try {
      const result = evalNoNewLintErrors(
        {
          command: "ruff check .",
          failure_output_rules: [{ id: "python-lint", contains: "F401" }],
        },
        Object(),
        root,
        () => ({ ok: false, out: "src/a.py:1:2: F401 imported but unused", err: "", commandNotFound: false, exitCode: 1 }),
      );
      assert.equal(result.passed, false);
      assert.match(result.detail, /python-lint/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P10.S4 evalNoForbiddenPatterns rejects ReDoS patterns", () => {
  test("ReDoS regex pattern returns fail, not hang", () => {
    const root = emptyRoot();
    try {
      writeFileSync(join(root, "foo.ts"), "const x = 1;\n", "utf8");
      const exec = (cmd: string) => {
        if (cmd.startsWith("git diff")) return { ok: true, out: "+const x = 1;", commandNotFound: false, exitCode: 0 };
        return { ok: true, out: "", commandNotFound: false, exitCode: 0 };
      };
      const result = evalNoForbiddenPatterns(
        {
          patterns: [{ pattern: "(a+)+$", is_regex: true }],
          targets: ["foo.ts"],
        },
        null,
        root,
        exec,
      );
      assert.equal(result.passed, false);
      assert.match(result.detail, /禁用模式正则被拒绝|nested quantifiers/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P10.S4 evalTypeErrorsContain rejects ReDoS patterns", () => {
  test("ReDoS regex pattern returns fail, not hang", () => {
    const root = emptyRoot();
    try {
      const exec = () => ({ ok: true, out: "error TS2322: bad", commandNotFound: false, exitCode: 0 });
      const result = evalTypeErrorsContain(
        { command: "tsc --noEmit", pattern: "(a+)+$" },
        null,
        root,
        exec,
      );
      assert.equal(result.passed, false);
      assert.match(result.detail, /类型检查正则被拒绝|nested quantifiers/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
