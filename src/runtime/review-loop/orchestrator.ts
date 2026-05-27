import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildReviewPreCompletedSet,
  contractReviewFindings,
  ensureReviewTaskShape,
  fallbackClassifyFindings,
  mergeClaudeReviewTasks,
  mergeReviewResults,
  pendingReviewTasks as findPendingReviewTasks,
  reviewClassifierMeta,
  reviewIssueLogInput,
  reviewScopeFilesForPrd as reviewScopeFilesForPrdFromPolicy,
  shouldSkipReviewForPrd as shouldSkipReviewForPrdByPolicy,
} from "./round-helpers.js";
import {
  autoFixErrorFallback,
  buildReviewScannerArgs,
  normalizeAutoFixResult,
  parseReviewFindings,
  scannerStdoutFromError,
  shouldStopReviewAfterFailure,
} from "./execution-helpers.js";
import {
  appendReviewTasksToPrd,
  buildReviewTaskLimitBlock,
  hasReviewFixFailures,
  pendingReviewDecision,
  reviewFixFailureDetail,
  reviewTaskIdSet,
  shouldBlockReviewTaskLimit,
} from "./task-application.js";

function noop() {}

function appendUniqueDefault(target, items = []) {
  const seen = new Set(target);
  for (const item of items) {
    if (!seen.has(item)) {
      target.push(item);
      seen.add(item);
    }
  }
}

async function importFromRoot(rootDir, relativePath) {
  return import(pathToFileURL(join(rootDir, relativePath)).href);
}

export async function runReviewLoop({
  prd,
  prdPath,
  taskResults,
  resumeCompleted = new Set(),
  runId,
  yoloRoot,
  rootDir,
  progress,
  mainLoop,
  loadPRD,
  appendUnique = appendUniqueDefault,
  normalizeRepoPath = (value) => value,
  maxReviewRounds = 5,
  maxReviewTasksPerRound = 5,
  execFileSync,
  processExecPath = process.execPath,
  logProgress = noop,
  logReviewStart = noop,
  logReviewGate = noop,
  logReviewIssue = noop,
  logReviewDone = noop,
  logReviewError = noop,
} = {}) {
  if (!execFileSync) throw new Error("runReviewLoop requires execFileSync");
  if (typeof loadPRD !== "function") throw new Error("runReviewLoop requires loadPRD");

  let reviewFailCount = 0;
  let prevPendingCount;
  const loadLatestPrd = () => {
    try {
      return prdPath ? loadPRD(prdPath) : prd;
    } catch {
      return prd;
    }
  };
  const reviewLogMeta = (extra = {}) => ({ run_id: runId, ...extra });

  for (let round = 1; round <= maxReviewRounds; round++) {
    try {
      prd = loadLatestPrd();
      if (shouldSkipReviewForPrdByPolicy(prd)) {
        logProgress("REVIEW", "SKIP", "当前 PRD 为 dry-run/report_only，禁止 review 自动追加任务污染 PRD");
        break;
      }
      logProgress("REVIEW", `Round ${round}/${maxReviewRounds}`, "扫描代码问题...");
      const reviewScopeFiles = reviewScopeFilesForPrdFromPolicy(prd, { normalizeRepoPath });
      logReviewStart(
        { round, files: reviewScopeFiles.length > 0 ? reviewScopeFiles : ["<prd-scope>"] },
        reviewScopeFiles.length,
        reviewLogMeta({ round }),
      );
      if (reviewScopeFiles.length > 0) {
        logProgress("REVIEW", "SCOPE", `仅扫描当前 PRD scope: ${reviewScopeFiles.join(", ")}`);
      }

      let scanResult;
      try {
        const scanArgs = buildReviewScannerArgs({ yoloRoot, rootDir, reviewScopeFiles });
        scanResult = execFileSync(
          processExecPath,
          scanArgs,
          { cwd: rootDir, timeout: 120000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
        );
      } catch (e) {
        const stdout = scannerStdoutFromError(e);
        if (stdout) {
          scanResult = stdout;
        } else {
          logProgress("REVIEW", "", `Scanner 执行失败: ${e.message}`);
          logReviewError("Scanner 执行失败", e.message, reviewLogMeta({ round }));
          reviewFailCount++;
          if (shouldStopReviewAfterFailure(reviewFailCount)) {
            logProgress("REVIEW", "", "连续失败 3 次，退出 review");
            break;
          }
          continue;
        }
      }

      let findings;
      try {
        findings = parseReviewFindings(scanResult);
      } catch {
        logProgress("REVIEW", "", "Scanner 返回值非 JSON，跳过本轮");
        logReviewError("Scanner 返回值非 JSON", String(scanResult || "").slice(0, 300), reviewLogMeta({ round }));
        reviewFailCount++;
        if (shouldStopReviewAfterFailure(reviewFailCount)) {
          logProgress("REVIEW", "", "连续失败 3 次，退出 review");
          break;
        }
        continue;
      }

      if (!findings.length) {
        logProgress("REVIEW", "", "无新发现，review 完成");
        logReviewDone("pass", 0, 0, reviewLogMeta({ round, status: "clean" }));
        break;
      }

      logProgress("REVIEW", "", `Scanner 发现 ${findings.length} 条`);
      logReviewGate("review-scanner", "pass", reviewLogMeta({ round, total_findings: findings.length }));

      let classified;
      try {
        const { scannerToTasks } = await importFromRoot(yoloRoot, "lib/scanner-to-task.js");
        classified = scannerToTasks(findings, round);
      } catch (e) {
        logProgress("REVIEW", "", `scanner-to-task 不可用 (${e.message})，全部转为 CLAUDE_FIX`);
        classified = fallbackClassifyFindings(findings, round);
      }

      const { autoFixTasks, claudeFixTasks, infoCount } = classified;
      let reviewToPrdTasks = [];
      try {
        const contractFindings = contractReviewFindings(findings);
        if (contractFindings.length > 0) {
          const { reviewFindingsToPrdTasks } = await importFromRoot(yoloRoot, "src/review/findings-to-tasks.js");
          const converted = reviewFindingsToPrdTasks(contractFindings, {
            round,
            existingTasks: [...(prd.tasks || []), ...autoFixTasks, ...claudeFixTasks],
          });
          reviewToPrdTasks = converted.tasks || [];
          if (converted.blocks_ship) {
            logProgress("REVIEW", "review-to-prd", `生成 ${reviewToPrdTasks.length} 个阻断 ship 的 review_fix task`);
          }
        }
      } catch (e) {
        logProgress("REVIEW", "review-to-prd", `转换失败: ${e.message}`);
      }

      logProgress("REVIEW", "", `${autoFixTasks.length} AUTO_FIX, ${claudeFixTasks.length + reviewToPrdTasks.length} CLAUDE_FIX, ${infoCount} INFO`);
      logReviewGate("review-classifier", "pass", reviewLogMeta(
        reviewClassifierMeta({ round, findings, autoFixTasks, claudeFixTasks, reviewToPrdTasks, infoCount }),
      ));
      for (const finding of findings) {
        const issue = reviewIssueLogInput(finding);
        logReviewIssue(
          issue.severity,
          issue.file,
          issue.line,
          issue.message,
          reviewLogMeta({
            round,
            fix_type: issue.fix_type,
            finding_id: issue.finding_id,
            rule_id: issue.rule_id,
            status: "found",
          }),
        );
      }

      let escalatedFromAuto = [];
      let autoFixedCount = 0;
      if (autoFixTasks.length > 0) {
        logProgress("REVIEW", "", `执行 ${autoFixTasks.length} 个 AUTO_FIX 任务...`);
        try {
          const { applyAutoFixTasks } = await importFromRoot(yoloRoot, "lib/auto-fix.js");
          const autoResult = await applyAutoFixTasks(autoFixTasks, rootDir, {
            logP: (id, phase, detail) => logProgress(id || "AUTO-FIX", phase, detail),
            prdPath,
          });
          const normalized = normalizeAutoFixResult(autoResult);
          escalatedFromAuto = normalized.escalatedFromAuto;
          autoFixedCount = normalized.autoFixedCount;
          logProgress("REVIEW", "", normalized.summary);
          logReviewGate("AUTO_FIX", "pass", reviewLogMeta({
            round,
            ...normalized.gateMeta,
          }));
        } catch (e) {
          logProgress("REVIEW", "", `auto-fix 模块异常: ${e.message}，全部升级为 CLAUDE_FIX`);
          logReviewError("AUTO_FIX 异常", e.message, reviewLogMeta({ round, phase: "AUTO_FIX_ERROR" }));
          ({ escalatedFromAuto, autoFixedCount } = autoFixErrorFallback(autoFixTasks));
        }
      }

      const allClaudeTasks = mergeClaudeReviewTasks({ claudeFixTasks, reviewToPrdTasks, escalatedFromAuto });

      if (allClaudeTasks.length === 0) {
        if (autoFixedCount > 0) {
          logProgress("REVIEW", "", "AUTO_FIX 已处理，继续下一轮 review 扫描");
          logReviewDone("auto_fix_applied", findings.length, autoFixedCount, reviewLogMeta({ round, status: "auto_fix_applied" }));
          continue;
        }
        logProgress("REVIEW", "", "无 CLAUDE_FIX 任务且无 AUTO_FIX 改动，review 完成");
        logReviewDone("pass", findings.length, 0, reviewLogMeta({ round, status: "clean" }));
        break;
      }

      if (shouldBlockReviewTaskLimit(allClaudeTasks.length, maxReviewTasksPerRound)) {
        const taskLimitBlock = buildReviewTaskLimitBlock({
          round,
          taskCount: allClaudeTasks.length,
          maxTasks: maxReviewTasksPerRound,
          taskIds: allClaudeTasks.map((task) => task.id),
        });
        logProgress("REVIEW", "BLOCKED", taskLimitBlock.message);
        logReviewError(taskLimitBlock.errorTitle, taskLimitBlock.errorDetail, reviewLogMeta(taskLimitBlock.meta));
        appendUnique(taskResults.failed, [taskLimitBlock.blockerId]);
        break;
      }

      logProgress("REVIEW", "", `处理 ${allClaudeTasks.length} 个 CLAUDE_FIX 任务...`);

      prd = loadLatestPrd();
      const addedReviewTasks = appendReviewTasksToPrd({
        prd,
        progress,
        tasks: allClaudeTasks,
        ensureTaskShape: ensureReviewTaskShape,
      });
      for (const task of addedReviewTasks) {
        logProgress(task.id, "ADDED", `${task.priority} ${task.title}`);
      }

      writeFileSync(prdPath, JSON.stringify(prd, null, 2), "utf8");

      const reviewTaskIds = reviewTaskIdSet(allClaudeTasks);
      if (typeof mainLoop === "function" && taskResults) {
        logProgress("REVIEW", "", "执行 CLAUDE_FIX 任务...");
        try {
          const preCompleted = buildReviewPreCompletedSet({
            resumeCompleted,
            completed: taskResults.completed,
            skipped: taskResults.skipped,
          });
          const reviewResults = await mainLoop(prdPath, preCompleted);
          mergeReviewResults({ taskResults, reviewResults });
          if (hasReviewFixFailures(reviewResults)) {
            const failureDetail = reviewFixFailureDetail(reviewResults);
            logProgress("REVIEW", "BLOCKED", `review fix 未全部完成: ${failureDetail}`);
            logReviewError("review fix 未全部完成", failureDetail, reviewLogMeta({ round }));
            break;
          }
        } catch (loopErr) {
          logProgress("REVIEW", "", `mainLoop 异常: ${loopErr.message}`);
          logReviewError("review mainLoop 异常", loopErr.message, reviewLogMeta({ round }));
          appendUnique(taskResults.failed, [...reviewTaskIds]);
        }
      }

      const latestPrdAfterReview = loadPRD(prdPath);
      const pendingReviewTasks = findPendingReviewTasks(latestPrdAfterReview);

      if (pendingReviewTasks.length > 0) {
        appendUnique(taskResults.failed, pendingReviewTasks.map((task) => task.id));
      }

      const pendingDecision = pendingReviewDecision({
        pendingReviewTasks,
        prevPendingCount,
        round,
      });

      if (pendingDecision.action === "continue") {
        logProgress("REVIEW", "", pendingDecision.message);
        logReviewDone("round_done", findings.length, autoFixedCount, reviewLogMeta({ round, status: "round_done" }));
        continue;
      }

      if (pendingDecision.action === "break") {
        logProgress("REVIEW", "", pendingDecision.message);
        break;
      }
      prevPendingCount = pendingDecision.nextPendingCount;
    } catch (reviewErr) {
      reviewFailCount++;
      logProgress("REVIEW", "", `Round ${round} 异常 (${reviewFailCount}/3): ${reviewErr.message}`);
      logReviewError("Review Round 异常", reviewErr.message, reviewLogMeta({ round }));
      if (shouldStopReviewAfterFailure(reviewFailCount)) {
        logProgress("REVIEW", "", "连续失败 3 次，跳过 review");
        break;
      }
      progress.done = taskResults.completed.length;
      progress.failed = taskResults.failed.length;
    }
  }

  return taskResults;
}
