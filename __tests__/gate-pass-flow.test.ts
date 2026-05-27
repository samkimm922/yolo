import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleGatePassFlow } from "../src/runtime/execution/gate-pass-flow.js";

const task = { id: "FIX-PASS", scope: { targets: [{ file: "src/a.ts" }] } };
const wt = { path: "/tmp/wt", branch: "yolo/FIX-PASS", base: "base-ref" };

function logs() {
  return {
    events: [],
    progress: [],
    errors: [],
    done: [],
    cleanup: [],
    transitions: [],
  };
}

function baseOptions(record, overrides = {}) {
  return {
    task,
    prdPath: "prd.json",
    wt,
    attempt: 2,
    startedAtMs: 100,
    loadPRD: () => ({ tasks: [task] }),
    taskPostconditionsPass: () => ({ passed: true, failed: [] }),
    cleanupWorktree: (...args) => {
      record.cleanup.push(args);
      return ["src/a.ts"];
    },
    commitTask: async () => ({
      committed: true,
      hasRealCode: true,
      businessFiles: ["src/a.ts"],
      metadataFiles: [],
      outOfScope: [],
    }),
    recordTaskTransition: (transition) => record.transitions.push(transition),
    logEvent: (...entry) => record.events.push(entry),
    logProgress: (...entry) => record.progress.push(entry),
    logTaskError: (...entry) => record.errors.push(entry),
    logTaskDone: (...entry) => record.done.push(entry),
    readDiffStats: () => ({ added: 3, deleted: 1, files: 1 }),
    nowMs: () => 175,
    ...overrides,
  };
}

describe("gate pass flow", () => {
  test("pre-merge postcondition failure cleans worktree and returns failure", async () => {
    const record = logs();
    const result = await handleGatePassFlow(baseOptions(record, {
      taskPostconditionsPass: () => ({
        passed: false,
        failed: ["code_contains: missing text"],
      }),
    }));

    assert.deepEqual(result, {
      action: "return",
      result: {
        status: "failed",
        reason: "post_conditions failed before merge: code_contains: missing text",
      },
    });
    assert.deepEqual(record.cleanup, [["/tmp/wt", "yolo/FIX-PASS", false]]);
    assert.equal(record.transitions[0].prd_update.phase, "postcondition");
    assert.deepEqual(record.done[0], ["FIX-PASS", "failed", 75, result.result.reason]);
  });

  test("commit exceptions return a retry decision after merge cleanup", async () => {
    const record = logs();
    const result = await handleGatePassFlow(baseOptions(record, {
      commitTask: async () => {
        throw new Error("commit exploded");
      },
    }));

    assert.equal(result.action, "retry");
    assert.equal(result.reason, "commit 异常（将重试）: commit exploded");
    assert.deepEqual(record.cleanup, [["/tmp/wt", "yolo/FIX-PASS", true, task.scope, "base-ref"]]);
    assert.deepEqual(record.errors[0], ["FIX-PASS", "commit 异常（将重试）", "Error: commit exploded"]);
    assert.equal(record.transitions.length, 0);
  });

  test("successful committed code records post-commit pass with scope evidence", async () => {
    const record = logs();
    let postChecks = 0;
    const result = await handleGatePassFlow(baseOptions(record, {
      taskPostconditionsPass: () => {
        postChecks++;
        return { passed: true, failed: [] };
      },
    }));

    assert.deepEqual(result, {
      action: "return",
      result: { status: "completed", reason: undefined },
    });
    assert.equal(postChecks, 2);
    assert.equal(record.transitions[0].result.status, "PASS");
    assert.equal(record.transitions[0].result.files_changed_business, 1);
    assert.deepEqual(record.transitions[0].result.scope_targets_touched, ["src/a.ts"]);
    assert.deepEqual(record.done[0], ["FIX-PASS", "completed", 75, undefined]);
  });

  test("metadata-only commit outcomes fail without postcondition recheck", async () => {
    const record = logs();
    let postChecks = 0;
    const result = await handleGatePassFlow(baseOptions(record, {
      taskPostconditionsPass: () => {
        postChecks++;
        return { passed: true, failed: [] };
      },
      commitTask: async () => ({
        committed: false,
        hasRealCode: false,
        businessFiles: [],
        metadataFiles: ["docs/a.md"],
        outOfScope: [],
      }),
    }));

    assert.deepEqual(result, {
      action: "return",
      result: { status: "failed", reason: "0 业务代码" },
    });
    assert.equal(postChecks, 1);
    assert.equal(record.transitions[0].result.status, "FAILED_NO_CODE");
  });

  test("nonblocking commit warnings reuse pre-merge postconditions and complete", async () => {
    const record = logs();
    let postChecks = 0;
    const result = await handleGatePassFlow(baseOptions(record, {
      taskPostconditionsPass: () => {
        postChecks++;
        return { passed: true, failed: [] };
      },
      commitTask: async () => ({
        committed: false,
        hasRealCode: true,
        businessFiles: ["src/a.ts"],
        metadataFiles: [],
        outOfScope: [],
        nonBlocking: true,
        commitWarning: "git_add_failed",
      }),
    }));

    assert.deepEqual(result, {
      action: "return",
      result: { status: "completed", reason: "commit warning: git_add_failed" },
    });
    assert.equal(postChecks, 1);
    assert.equal(record.transitions[0].result.status, "PASS");
    assert.equal(record.transitions[0].result.commit_warning, "git_add_failed");
    assert.deepEqual(record.done[0], ["FIX-PASS", "completed", 75, "commit warning: git_add_failed"]);
  });
});
