import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeFailureFromGateLog,
  analyzeFailureOutput,
  buildFailureHint,
  gateFailureFingerprint,
  isContractConditionFailure,
} from "../src/runtime/gates/failure-analysis.js";

describe("runner gate failure analysis", () => {
  test("extracts failed gate details from the latest gate JSON log", () => {
    const logDir = mkdtempSync(join(tmpdir(), "yolo-gate-analysis-"));
    try {
      writeFileSync(join(logDir, "gate-FIX-001-100.json"), JSON.stringify({
        gates: [{ name: "POST-OLD", type: "code_contains", passed: false, detail: "old failure" }],
      }), "utf8");
      writeFileSync(join(logDir, "gate-FIX-001-200.json"), JSON.stringify({
        gates: [
          { id: "POST-FILE", name: "file_exists", type: "file_exists", passed: true, detail: "ok" },
          { id: "POST-CODE", name: "code_contains", type: "code_contains", passed: false, detail: "missing target text", severity: "FAIL" },
        ],
      }), "utf8");

      const failures = analyzeFailureFromGateLog("FIX-001", logDir);

      assert.deepEqual(failures, [{
        id: "POST-CODE",
        type: "code_contains",
        detail: "missing target text",
        severity: "FAIL",
        rules: ["code_contains"],
      }]);
      assert.equal(isContractConditionFailure(failures), true);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("classifies text gate output into retry categories", () => {
    assert.deepEqual(analyzeFailureOutput("error TS2322: Type 'string' is not assignable").at(0), {
      type: "tsc",
      detail: "error TS2322: Type 'string' is not assignable",
      rules: ["tsc"],
    });

    assert.equal(analyzeFailureOutput("no_new_lint_errors: no-unused-vars at src/a.ts").at(0).type, "eslint");
    assert.equal(analyzeFailureOutput("code_contains 期望找到 target text").at(0).type, "语义审查");
    assert.equal(analyzeFailureOutput("files_modified_max 文件数超过限制").at(0).type, "file_scope");
    assert.equal(analyzeFailureOutput("innerHTML unsafe sink").at(0).type, "dangerous");
    assert.equal(analyzeFailureOutput("opaque issue").at(0).type, "unknown");
  });

  test("builds scoped retry hints from relevant failure lines", () => {
    const hint = buildFailureHint([
      "unrelated/package.ts error",
      "src/service/value.ts:2 error TS2322",
      "eslint no-unused-vars src/service/value.ts:3",
    ].join("\n"), "src/service/value.ts");

    assert.match(hint, /src\/service\/value\.ts:2/);
    assert.match(hint, /eslint unused 根因分析/);
    assert.doesNotMatch(hint, /unrelated\/package\.ts error/);
  });

  test("produces stable fingerprints for repeated gate failures", () => {
    const fingerprint = gateFailureFingerprint([
      { id: "POST-CODE", type: "code_contains", detail: "missing target text" },
      { type: "eslint", detail: "no-unused-vars" },
    ]);

    assert.equal(fingerprint, "POST-CODE:code_contains:missing target text | eslint:no-unused-vars");
  });
});
