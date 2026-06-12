import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectSessionPreGateChecks } from "../src/runtime/execution/session-pre-gates.js";

type SessionPreGateResult = Awaited<ReturnType<typeof inspectSessionPreGateChecks>>;

const baseTask = { id: "FIX-PREGATE", scope: { targets: [{ file: "src/a.ts" }] } };
const baseWt = { path: "/tmp/wt", branch: "yolo/FIX-PREGATE" };

function recorder() {
  return {
    cleanup: [],
    transitions: [],
    progress: [],
    errors: [],
    bash: [],
    done: [],
  };
}

function baseOptions(logs, overrides = {}) {
  return {
    task: baseTask,
    attempt: 1,
    wt: baseWt,
    startedAtMs: 100,
    providerRun: { provider: "codex", success: true, stdout: "ok" },
    providerName: "codex",
    validateDiffQualityGate: () => ({ blocks_execution: false, failures: [] }),
    validateTestGeneration: async () => ({ blocks_execution: false, failures: [] }),
    cleanupWorktree: (...args) => logs.cleanup.push(args),
    recordTaskTransition: (transition) => logs.transitions.push(transition),
    logProgress: (...entry) => logs.progress.push(entry),
    logTaskError: (...entry) => logs.errors.push(entry),
    logTaskBash: (...entry) => logs.bash.push(entry),
    logTaskDone: (...entry) => logs.done.push(entry),
    nowMs: () => 160,
    ...overrides,
  };
}

describe("session pre-gate checks", () => {
  test("provider failures cleanup and retry while recording the failed attempt", async () => {
    const logs = recorder();
    const result = await inspectSessionPreGateChecks(baseOptions(logs, {
      providerRun: { success: false, stdout: "", stderr: "provider failed", exitCode: 1 },
      maxRetryForProvider: 2,
    }));

    assert.equal(result.action, "retry");
    assert.match(result.retryMessage, /codex 失败, 重试 1\/2/);
    assert.deepEqual(logs.cleanup, [["/tmp/wt", "yolo/FIX-PREGATE", false]]);
    assert.equal(logs.transitions[0].task_id, "FIX-PREGATE");
    assert.equal(logs.transitions[0].prd_update.phase, "claude");
    assert.deepEqual(logs.done[0], ["FIX-PREGATE", "failed", 60, "codex 退出失败: exit=1 stderr=provider failed"]);
  });

  test("provider terminal budget failures return blocked result", async () => {
    const logs = recorder();
    const result = await inspectSessionPreGateChecks(baseOptions(logs, {
      providerRun: {
        success: false,
        stdout: "",
        stderr: "Exceeded USD budget for this session",
        exitCode: 1,
      },
    }));

    assert.deepEqual(result, { action: "return", result: { status: "blocked", reason: "provider_budget_exceeded" } });
    assert.equal(logs.transitions[0].prd_update.phase, "provider_budget");
  });

  test("provider preflight blockers are not retried as ordinary provider failures", async () => {
    const logs = recorder();
    const result = await inspectSessionPreGateChecks(baseOptions(logs, {
      providerRun: {
        success: false,
        blocked: true,
        reason: "claude_settings_missing",
        stdout: "",
        stderr: "Claude settings file not found: /repo/missing-settings.json",
        exitCode: null,
      },
      providerName: "claude",
      maxRetryForProvider: 3,
    }));

    assert.deepEqual(result, { action: "return", result: { status: "blocked", reason: "claude_settings_missing" } });
    assert.equal(logs.progress.some((entry) => String(entry[2] || "").includes("重试")), false);
    assert.equal(logs.transitions[0].prd_update.phase, "provider_preflight");
  });

  test("diff quality failures update retry context before retrying", async () => {
    const logs = recorder();
    const result = await inspectSessionPreGateChecks(baseOptions(logs, {
      validateDiffQualityGate: () => ({
        blocks_execution: true,
        recovery_hint: "keep diff small",
        failures: [{ code: "DIFF_TOO_LARGE", detail: "too many files" }],
      }),
      maxRetryForDiffQuality: 2,
    }));

    assert.equal(result.action, "retry");
    assert.match((result as SessionPreGateResult & { lastGateError: string }).lastGateError, /diff-quality-gate blocked: DIFF_TOO_LARGE/);
    assert.deepEqual((result as SessionPreGateResult & { historyEntry: unknown }).historyEntry, {
      gate: 1,
      fingerprint: "diff-quality:DIFF_TOO_LARGE",
      message: "diff-quality-gate blocked: DIFF_TOO_LARGE",
    });
    assert.deepEqual(logs.cleanup, [["/tmp/wt", "yolo/FIX-PREGATE", false]]);
    assert.equal(logs.transitions.length, 0);
  });

  test("diff quality exhaustion records transition and returns failure", async () => {
    const logs = recorder();
    const result = await inspectSessionPreGateChecks(baseOptions(logs, {
      attempt: 3,
      validateDiffQualityGate: () => ({
        blocks_execution: true,
        failures: [{ code: "DIFF_TOO_LARGE", detail: "too many files" }],
      }),
      maxRetryForDiffQuality: 2,
    }));

    assert.equal(result.action, "return");
    assert.deepEqual(result.result, { status: "failed", reason: "diff-quality-gate blocked: DIFF_TOO_LARGE" });
    assert.equal(logs.transitions[0].prd_update.phase, "diff_quality");
    assert.deepEqual(logs.done[0], ["FIX-PREGATE", "failed", 60, "diff-quality-gate blocked: DIFF_TOO_LARGE"]);
  });

  test("test generation blockers cleanup and return failure", async () => {
    const logs = recorder();
    const result = await inspectSessionPreGateChecks(baseOptions(logs, {
      validateTestGeneration: async () => ({
        blocks_execution: true,
        failures: [{ code: "NEW_TEST_FORBIDDEN" }],
      }),
    }));

    assert.equal(result.action, "return");
    assert.deepEqual(result.result, { status: "failed", reason: "test-generation-validator blocked: NEW_TEST_FORBIDDEN" });
    assert.equal(logs.transitions[0].prd_update.phase, "test_generation");
    assert.deepEqual(logs.cleanup, [["/tmp/wt", "yolo/FIX-PREGATE", false]]);
  });

  test("passes through when provider, diff quality, and test generation all pass", async () => {
    const logs = recorder();
    const result = await inspectSessionPreGateChecks(baseOptions(logs));

    assert.deepEqual(result, { action: "continue" });
    assert.equal(logs.cleanup.length, 0);
    assert.equal(logs.transitions.length, 0);
    assert.deepEqual(logs.bash.map((entry) => entry[1]), ["diff-quality-gate", "test-generation-validator"]);
  });
});
