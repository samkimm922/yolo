import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerGeneratedArtifactIntegrity } from "../evidence/artifact-integrity.js";
import { resolveLedgerHmacKey } from "../evidence/ledger.js";
import {
  buildReviewPreCompletedSet,
  ensureReviewTaskShape,
  fallbackClassifyFindings,
  mergeReviewResults,
  pendingReviewTasks as findPendingReviewTasks,
  reviewClassifierMeta,
  reviewIssueLogInput,
  reviewScopeFilesForPrd as reviewScopeFilesForPrdFromPolicy,
  shouldSkipReviewForPrd as shouldSkipReviewForPrdByPolicy,
} from "./round-helpers.js";
import {
  buildReviewScannerArgs,
  inspectReviewScannerCoverage,
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
import { resolveExecutorTimeoutMs } from "../../lib/toolchain.js";
import { circuitBreakerThreshold, hasRepeatedFailure } from "../recovery/retry-policy.js";

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
  const candidates = [
    join(rootDir, relativePath),
    join(rootDir, "src", relativePath),
    join(rootDir, "dist", relativePath),
    join(rootDir, "dist", "src", relativePath),
  ];
  const modulePath = candidates.find((candidate) => existsSync(candidate)) || candidates[0];
  return import(pathToFileURL(modulePath).href);
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

function defaultReviewReportPath(prdPath: string): string {
  const normalized = String(prdPath || "").replace(/\\/g, "/");
  return normalized.includes("/.yolo/") ? ".yolo/lifecycle/review-report.json" : "review-report.json";
}

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function findingFingerprint(finding: Record<string, unknown> = Object()): string {
  return [
    cleanString(finding.scanner_id || finding.rule_id || finding.code || finding.finding_id || finding.id || "review"),
    cleanString(finding.file || finding.path || ""),
    cleanString(finding.line || ""),
  ].join("|");
}

function findingSourceId(finding: Record<string, unknown> = Object()): string {
  return cleanString(finding.finding_id || finding.id) || findingFingerprint(finding);
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

type FindingFixHistoryItem = {
  round: number;
  task_type: "EXECUTOR_FIX";
  task_ids: string[];
  review_report_path: string;
  prd_path: string;
};

type FindingPersistenceState = {
  count: number;
  round: number;
  firstRound: number;
  appearances: Array<{ fingerprint: string }>;
  fixHistory: FindingFixHistoryItem[];
  unresolvable?: boolean;
};

type AutoFixUnresolvableFinding = {
  status: "auto_fix_unresolvable";
  action: "ASK_HUMAN";
  reason: "repeated_review_finding";
  finding_id: string | null;
  fingerprint: string;
  scanner_id: unknown;
  file: unknown;
  line: unknown;
  attempts: number;
  threshold: number;
  first_seen_round: number;
  last_seen_round: number;
  fix_history: FindingFixHistoryItem[];
  remediation: {
    action: "ASK_HUMAN";
    reason: "auto_fix_unresolvable";
  };
};

function sameFindingKey(entry: { fingerprint: string }): string {
  return entry.fingerprint;
}

function appendUnresolvableFinding(
  target: AutoFixUnresolvableFinding[],
  item: AutoFixUnresolvableFinding,
): AutoFixUnresolvableFinding[] {
  const index = target.findIndex((existing) => existing.fingerprint === item.fingerprint);
  if (index >= 0) target[index] = item;
  else target.push(item);
  return target;
}

function markAutoFixUnresolvable({
  taskResults,
  items = [],
}: {
  taskResults?: TaskResults | null;
  items?: AutoFixUnresolvableFinding[];
}): void {
  if (!taskResults || items.length === 0) return;
  const existing = Array.isArray(taskResults.review_unresolvable_findings)
    ? taskResults.review_unresolvable_findings as AutoFixUnresolvableFinding[]
    : [];
  const merged = [...existing];
  for (const item of items) appendUnresolvableFinding(merged, item);
  taskResults.review_unresolvable_findings = merged;
  taskResults.review_human_actions = merged.map((item) => ({
    action: item.action,
    finding_id: item.finding_id,
    fingerprint: item.fingerprint,
    reason: item.reason,
    status: item.status,
  }));
}

function unresolvableOutcome(items: AutoFixUnresolvableFinding[], round?: number) {
  return {
    id: "REVIEW-FINDINGS-ASK-HUMAN",
    status: "blocked",
    reason: "auto_fix_unresolvable",
    message: "Review findings repeated after automatic fix attempts; human review is required.",
    humanNeeded: true,
    meta: {
      round,
      phase: "REVIEW_FINDINGS_ASK_HUMAN",
      action: "ASK_HUMAN",
      human_needed: true,
      unresolvable_findings: items,
    },
  };
}

function unresolvableFindingFor({
  finding,
  fingerprint,
  state,
  threshold,
  round,
}: {
  finding: Record<string, unknown>;
  fingerprint: string;
  state: FindingPersistenceState;
  threshold: number;
  round: number;
}): AutoFixUnresolvableFinding {
  const attemptRounds = new Set(state.fixHistory.map((item) => item.round));
  return {
    status: "auto_fix_unresolvable",
    action: "ASK_HUMAN",
    reason: "repeated_review_finding",
    finding_id: cleanString(finding.finding_id || finding.id) || null,
    fingerprint,
    scanner_id: finding.scanner_id || finding.rule_id || null,
    file: finding.file || finding.path || null,
    line: finding.line || null,
    attempts: attemptRounds.size,
    threshold,
    first_seen_round: state.firstRound,
    last_seen_round: round,
    fix_history: state.fixHistory,
    remediation: {
      action: "ASK_HUMAN",
      reason: "auto_fix_unresolvable",
    },
  };
}

function splitAutoFixUnresolvableFindings({
  round,
  findings = [],
  persistence,
  threshold,
}: {
  round: number;
  findings?: NormalizedReviewFinding[];
  persistence: Map<string, FindingPersistenceState>;
  threshold: number;
}): { activeFindings: NormalizedReviewFinding[]; unresolvable: AutoFixUnresolvableFinding[] } {
  const activeFindings: NormalizedReviewFinding[] = [];
  const unresolvable: AutoFixUnresolvableFinding[] = [];

  for (const finding of findings) {
    const fingerprint = findingFingerprint(finding as Record<string, unknown>);
    const state = persistence.get(fingerprint);
    const repeated = state ? hasRepeatedFailure(state.appearances, threshold, sameFindingKey) : false;
    const attemptRounds = state ? new Set(state.fixHistory.map((item) => item.round)).size : 0;
    if (state && attemptRounds >= threshold && repeated) {
      state.unresolvable = true;
      const item = unresolvableFindingFor({
        finding: finding as Record<string, unknown>,
        fingerprint,
        state,
        threshold,
        round,
      });
      Object.assign(finding, {
        auto_fix_unresolvable: true,
        status: item.status,
        resolution: item.status,
        action: item.action,
        remediation: item.remediation,
        fix_history: item.fix_history,
      });
      unresolvable.push(item);
    } else {
      activeFindings.push(finding);
    }
  }

  return {
    activeFindings,
    unresolvable,
  };
}

function recordFixHistoryForTasks({
  findings = [],
  persistence,
  tasks = [],
  round,
  taskType,
  reviewReportPath,
  prdPath,
}: {
  findings?: NormalizedReviewFinding[];
  persistence: Map<string, FindingPersistenceState>;
  tasks?: Array<Record<string, unknown>>;
  round: number;
  taskType: "EXECUTOR_FIX";
  reviewReportPath: string;
  prdPath: string;
}): void {
  if (tasks.length === 0) return;
  const sourceToFingerprint = new Map<string, string>();
  for (const finding of findings) {
    sourceToFingerprint.set(findingSourceId(finding as Record<string, unknown>), findingFingerprint(finding as Record<string, unknown>));
  }

  for (const task of tasks) {
    const taskId = cleanString(task.id);
    if (!taskId) continue;
    for (const sourceId of taskSourceFindingIds(task)) {
      const fingerprint = sourceToFingerprint.get(sourceId) || sourceId;
      const state = persistence.get(fingerprint);
      if (!state) continue;
      const existing = state.fixHistory.find((item) => item.round === round && item.task_type === taskType);
      if (existing) {
        if (!existing.task_ids.includes(taskId)) existing.task_ids.push(taskId);
      } else {
        state.fixHistory.push({
          round,
          task_type: taskType,
          task_ids: [taskId],
          review_report_path: reviewReportPath,
          prd_path: prdPath,
        });
      }
    }
  }
}

export async function runReviewLoop({
  prd,
  prdPath,
  taskResults,
  resumeCompleted = new Set<unknown>(),
  runId,
  yoloRoot,
  rootDir,
  stateRoot,
  progress,
  mainLoop,
  loadPRD,
  appendUnique = appendUniqueDefault,
  normalizeRepoPath = (value: unknown) => value,
  maxReviewRounds = 5,
  maxReviewTasksPerRound = 5,
  maxPersistentFindingRounds,
  config = Object(),
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
  stateRoot?: string;
  progress: { total: number; done?: number; failed?: number };
  mainLoop?: (prdPath: string, preCompleted: Set<unknown>) => Promise<TaskResults>;
  loadPRD?: (prdPath: string) => Prd;
  appendUnique?: AppendUniqueFn;
  normalizeRepoPath?: (value: unknown) => unknown;
  maxReviewRounds?: number;
  maxReviewTasksPerRound?: number;
  maxPersistentFindingRounds?: number;
  config?: Record<string, unknown>;
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
  const findingPersistence = new Map<string, FindingPersistenceState>();
  let lastRoundFindings: NormalizedReviewFinding[] = [];
  const reviewReportPath = defaultReviewReportPath(prdPath);
  const repeatedFindingThreshold = maxPersistentFindingRounds
    ?? circuitBreakerThreshold(config, { warn: () => undefined });
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
          { cwd: rootDir, timeout: resolveExecutorTimeoutMs(config), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
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
        const consecutive = previous?.round === round - 1;
        currentFingerprints.add(fingerprint);
        findingPersistence.set(fingerprint, {
          count: consecutive ? previous.count + 1 : 1,
          round,
          firstRound: consecutive ? previous.firstRound : round,
          appearances: consecutive ? [...previous.appearances, { fingerprint }] : [{ fingerprint }],
          fixHistory: consecutive ? previous.fixHistory : [],
          unresolvable: consecutive ? previous.unresolvable : false,
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

      const { activeFindings, unresolvable } = splitAutoFixUnresolvableFindings({
        round,
        persistence: findingPersistence,
        findings,
        threshold: repeatedFindingThreshold,
      });
      if (unresolvable.length > 0) {
        markAutoFixUnresolvable({ taskResults, items: unresolvable });
        logProgress("REVIEW", "ASK_HUMAN", `${unresolvable.length} 条 finding 已标记 auto_fix_unresolvable`);
        logReviewGate("review-convergence", "ask_human", reviewLogMeta({
          round,
          threshold: repeatedFindingThreshold,
          unresolvable_findings: unresolvable,
        }));
      }

      for (const finding of findings) {
        const issue = reviewIssueLogInput(finding);
        const fingerprint = findingFingerprint(finding as Record<string, unknown>);
        const blocked = unresolvable.some((item) => item.fingerprint === fingerprint);
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
            status: blocked ? "auto_fix_unresolvable" : "found",
            action: blocked ? "ASK_HUMAN" : undefined,
          }),
        );
      }

      if (activeFindings.length === 0) {
        const recorded = Array.isArray(taskResults.review_unresolvable_findings)
          ? taskResults.review_unresolvable_findings as AutoFixUnresolvableFinding[]
          : unresolvable;
        const outcome = unresolvableOutcome(recorded, round);
        logReviewError("review finding 需人工处理", outcome.message, reviewLogMeta(outcome.meta));
        recordReviewOutcome(outcome);
        break;
      }

      let classified: { executorTasks: Array<Record<string, unknown>>; infoCount: number };
      try {
        const mod = await importFromRoot(yoloRoot, "src/lib/scanner-to-task.js");
        const scannerToTasks = mod.scannerToTasks as (
          findings: unknown[],
          round?: number,
          options?: Record<string, unknown>,
        ) => { executorTasks: Array<Record<string, unknown>>; infoCount: number };
        classified = scannerToTasks(activeFindings, round, { reviewReportPath });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        logProgress("REVIEW", "", `scanner-to-task 不可用 (${errMsg})，使用内置 executor task 转换`);
        classified = fallbackClassifyFindings(activeFindings, round, { reviewReportPath }) as typeof classified;
      }

      const { executorTasks, infoCount } = classified;

      logProgress("REVIEW", "", `${executorTasks.length} EXECUTOR_FIX, ${infoCount} INFO`);
      logReviewGate("review-classifier", "pass", reviewLogMeta(
        {
          ...reviewClassifierMeta({ round, findings: activeFindings, executorTasks, infoCount }),
          skipped_unresolvable: unresolvable.length,
        },
      ));

      if (executorTasks.length === 0) {
        const recorded = Array.isArray(taskResults.review_unresolvable_findings)
          ? taskResults.review_unresolvable_findings as AutoFixUnresolvableFinding[]
          : [];
        if (recorded.length > 0) {
          const outcome = unresolvableOutcome(recorded, round);
          logReviewError("review finding 需人工处理", outcome.message, reviewLogMeta(outcome.meta));
          recordReviewOutcome(outcome);
          break;
        }
        logProgress("REVIEW", "", "无 executor 修复任务，review 完成");
        logReviewDone("pass", findings.length, 0, reviewLogMeta({ round, status: "clean" }));
        reviewCompleted = true;
        break;
      }

      if (shouldBlockReviewTaskLimit(executorTasks.length, maxReviewTasksPerRound)) {
        const taskLimitBlock = buildReviewTaskLimitBlock({
          round,
          taskCount: executorTasks.length,
          maxTasks: maxReviewTasksPerRound,
          taskIds: executorTasks.map((task) => String(task.id ?? "")),
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

      logProgress("REVIEW", "", `处理 ${executorTasks.length} 个 executor 修复任务...`);

      prd = loadLatestPrd();
      const addedReviewTasks = appendReviewTasksToPrd({
        prd,
        progress,
        tasks: executorTasks,
        ensureTaskShape: ensureReviewTaskShape,
      });
      recordFixHistoryForTasks({
        findings: activeFindings,
        persistence: findingPersistence,
        tasks: executorTasks,
        round,
        taskType: "EXECUTOR_FIX",
        reviewReportPath,
        prdPath,
      });
      for (const task of addedReviewTasks) {
        logProgress(String(task.id ?? ""), "ADDED", `${String(task.priority ?? "")} ${String(task.title ?? "")}`);
      }

      writeFileSync(prdPath, JSON.stringify(prd, null, 2), "utf8");
      if (stateRoot && resolveLedgerHmacKey(stateRoot)) {
        registerGeneratedArtifactIntegrity([prdPath], {
          rootDir,
          stateRoot,
          source: "review-loop-prd-update",
        });
      }

      const reviewTaskIds = reviewTaskIdSet(executorTasks);
      if (typeof mainLoop === "function" && taskResults) {
        logProgress("REVIEW", "", "执行 provider executor 任务...");
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
        logReviewDone("round_done", findings.length, 0, reviewLogMeta({ round, status: "round_done" }));
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
  const recordedUnresolvableFindings = Array.isArray(taskResults.review_unresolvable_findings)
    ? taskResults.review_unresolvable_findings as AutoFixUnresolvableFinding[]
    : [];
  if (!reviewOutcomeRecorded && !reviewCompleted && recordedUnresolvableFindings.length > 0) {
    recordReviewOutcome(unresolvableOutcome(recordedUnresolvableFindings));
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

  if (stateRoot && prdPath && existsSync(prdPath) && resolveLedgerHmacKey(stateRoot)) {
    registerGeneratedArtifactIntegrity([prdPath], {
      rootDir,
      stateRoot,
      source: "review-loop-prd-final",
    });
  }

  return taskResults;
}
