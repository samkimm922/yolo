export function atomicDoctorFailureReason(doctor = Object()) {
  if (doctor.mode === "must_split" && !atomicDoctorHasExecutableRemediation(doctor)) return "doctor 无法给出拆分建议";
  return doctor.mode === "must_split" ? "atomic_task_must_split" : "atomic_task_doctor_failed";
}

export function atomicDoctorFailureDetail(doctor = Object()) {
  if (doctor.mode === "must_split" && !atomicDoctorHasExecutableRemediation(doctor)) {
    return "doctor 无法给出拆分建议";
  }
  if (doctor.mode === "must_split") {
    return `atomic_task_must_split: score=${doctor.score}, evidence=${doctor.evidence_file}`;
  }
  return `atomic_task_doctor_failed: ${doctor.error || doctor.next_action || "unknown"}`;
}

export function atomicDoctorHasExecutableRemediation(doctor = Object()) {
  if (doctor.mode !== "must_split") return true;
  return Array.isArray(doctor.split_suggestions) && doctor.split_suggestions.length > 0;
}

export function buildAtomicDoctorBlockOutcome({
  task = Object(),
  doctor = Object(),
  splitResult = { applied: false, childIds: [] },
  now = new Date().toISOString(),
} = Object()) {
  if (doctor.mode === "must_split" && !atomicDoctorHasExecutableRemediation(doctor)) {
    const reason = "doctor 无法给出拆分建议";
    const remediation = { action: "ASK_HUMAN", reason };
    return {
      failReason: reason,
      logMarker: "ASK_HUMAN",
      taskResult: {
        id: task.id,
        status: "ASK_HUMAN",
        reason,
        mode: doctor.mode,
        score: doctor.score,
        evidence_file: doctor.evidence_file,
        split_suggestions: [],
        split_applied: false,
        split_into: [],
        remediation,
        skip_kind: "ask_human_missing_split_suggestions",
        counts_as_completed: false,
        timestamp: now,
      },
      prdUpdate: {
        status: "ask_human",
        phase: "atomic_task_doctor",
        phaseDetail: reason,
        failReason: reason,
        blocked_by: doctor.evidence_file ? [doctor.evidence_file] : ["atomic-task-doctor"],
        split_suggestions: [],
        remediation,
        skip_kind: "ask_human_missing_split_suggestions",
        counts_as_completed: false,
        atomic_task_doctor: {
          mode: doctor.mode,
          score: doctor.score,
          evidence_file: doctor.evidence_file,
          next_action: "ASK_HUMAN",
        },
      },
      doneStatus: "blocked",
      doneReason: reason,
      result: {
        status: "ask_human",
        reason,
        split_into: [],
        remediation,
      },
    };
  }

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
