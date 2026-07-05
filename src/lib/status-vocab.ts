export function normalizeStatusToken(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function statusSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values);
}

export const RELEASE_INCIDENT_PASS_STATUS_VALUES = ["pass", "passed", "fixed", "closed"] as const;
export const RELEASE_RUN_PASS_STATUS_VALUES = ["pass", "passed", "success", "completed"] as const;
export const RELEASE_RUN_PASS_OUTCOME_VALUES = ["success", "completed"] as const;

export const EVIDENCE_RUN_REPORT_PASS_STATUS_VALUES = ["pass", "success"] as const;
export const ACCEPTANCE_RUN_PASS_STATUS_VALUES = ["pass", "success"] as const;
export const PARALLEL_WAVE_PASS_STATUS_VALUES = ["pass", "passed", "success", "completed", "done"] as const;

export const RUNNER_TASK_COMPLETED_STATUS_VALUES = ["done", "completed", "merged_into"] as const;
export const TASK_RESULT_COMPLETED_STATUS_VALUES = ["PASS", "COMPLETED", "SUCCEEDED"] as const;

export const RELEASE_INCIDENT_PASS_STATUSES = statusSet(RELEASE_INCIDENT_PASS_STATUS_VALUES);
export const RELEASE_RUN_PASS_STATUSES = statusSet(RELEASE_RUN_PASS_STATUS_VALUES);
export const RELEASE_RUN_PASS_OUTCOMES = statusSet(RELEASE_RUN_PASS_OUTCOME_VALUES);

export const EVIDENCE_RUN_REPORT_PASS_STATUSES = statusSet(EVIDENCE_RUN_REPORT_PASS_STATUS_VALUES);
export const ACCEPTANCE_RUN_PASS_STATUSES = statusSet(ACCEPTANCE_RUN_PASS_STATUS_VALUES);
export const PARALLEL_WAVE_PASS_STATUSES = statusSet(PARALLEL_WAVE_PASS_STATUS_VALUES);
export const RUN_LIFECYCLE_CLEAN_STATUSES = EVIDENCE_RUN_REPORT_PASS_STATUSES;
export const RUN_LIFECYCLE_CLEAN_FINAL_OUTCOMES = EVIDENCE_RUN_REPORT_PASS_STATUSES;

export const RUNNER_TASK_COMPLETED_STATUSES = statusSet(RUNNER_TASK_COMPLETED_STATUS_VALUES);
export const TASK_RESULT_COMPLETED_STATUSES = statusSet(TASK_RESULT_COMPLETED_STATUS_VALUES);
