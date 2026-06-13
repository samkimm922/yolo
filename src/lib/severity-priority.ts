// Single source of truth for review/scanner severity → PRD priority mapping.
// Used by both lib/scanner-to-task.ts and review/findings-to-tasks.ts so the
// two review-fix pipelines cannot drift apart.
//
// CRITICAL findings are P0 (ship blockers, must fix before release).
// HIGH     findings are P1 (release-blocker gaps).
// MEDIUM   findings are P2 (advisory but tracked).
// LOW/unknown findings are P3 (advisory cleanup, does not block ship).

const SEVERITY_TO_PRIORITY = {
  CRITICAL: "P0",
  HIGH: "P1",
  MEDIUM: "P2",
  LOW: "P3",
};

export function severityToPriority(severity) {
  const normalized = String(severity || "").trim().toUpperCase();
  return SEVERITY_TO_PRIORITY[normalized] || "P3";
}

export const SEVERITY_PRIORITY_ENTRIES = Object.freeze({ ...SEVERITY_TO_PRIORITY });
