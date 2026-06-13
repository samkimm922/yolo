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
  inspectReviewScannerCoverage,
  normalizeAutoFixResult,
  parseReviewFindings,
  scannerFailureDiagnostic,
  shouldStopReviewAfterFailure,
} from "./execution-helpers.js";
import {
  appendReviewTasksToPrd,
  buildReviewTaskLimitBlock,
  hasReviewFixFailures,
  markReviewOutcome,
  markReviewTaskLimitBlocked,
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

function reviewScannerArtifactState(scanResult) {
  let parsed;
  try {
    parsed = JSON.parse(scanResult);
  } catch {
    return { ok: true };
  }
  if (Array.isArray(parsed)) return { ok: true };
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.findings)) return { ok: true };
  return {
    ok: false,
    detail: "scanner JSON missing findings array",
  };
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
} = Object()) {
  if (!execFileSync) throw new Error("runReviewLoop requires execFileSync");
  if (typeof loadPRD !== "function") throw new Error("runReviewLoop requires loadPRD");

  let reviewFailCount = 0;
  let prevPendingCount;
  let reviewCompleted = false;
  let reviewOutcomeRecorded = false;
  let pendingReviewFailureOutcome = null;
  const loadLatestPrd = () => {
    try {
      return prdPath ? loadPRD(prdPath) : prd;
    } catch {
      return prd;
    }
  };
  const reviewLogMeta = (extra = Object()) => ({ run_id: runId, ...extra });
  const recordReviewOutcome = (outcome) => {
    reviewOutcomeRecorded = true;
    markReviewOutcome({ taskResults, appendUnique, ...outcome });
  };

  for (let round = 1; round <= maxReviewRounds; round++) {
    try {
      prd = loadLatestPrd();
      if (shouldSkipReviewForPrdByPolicy(prd)) {
        logProgress("REVIEW", "SKIP", "当前 PRD 为 dry-run/report_only，禁止 review 自动追加任务污染 PRD");
        reviewCompleted = true;
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
        const diagnostic = scannerFailureDiagnostic(e);
        logProgress("REVIEW", "", `Scanner 执行失败: ${diagnostic.message}`);
        logReviewError("Scanner 执行失败", diagnostic.detail, reviewLogMeta({ round }));
        reviewFailCount++;
        pendingReviewFailureOutcome = {
          id: "REVIEW-SCANNER-EXEC-FAILED",
          status: "failed",
          reason: "scanner_exec_failed",
          message: diagnostic.message,
          meta: {
            round,
            failures: reviewFailCount,
            phase: "REVIEW_SCANNER_EXEC_FAILED",
            stdout_sample: diagnostic.stdout_sample,
            stderr_sample: diagnostic.stderr_sample,
          },
        };
        if (shouldStopReviewAfterFailure(reviewFailCount)) {
          logProgress("REVIEW", "", "连续失败 3 次，退出 review");
          recordReviewOutcome(pendingReviewFailureOutcome);
          break;
        }
        continue;
      }

      const artifactState = reviewScannerArtifactState(scanResult);
      if (!artifactState.ok) {
        logProgress("REVIEW", "", "Scanner 缺少 review artifact，跳过本轮");
        logReviewError("Scanner 缺少 review artifact", artifactState.detail, reviewLogMeta({ round }));
        reviewFailCount++;
        pendingReviewFailureOutcome = {
          id: "REVIEW-SCANNER-MISSING-ARTIFACT",
          status: "failed",
          reason: "scanner_missing_review_artifact",
          message: artifactState.detail,
          meta: { round, failures: reviewFailCount, phase: "REVIEW_SCANNER_MISSING_ARTIFACT" },
        };
        if (shouldStopReviewAfterFailure(reviewFailCount)) {
          logProgress("REVIEW", "", "连续失败 3 次，退出 review");
          recordReviewOutcome(pendingReviewFailureOutcome);
          break;
        }
        continue;
      }

      let findings;
      try {
        findings = parseReviewFindings(scanResult);
      } catch {
        logProgress("REVIEW", "", "Scanner 返回值非 JSON，跳过本轮");
        logReviewError("Scanner 返回值非 JSON", String(scanResult || "").slice(0, 300), reviewLogMeta({ round }));
        reviewFailCount++;
        pendingReviewFailureOutcome = {
          id: "REVIEW-SCANNER-NON-JSON",
          status: "failed",
          reason: "scanner_non_json",
          message: "Scanner 返回值非 JSON",
          meta: {
            round,
            failures: reviewFailCount,
            phase: "REVIEW_SCANNER_NON_JSON",
            sample: String(scanResult || "").slice(0, 300),
          },
        };
        if (shouldStopReviewAfterFailure(reviewFailCount)) {
          logProgress("REVIEW", "", "连续失败 3 次，退出 review");
          recordReviewOutcome(pendingReviewFailureOutcome);
          break;
        }
        continue;
      }
      reviewFailCount = 0;
      pendingReviewFailureOutcome = null;

      const coverageState = inspectReviewScannerCoverage(scanResult, findings);
      if (!findings.length && coverageState.blocks_execution) {
        logProgress("REVIEW", "BLOCKED", coverageState.message);
        logReviewError("Scanner coverage 不完整", coverageState.message, reviewLogMeta({
          round,
          phase: coverageState.reason === "scanner_coverage_incomplete"
            ? "REVIEW_SCANNER_COVERAGE_INCOMPLETE"
            : "REVIEW_SCANNER_COVERAGE_MISSING",
          blockers: coverageState.blockers,
        }));
        recordReviewOutcome({
          id: coverageState.reason === "scanner_coverage_incomplete"
            ? "REVIEW-SCANNER-COVERAGE-INCOMPLETE"
            : "REVIEW-SCANNER-COVERAGE-MISSING",
          status: "blocked",
          reason: coverageState.reason,
          message: coverageState.message,
          meta: {
            round,
            phase: coverageState.reason === "scanner_coverage_incomplete"
              ? "REVIEW_SCANNER_COVERAGE_INCOMPLETE"
              : "REVIEW_SCANNER_COVERAGE_MISSING",
            missing_fields: coverageState.missing_fields || [],
            blockers: coverageState.blockers,
          },
        });
        break;
      }

      if (!findings.length) {
        logProgress("REVIEW", "", "无新发现，review 完成");
        logReviewDone("pass", 0, 0, reviewLogMeta({ round, status: "clean", coverage: coverageState.coverage }));
        reviewCompleted = true;
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
      const contractFindings = contractReviewFindings(findings);
      try {
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
        if (contractFindings.length > 0) {
          const targets = [...new Set(contractFindings.flatMap((finding) =>
            (finding.files || [finding.file]).filter(Boolean).map((file) => String(file).replace(/:\d+$/, "")),
          ))].map((file) => ({ file }));
          reviewToPrdTasks = [{
            id: `FIX-R${round}-CONVERSION-FAILED`,
            title: "[review] Preserve blocking findings after conversion failure",
            type: "bugfix",
            priority: "P1",
            status: "pending",
            depends_on: [],
            scope: { targets },
            pre_conditions: [],
            post_conditions: [],
            acceptance_criteria: [
              "Resolve or manually convert the preserved review findings before ship.",
              "Attach evidence that the original findings were handled.",
            ],
            description: [
              `reviewFindingsToPrdTasks failed: ${e.message}`,
              ...contractFindings.map((finding) => `- [${finding.severity || "MEDIUM"}] ${finding.finding_id || finding.id || finding.code || "review-finding"} ${finding.message || finding.description || ""}`),
            ].join("\n"),
            source_findings: contractFindings,
            blocks_ship: true,
            review_conversion_failed: {
              message: e.message,
              preserved_finding_count: contractFindings.length,
            },
          }];
          logReviewError("review finding 转换失败", e.message, reviewLogMeta({
            round,
            phase: "REVIEW_FINDING_CONVERSION_FAILED",
            preserved_finding_count: contractFindings.length,
            generated_task_id: reviewToPrdTasks[0].id,
          }));
        }
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
        reviewCompleted = true;
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
        markReviewTaskLimitBlocked({ taskResults, taskLimitBlock, appendUnique });
        recordReviewOutcome({
          id: taskLimitBlock.blockerId,
          status: "blocked",
          reason: taskLimitBlock.reason,
          message: taskLimitBlock.message,
          humanNeeded: taskLimitBlock.human_needed,
          meta: taskLimitBlock.meta,
        });
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
            recordReviewOutcome({
              id: "REVIEW-FIX-BLOCKED",
              status: "blocked",
              reason: "review_fix_blocked",
              message: failureDetail,
              meta: { round, phase: "REVIEW_FIX_BLOCKED" },
            });
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
        recordReviewOutcome({
          id: "REVIEW-FIX-STALLED",
          status: "blocked",
          reason: "review_fix_stalled",
          message: pendingDecision.message,
          meta: {
            round,
            phase: "REVIEW_FIX_STALLED",
            pending_review_tasks: pendingReviewTasks.map((task) => task.id),
          },
        });
        break;
      }
      prevPendingCount = pendingDecision.nextPendingCount;
    } catch (reviewErr) {
      reviewFailCount++;
      logProgress("REVIEW", "", `Round ${round} 异常 (${reviewFailCount}/3): ${reviewErr.message}`);
      logReviewError("Review Round 异常", reviewErr.message, reviewLogMeta({ round }));
      if (shouldStopReviewAfterFailure(reviewFailCount)) {
        logProgress("REVIEW", "", "连续失败 3 次，跳过 review");
        recordReviewOutcome({
          id: "REVIEW-ROUND-FAILED",
          status: "failed",
          reason: "review_round_failed",
          message: reviewErr.message,
          meta: { round, failures: reviewFailCount, phase: "REVIEW_ROUND_FAILED" },
        });
        break;
      }
      progress.done = taskResults.completed.length;
      progress.failed = taskResults.failed.length;
    }
  }

  if (!reviewOutcomeRecorded && !reviewCompleted && pendingReviewFailureOutcome) {
    recordReviewOutcome({
      ...pendingReviewFailureOutcome,
      meta: {
        ...pendingReviewFailureOutcome.meta,
        max_review_rounds: maxReviewRounds,
        exhausted_review_rounds: true,
      },
    });
  }

  return taskResults;
}
