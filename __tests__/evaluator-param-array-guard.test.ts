import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evalCodeContains,
  evalCodeNotContains,
  evalAstFindByProperty,
} from "../src/lib/evaluators/code-check.js";
import { evalFileLinesMax } from "../src/lib/evaluators/file-check.js";
import { evalNoForbiddenPatterns } from "../src/lib/evaluators/quality-check.js";

// Regression: a hand-edited PRD can put a string on params.files / params.targets
// (schema only constrains params to be an object). Before the guard, each
// evaluator iterated the *characters* of the string via `for...of`, which
// either silently passed (file_lines_max/no_forbidden_patterns: single-char
// paths vacuously `continue` on existsSync==false) or crashed with
// "targetFiles.join|filter is not a function" (code_contains/code_not_contains/
// ast_find_by_property: strings lack Array methods). The fix coerces
// params.files/params.targets through Array.isArray; a non-array now falls
// through to params.file/taskScope.targets instead of being iterated as chars.

function fakeExec(_cmd) {
  return { ok: true, out: "" };
}

describe("evaluator param-array guard (non-array params.files/targets)", () => {
  test("evalFileLinesMax does not silently pass when params.targets is a string", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-eval-guard-"));
    try {
      writeFileSync(join(root, "big.ts"), `${"a = 1\n".repeat(500)}`, "utf8");
      const arrayForm = evalFileLinesMax({ targets: ["big.ts"], max: 150 }, {}, root);
      assert.equal(arrayForm.passed, false);
      const stringForm = evalFileLinesMax({ targets: "big.ts", max: 150 }, {}, root);
      assert.equal(stringForm.passed, false);
      assert.equal(stringForm.status, "not_run");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("evalFileLinesMax does not silently pass when params.files is a string", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-eval-guard-"));
    try {
      writeFileSync(join(root, "big.ts"), `${"a = 1\n".repeat(500)}`, "utf8");
      const stringForm = evalFileLinesMax({ files: "big.ts", max: 150 }, {}, root);
      assert.equal(stringForm.passed, false);
      assert.equal(stringForm.status, "not_run");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("evalNoForbiddenPatterns does not silently pass when params.targets is a string", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-eval-guard-"));
    try {
      const result = evalNoForbiddenPatterns(
        { patterns: [{ pattern: "evil" }], targets: "src/foo.ts" },
        {},
        root,
        fakeExec,
      );
      assert.equal(result.passed, false);
      assert.equal(result.status, "not_run");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("evalCodeContains does not crash when params.files is a string", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-eval-guard-"));
    try {
      writeFileSync(join(root, "big.ts"), "export const evil = 'bad';\n", "utf8");
      const result = evalCodeContains({ text: "good", files: "big.ts" }, {}, root);
      assert.equal(result.passed, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("evalCodeNotContains does not crash when params.files is a string", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-eval-guard-"));
    try {
      writeFileSync(join(root, "big.ts"), "export const evil = 'bad';\n", "utf8");
      const result = evalCodeNotContains({ text: "missing", files: "big.ts" }, {}, root);
      assert.equal(result.passed, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("evalAstFindByProperty does not crash when params.files is a string", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-eval-guard-"));
    try {
      writeFileSync(join(root, "big.ts"), "export const evil = 'bad';\n", "utf8");
      const result = evalAstFindByProperty({ property: "evil", files: "big.ts" }, {}, root);
      assert.equal(result.passed, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
