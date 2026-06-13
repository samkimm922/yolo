import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildScopeTargetCoverage,
  buildTaskExecutionBaseRecord,
  parseGitNumstat,
  readWorktreeDiffStats,
} from "../src/runtime/execution/merge-result.js";

describe("worktree merge result helpers", () => {
  test("parseGitNumstat sums tracked text changes and ignores binary counters", () => {
    assert.deepEqual(parseGitNumstat([
      "3\t1\tsrc/a.ts",
      "-\t-\tpublic/image.png",
      "2\t0\tsrc/b.ts",
    ].join("\n")), {
      added: 5,
      removed: 1,
    });
  });

  test("readWorktreeDiffStats combines committed and uncommitted worktree diffs", () => {
    const execFileSync = (_command, args) => {
      if (args.includes("HEAD")) return "1\t2\tsrc/a.ts\n";
      return "3\t4\tsrc/b.ts\n";
    };

    assert.deepEqual(readWorktreeDiffStats({
      wtPath: "/wt/FIX-1",
      baseRef: "abc123",
      execFileSync,
    }), {
      added: 4,
      removed: 6,
    });
  });

  test("readWorktreeDiffStats marks unknown (not zero) when git diff fails (P7.M1)", () => {
    const execFileSync = () => { throw new Error("git failed: not a worktree"); };
    const stats = readWorktreeDiffStats({
      wtPath: "/wt/missing",
      baseRef: "abc123",
      execFileSync,
    });
    assert.notDeepEqual(stats, { added: 0, removed: 0 });
    assert.equal(stats.added, null);
    assert.equal(stats.removed, null);
    if ("error" in stats) {
      assert.ok(stats.error, "failure must carry an error reason");
    }
  });

  test("buildTaskExecutionBaseRecord records null diff lines on stats failure (P7.M1)", () => {
    const record = buildTaskExecutionBaseRecord({
      taskId: "FIX-1",
      startedAtMs: 1000,
      diffStats: { added: null, removed: null, error: "git diff 统计失败" },
      businessFiles: ["src/a.ts"],
      metadataFiles: [],
      outOfScope: [],
      scopeTargets: ["src/a.ts"],
      now: () => 3500,
      nowIso: () => "2026-05-24T00:00:00.000Z",
    });
    assert.equal(record.diff_lines_added, null);
    assert.equal(record.diff_lines_removed, null);
    assert.ok(record.diff_stats_error);
  });

  test("buildTaskExecutionBaseRecord records real zero diff lines when stats are clean (P7.M1 happy)", () => {
    const record = buildTaskExecutionBaseRecord({
      taskId: "FIX-1",
      startedAtMs: 1000,
      diffStats: { added: 0, removed: 0 },
      businessFiles: ["src/a.ts"],
      metadataFiles: [],
      outOfScope: [],
      scopeTargets: ["src/a.ts"],
      now: () => 3500,
      nowIso: () => "2026-05-24T00:00:00.000Z",
    });
    assert.equal(record.diff_lines_added, 0);
    assert.equal(record.diff_lines_removed, 0);
    assert.equal(record.diff_stats_error, undefined);
  });

  test("buildScopeTargetCoverage handles exact files and directory targets", () => {
    assert.deepEqual(buildScopeTargetCoverage([
      "src/a.ts",
      "src/features/",
      "src/missing.ts",
    ], [
      "src/a.ts",
      "src/features/b.ts",
      "docs/readme.md",
    ]), {
      scope_targets_touched: ["src/a.ts", "src/features/"],
      scope_targets_missed: ["src/missing.ts"],
    });
  });

  test("buildTaskExecutionBaseRecord produces deterministic task evidence fields", () => {
    assert.deepEqual(buildTaskExecutionBaseRecord({
      taskId: "FIX-1",
      startedAtMs: 1000,
      diffStats: { added: 5, removed: 2 },
      businessFiles: ["src/a.ts"],
      metadataFiles: ["docs/a.md"],
      outOfScope: ["src/out.ts"],
      scopeTargets: ["src/a.ts", "src/b.ts"],
      now: () => 3500,
      nowIso: () => "2026-05-24T00:00:00.000Z",
    }), {
      id: "FIX-1",
      timestamp: "2026-05-24T00:00:00.000Z",
      duration_sec: "2.5",
      diff_lines_added: 5,
      diff_lines_removed: 2,
      files_changed_total: 2,
      files_changed_business: 1,
      files_changed_metadata: 1,
      scope_targets_touched: ["src/a.ts"],
      scope_targets_missed: ["src/b.ts"],
      out_of_scope_files: ["src/out.ts"],
    });
  });
});
