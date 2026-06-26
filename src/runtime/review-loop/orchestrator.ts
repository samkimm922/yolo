import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildReviewPreCompletedSet,
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
import type { NormalizedReviewFinding } from "../../review/findings.js";
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

type Prd = Record<string, unknown>;
type Task = Record<string, unknown>;
type ReviewLoopOutcomeRecord = {
  id?: unknown;
  status?: unknown;
  reason?: unknown;
  message?: unknown;
  human_needed?: unknown;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
};
type TaskResults = {
  completed?: unknown[];
  failed?: unknown[];
  blocked?: unknown[];
  contractReview?: unknown[];
  review_outcome?: ReviewLoopOutcomeRecord;
  review_blocker?: ReviewLoopOutcomeRecord;
  stop_reason?: unknown;
  [key: string]: unknown;
};
type AppendUniqueFn = (target: unknown[], items?: unknown[]) => void;
type LogProgressFn = (id: string, phase: string, detail?: string) => void;
type LogReviewStartFn = (
  meta: { round: number; files: string[] },
  fileCount: number,
  extra: Record<string, unknown>,
) => void;
type LogReviewGateFn = (gate: string, status: string, meta: Record<string, unknown>) => void;
type LogReviewIssueFn = (
  severity: unknown,
  file: unknown,
  line: unknown,
  message: unknown,
  meta: Record<string, unknown>,
) => void;
type LogReviewDoneFn = (status: string, findings: number, fixed: number, meta: Record<string, unknown>) => void;
type LogReviewErrorFn = (title: string, detail: unknown, meta: Record<string, unknown>) => void;

function noop(): void {}

function appendUniqueDefault(target: unknown[], items: unknown[] = []) {
  const seen = new Set(target);
  for (const item of items) {
    if (!seen.has(item)) {
      target.push(item);
      seen.add(item);
    }
  }
}

async function importFromRoot(rootDir: string, relativePath: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(join(rootDir, relativePath)).href);
}

function reviewScannerArtifactState(scanResult: string): { ok: boolean; detail?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(scanResult);
  } catch {
    return { ok: true };
  }
  if (Array.isArray(parsed)) return { ok: true };
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).findings)) {
    return { ok: true };
  }
  return {
    ok: false,
    detail: "scanner JSON missing findings array",
  };
}

function findingFingerprint(finding: Record<string, unknown> = Object()): string {
  return String(
    finding.finding_id ||
    finding.id ||
    [
      finding.scanner_id || finding.rule_id || finding.code || "review",
      finding.file || finding.path || "",
      finding.line || "",
      finding.match || finding.message || finding.description || "",
    ].join("|"),
  );
}

function taskSourceFindingIds(task: Record<string, unknown> = Object()): string[] {
  const sourceFindingIds = Array.isArray(task.source_finding_ids) ? (task.source_finding_ids as unknown[]) : [];
  const sourceFindings = Array.isArray(task.source_findings)
    ? (task.source_findings as Array<Record<string, unknown>>).map((finding) => finding?.finding_id || finding?.id)
    : [];
  const fixFindings = Array.isArray(task.fix_findings)
    ? (task.fix_findings as Array<Record<string, unknown>>).map((finding) => finding?.finding_id || finding?.id)
    : [];
  return [
    ...sourceFindingIds,
    ...sourceFindings,
    ...fixFindings,
  ].filter(Boolean).map(String);
}

function reviewFixTaskCompletedForFinding({
  prd,
  taskResults,
  finding,
}: {
  prd?: Prd | null;
  taskResults?: TaskResults | null;
  finding: Record<string, unknown>;
}): boolean {
  const sourceId = findingFingerprint(finding);
  const completedIds = new Set([
    ...((taskResults?.completed as unknown[]) || []),
    ...((taskResults?.skipped as unknown[]) || []),
  ]);
  const tasks = Array.isArray(prd?.tasks) ? (prd?.tasks as Task[]) : [];
  return tasks.some((task) => {
    if (task?.task_kind !== "review_fix") return false;
    if (!taskSourceFindingIds(task).includes(sourceId)) return false;
    const status = String(task.status || "").toLowerCase();
    return ["completed", "done"].includes(status) || completedIds.has(task.id);
  });
}

type PersistedFindingOutcome = {
  id: string;
  status: "blocked";
  reason: string;
  message: string;
  humanNeeded: boolean;
  meta: Record<string, unknown>;
};

function persistentFindingBlock({
  round,
  findings = [],
  persistence = new Map(),
  prd,
  taskResults,
  maxRounds,
}: {
  round: number;
  findings?: Array<Record<string, unknown>>;
  persistence?: Map<string, { count: number; round?: number }>;
  prd?: Prd | null;
  taskResults?: TaskResults | null;
  maxRounds: number;
}): PersistedFindingOutcome | null {
  const persisted = findings
    .map((finding) => {
      const fingerprint = findingFingerprint(finding);
      const state = persistence.get(fingerprint) || { count: 0 };
      return {
        finding,
        fingerprint,
        count: state.count || 0,
        completed_review_fix: reviewFixTaskCompletedForFinding({ prd, taskResults, finding }),
      };
    })
    .filter((item) => item.count >= maxRounds || (item.count > 1 && item.completed_review_fix));

  if (persisted.length === 0) return null;
  return {
    id: "REVIEW-FINDINGS-PERSISTED",
    status: "blocked",
    reason: "review_findings_persisted",
    message: `Review findings persisted across ${round} round(s); human review is required.`,
    humanNeeded: true,
    meta: {
      round,
      phase: "REVIEW_FINDINGS_PERSISTED",
      max_persistent_finding_rounds: maxRounds,
      persisted_findings: persisted.map((item) => ({
        finding_id: item.finding.finding_id || item.finding.id || null,
        fingerprint: item.fingerprint,
        scanner_id: item.finding.scanner_id || item.finding.rule_id || null,
        file: item.finding.file || null,
        line: item.finding.line || null,
        count: item.count,
        completed_review_fix: item.completed_review_fix,
      })),
      human_needed: true,
    },
  };
}

export async function runReviewLoop({
  prd,
  prdPath,
  taskResults,
  resumeCompleted = new Set<unknown>(),
  runId,
  yoloRoot,
  rootDir,
  progress,
  mainLoop,
  loadPRD,
  appendUnique = appendUniqueDefault,
  normalizeRepoPath = (value: unknown) => value,
  maxReviewRounds = 5,
  maxReviewTasksPerRound = 5,
  maxPersistentFindingRounds = 2,
  execFileSync,
  processExecPath = process.execPath,
  logProgress = noop as LogProgressFn,
  logReviewStart = noop as LogReviewStartFn,
  logReviewGate = noop as LogReviewGateFn,
  logReviewIssue = noop as LogReviewIssueFn,
  logReviewDone = noop as LogReviewDoneFn,
  logReviewError = noop as LogReviewErrorFn,
}: {
  prd?: Prd;
  prdPath: string;
  taskResults: TaskResults;
  resumeCompleted?: Set<unknown> | Iterable<unknown>;
  runId?: string;
  yoloRoot: string;
  rootDir: string;
  progress: { total: number; done?: number; failed?: number };
  mainLoop?: (prdPath: string, preCompleted: Set<unknown>) => Promise<TaskResults>;
  loadPRD?: (prdPath: string) => Prd;
  appendUnique?: AppendUniqueFn;
  normalizeRepoPath?: (value: unknown) => unknown;
  maxReviewRounds?: number;
  maxReviewTasksPerRound?: number;
  maxPersistentFindingRounds?: number;
  execFileSync?: (file: string, args: string[], options: Record<string, unknown>) => string;
  processExecPath?: string;
  logProgress?: LogProgressFn;
  logReviewStart?: LogReviewStartFn;
  logReviewGate?: LogReviewGateFn;
  logReviewIssue?: LogReviewIssueFn;
  logReviewDone?: LogReviewDoneFn;
  logReviewError?: LogReviewErrorFn;
} = Object()): Promise<TaskResults> {
  if (!execFileSync) throw new Error("runReviewLoop requires execFileSync");
  if (typeof loadPRD !== "function") throw new Error("runReviewLoop requires loadPRD");

  let reviewFailCount = 0;
  let prevPendingCount: number | undefined;
  let reviewCompleted = false;
  let reviewOutcomeRecorded = false;
  let pendingReviewFailureOutcome: {
    id: string;
    status: string;
    reason: string;
    message: string;
    meta: Record<string, unknown>;
  } | null = null;
  const findingPersistence = new Map<string, { count: number; round: number }>();
  let lastRoundFindings: NormalizedReviewFinding[] = [];
  const loadLatestPrd = (): Prd => {
    try {
      return prdPath ? loadPRD(prdPath) : (prd as Prd);
    } catch {
      return prd as Prd;
    }
  };
  const reviewLogMeta = (extra: Record<string, unknown> = Object()) => ({ run_id: runId, ...extra });
  const recordReviewOutcome = (outcome: {
    id: string;
    status?: string;
    reason?: string;
    message?: string;
    humanNeeded?: boolean;
    meta?: Record<string, unknown>;
  }) => {
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
      const reviewScopeFiles = reviewScopeFilesForPrdFromPolicy(prd, {
        normalizeRepoPath: (value) => String(normalizeRepoPath(value) ?? ""),
      });
      logReviewStart(
        { round, files: reviewScopeFiles.length > 0 ? reviewScopeFiles : ["<prd-scope>"] },
        reviewScopeFiles.length,
        reviewLogMeta({ round }),
      );
      if (reviewScopeFiles.length > 0) {
        logProgress("REVIEW", "SCOPE", `仅扫描当前 PRD scope: ${reviewScopeFiles.join(", ")}`);
      }

      let scanResult: string;
      try {
        const scanArgs = buildReviewScannerArgs({ yoloRoot, rootDir, reviewScopeFiles });
        scanResult = execFileSync(
          processExecPath,
          scanArgs,
          { cwd: rootDir, timeout: 120000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
        );
      } catch (e) {
        const diagnostic = scannerFailureDiagnostic(e as Record<string, unknown> | null | undefined);
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
          message: artifactState.detail ?? "",
          meta: { round, failures: reviewFailCount, phase: "REVIEW_SCANNER_MISSING_ARTIFACT" },
        };
        if (shouldStopReviewAfterFailure(reviewFailCount)) {
          logProgress("REVIEW", "", "连续失败 3 次，退出 review");
          recordReviewOutcome(pendingReviewFailureOutcome);
          break;
        }
        continue;
      }

      let findings: NormalizedReviewFinding[];
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
      const currentFingerprints = new Set<string>();
      for (const finding of findings) {
        const fingerprint = findingFingerprint(finding as Record<string, unknown>);
        const previous = findingPersistence.get(fingerprint);
        currentFingerprints.add(fingerprint);
        findingPersistence.set(fingerprint, {
          count: previous?.round === round - 1 ? previous.count + 1 : 1,
          round,
        });
      }
      for (const [fingerprint, state] of findingPersistence.entries()) {
        if (state.round !== round && !currentFingerprints.has(fingerprint)) {
          findingPersistence.delete(fingerprint);
        }
      }
      lastRoundFindings = findings;

      const coverageState = inspectReviewScannerCoverage(scanResult, findings, { expectedFiles: reviewScopeFiles });
      if (coverageState.blocks_execution) {
        logProgress("REVIEW", "BLOCKED", coverageState.message ?? "");
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
          reason: coverageState.reason ?? undefined,
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

      const persistedBlock = persistentFindingBlock({
        round,
        findings: findings as Array<Record<string, unknown>>,
        persistence: findingPersistence,
        prd,
        taskResults,
        maxRounds: maxPersistentFindingRounds,
      });
      if (persistedBlock) {
        logProgress("REVIEW", "BLOCKED", persistedBlock.message);
        logReviewError("review finding 持续存在", persistedBlock.message, reviewLogMeta(persistedBlock.meta));
        recordReviewOutcome(persistedBlock);
        break;
      }

      let classified: { autoFixTasks: Array<Record<string, unknown>>; claudeFixTasks: Array<Record<string, unknown>>; infoCount: number };
      try {
        const mod = await importFromRoot(yoloRoot, "src/lib/scanner-to-task.js");
        const scannerToTasks = mod.scannerToTasks as (
          findings: unknown[],
          round?: number,
        ) => { autoFixTasks: Array<Record<string, unknown>>; claudeFixTasks: Array<Record<string, unknown>>; infoCount: number };
        classified = scannerToTasks(findings, round);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logProgress("REVIEW", "", `scanner-to-task 不可用 (${errMsg})，全部转为 CLAUDE_FIX`);
        classified = fallbackClassifyFindings(findings, round) as typeof classified;
      }

      const { autoFixTasks, claudeFixTasks, infoCount } = classified;

      logProgress("REVIEW", "", `${autoFixTasks.length} AUTO_FIX, ${claudeFixTasks.length} CLAUDE_FIX, ${infoCount} INFO`);
      logReviewGate("review-classifier", "pass", reviewLogMeta(
        reviewClassifierMeta({ round, findings, autoFixTasks, claudeFixTasks, infoCount }),
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

      let escalatedFromAuto: Array<Record<string, unknown>> = [];
      let autoFixedCount = 0;
      if (autoFixTasks.length > 0) {
        logProgress("REVIEW", "", `执行 ${autoFixTasks.length} 个 AUTO_FIX 任务...`);
        try {
          const mod = await importFromRoot(yoloRoot, "lib/auto-fix.js");
          const applyAutoFixTasks = mod.applyAutoFixTasks as (
            tasks: Array<Record<string, unknown>>,
            rootDir: string,
            options: Record<string, unknown>,
          ) => Promise<Record<string, unknown>>;
          const autoResult = await applyAutoFixTasks(autoFixTasks, rootDir, {
            logP: (id: string, phase: string, detail?: string) => logProgress(id || "AUTO-FIX", phase, detail),
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
          const errMsg = e instanceof Error ? e.message : String(e);
          logProgress("REVIEW", "", `auto-fix 模块异常: ${errMsg}，全部升级为 CLAUDE_FIX`);
          logReviewError("AUTO_FIX 异常", errMsg, reviewLogMeta({ round, phase: "AUTO_FIX_ERROR" }));
          ({ escalatedFromAuto, autoFixedCount } = autoFixErrorFallback(autoFixTasks));
        }
      }

      const allClaudeTasks = mergeClaudeReviewTasks({ claudeFixTasks, escalatedFromAuto });

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
          taskIds: allClaudeTasks.map((task) => String(task.id ?? "")),
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
        logProgress(String(task.id ?? ""), "ADDED", `${String(task.priority ?? "")} ${String(task.title ?? "")}`);
      }

      writeFileSync(prdPath, JSON.stringify(prd, null, 2), "utf8");

      const reviewTaskIds = reviewTaskIdSet(allClaudeTasks);
      if (typeof mainLoop === "function" && taskResults) {
        logProgress("REVIEW", "", "执行 CLAUDE_FIX 任务...");
        try {
          const preCompleted = buildReviewPreCompletedSet({
            resumeCompleted,
            completed: taskResults.completed as unknown[],
            skipped: taskResults.skipped as unknown[],
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
          const errMsg = loopErr instanceof Error ? loopErr.message : String(loopErr);
          logProgress("REVIEW", "", `mainLoop 异常: ${errMsg}`);
          logReviewError("review mainLoop 异常", errMsg, reviewLogMeta({ round }));
          if (!Array.isArray(taskResults.failed)) taskResults.failed = [];
          appendUnique(taskResults.failed, [...reviewTaskIds]);
        }
      }

      const latestPrdAfterReview = loadPRD(prdPath);
      const pendingReviewTasks = findPendingReviewTasks(latestPrdAfterReview);

      if (pendingReviewTasks.length > 0) {
        if (!Array.isArray(taskResults.failed)) taskResults.failed = [];
        appendUnique(taskResults.failed, pendingReviewTasks.map((task) => task.id));
      }

      const pendingDecision = pendingReviewDecision({
        pendingReviewTasks,
        prevPendingCount,
        round,
      });

      if (pendingDecision.action === "continue") {
        logProgress("REVIEW", "", pendingDecision.message ?? "");
        logReviewDone("round_done", findings.length, autoFixedCount, reviewLogMeta({ round, status: "round_done" }));
        continue;
      }

      if (pendingDecision.action === "break") {
        logProgress("REVIEW", "", pendingDecision.message ?? "");
        recordReviewOutcome({
          id: "REVIEW-FIX-STALLED",
          status: "blocked",
          reason: "review_fix_stalled",
          message: pendingDecision.message ?? undefined,
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
      const errMsg = reviewErr instanceof Error ? reviewErr.message : String(reviewErr);
      logProgress("REVIEW", "", `Round ${round} 异常 (${reviewFailCount}/3): ${errMsg}`);
      logReviewError("Review Round 异常", errMsg, reviewLogMeta({ round }));
      if (shouldStopReviewAfterFailure(reviewFailCount)) {
        logProgress("REVIEW", "", "连续失败 3 次，跳过 review");
        recordReviewOutcome({
          id: "REVIEW-ROUND-FAILED",
          status: "failed",
          reason: "review_round_failed",
          message: errMsg,
          meta: { round, failures: reviewFailCount, phase: "REVIEW_ROUND_FAILED" },
        });
        break;
      }
      const completedLen = Array.isArray(taskResults.completed) ? (taskResults.completed as unknown[]).length : 0;
      const failedLen = Array.isArray(taskResults.failed) ? (taskResults.failed as unknown[]).length : 0;
      if (progress) {
        progress.done = completedLen;
        progress.failed = failedLen;
      }
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
  if (!reviewOutcomeRecorded && !reviewCompleted && lastRoundFindings.length > 0) {
    recordReviewOutcome({
      id: "REVIEW-FINDINGS-PERSISTED",
      status: "blocked",
      reason: "review_findings_persisted",
      message: "Review loop exhausted while findings still existed.",
      humanNeeded: true,
      meta: {
        phase: "REVIEW_FINDINGS_PERSISTED",
        exhausted_review_rounds: true,
        max_review_rounds: maxReviewRounds,
        persisted_findings: lastRoundFindings.map((finding) => ({
          finding_id: finding.finding_id || (finding as Record<string, unknown>).id || null,
          fingerprint: findingFingerprint(finding as Record<string, unknown>),
          scanner_id: finding.scanner_id || finding.rule_id || null,
          file: finding.file || null,
          line: finding.line || null,
        })),
        human_needed: true,
      },
    });
  }

  return taskResults;
}
