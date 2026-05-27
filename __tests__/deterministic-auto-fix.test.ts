import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeterministicAutoFixResultRecord,
  normalizeAutoFixTask,
  tryDeterministicAutoFixTask,
} from "../src/runtime/execution/deterministic-auto-fix.js";

const baseTask = {
  id: "AUTO-1",
  fix_rule: "debug-console-log",
  scope: { targets: [{ file: "src/a.ts" }, { file: "src/b.ts" }] },
  source_findings: [{ rule_id: "debug-console-log", line: 3 }],
};

describe("deterministic auto-fix execution helpers", () => {
  test("normalizeAutoFixTask preserves AUTO_FIX shape and fills missing finding file/rule", () => {
    const normalized = normalizeAutoFixTask(baseTask);
    assert.equal(normalized.fix_type, "AUTO_FIX");
    assert.equal(normalized.fix_rule, "debug-console-log");
    assert.deepEqual(normalized.fix_findings, [{
      rule_id: "debug-console-log",
      line: 3,
      file: "src/a.ts",
      scanner_id: "debug-console-log",
    }]);
  });

  test("buildDeterministicAutoFixResultRecord preserves runner result counters", () => {
    const record = buildDeterministicAutoFixResultRecord({
      task: baseTask,
      modifiedFiles: ["src/a.ts", "README.md"],
      startedAtMs: 1000,
      nowMs: 3500,
      isBusinessFile: (file) => file.startsWith("src/"),
    });
    assert.deepEqual(record, {
      deterministic_auto_fix: true,
      duration_sec: "2.5",
      files_changed_total: 2,
      files_changed_business: 1,
      files_changed_metadata: 1,
      scope_targets_touched: ["src/a.ts"],
      scope_targets_missed: ["src/b.ts"],
      out_of_scope_files: [],
    });
  });

  test("tryDeterministicAutoFixTask returns null and logs fallback when auto-fix makes no changes", async () => {
    const bash = [];
    const progress = [];
    const result = await tryDeterministicAutoFixTask({
      task: baseTask,
      prdPath: "prd.json",
      projectRoot: "/repo",
      applyAutoFixTasks: async () => ({ success: false, modifiedFiles: [], escalatedTasks: [{ id: "x" }], stats: { escalated: 1 } }),
      logTaskBash: (...args) => bash.push(args),
      logProgress: (...args) => progress.push(args),
    });
    assert.equal(result, null);
    assert.equal(bash[0][2], "fail");
    assert.deepEqual(progress[0], ["AUTO-1", "auto", "deterministic auto-fix 未完成，回退 provider: escalated=1"]);
  });

  test("tryDeterministicAutoFixTask fails closed when postconditions fail", async () => {
    const transitions = [];
    const result = await tryDeterministicAutoFixTask({
      task: baseTask,
      prdPath: "prd.json",
      startedAtMs: Date.now(),
      projectRoot: "/repo",
      applyAutoFixTasks: async () => ({ success: true, modifiedFiles: ["src/a.ts"], escalatedTasks: [], stats: {} }),
      loadPRD: () => ({ tasks: [baseTask] }),
      taskPostconditionsPass: () => ({ passed: false, failed: ["code_contains: missing"] }),
      recordTaskTransition: (prdPath, transition) => transitions.push({ prdPath, transition }),
    });
    assert.deepEqual(result, { status: "failed", reason: "deterministic auto-fix postconditions failed: code_contains: missing" });
    assert.equal(transitions[0].transition.result.status, "FAIL");
    assert.equal(transitions[0].transition.prd_update.phase, "auto_fix");
  });

  test("tryDeterministicAutoFixTask commits successful fixes and records pass transition", async () => {
    const commits = [];
    const transitions = [];
    const done = [];
    const result = await tryDeterministicAutoFixTask({
      task: baseTask,
      prdPath: "prd.json",
      startedAtMs: Date.now(),
      projectRoot: "/repo",
      applyAutoFixTasks: async () => ({ success: true, modifiedFiles: ["src/a.ts"], escalatedTasks: [], stats: {} }),
      loadPRD: () => ({ tasks: [baseTask] }),
      taskPostconditionsPass: () => ({ passed: true, failed: [] }),
      commitTask: async (task, prdPath, modifiedFiles) => {
        commits.push({ task, prdPath, modifiedFiles });
        return { committed: true };
      },
      recordTaskTransition: (prdPath, transition) => transitions.push({ prdPath, transition }),
      logTaskDone: (...args) => done.push(args),
      isBusinessFile: (file) => file.startsWith("src/"),
    });
    assert.deepEqual(result, { status: "completed", deterministic_auto_fix: true });
    assert.deepEqual(commits[0].modifiedFiles, ["src/a.ts"]);
    assert.equal(transitions[0].transition.result.status, "PASS");
    assert.equal(transitions[0].transition.result.deterministic_auto_fix, true);
    assert.equal(transitions[0].transition.prd_update.phaseDetail, "deterministic_auto_fix");
    assert.equal(done[0][1], "completed");
  });
});
