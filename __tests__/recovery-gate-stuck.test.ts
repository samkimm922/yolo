import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContractSuspectTransition,
  buildMaxRetryFailure,
  buildRepeatedGateFailureTransition,
  hasRepeatedGateFailure,
  incrementRetryCountFile,
  summarizeGateFailures,
} from "../src/runtime/recovery/gate-stuck.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "yolo-gate-stuck-"));
}

describe("recovery gate stuck helpers", () => {
  test("summarizeGateFailures builds retry prompt context and history entry", () => {
    const result = summarizeGateFailures({
      gateExitCode: 2,
      gateOutput: "raw gate output that should be included",
      failures: [
        { id: "POST-1", type: "code_contains", severity: "FAIL", detail: "missing target code" },
        { id: "POST-2", type: "tsc", severity: "FAIL", detail: "type mismatch" },
      ],
    });

    assert.equal(result.failedSummary, "code_contains: missing target code | tsc: type mismatch");
    assert.match(result.lastGateError, /以下 gate 检查失败/);
    assert.match(result.lastGateError, /code_contains \[FAIL\]: missing target code/);
    assert.match(result.lastGateError, /raw gate output/);
    assert.deepEqual(result.historyEntry, {
      gate: 2,
      fingerprint: "POST-1:code_contains:missing target code | POST-2:tsc:type mismatch",
      message: "code_contains: missing target code | tsc: type mismatch",
    });
  });

  test("incrementRetryCountFile increments existing task counts defensively", () => {
    const root = tempDir();
    try {
      const filePath = join(root, "retry-count.json");
      assert.deepEqual(incrementRetryCountFile(filePath, "FIX-P36-001"), {
        wrote: true,
        count: 1,
        retryData: { "FIX-P36-001": 1 },
      });
      assert.deepEqual(incrementRetryCountFile(filePath, "FIX-P36-001"), {
        wrote: true,
        count: 2,
        retryData: { "FIX-P36-001": 2 },
      });
      assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), { "FIX-P36-001": 2 });

      writeFileSync(filePath, "{not-json", "utf8");
      assert.equal(incrementRetryCountFile(filePath, "FIX-P36-001").wrote, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hasRepeatedGateFailure detects consecutive same gate and fingerprint only", () => {
    assert.equal(hasRepeatedGateFailure([]), false);
    assert.equal(hasRepeatedGateFailure([
      { gate: 1, fingerprint: "A" },
      { gate: 1, fingerprint: "B" },
    ]), false);
    assert.equal(hasRepeatedGateFailure([
      { gate: 1, fingerprint: "A" },
      { gate: 2, fingerprint: "A" },
    ]), false);
    assert.equal(hasRepeatedGateFailure([
      { gate: 9, fingerprint: "OLD" },
      { gate: 1, fingerprint: "A" },
      { gate: 1, fingerprint: "A" },
    ]), true);
  });

  test("buildContractSuspectTransition creates blocked contract review transition", () => {
    const transition = buildContractSuspectTransition({
      task: { id: "FIX-P36-001" },
      suspect: { evidence_file: "state/evidence/FIX-P36-001/contract-suspect.json" },
      failedSummary: "code_contains: missing target code",
      attempt: 2,
      now: "2026-05-24T15:00:00.000Z",
    });

    assert.deepEqual(transition, {
      task_id: "FIX-P36-001",
      result: {
        id: "FIX-P36-001",
        status: "CONTRACT_SUSPECT",
        reason: "same_contract_condition_failed_repeatedly",
        evidence_file: "state/evidence/FIX-P36-001/contract-suspect.json",
        retries: 2,
        timestamp: "2026-05-24T15:00:00.000Z",
      },
      prd_update: {
        status: "needs_contract_review",
        phase: "contract_review",
        phaseDetail: "same_contract_condition_failed_repeatedly",
        failReason: "contract_suspect: code_contains: missing target code",
        blocked_by: ["state/evidence/FIX-P36-001/contract-suspect.json"],
        counts_as_completed: false,
        updatedAt: "2026-05-24T15:00:00.000Z",
      },
    });
  });

  test("buildRepeatedGateFailureTransition and buildMaxRetryFailure create standard fail transitions", () => {
    assert.deepEqual(buildRepeatedGateFailureTransition({
      taskId: "FIX-P36-001",
      attempt: 2,
      now: "2026-05-24T15:00:00.000Z",
    }), {
      task_id: "FIX-P36-001",
      result: {
        id: "FIX-P36-001",
        retries: 2,
        status: "FAIL",
        reason: "连续同因",
        timestamp: "2026-05-24T15:00:00.000Z",
      },
      prd_update: {
        status: "failed",
        failReason: "连续同因",
      },
    });

    const maxRetry = buildMaxRetryFailure({
      taskId: "FIX-P36-001",
      gateExitCode: 3,
      attempt: 4,
      now: "2026-05-24T15:00:00.000Z",
    });
    assert.equal(maxRetry.reason, "闸门 exit 3, 重试 4 次仍失败");
    assert.equal(maxRetry.transition.result.reason, maxRetry.reason);
    assert.deepEqual(maxRetry.transition.prd_update, {
      status: "failed",
      failReason: maxRetry.reason,
      retry: 4,
    });
  });
});
