import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { handleGateFailureFlow } from "../src/runtime/execution/gate-failure-flow.js";

// B3: drives the REAL buildGateFailureRetryDecision (no stub) by controlling
// history / attempt / maxRetryForGate / failures. The summarizeFailures and
// applyLearningEffects stubs only fix the historyEntry fingerprint fed into
// nextHistory, so we can deterministically trigger each decision branch.

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

describe("gate failure flow (real buildGateFailureRetryDecision)", () => {
  test("non-repeated history within retry budget retries and discards worktree", () => {
    const record = logs();
    // attempt=2 <= maxRetryForGate=3, history fingerprint differs from new entry → retry
    const result = handleGateFailureFlow(baseOptions(record));

    assert.equal(result.action, "retry");
    assert.equal(result.lastGateError, "eslint failed");
    assert.equal(result.remediation.action, "RETRY_WITH_CONTEXT");
    assert.equal(result.remediation.automation_can_continue, true);
    assert.deepEqual(result.history.at(-1), historyEntry);
    // Real retry message is built from attempt/maxRetry, not faked:
    assert.ok(
      record.progress.some((entry) => entry[0] === task.id && entry[2] === "exit=1, 重试 2/3"),
      "retry message must reflect real attempt/maxRetry",
    );
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

  test("non-repeated history over retry budget returns terminal max_retry result", () => {
    const record = logs();
    // attempt=2 > maxRetryForGate=1, history still non-repeated → max_retry
    const result = handleGateFailureFlow(baseOptions(record, { maxRetryForGate: 1 }));
    const reason = "闸门 exit 1, 重试 2 次仍失败";

    assert.equal(result.action, "return");
    assert.equal(result.result.status, "failed");
    assert.equal(result.result.reason, reason);
    assert.equal(result.result.remediation.action, "REROUTE_REVIEW_FIX");
    assert.deepEqual(record.errors[0], ["FIX-FAIL", reason, "eslint failed"]);
    assert.equal(record.transitions[0].task_id, "FIX-FAIL");
    assert.equal(record.transitions[0].result.remediation.action, "REROUTE_REVIEW_FIX");
    assert.deepEqual(record.done[0], ["FIX-FAIL", "failed", 75, reason]);
    assert.deepEqual(record.cleanup, [["/tmp/wt", "yolo/FIX-FAIL", false]]);
  });

  test("repeated non-contract failures return stuck result and record learning", () => {
    const record = logs();
    // history tail matches new entry fingerprint → hasRepeatedGateFailure=true,
    // eslint failure is not a contract condition → stuck
    const result = handleGateFailureFlow(baseOptions(record, {
      history: [{ gate: 1, fingerprint: "eslint:unused", message: "previous" }],
    }));

    assert.equal(result.action, "return");
    assert.equal(result.result.status, "stuck");
    assert.equal(result.result.reason, "连续同因");
    assert.equal(result.result.remediation.action, "REROUTE_REVIEW_FIX");
    assert.deepEqual(
      record.progress.find((entry) => entry[1] === "!! 停机"),
      ["FIX-FAIL", "!! 停机", "连续 2 次同 gate code 失败"],
    );
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

  test("repeated contract-condition failures block the task as contract_suspect", () => {
    const record = logs();
    // repeated history + a contract-condition failure (code_contains) → contract_suspect
    const result = handleGateFailureFlow(baseOptions(record, {
      history: [{ gate: 1, fingerprint: "eslint:unused", message: "previous" }],
      analyzeOutput: () => [{ type: "code_contains", detail: "missing", code: "code_contains" }],
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
