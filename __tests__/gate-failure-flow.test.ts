import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleGateFailureFlow } from "../src/runtime/execution/gate-failure-flow.js";

const task = { id: "FIX-FAIL", scope: { targets: [{ file: "src/a.ts" }] } };
const wt = { path: "/tmp/wt", branch: "yolo/FIX-FAIL" };
const gate = { exitCode: 1, stdout: "eslint failed in src/a.ts" };
const historyEntry = { gate: 1, fingerprint: "eslint:unused", message: "eslint failed" };

function logs() {
  return {
    events: [],
    progress: [],
    fixes: [],
    errors: [],
    done: [],
    cleanup: [],
    transitions: [],
    execs: [],
  };
}

function baseOptions(record, overrides = {}) {
  return {
    task,
    prdPath: "prd.json",
    wt,
    gate,
    attempt: 2,
    history: [{ gate: 1, fingerprint: "previous", message: "previous" }],
    maxRetryForGate: 3,
    runtimeDir: "/tmp/runtime",
    yoloRoot: "/tmp/yolo",
    projectRoot: "/repo",
    analyzeFromGateLog: () => null,
    analyzeOutput: () => [{ type: "eslint", detail: "unused", code: "no-unused-vars" }],
    summarizeFailures: () => ({
      failedSummary: "eslint: unused",
      lastGateError: "eslint failed",
      historyEntry,
    }),
    applyLearningEffects: ({ gateFailure, logAnalysis, logFix, execNode }) => {
      logAnalysis("", "├─", "分析: eslint: unused");
      logFix(task.id, "eslint", "unused");
      execNode("learn.js", ["--record", "--message=eslint: unused"]);
      return {
        failedSummary: gateFailure.failedSummary,
        lastGateError: gateFailure.lastGateError,
        historyEntry: gateFailure.historyEntry,
      };
    },
    buildRetryDecision: () => ({
      action: "retry",
      retryMessage: "exit=1, 重试 2/3",
      cleanupMessage: "worktree: 已丢弃失败改动，从干净基线重试",
    }),
    cleanupWorktree: (...args) => record.cleanup.push(args),
    recordTaskTransition: (transition) => record.transitions.push(transition),
    execNode: (...args) => {
      record.execs.push(args);
      return { ok: true };
    },
    logEvent: (...entry) => record.events.push(entry),
    logProgress: (...entry) => record.progress.push(entry),
    logTaskError: (...entry) => record.errors.push(entry),
    logTaskFix: (...entry) => record.fixes.push(entry),
    logTaskDone: (...entry) => record.done.push(entry),
    nowMs: () => 200,
    startedAtMs: 125,
    ...overrides,
  };
}

describe("gate failure flow", () => {
  test("retry decisions preserve updated history and discard worktree", () => {
    const record = logs();
    const result = handleGateFailureFlow(baseOptions(record));

    assert.equal(result.action, "retry");
    assert.equal(result.lastGateError, "eslint failed");
    assert.equal(result.remediation.action, "RETRY_WITH_CONTEXT");
    assert.equal(result.remediation.automation_can_continue, true);
    assert.deepEqual(result.history.at(-1), historyEntry);
    assert.deepEqual(record.cleanup, [["/tmp/wt", "yolo/FIX-FAIL", false]]);
    assert.deepEqual(record.progress.at(-1), ["", "├─", "worktree: 已丢弃失败改动，从干净基线重试"]);
    assert.deepEqual(record.fixes[0], ["FIX-FAIL", "eslint", "unused"]);
    assert.deepEqual(record.events[1], ["gate_remediation", {
      task: "FIX-FAIL",
      action: "RETRY_WITH_CONTEXT",
      status: "remediation_required",
      automation_can_continue: true,
      requires_human: false,
      unsafe_stop: false,
    }]);
  });

  test("max retry decisions record failure and return terminal result", () => {
    const record = logs();
    const result = handleGateFailureFlow(baseOptions(record, {
      buildRetryDecision: () => ({
        action: "max_retry",
        errorTitle: "闸门 exit 1, 重试 2 次仍失败",
        errorDetail: "eslint failed",
        transition: { task_id: "FIX-FAIL", result: { status: "FAIL" }, prd_update: { status: "failed" } },
        doneStatus: "failed",
        doneReason: "闸门 exit 1, 重试 2 次仍失败",
        result: { status: "failed", reason: "闸门 exit 1, 重试 2 次仍失败" },
      }),
    }));

    assert.equal(result.action, "return");
    assert.equal(result.result.status, "failed");
    assert.equal(result.result.reason, "闸门 exit 1, 重试 2 次仍失败");
    assert.equal(result.result.remediation.action, "REROUTE_REVIEW_FIX");
    assert.deepEqual(record.errors[0], ["FIX-FAIL", "闸门 exit 1, 重试 2 次仍失败", "eslint failed"]);
    assert.equal(record.transitions[0].task_id, "FIX-FAIL");
    assert.equal(record.transitions[0].result.remediation.action, "REROUTE_REVIEW_FIX");
    assert.deepEqual(record.done[0], ["FIX-FAIL", "failed", 75, "闸门 exit 1, 重试 2 次仍失败"]);
  });

  test("stuck decisions learn, cleanup, transition, and return stuck result", () => {
    const record = logs();
    const result = handleGateFailureFlow(baseOptions(record, {
      buildRetryDecision: () => ({
        action: "stuck",
        stopLog: { id: "FIX-FAIL", marker: "!! 停机", message: "连续 2 次同 gate code 失败" },
        errorTitle: "连续同因停机",
        errorDetail: "gate exit 1: eslint: unused",
        learnMessage: "连续同因停机: eslint: unused",
        transition: { task_id: "FIX-FAIL", result: { status: "FAIL", reason: "连续同因" } },
        doneStatus: "failed",
        doneReason: "连续同因停机",
        result: { status: "stuck", reason: "连续同因" },
      }),
    }));

    assert.equal(result.action, "return");
    assert.equal(result.result.status, "stuck");
    assert.equal(result.result.reason, "连续同因");
    assert.equal(result.result.remediation.action, "REROUTE_REVIEW_FIX");
    assert.deepEqual(record.progress.find((entry) => entry[1] === "!! 停机"), ["FIX-FAIL", "!! 停机", "连续 2 次同 gate code 失败"]);
    assert.deepEqual(record.execs.at(-1), ["learn.js", [
      "--record",
      "--task=FIX-FAIL",
      "--result=fail",
      "--gate=gate-exit-1",
      "--message=连续同因停机: eslint: unused",
      "--project-root=/repo",
      "--state-root=/tmp/yolo",
    ]]);
    assert.equal(record.transitions[0].result.reason, "连续同因");
    assert.equal(record.transitions[0].result.remediation.action, "REROUTE_REVIEW_FIX");
  });

  test("contract suspect decisions write evidence and block the task", () => {
    const record = logs();
    const result = handleGateFailureFlow(baseOptions(record, {
      buildRetryDecision: () => ({
        action: "contract_suspect",
        stopLog: { id: "FIX-FAIL", marker: "!! 停机", message: "连续 2 次同 gate code 失败" },
        errorTitle: "连续同因停机",
        errorDetail: "gate exit 1: code_contains missing",
        learnMessage: "连续同因停机: code_contains missing",
      }),
      writeSuspectEvidence: (payload, options) => {
        assert.equal(payload.history.at(-1), historyEntry);
        assert.deepEqual(options, { yoloRoot: "/tmp/yolo", projectRoot: "/repo" });
        return { evidence_file: "state/evidence/FIX-FAIL/suspect.json" };
      },
      buildSuspectTransition: ({ task: suspectTask, suspect, failedSummary, attempt }) => ({
        task_id: suspectTask.id,
        result: { status: "BLOCKED", evidence_file: suspect.evidence_file, failedSummary, retries: attempt },
      }),
    }));

    assert.equal(result.action, "return");
    assert.equal(result.result.status, "blocked");
    assert.equal(result.result.reason, "contract_suspect");
    assert.equal(result.result.evidence_file, "state/evidence/FIX-FAIL/suspect.json");
    assert.equal(result.result.remediation.action, "ASK_HUMAN");
    assert.equal(record.transitions[0].result.status, "BLOCKED");
    assert.equal(record.transitions[0].result.remediation.action, "ASK_HUMAN");
    assert.deepEqual(record.done[0], ["FIX-FAIL", "blocked", 75, "contract_suspect"]);
  });
});
