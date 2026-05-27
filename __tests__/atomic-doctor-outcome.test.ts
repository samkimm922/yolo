import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  atomicDoctorFailureDetail,
  atomicDoctorFailureReason,
  buildAtomicDoctorBlockOutcome,
} from "../src/runtime/execution/atomic-doctor-outcome.js";

describe("atomic doctor outcome helpers", () => {
  test("atomicDoctorFailureReason and detail preserve must_split messages", () => {
    const doctor = {
      mode: "must_split",
      score: 84,
      evidence_file: "state/evidence/FIX-1/investigation.json",
    };

    assert.equal(atomicDoctorFailureReason(doctor), "atomic_task_must_split");
    assert.equal(
      atomicDoctorFailureDetail(doctor),
      "atomic_task_must_split: score=84, evidence=state/evidence/FIX-1/investigation.json",
    );
  });

  test("buildAtomicDoctorBlockOutcome skips PRD block update when split was applied", () => {
    const outcome = buildAtomicDoctorBlockOutcome({
      task: { id: "FIX-1" },
      doctor: {
        mode: "must_split",
        score: 84,
        evidence_file: "state/evidence/FIX-1/investigation.json",
        split_suggestions: [{ id: "FIX-1A" }],
      },
      splitResult: { applied: true, childIds: ["FIX-1A"] },
      now: "2026-05-24T00:00:00.000Z",
    });

    assert.equal(outcome.failReason, "atomic_task_must_split: score=84, evidence=state/evidence/FIX-1/investigation.json");
    assert.equal(outcome.logMarker, "BLOCKED");
    assert.deepEqual(outcome.taskResult, {
      id: "FIX-1",
      status: "BLOCKED",
      reason: "atomic_task_must_split",
      mode: "must_split",
      score: 84,
      evidence_file: "state/evidence/FIX-1/investigation.json",
      split_suggestions: [{ id: "FIX-1A" }],
      split_applied: true,
      split_into: ["FIX-1A"],
      skip_kind: "blocked_skip_missing_evidence",
      counts_as_completed: false,
      timestamp: "2026-05-24T00:00:00.000Z",
    });
    assert.equal(outcome.prdUpdate, null);
    assert.deepEqual(outcome.result, {
      status: "blocked",
      reason: "atomic_task_must_split",
      split_into: ["FIX-1A"],
    });
  });

  test("buildAtomicDoctorBlockOutcome blocks PRD when split was not applied", () => {
    const outcome = buildAtomicDoctorBlockOutcome({
      task: { id: "FIX-2" },
      doctor: {
        mode: "must_split",
        score: 92,
        evidence_file: "state/evidence/FIX-2/investigation.json",
        split_suggestions: [{ id: "FIX-2A" }],
        next_action: "split",
      },
      splitResult: { applied: false, childIds: [] },
      now: "2026-05-24T00:00:00.000Z",
    });

    assert.equal(outcome.prdUpdate.status, "blocked");
    assert.equal(outcome.prdUpdate.phase, "atomic_task_doctor");
    assert.equal(outcome.prdUpdate.phaseDetail, "atomic_task_must_split: score=92, evidence=state/evidence/FIX-2/investigation.json");
    assert.deepEqual(outcome.prdUpdate.blocked_by, ["state/evidence/FIX-2/investigation.json"]);
    assert.deepEqual(outcome.prdUpdate.atomic_task_doctor, {
      mode: "must_split",
      score: 92,
      evidence_file: "state/evidence/FIX-2/investigation.json",
      next_action: "split",
    });
  });

  test("buildAtomicDoctorBlockOutcome handles doctor execution failures", () => {
    const outcome = buildAtomicDoctorBlockOutcome({
      task: { id: "FIX-3" },
      doctor: {
        mode: "error",
        error: "doctor crashed",
      },
      splitResult: { applied: false, childIds: [] },
      now: "2026-05-24T00:00:00.000Z",
    });

    assert.equal(atomicDoctorFailureReason(outcome.taskResult), "atomic_task_doctor_failed");
    assert.equal(outcome.failReason, "atomic_task_doctor_failed: doctor crashed");
    assert.equal(outcome.taskResult.reason, "atomic_task_doctor_failed");
    assert.deepEqual(outcome.prdUpdate.blocked_by, ["atomic-task-doctor"]);
    assert.deepEqual(outcome.result, {
      status: "blocked",
      reason: "atomic_task_doctor_failed",
      split_into: [],
    });
  });
});
