/**
 * YOLO 引擎单元测试 — 覆盖所有条件评估器、条件组合、错误传播、边界值
 *
 * 用法: node --test scripts/yolo/__tests__/engine.test.js
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { CONDITION_TYPES, inspectConditionCatalogSync } from "../src/prd/condition-catalog.js";

// ── expect shim (compatible with vitest expect API) ──────────────
function expect(actual) {
  return {
    toBe(expected) {
      assert.strictEqual(actual, expected);
    },
    toContain(expected) {
      const ok =
        (typeof actual === "string" && actual.includes(expected)) ||
        (Array.isArray(actual) && actual.includes(expected));
      assert.ok(
        ok,
        `Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`,
      );
    },
    toBeDefined() {
      assert.ok(actual !== undefined, "Expected value to be defined");
    },
    toBeUndefined() {
      assert.strictEqual(actual, undefined);
    },
    toHaveLength(n) {
      assert.strictEqual(actual.length, n);
    },
    toHaveProperty(prop) {
      assert.ok(
        prop in actual,
        `Expected ${JSON.stringify(actual)} to have property "${prop}"`,
      );
    },
    toBeGreaterThanOrEqual(n) {
      assert.ok(
        actual >= n,
        `Expected ${JSON.stringify(actual)} >= ${n}`,
      );
    },
    get not() {
      return {
        toThrow() {
          assert.doesNotThrow(actual);
        },
      };
    },
  };
}

let engine;
const mockDir = resolve(import.meta.dirname, ".tmp-test");
const fileA = join(mockDir, "a.ts");
const fileB = join(mockDir, "b.ts");

before(async () => {
  engine = await import("../src/prd/contract.js");
  if (!existsSync(mockDir)) mkdirSync(mockDir, { recursive: true });
  // fileA: has console.error, as any, rarity: 'Base'
  writeFileSync(fileA, "console.error('test');\nconst x = 1 as any;\nrarity: 'Base';\n// line 4\n// line 5\n", "utf8");
  // fileB: has import/export
  writeFileSync(fileB, "import { foo } from './bar';\nexport function test() { return 42; }\n", "utf8");
});

after(() => {
  try { rmSync(mockDir, { recursive: true, force: true }); } catch {}
});

// Helper: create a task with pre_conditions and evaluate
function pre(conds) {
  return engine.evaluatePreConditions({ id: "T", pre_conditions: conds }, {});
}

// Helper: create a task with post_conditions and evaluate
function post(task) {
  const t = { id: "T", scope: { check_dead_code: false }, post_conditions: [], ...task };
  return engine.evaluatePostConditions(t, {});
}

// ═══════════════════════════════════════════════════════════════
// evalCodeContains
// ═══════════════════════════════════════════════════════════════
describe("evalCodeContains", () => {
  function cc(params) {
    return pre([{ id: "c1", type: "code_contains", severity: "FAIL", params, message: "" }]).results[0];
  }

  test("plain text with file (old style)", () => {
    const r = cc({ text: "console.error", file: fileA });
    expect(r.passed).toBe(true);
  });

  test("files array (PRD style)", () => {
    // code_contains 检查 files 中每个文件都需匹配，fileB 不含 "console.error"
    const r = cc({ text: "console.error", files: [fileA] });
    expect(r.passed).toBe(true);
  });

  test("pattern auto-detected as regex", () => {
    const r = cc({ pattern: "console\\.error", files: [fileA] });
    expect(r.passed).toBe(true);
  });

  test("pattern regex metacharacters work", () => {
    const r = cc({ pattern: "rarity:\\s*'Base'", files: [fileA] });
    expect(r.passed).toBe(true);
  });

  test("pattern with is_regex: false → literal search fails on regex chars", () => {
    const r = cc({ pattern: "rarity:.*'Base'", is_regex: false, files: [fileA] });
    expect(r.passed).toBe(false);
  });

  test("text with is_regex: true", () => {
    const r = cc({ text: "x = \\d+ as", is_regex: true, files: [fileA] });
    expect(r.passed).toBe(true);
  });

  test("count.min/max exact range match", () => {
    const r = cc({ text: "console.error", files: [fileA], count: { min: 1, max: 1 } });
    expect(r.passed).toBe(true);
  });

  test("count.max exceeded", () => {
    const r = cc({ text: "line", files: [fileA], count: { min: 1, max: 1 } });
    expect(r.passed).toBe(false);
  });

  test("count.exact match", () => {
    const r = cc({ text: "console.error", files: [fileA], count: { exact: 1 } });
    expect(r.passed).toBe(true);
  });

  test("count.exact mismatch", () => {
    const r = cc({ text: "console.error", files: [fileA], count: { exact: 2 } });
    expect(r.passed).toBe(false);
  });

  test("missing text/pattern → fail with clear message", () => {
    const r = cc({ files: [fileA] });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("缺少");
  });

  test("no file → not_run", () => {
    const r = cc({ text: "console.error" });
    expect(r.passed).toBe(false);
    expect(r.status).toBe("not_run");
  });

  test("non-existent file → fail", () => {
    const r = cc({ text: "whatever", files: ["/no/such/file.ts"] });
    expect(r.passed).toBe(false);
  });

  test("multi-file — all files match", () => {
    // code_contains 检查 files 中每个文件都需匹配，用 "test" 两文件都有
    const r = cc({ text: "test", files: [fileA, fileB] });
    expect(r.passed).toBe(true);
  });

  test("multi-file — all missing", () => {
    const r = cc({ text: "foo", files: ["/x.ts", "/y.ts"] });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("均不存在");
  });

  test("detail shows match count", () => {
    const r = cc({ text: "console.error", files: [fileA] });
    expect(r.detail).toContain("找到 1 处");
  });
});

// ═══════════════════════════════════════════════════════════════
// evalCodeNotContains
// ═══════════════════════════════════════════════════════════════
describe("evalCodeNotContains", () => {
  function cnc(params) {
    return engine.evaluatePostConditions({
      id: "T",
      scope: {},
      post_conditions: [{ id: "c1", type: "code_not_contains", severity: "FAIL", params, message: "" }],
    }, {}).results[0];
  }

  test("pattern absent → PASS", () => {
    const r = cnc({ pattern: "NO_SUCH_TEXT_XYZ", files: [fileA] });
    expect(r.passed).toBe(true);
  });

  test("pattern present → FAIL", () => {
    const r = cnc({ pattern: "console\\.error", files: [fileA] });
    expect(r.passed).toBe(false);
  });

  test("text (old style) absent → PASS", () => {
    const r = cnc({ text: "NO_EXIST", file: fileA });
    expect(r.passed).toBe(true);
  });

  test("text present → FAIL with detail", () => {
    const r = cnc({ text: "console.error", file: fileA });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("仍包含");
  });

  test("missing text/pattern → handled", () => {
    const r = cnc({ files: [fileA] });
    expect(r).toBeDefined();
    expect(r.passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// evalFileExists / evalFileNotExists
// ═══════════════════════════════════════════════════════════════
describe("file_exists / file_not_exists", () => {
  test("existing → PASS (uses file param)", () => {
    const r = pre([{ id: "c1", type: "file_exists", severity: "FAIL", params: { file: fileA }, message: "" }]);
    expect(r.results[0].passed).toBe(true);
  });

  test("existing → PASS (uses path alias)", () => {
    const r = pre([{ id: "c1", type: "file_exists", severity: "FAIL", params: { path: fileA }, message: "" }]);
    expect(r.results[0].passed).toBe(true);
  });

  test("non-existing → FAIL", () => {
    const r = pre([{ id: "c1", type: "file_exists", severity: "FAIL", params: { file: "/no/such/file.ts" }, message: "" }]);
    expect(r.results[0].passed).toBe(false);
  });

  test("file_not_exists non-existing → PASS", () => {
    const r = pre([{ id: "c1", type: "file_not_exists", severity: "FAIL", params: { file: "no-such-file.ts" }, message: "" }]);
    expect(r.results[0].passed).toBe(true);
  });

  test("file_not_exists existing → FAIL", () => {
    const r = pre([{ id: "c1", type: "file_not_exists", severity: "FAIL", params: { file: fileA }, message: "" }]);
    expect(r.results[0].passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// evalNoForbiddenPatterns
// ═══════════════════════════════════════════════════════════════
describe("no_forbidden_patterns", () => {
  test("clean file → PASS", () => {
    const clean = join(mockDir, "clean.ts");
    writeFileSync(clean, "export const PI = 3.14;\n", "utf8");
    const r = pre([{
      id: "c1", type: "no_forbidden_patterns", severity: "FAIL",
      params: { patterns: [{ pattern: "as any" }], files: [clean] }, message: "",
    }]);
    expect(r.results[0].passed).toBe(true);
    unlinkSync(clean);
  });

  test("no uncommitted git diff → PASS (no violations to report)", () => {
    // no_forbidden_patterns checks git diff added lines, not file contents.
    // fileA is in .tmp-test (untracked) so git diff returns nothing → PASS.
    const r = pre([{
      id: "c1", type: "no_forbidden_patterns", severity: "FAIL",
      params: { patterns: [{ pattern: "as any" }], targets: [fileA] }, message: "",
    }]);
    expect(r.results[0].passed).toBe(true);
  });

  test("pattern found in git diff added lines → FAIL", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-engine-forbidden-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      const file = join(root, "a.ts");
      writeFileSync(file, "export const PI = 3.14;\n", "utf8");
      execFileSync("git", ["add", "a.ts"], { cwd: root });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
      // Add violating pattern in uncommitted change
      writeFileSync(file, "export const PI = 3.14;\nconst x = 1 as any;\n", "utf8");

      const r = engine.evaluatePreConditions({
        id: "T",
        pre_conditions: [{
          id: "c1", type: "no_forbidden_patterns", severity: "FAIL",
          params: { patterns: [{ pattern: "as any" }], targets: ["a.ts"] }, message: "",
        }],
      }, {}, { root });

      assert.equal(r.results[0].passed, false);
      assert.match(r.results[0].detail, /as any/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// evalFileLinesMax
// ═══════════════════════════════════════════════════════════════
describe("file_lines_max", () => {
  test("under limit → PASS", () => {
    const r = pre([{
      id: "c1", type: "file_lines_max", severity: "FAIL",
      params: { files: [fileA], max: 200 }, message: "",
    }]);
    expect(r.results[0].passed).toBe(true);
  });

  test("over limit → FAIL with detail", () => {
    const r = pre([{
      id: "c1", type: "file_lines_max", severity: "FAIL",
      params: { files: [fileA], max: 3 }, message: "",
    }]);
    expect(r.results[0].passed).toBe(false);
    expect(r.results[0].detail).toContain("限制 3 行");
  });

  test("no files/targets → not_run", () => {
    const r = pre([{
      id: "c1", type: "file_lines_max", severity: "FAIL",
      params: { max: 150 }, message: "",
    }]);
    expect(r.results[0].passed).toBe(false);
    expect(r.results[0].status).toBe("not_run");
  });
});

// ═══════════════════════════════════════════════════════════════
// evaluatePostConditions — auto-conditions
// ═══════════════════════════════════════════════════════════════
describe("evaluatePostConditions auto-conditions", () => {
  test("AUTO-files_modified_max from scope.max_files", () => {
    const r = post({ scope: { max_files: 5 } });
    const a = r.results.find(c => c.id === "AUTO-files_modified_max");
    expect(a).toBeDefined();
  });

  test("explicit files_modified_max suppresses auto", () => {
    const r = post({
      scope: { max_files: 10 },
      post_conditions: [{ id: "my_fm", type: "files_modified_max", severity: "FAIL", params: { max: 3 }, message: "" }],
    });
    const auto = r.results.filter(c => c.id.startsWith("AUTO-files_modified_max"));
    expect(auto).toHaveLength(0);
  });

  test("AUTO-file_lines_max from scope.max_lines_per_file", () => {
    const r = post({ scope: { max_lines_per_file: 120 } });
    const a = r.results.find(c => c.id === "AUTO-file_lines_max");
    expect(a).toBeDefined();
  });

  test("AUTO-no_forbidden_patterns from scope.forbidden_patterns", () => {
    const r = post({ scope: { forbidden_patterns: [{ pattern: "console.log" }] } });
    const a = r.results.find(c => c.id === "AUTO-no_forbidden_patterns");
    expect(a).toBeDefined();
  });

  test("explicit + auto coexist", () => {
    const r = post({
      scope: { max_files: 5, max_lines_per_file: 150 },
      post_conditions: [{
        id: "my_check", type: "code_contains", severity: "FAIL",
        params: { text: "export", file: fileA }, message: "",
      }],
    });
    // 1 explicit + 3 auto (files_modified_max, file_lines_max, business_code_min)
    expect(r.results.length).toBeGreaterThanOrEqual(3);
    const ids = r.results.map(c => c.id);
    expect(ids).toContain("my_check");
    expect(ids.some(id => id.startsWith("AUTO-"))).toBe(true);
  });

  test("all results have required fields", () => {
    const r = post({ scope: { max_files: 3 } });
    for (const c of r.results) {
      expect(c).toHaveProperty("id");
      expect(c).toHaveProperty("passed");
      expect(c).toHaveProperty("severity");
      expect(c).toHaveProperty("detail");
    }
  });

  test("empty scope → no crash", () => {
    expect(() => post({ scope: {} })).not.toThrow();
  });

  test("undefined scope → no crash", () => {
    expect(() => post({ id: "T" })).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// evaluatePreConditions
// ═══════════════════════════════════════════════════════════════
describe("evaluatePreConditions", () => {
  test("all pass → allPass true", () => {
    const r = pre([{ id: "c1", type: "code_contains", severity: "FAIL",
      params: { text: "console.error", file: fileA }, message: "" }]);
    expect(r.allPass).toBe(true);
  });

  test("one FAIL fail → allPass false", () => {
    const r = pre([{ id: "c1", type: "code_contains", severity: "FAIL",
      params: { text: "DOES_NOT_EXIST", file: fileA }, message: "" }]);
    expect(r.allPass).toBe(false);
  });

  test("WARN only → allPass false", () => {
    const r = pre([{ id: "w1", type: "code_contains", severity: "WARN",
      params: { text: "DOES_NOT_EXIST", file: fileA }, message: "" }]);
    expect(r.allPass).toBe(false);
  });

  test("empty pre_conditions → allPass true", () => {
    const r = pre([]);
    expect(r.allPass).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// toGateFormat
// ═══════════════════════════════════════════════════════════════
describe("toGateFormat", () => {
  test("all PASS → allPass true, failHigh false", () => {
    const r = pre([{ id: "c1", type: "code_contains", severity: "FAIL",
      params: { text: "console.error", file: fileA }, message: "" }]);
    const gf = engine.toGateFormat(r);
    expect(gf.allPass).toBe(true);
    expect(gf.failHigh).toBe(false);
  });

  test("has FAIL → allPass false, failHigh true", () => {
    const r = pre([{ id: "c1", type: "code_contains", severity: "FAIL",
      params: { text: "NOT_HERE", file: fileA }, message: "" }]);
    const gf = engine.toGateFormat(r);
    expect(gf.allPass).toBe(false);
    expect(gf.failHigh).toBe(true);
  });

  test("gates array items have required fields", () => {
    const r = pre([{ id: "c1", type: "code_contains", severity: "FAIL",
      params: { text: "console.error", file: fileA }, message: "" }]);
    const gf = engine.toGateFormat(r);
    expect(gf.gates.length).toBe(1);
    expect(gf.gates[0]).toHaveProperty("name");
    expect(gf.gates[0]).toHaveProperty("passed");
    expect(gf.gates[0]).toHaveProperty("severity");
    expect(gf.gates[0]).toHaveProperty("detail");
  });
});

// ═══════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════
describe("edge cases", () => {
  test("unknown condition → passed false + error detail", () => {
    const r = pre([{ id: "c1", type: "this_type_does_not_exist", severity: "FAIL", params: {}, message: "" }]);
    expect(r.results[0].passed).toBe(false);
    expect(r.results[0].detail).toContain("未知条件类型");
  });

  test("invert: FAIL pattern not found → PASS", () => {
    const r = pre([{ id: "c1", type: "code_contains", severity: "FAIL",
      params: { text: "NO_MATCH", file: fileA }, invert: true, message: "" }]);
    // Without invert: FAIL (not found). With invert: PASS
    expect(r.results[0].passed).toBe(true);
  });

  test("invert: PASS pattern found → FAIL", () => {
    const r = pre([{ id: "c1", type: "code_contains", severity: "FAIL",
      params: { text: "console.error", file: fileA }, invert: true, message: "" }]);
    // Without invert: PASS (found). With invert: FAIL
    expect(r.results[0].passed).toBe(false);
  });

  test("null scope → no crash", () => {
    expect(() => post({ scope: null })).not.toThrow();
  });

  test("non-array post_conditions → fail-closed, no crash", () => {
    // post_conditions as a truthy non-array (string/number) must not crash
    // evaluatePostConditions on .some/.length; it must produce a structured result.
    expect(() => post({ post_conditions: "not-an-array" })).not.toThrow();
    expect(() => post({ post_conditions: 42 })).not.toThrow();
    expect(() => post({ post_conditions: {} })).not.toThrow();
    // The run produces a valid result object rather than throwing.
    const r = post({ post_conditions: "not-an-array" });
    expect(r.results).toBeDefined();
  });

  test("non-array pre_conditions → no crash", () => {
    expect(() => pre("not-an-array")).not.toThrow();
    expect(() => engine.evaluatePreConditions({ id: "T", pre_conditions: 42 }, {})).not.toThrow();
    // Non-array pre_conditions coerce to empty → allPass true (no conditions to fail).
    expect(engine.evaluatePreConditions({ id: "T", pre_conditions: "not-an-array" }, {}).allPass).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Full pipeline simulation
// ═══════════════════════════════════════════════════════════════
describe("full pipeline", () => {
  test("precheck PASS → postcheck FAIL (bug still present)", () => {
    const preR = pre([{ id: "bug", type: "code_contains", severity: "FAIL",
      params: { pattern: "as any", files: [fileA] }, message: "" }]);
    expect(preR.allPass).toBe(true);

    const postR = post({
      scope: { max_files: 5 },
      post_conditions: [{ id: "bug_gone", type: "code_not_contains", severity: "FAIL",
        params: { pattern: "as any", files: [fileA] }, message: "" }],
    });
    const check = postR.results.find(c => c.id === "bug_gone");
    expect(check.passed).toBe(false);
  });

  test("empty task → auto-conditions only, no crash", () => {
    const r = post({ scope: { max_files: 3, max_lines_per_file: 150 } });
    // AUTO-files_modified_max + AUTO-file_lines_max + AUTO-business_code_min
    expect(r.results.length).toBeGreaterThanOrEqual(2);
    expect(r.results.every(c => typeof c.detail === "string")).toBe(true);
  });

  test("mixed FAIL + WARN → correct result structure", () => {
    const r = post({
      scope: { max_files: 10 },
      post_conditions: [
        { id: "f1", type: "code_contains", severity: "FAIL",
          params: { text: "NONEXISTENT", file: fileA }, message: "" },
        { id: "w1", type: "code_contains", severity: "WARN",
          params: { text: "NONEXISTENT", file: fileA }, message: "" },
        { id: "p1", type: "code_contains", severity: "FAIL",
          params: { text: "console.error", file: fileA }, message: "" },
      ],
    });
    expect(r.allPass).toBe(false);
    expect(r.failConditions.length).toBeGreaterThanOrEqual(1);
    expect(r.warnConditions.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Auto-conditions structure
// ═══════════════════════════════════════════════════════════════
describe("auto-conditions structure", () => {
  test("AUTO-files_modified_max + AUTO-business_code_min auto-added", () => {
    // contract 自动追加: files_modified_max (scope.max_files 存在) + business_code_min (始终)
    const r = post({ scope: { max_files: 5, check_dead_code: false } });
    expect(r.results.find(c => c.id === "AUTO-files_modified_max")).toBeDefined();
    expect(r.results.find(c => c.id === "AUTO-business_code_min")).toBeDefined();
    // no_new_dead_code is never auto-added; only added via explicit post_conditions
    expect(r.results.find(c => c.id === "AUTO-no_new_dead_code")).toBeUndefined();
  });

  test("total auto-condition count ≥ 2 for standard scope", () => {
    const r = post({ scope: { max_files: 5, check_dead_code: false } });
    const auto = r.results.filter(c => c.id.startsWith("AUTO-"));
    // AUTO-files_modified_max + AUTO-business_code_min
    expect(auto.length).toBeGreaterThanOrEqual(2);
  });

  test("tests_pass + build_pass only when explicitly in post_conditions", () => {
    // contract 不会根据 phase 自动追加 tests_pass/build_pass，需显式添加
    const r = engine.evaluatePostConditions({ id: "T", scope: { max_files: 5, check_dead_code: false }, post_conditions: [
      { id: "my_tests", type: "tests_pass", severity: "FAIL", params: { command: `"${process.execPath}" -e "process.exit(0)"`, timeout_ms: 5000 }, message: "" },
      { id: "my_build", type: "build_pass", severity: "FAIL", params: { command: `"${process.execPath}" -e "process.exit(0)"`, timeout_ms: 5000 }, message: "" },
    ] }, {});
    expect(r.results.find(c => c.id === "my_tests")).toBeDefined();
    expect(r.results.find(c => c.id === "my_build")).toBeDefined();
  });

  test("default — no tests_pass/build_pass in auto-conditions", () => {
    const r = post({ scope: { max_files: 5, check_dead_code: false } });
    expect(r.results.find(c => c.id === "AUTO-tests_pass")).toBeUndefined();
    expect(r.results.find(c => c.id === "AUTO-build_pass")).toBeUndefined();
  });

  test("scope.max_files=15 → AUTO-files_modified_max detail 含 15", () => {
    const r = engine.evaluatePostConditions({ id: "T", scope: { max_files: 15, check_dead_code: false }, post_conditions: [] }, {});
    const a = r.results.find(c => c.id === "AUTO-files_modified_max");
    expect(a).toBeDefined();
    expect(a.detail).toContain("15");
  });

  test("scope.max_files=8 → AUTO-files_modified_max detail 含 8", () => {
    const r = engine.evaluatePostConditions({ id: "T", scope: { max_files: 8, check_dead_code: false }, post_conditions: [] }, {});
    expect(r.results.find(c => c.id === "AUTO-files_modified_max").detail).toContain("8");
  });

  test("no scope.max_files → no AUTO-files_modified_max", () => {
    // contract 仅在 scope.max_files 为 truthy 时追加 AUTO-files_modified_max
    const r = engine.evaluatePostConditions({ id: "T", scope: { check_dead_code: false }, post_conditions: [] }, {});
    expect(r.results.find(c => c.id === "AUTO-files_modified_max")).toBeUndefined();
  });

  test("scope.max_files overrides — detail 含指定值", () => {
    const r = engine.evaluatePostConditions({ id: "T", scope: { max_files: 3, check_dead_code: false }, post_conditions: [] }, {});
    expect(r.results.find(c => c.id === "AUTO-files_modified_max").detail).toContain("3");
  });

  test("sanity: engine loads and evaluates correctly", () => {
    const r = post({ scope: { max_files: 5, check_dead_code: false } });
    // AUTO-files_modified_max + AUTO-business_code_min = 2 auto-conditions minimum
    expect(r.results.length).toBeGreaterThanOrEqual(2);
    expect(r.results.every(c => typeof c.detail === "string")).toBe(true);
  });
});

describe("schema condition coverage", () => {
  test("condition catalog is the single source for schema and evaluators", () => {
    const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "../schemas/prd-v2.schema.json"), "utf8"));
    const schemaTypes = schema.definitions.condition.properties.type.enum;
    const result = inspectConditionCatalogSync({
      schemaTypes,
      evaluatorTypes: engine.evaluatorConditionTypes(),
    });

    assert.equal(result.status, "pass");
    assert.deepEqual(result.catalog, [...CONDITION_TYPES].sort());
  });

  test("negative: condition catalog drift is blocked instead of silently passing", () => {
    const result = inspectConditionCatalogSync({
      schemaTypes: CONDITION_TYPES.filter((type) => type !== "tests_pass"),
      evaluatorTypes: [...CONDITION_TYPES, "fake_condition"],
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "CONDITION_CATALOG_SCHEMA_DRIFT" && blocker.missing.includes("tests_pass")));
    assert.ok(result.blockers.some((blocker) => blocker.code === "CONDITION_EVALUATOR_CATALOG_DRIFT" && blocker.missing.includes("fake_condition")));
  });

  test("function_contains_text and function_contains_call evaluate bounded function bodies", () => {
    mkdirSync(mockDir, { recursive: true });
    const fnFile = join(mockDir, "fn.ts");
    writeFileSync(fnFile, [
      "export function createSale(input) {",
      "  const quantity = input.quantity;",
      "  return runTransaction(quantity);",
      "}",
      "export function other() { return 'inventory'; }",
    ].join("\n"), "utf8");

    const textResult = pre([{ id: "PRE-FN-TEXT", type: "function_contains_text", severity: "FAIL", params: { file: fnFile, function: "createSale", text: "quantity" }, message: "" }]);
    const callResult = pre([{ id: "PRE-FN-CALL", type: "function_contains_call", severity: "FAIL", params: { file: fnFile, function: "createSale", callee: "runTransaction" }, message: "" }]);
    const boundedResult = pre([{ id: "PRE-FN-BOUNDED", type: "function_contains_text", severity: "FAIL", params: { file: fnFile, function: "createSale", text: "inventory" }, message: "" }]);

    assert.equal(textResult.allPass, true);
    assert.equal(callResult.allPass, true);
    assert.equal(boundedResult.allPass, false);
  });

  test("AST compatibility conditions provide deterministic text checks", () => {
    mkdirSync(mockDir, { recursive: true });
    const astFile = join(mockDir, "ast.ts");
    writeFileSync(astFile, [
      "const handler = (event) => {",
      "  return { status: event.status };",
      "};",
      "const item = { kind: 'sale', active: true };",
    ].join("\n"), "utf8");

    const callbackResult = pre([{ id: "PRE-AST-CB", type: "ast_callback_uses_param", severity: "FAIL", params: { file: astFile, function: "handler", param: "event" }, message: "" }]);
    const propertyResult = pre([{ id: "PRE-AST-PROP", type: "ast_find_by_property", severity: "FAIL", params: { file: astFile, property: "kind", value: "sale" }, message: "" }]);

    assert.equal(callbackResult.allPass, true);
    assert.equal(propertyResult.allPass, true);
  });

  test("command-backed conditions use explicit commands instead of project defaults", () => {
    const typeResult = pre([{
      id: "PRE-TYPE-CONTAINS",
      type: "type_errors_contain",
      severity: "FAIL",
      params: { command: `"${process.execPath}" -e "console.error('TS2307 missing module'); process.exit(1)"`, text: "TS2307" },
      message: "",
    }]);
    const testResult = pre([{
      id: "PRE-TEST-FILE",
      type: "test_file_passes",
      severity: "FAIL",
      params: { command: `"${process.execPath}" -e "process.exit(0)"`, file: "unit.test.js" },
      message: "",
    }]);

    assert.equal(typeResult.allPass, true);
    assert.equal(testResult.allPass, true);
  });
});
