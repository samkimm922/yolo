import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyTaskExecution } from "../src/runtime/task-loop/router.js";
import { validateDiffQuality } from "../src/runtime/gates/diff-quality-gate.js";

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

  test("routes known mechanical recipes through the provider executor", () => {
    const route = classifyTaskExecution({
      id: "AUTO-LOG",
      fix_type: "AUTO_FIX",
      fix_rule: "debug-console-log",
      scope: { targets: [{ file: "src/a.ts" }] },
    });
    assert.equal(route.route, "provider");
    assert.equal(route.provider_required, true);
  });

  test("routes safe R6 test mock casts through the provider executor", () => {
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
    assert.equal(safeRoute.route, "provider");
    assert.equal(safeRoute.provider_required, true);

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
    assert.equal(businessRoute.provider_required, true);
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
