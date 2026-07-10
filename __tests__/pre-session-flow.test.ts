import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handlePreSessionFlow } from "../src/runtime/execution/pre-session-flow.js";

const task = { id: "FIX-PRE", type: "bugfix", scope: { targets: [{ file: "src/a.ts" }] } };

function logs() {
  return {
    bash: [],
    progress: [],
    done: [],
    transitions: [],
    taskResults: [],
    prdUpdates: [],
    splits: [],
  };
}

function baseOptions(record, overrides = {}) {
  return {
    task,
    prdPath: "prd.json",
    attempt: 0,
    taskRoute: { route: "provider" },
    config: { runner: {}, build: { type_check: "npm run typecheck" } },
    yoloRoot: "/tmp/yolo",
    projectRoot: "/repo",
    execNode: () => ({ ok: true, stdout: "" }),
    execSync: () => "",
    loadPRD: () => ({ tasks: [task] }),
    shouldRunPrecheck: () => false,
    skippedTaskPostconditionsPass: () => ({ passed: true, failed: [] }),
    taskPostconditionsPass: () => ({ passed: true, failed: [] }),
    commitTask: async () => ({ committed: true }),
    recordTaskTransition: (transition) => record.transitions.push(transition),
    writeTaskResult: (result) => record.taskResults.push(result),
    updatePrdTaskStatus: (taskId, update) => record.prdUpdates.push([taskId, update]),
    applySplitSuggestionsToPrd: (...args) => {
      record.splits.push(args);
      return { applied: true, childIds: ["FIX-PRE-A"] };
    },
    isBusinessFile: () => true,
    logProgress: (...entry) => record.progress.push(entry),
    logTaskBash: (...entry) => record.bash.push(entry),
    logTaskDone: (...entry) => record.done.push(entry),
    nowMs: () => 100,
    engineBlockBuilder: () => ({ shouldBlock: false }),
    atomicDoctorGate: () => ({ ok: true }),
    ...overrides,
  };
}

describe("pre-session flow", () => {
  test("valid precheck skip records a verified skip transition", async () => {
    const record = logs();
    const calls = [];
    const result = await handlePreSessionFlow(baseOptions(record, {
      shouldRunPrecheck: () => true,
      execNode: (script, args) => {
        calls.push({ script, args });
        return { ok: false, stdout: "PRE-CHECK SKIP: already fixed", stderr: "" };
      },
    }));

    assert.equal(result.action, "return");
    assert.equal(calls[0].script, "src/runtime/execution/precheck.js");
    assert.deepEqual(calls[0].args, ["--task=FIX-PRE", "--prd=prd.json", "--cwd=/repo"]);
    assert.equal(result.result.status, "skipped");
    assert.equal(result.result.skip_kind, "valid_skip_already_satisfied");
    assert.equal(record.transitions[0].result.status, "SKIP");
    assert.match(record.progress[0][2], /post_conditions 已满足/);
  });

  test("engine self-modification blocker returns before provider work", async () => {
    const record = logs();
    const result = await handlePreSessionFlow(baseOptions(record, {
      engineBlockBuilder: () => ({
        shouldBlock: true,
        logMessage: "engine file blocked",
        transition: { task_id: "FIX-PRE", result: { status: "BLOCKED" } },
        doneStatus: "blocked",
        doneReason: "engine_self_modify_blocked",
        result: { status: "blocked", reason: "engine_self_modify_blocked" },
      }),
    }));

    assert.deepEqual(result, { action: "return", result: { status: "blocked", reason: "engine_self_modify_blocked" } });
    assert.deepEqual(record.transitions[0], { task_id: "FIX-PRE", result: { status: "BLOCKED" } });
    assert.deepEqual(record.done[0], ["FIX-PRE", "blocked", 0, "engine_self_modify_blocked"]);
  });

  test("deterministic dry-run artifacts delegate to the dry-run producer", async () => {
    const record = logs();
    const dryRunTask = { ...task, task_kind: "dry_run_artifact" };
    const result = await handlePreSessionFlow(baseOptions(record, {
      task: dryRunTask,
      dryRunTaskCompleter: (options) => {
        assert.equal(options.startedAtMs, 100);
        assert.equal(options.task.task_kind, "dry_run_artifact");
        return { status: "completed", reason: "dry_run_artifact" };
      },
    }));

    assert.deepEqual(result, { action: "return", result: { status: "completed", reason: "dry_run_artifact" } });
  });

  test("deterministic check tasks run postconditions without provider", async () => {
    const record = logs();
    const checkTask = { ...task, id: "CHECK-PRE", task_kind: "deterministic_check" };
    const result = await handlePreSessionFlow(baseOptions(record, {
      task: checkTask,
      taskRoute: { route: "deterministic_check" },
      loadPRD: () => ({ tasks: [checkTask] }),
      taskPostconditionsPass: (receivedTask, _prd, root) => {
        assert.equal(receivedTask.id, "CHECK-PRE");
        assert.equal(root, "/repo");
        return { passed: true, failed: [] };
      },
    }));

    assert.deepEqual(result, { action: "return", result: { status: "completed", deterministic_check: true } });
    assert.equal(record.transitions[0].result.status, "PASS");
    assert.equal(record.transitions[0].result.deterministic_check, true);
    assert.deepEqual(record.done[0], ["CHECK-PRE", "completed", 100, "deterministic_check"]);
  });

  test("legacy auto-fix routes cannot bypass atomic doctor or provider execution", async () => {
    const record = logs();
    let doctorRuns = 0;
    const result = await handlePreSessionFlow(baseOptions(record, {
      taskRoute: { route: "auto_fix" },
      deterministicAutoFix: async () => {
        throw new Error("deterministic auto-fix must not run");
      },
      atomicDoctorGate: () => {
        doctorRuns++;
        return { ok: true };
      },
    }));

    assert.deepEqual(result, { action: "continue" });
    assert.equal(doctorRuns, 1);
  });

  test("atomic doctor blockers apply split suggestions and write task state", async () => {
    const record = logs();
    const result = await handlePreSessionFlow(baseOptions(record, {
      atomicDoctorGate: () => ({ ok: false, result: { mode: "must_split", status: "fail" } }),
      atomicDoctorBlockBuilder: ({ splitResult }) => ({
        logMarker: "!!",
        failReason: "atomic task must split",
        taskResult: { id: "FIX-PRE", status: "BLOCKED" },
        prdUpdate: { status: "blocked", phase: "atomic_task_doctor" },
        doneStatus: "blocked",
        doneReason: "atomic_task_must_split",
        result: { status: "blocked", reason: "atomic_task_must_split", splitResult },
      }),
    }));

    assert.equal(result.action, "return");
    assert.equal(result.result.reason, "atomic_task_must_split");
    assert.equal(record.splits.length, 1);
    assert.deepEqual(record.taskResults[0], { id: "FIX-PRE", status: "BLOCKED" });
    assert.deepEqual(record.prdUpdates[0], ["FIX-PRE", { status: "blocked", phase: "atomic_task_doctor" }]);
  });

  test("post-precheck can return a valid skip on retry attempts", async () => {
    const record = logs();
    const result = await handlePreSessionFlow(baseOptions(record, {
      attempt: 2,
      postPrecheckInspector: () => ({
        logMessage: "postconditions already satisfied",
        shouldSkip: true,
        transition: { task_id: "FIX-PRE", result: { status: "SKIP" } },
        result: { status: "skipped", reason: "valid_skip_already_satisfied" },
      }),
    }));

    assert.deepEqual(result, { action: "return", result: { status: "skipped", reason: "valid_skip_already_satisfied" } });
    assert.deepEqual(record.transitions[0], { task_id: "FIX-PRE", result: { status: "SKIP" } });
    assert.deepEqual(record.progress[0], ["FIX-PRE", "--", "postconditions already satisfied"]);
  });

  test("continues when no pre-session guard blocks execution", async () => {
    const record = logs();
    const result = await handlePreSessionFlow(baseOptions(record));

    assert.deepEqual(result, { action: "continue" });
    assert.equal(record.transitions.length, 0);
    assert.equal(record.taskResults.length, 0);
  });
});
