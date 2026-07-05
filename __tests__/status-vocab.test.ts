import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCEPTANCE_RUN_PASS_STATUSES,
  EVIDENCE_RUN_REPORT_PASS_STATUSES,
  PARALLEL_WAVE_PASS_STATUSES,
  RELEASE_INCIDENT_PASS_STATUSES,
  RELEASE_RUN_PASS_OUTCOMES,
  RELEASE_RUN_PASS_STATUSES,
  RUNNER_TASK_COMPLETED_STATUSES,
  TASK_RESULT_COMPLETED_STATUSES,
  normalizeStatusToken,
} from "../src/lib/status-vocab.js";

describe("status vocabulary adapters", () => {
  test("central vocab preserves each layer's completion semantics", () => {
    const statuses = ["pass", "passed", "fixed", "closed", "success", "completed", "done", "PASS", " pass "];

    for (const status of statuses) {
      const token = normalizeStatusToken(status);
      assert.equal(RELEASE_INCIDENT_PASS_STATUSES.has(token), ["pass", "passed", "fixed", "closed"].includes(token));
      assert.equal(RELEASE_RUN_PASS_STATUSES.has(token), ["pass", "passed", "success", "completed"].includes(token));
      assert.equal(EVIDENCE_RUN_REPORT_PASS_STATUSES.has(token), ["pass", "success"].includes(token));
      assert.equal(ACCEPTANCE_RUN_PASS_STATUSES.has(token), ["pass", "success"].includes(token));
      assert.equal(PARALLEL_WAVE_PASS_STATUSES.has(token), ["pass", "passed", "success", "completed", "done"].includes(token));
      assert.equal(RUNNER_TASK_COMPLETED_STATUSES.has(token), ["done", "completed", "merged_into"].includes(token));
    }
  });

  test("task-result bucket vocab keeps uppercase runtime statuses explicit", () => {
    assert.deepEqual([...TASK_RESULT_COMPLETED_STATUSES], ["PASS", "COMPLETED", "SUCCEEDED"]);
    assert.deepEqual([...RELEASE_RUN_PASS_OUTCOMES], ["success", "completed"]);
  });
});
