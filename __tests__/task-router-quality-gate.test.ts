import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTaskExecution } from "../src/runtime/task-loop/router.js";
import { validateDiffQuality } from "../src/runtime/gates/diff-quality-gate.js";
import { applyAutoFixTasks } from "../src/lib/auto-fix.js";

function makeGitRepo() {
  const root = mkdtempSync(join(tmpdir(), "yolo-diff-quality-"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  return root;
}

function commitAll(root) {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
}

const r6Task = {
  id: "FIX-R6",
  title: "[R6-as-unknown-as] src/a.test.ts",
  scope: { targets: [{ file: "src/a.test.ts" }], max_files: 1, allow_new_files: false },
  source_findings: [{ scanner_id: "R6-as-unknown-as", file: "src/a.test.ts", line: 1 }],
};

describe("task router", () => {
  test("routes deterministic checks without spending provider time", () => {
    const route = classifyTaskExecution({
      id: "ACCEPT-1",
      task_kind: "deterministic_check",
      scope: { expected_zero_business_code: true, targets: [{ file: ".yolo/adapters/ui.json" }] },
    });
    assert.equal(route.route, "deterministic_check");
    assert.equal(route.provider_required, false);
  });

  test("never routes split or R9 file-length tasks to auto-fix", () => {
    const route = classifyTaskExecution({
      id: "FIX-R9",
      title: "[R9-file-length] src/long.test.ts",
      scope: { targets: [{ file: "src/long.test.ts" }], allow_new_files: true },
      source_findings: [{ scanner_id: "R9-file-length" }],
      fix_type: "AUTO_FIX",
      fix_rule: "R9-file-length",
    });
    assert.equal(route.route, "provider");
    assert.equal(route.reason, "split_or_structural_refactor_not_auto_fix");
  });

  test("routes known deterministic recipes to auto-fix", () => {
    const route = classifyTaskExecution({
      id: "AUTO-LOG",
      fix_type: "AUTO_FIX",
      fix_rule: "debug-console-log",
      scope: { targets: [{ file: "src/a.ts" }] },
    });
    assert.equal(route.route, "auto_fix");
    assert.equal(route.provider_required, false);
  });

  test("routes only safe test R6 mock casts to auto-fix", () => {
    const safeRoute = classifyTaskExecution({
      ...r6Task,
      source_findings: [{
        scanner_id: "R6-as-unknown-as",
        file: "src/a.test.ts",
        line: 3,
        match: "as unknown as ",
        context: "vi.mocked(db.collection).mockReturnValue(mockCollection as unknown as WechatMiniprogram.TypedCollection<unknown>)",
      }],
    });
    assert.equal(safeRoute.route, "auto_fix");
    assert.equal(safeRoute.reason, "safe_r6_test_mock_cast_recipe");

    const businessRoute = classifyTaskExecution({
      ...r6Task,
      scope: { targets: [{ file: "src/services/a.ts" }], max_files: 1, allow_new_files: false },
      source_findings: [{
        scanner_id: "R6-as-unknown-as",
        file: "src/services/a.ts",
        line: 3,
        context: "return res.data as unknown as Inventory;",
      }],
    });
    assert.equal(businessRoute.route, "provider");
  });
});

describe("auto-fix recipes", () => {
  test("fixes safe R6 test mock collection casts without provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-r6-auto-fix-"));
    try {
      mkdirSync(join(root, "src/__tests__"), { recursive: true });
      const file = "src/__tests__/a.test.ts";
      writeFileSync(join(root, file), [
        "import { vi } from 'vitest'",
        "test('x', async () => {",
        "  const { db } = await import('../db')",
        "  vi.mocked(db.collection).mockReturnValue(mockCollection as unknown as WechatMiniprogram.TypedCollection<unknown>)",
        "})",
      ].join("\n"), "utf8");

      const result = await applyAutoFixTasks([{
        id: "FIX-R6",
        fix_type: "AUTO_FIX",
        fix_rule: "R6-as-unknown-as",
        scope: { targets: [{ file }] },
        fix_findings: [{ scanner_id: "R6-as-unknown-as", file, line: 4 }],
      }], root, {
        execFileSync: () => "",
        config: { build: { type_check: "node --version", lint: "node --version" } },
      });

      assert.equal(result.success, true);
      assert.deepEqual(result.modifiedFiles, [file]);
      const updated = readFileSync(join(root, file), "utf8");
      assert.match(updated, /as ReturnType<typeof db\.collection>/);
      assert.doesNotMatch(updated, /as unknown as/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("eslint auto-fix escalates when --fix produces no target diff", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-eslint-no-diff-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const file = "src/a.ts";
      writeFileSync(join(root, file), "const value: any = 1\n", "utf8");
      const result = await applyAutoFixTasks([{
        id: "AUTO-ESLINT",
        fix_type: "AUTO_FIX",
        fix_rule: "eslint-@typescript-eslint/no-explicit-any",
        scope: { targets: [{ file }] },
        fix_findings: [{ scanner_id: "eslint-@typescript-eslint/no-explicit-any", file, line: 1, match: "@typescript-eslint/no-explicit-any" }],
      }], root, {
        execFileSync: () => "",
      });

      assert.equal(result.success, false);
      assert.equal(result.stats.escalated, 1);
      assert.equal(result.escalatedTasks?.[0]?.fix_type, "CLAUDE_FIX");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("console auto-fix skips lint validation when lint is not configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-console-autofix-no-lint-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const file = "src/a.ts";
      writeFileSync(join(root, file), [
        "export function run() {",
        "  console.log('debug')",
        "  return 1",
        "}",
      ].join("\n"), "utf8");

      const result = await applyAutoFixTasks([{
        id: "FIX-CONSOLE",
        fix_type: "AUTO_FIX",
        fix_rule: "debug-console-log",
        scope: { targets: [{ file }] },
        fix_findings: [{ scanner_id: "debug-console-log", file, line: 2, match: "console.log('debug')" }],
      }], root, {
        execFileSync: () => "",
        config: { build: { type_check: "node --version" } },
      });

      assert.equal(result.success, true);
      assert.equal(result.stats.fixed, 1);
      assert.deepEqual(result.modifiedFiles, [file]);
      assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /console\.log/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("diff quality gate", () => {
  test("allows small mechanical diffs", () => {
    const root = makeGitRepo();
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/a.test.ts"), "const x = value as unknown as Foo\n", "utf8");
      commitAll(root);
      writeFileSync(join(root, "src/a.test.ts"), "const x = value as Foo\n", "utf8");

      const result = validateDiffQuality(r6Task, { cwd: root });
      assert.equal(result.status, "pass");
      assert.equal(result.blocks_execution, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks oversized provider rewrites for mechanical single-line fixes", () => {
    const root = makeGitRepo();
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/a.test.ts"), "const x = value as unknown as Foo\n", "utf8");
      commitAll(root);
      writeFileSync(join(root, "src/a.test.ts"), Array.from({ length: 30 }, (_, i) => `const x${i} = ${i}`).join("\n"), "utf8");

      const result = validateDiffQuality(r6Task, { cwd: root });
      assert.equal(result.status, "fail");
      assert.equal(result.failures[0].code, "DIFF_TOO_LARGE_FOR_MECHANICAL_FIX");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when git is unavailable (P7.H3)", () => {
    const result = validateDiffQuality(r6Task, { cwd: "/definitely/missing/path" });
    assert.notEqual(result.status, "pass");
    assert.equal(result.blocks_execution, true);
    assert.equal(result.failures[0].code, "DIFF_QUALITY_GIT_UNAVAILABLE");
  });
});
