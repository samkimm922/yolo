import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalNoNewTypeErrors } from "../src/lib/evaluators/quality-check.js";

function emptyRoot() {
  return mkdtempSync(join(tmpdir(), "yolo-qc-"));
}

describe("evalNoNewTypeErrors fail-closed on tool failure (P7.H1)", () => {
  test("non-zero exit with no parseable errors → FAIL, not pass", () => {
    const root = emptyRoot();
    try {
      const exec = () => ({
        ok: false,
        out: "",
        err: "some crash",
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
