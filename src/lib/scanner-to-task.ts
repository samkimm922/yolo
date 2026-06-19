// scanner-to-task.js - canonical adapter for review scanner findings.
// The task shape is owned by review/findings-to-tasks.ts so review-loop,
// review-fix, and acceptance use one contract.

import { reviewFindingsToPrdTasks } from "../review/findings-to-tasks.js";

/**
 * @param {Array} findings - review-scanner.js findings
 * @param {number} [round=1] - review round
 * @returns {{ autoFixTasks: Array, claudeFixTasks: Array, infoCount: number }}
 */
export function scannerToTasks(findings = [], round = 1) {
  const infoCount = findings.filter((finding) => finding?.fix_type === "INFO").length;
  const converted = reviewFindingsToPrdTasks(findings, { round });
  const autoFixTasks = [];
  const claudeFixTasks = [];

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
