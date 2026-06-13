import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { validateDiffQuality } from "../src/runtime/gates/diff-quality-gate.js";

// B5: behavioral negative cases for the mechanical-fix diff quality gate.
// Uses a real throwaway git repo so numstat/untracked probes exercise the
// real code paths that decide NEW_FILES_FOR_MECHANICAL_FIX and
// TOO_MANY_FILES_FOR_MECHANICAL_FIX.

function makeGitRepo() {
  const root = mkdtempSync(join(tmpdir(), "yolo-diff-quality-"));
  execSync("git init -q", { cwd: root });
  execSync("git config user.email t@t.test", { cwd: root });
  execSync("git config user.name test", { cwd: root });
  return root;
}

// task shape that classifies as single_line_mechanical (R6 single target),
// so the gate actually runs instead of skipping.
const mechanicalTask = {
  source_findings: [{ scanner_id: "R6-as-unknown-as", file: "src/a.ts" }],
  scope: { targets: [{ file: "src/a.ts" }] },
};

describe("diff quality gate (single_line_mechanical)", () => {
  test("untracked new files under a scoped target are blocked", () => {
    const root = makeGitRepo();
    try {
      execSync("git commit --allow-empty -q -m base", { cwd: root });
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
      const result = validateDiffQuality(mechanicalTask, { cwd: root });
      assert.equal(result.status, "fail");
      assert.equal(result.blocks_execution, true);
      assert.ok(
        result.failures.some((failure) => failure.code === "NEW_FILES_FOR_MECHANICAL_FIX"),
        "expected NEW_FILES_FOR_MECHANICAL_FIX failure",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("changed files exceeding the max_files budget are blocked", () => {
    const root = makeGitRepo();
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
      execSync("git add src/a.ts && git commit -q -m base", { cwd: root });
      // modify the tracked target so it shows up in changed/numstat
      writeFileSync(join(root, "src/a.ts"), "export const a = 2;\n");
      const result = validateDiffQuality(
        { ...mechanicalTask, quality_budget: { max_files: 0 } },
        { cwd: root },
      );
      assert.equal(result.status, "fail");
      assert.equal(result.blocks_execution, true);
      assert.ok(
        result.failures.some((failure) => failure.code === "TOO_MANY_FILES_FOR_MECHANICAL_FIX"),
        "expected TOO_MANY_FILES_FOR_MECHANICAL_FIX failure",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
