// scanner-to-task.js - canonical adapter for review scanner findings.
// The task shape is owned by review/findings-to-tasks.ts so review-loop,
// review-fix, and acceptance use one contract.

import { reviewFindingsToPrdTasks } from "../review/findings-to-tasks.js";
import type { ReviewPrdTask } from "../review/findings-to-tasks.js";
import type { ReviewFindingInput } from "../review/findings.js";

interface ScannerToTasksResult {
  autoFixTasks: ReviewPrdTask[];
  claudeFixTasks: ReviewPrdTask[];
  infoCount: number;
}

/**
 * @param findings - review-scanner.js findings
 * @param [round=1] - review round
 * @returns {{ autoFixTasks: Array, claudeFixTasks: Array, infoCount: number }}
 */
export function scannerToTasks(
  findings: ReviewFindingInput[] = [],
  round = 1,
): ScannerToTasksResult {
  const infoCount = findings.filter((finding) => finding?.fix_type === "INFO").length;
  const converted = reviewFindingsToPrdTasks(findings, { round });
  const autoFixTasks: ReviewPrdTask[] = [];
  const claudeFixTasks: ReviewPrdTask[] = [];

  for (const task of converted.tasks) {
    if (task.fix_type === "AUTO_FIX") {
      autoFixTasks.push(task);
    } else {
      claudeFixTasks.push(task);
    }
  }

  return {
    autoFixTasks,
    claudeFixTasks,
    infoCount,
  };
}
