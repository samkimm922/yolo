export function atomicDoctorFailureReason(doctor = {}) {
  return doctor.mode === "must_split" ? "atomic_task_must_split" : "atomic_task_doctor_failed";
}

export function atomicDoctorFailureDetail(doctor = {}) {
  if (doctor.mode === "must_split") {
    return `atomic_task_must_split: score=${doctor.score}, evidence=${doctor.evidence_file}`;
  }
  return `atomic_task_doctor_failed: ${doctor.error || doctor.next_action || "unknown"}`;
}

export function buildAtomicDoctorBlockOutcome({
  task = {},
  doctor = {},
  splitResult = { applied: false, childIds: [] },
  now = new Date().toISOString(),
} = {}) {
  const reason = atomicDoctorFailureReason(doctor);
  const failReason = atomicDoctorFailureDetail(doctor);
  const childIds = splitResult.childIds || [];
  const shouldUpdatePrd = doctor.mode !== "must_split" || !splitResult.applied;
  return {
    failReason,
    logMarker: "BLOCKED",
    taskResult: {
      id: task.id,
      status: "BLOCKED",
      reason,
      mode: doctor.mode,
      score: doctor.score,
      evidence_file: doctor.evidence_file,
      split_suggestions: doctor.split_suggestions || [],
      split_applied: splitResult.applied,
      split_into: childIds,
      skip_kind: "blocked_skip_missing_evidence",
      counts_as_completed: false,
      timestamp: now,
    },
    prdUpdate: shouldUpdatePrd ? {
      status: "blocked",
      phase: "atomic_task_doctor",
      phaseDetail: failReason,
      failReason,
      blocked_by: doctor.evidence_file ? [doctor.evidence_file] : ["atomic-task-doctor"],
      split_suggestions: doctor.split_suggestions || [],
      skip_kind: "blocked_skip_missing_evidence",
      counts_as_completed: false,
      atomic_task_doctor: {
        mode: doctor.mode,
        score: doctor.score,
        evidence_file: doctor.evidence_file,
        next_action: doctor.next_action,
      },
    } : null,
    doneStatus: "blocked",
    doneReason: failReason,
    result: {
      status: "blocked",
      reason,
      split_into: childIds,
    },
  };
}
