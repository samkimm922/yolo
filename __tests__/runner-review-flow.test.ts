import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Behavioral imports: drive real exported decision functions ──────────────
import { decidePreExecutionOutcome } from "../src/runtime/run-lifecycle/pre-execution-outcome.js";
import { isDryRunPrd, shouldSkipReviewForPrd, mergeReviewResults } from "../src/runtime/review-loop/round-helpers.js";
import { isFileInScopeTargets, isFileAllowedByScope } from "../src/runtime/execution/worktree-session.js";
import {
  isAllowedDryRunArtifactTarget,
  taskTargetsEngineFiles,
  buildEngineSelfModificationBlockOutcome,
} from "../src/runtime/execution/engine-scope-outcome.js";
import { buildAtomicDoctorBlockOutcome } from "../src/runtime/execution/atomic-doctor-outcome.js";
import { buildDryRunArtifactBaseRecord } from "../src/runtime/execution/dry-run-artifact.js";
import { normalizeBaselineIssueKey, pruneResolvedBaselineKeys } from "../src/runtime/execution/baselines.js";
import { buildContextPackFailureOutcome } from "../src/runtime/execution/context-pack-outcome.js";
import { buildPreMergePostconditionFailureOutcome } from "../src/runtime/execution/gate-pass-outcome.js";
import { shouldRunPostCommitPostconditions, buildPostCommitOutcome } from "../src/runtime/execution/post-commit-outcome.js";
import { buildRunTaskExceptionOutcome, hasRepeatedExceptionFailure } from "../src/runtime/execution/exception-outcome.js";
import { buildDiffQualityFailureOutcome, buildTestGenerationFailureOutcome } from "../src/runtime/execution/session-failure-outcome.js";
import {
  buildDryRunOutOfScopeBlock,
  buildOutOfScopeBlock,
  buildCommitSkipDecision,
  buildScopeAuditDecision,
} from "../src/runtime/execution/commit-flow.js";
import { buildPrecheckValidSkipOutcome, precheckRequestedSkip } from "../src/runtime/execution/precheck-outcome.js";

// ── Source reads: kept ONLY for architectural wiring contracts ──────────────
// These verify internal integration wiring (handler X called from site Y with
// args Z) that cannot be exercised behaviorally without running the full
// runner pipeline. Each remaining assert.match in the file falls into this
// category and is annotated with the wiring contract it verifies.
const YOLO_DIR = resolve(import.meta.dirname, "..");
const runnerEntrySource = readFileSync(resolve(YOLO_DIR, "src/cli/yolo.ts"), "utf8");
const runnerCoreSource = readFileSync(resolve(YOLO_DIR, "src/runtime/runner-core.ts"), "utf8");
const runnerCoreHelperSource = readFileSync(resolve(YOLO_DIR, "src/runtime/runner-core-helpers.ts"), "utf8");
const runnerContextSource = readFileSync(resolve(YOLO_DIR, "src/runtime/run-lifecycle/context.ts"), "utf8");
const runnerProcessHandlersSource = readFileSync(resolve(YOLO_DIR, "src/runtime/run-lifecycle/process-handlers.ts"), "utf8");
const runnerRecoveryCheckpointSource = readFileSync(resolve(YOLO_DIR, "src/runtime/run-lifecycle/recovery-checkpoints.ts"), "utf8");
const runnerTaskRuntimeBindingsSource = readFileSync(resolve(YOLO_DIR, "src/runtime/run-lifecycle/task-runtime-bindings.ts"), "utf8");
const runnerSource = `${runnerEntrySource}\n${runnerCoreSource}\n${runnerCoreHelperSource}\n${runnerContextSource}\n${runnerProcessHandlersSource}\n${runnerRecoveryCheckpointSource}\n${runnerTaskRuntimeBindingsSource}`;
const preExecutionGatesSource = readFileSync(resolve(YOLO_DIR, "src/runtime/gates/pre-execution-gates.ts"), "utf8");
const specGovernanceGateSource = readFileSync(resolve(YOLO_DIR, "src/runtime/gates/spec-governance-gate.ts"), "utf8");
const taskLoopExpansionSource = readFileSync(resolve(YOLO_DIR, "src/runtime/task-loop/expansion.ts"), "utf8");
const taskLoopMainSource = readFileSync(resolve(YOLO_DIR, "src/runtime/task-loop/main-loop.ts"), "utf8");
const taskRunnerSource = readFileSync(resolve(YOLO_DIR, "src/runtime/task-loop/task-runner.ts"), "utf8");
const splitApplicationSource = readFileSync(resolve(YOLO_DIR, "src/runtime/task-loop/split-application.ts"), "utf8");
const runOrchestratorSource = readFileSync(resolve(YOLO_DIR, "src/runtime/run-lifecycle/run-orchestrator.ts"), "utf8");
const retryOrchestratorSource = readFileSync(resolve(YOLO_DIR, "src/runtime/recovery/retry-orchestrator.ts"), "utf8");
const reviewRoundSource = readFileSync(resolve(YOLO_DIR, "src/runtime/review-loop/round-helpers.ts"), "utf8");
const reviewTaskApplicationSource = readFileSync(resolve(YOLO_DIR, "src/runtime/review-loop/task-application.ts"), "utf8");
const reviewOrchestratorSource = readFileSync(resolve(YOLO_DIR, "src/runtime/review-loop/orchestrator.ts"), "utf8");
const providerAdapterSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/provider-adapter.ts"), "utf8");
const executionChangeSetSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/change-set.ts"), "utf8");
const executionCommitFlowSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/commit-flow.ts"), "utf8");
const dryRunArtifactSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/dry-run-artifact.ts"), "utf8");
const executionBaselinesSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/baselines.ts"), "utf8");
const gateFailureFlowSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/gate-failure-flow.ts"), "utf8");
const gateFailureOutcomeSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/gate-failure-outcome.ts"), "utf8");
const gateLearningSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/gate-learning.ts"), "utf8");
const gatePassFlowSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/gate-pass-flow.ts"), "utf8");
const outcomeHandlerSource = readFileSync(resolve(YOLO_DIR, "src/runtime/task-loop/outcome-handler.ts"), "utf8");
const postPrecheckSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/post-precheck.ts"), "utf8");
const preSessionFlowSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/pre-session-flow.ts"), "utf8");
const retryRoundSource = readFileSync(resolve(YOLO_DIR, "src/runtime/recovery/retry-round.ts"), "utf8");
const sessionAttemptSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/session-attempt.ts"), "utf8");
const sessionPreGatesSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/session-pre-gates.ts"), "utf8");
const sessionPromptSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/session-prompt.ts"), "utf8");
const worktreeSessionSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/worktree-session.ts"), "utf8");
const taskLoopSource = `${runnerSource}\n${outcomeHandlerSource}\n${taskLoopExpansionSource}\n${taskLoopMainSource}\n${taskRunnerSource}\n${splitApplicationSource}`;
const recoverySource = `${runnerSource}\n${runOrchestratorSource}\n${retryRoundSource}\n${retryOrchestratorSource}`;
const reviewLoopSource = `${runnerSource}\n${reviewRoundSource}\n${reviewTaskApplicationSource}\n${reviewOrchestratorSource}`;
const prdSchema = JSON.parse(readFileSync(resolve(YOLO_DIR, "schemas/prd-v2.schema.json"), "utf8"));

describe("runner review fix execution flow", () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // BEHAVIORAL TESTS — drive real exported decision functions
  // Each test exercises the function's actual logic, not its source text.
  // Mutation sanity: flip the condition under test → test must go red.
  // ═══════════════════════════════════════════════════════════════════════════

  test("blocked pre-execution gate halts via decidePreExecutionOutcome (fail-closed)", () => {
    const blocked = decidePreExecutionOutcome(
      { status: "blocked", stage: "spec", code: "PRD_SPEC_GOVERNANCE_BLOCKED", exit_code: 1, message: "blocked", spec: { result: {} }, messages: ["[spec-governance] blocked"] },
      { exitOnFailure: false },
    );
    assert.equal(blocked.halt, true);
    assert.equal(blocked.outcome, "blocked");
    assert.equal(blocked.shouldThrow, true);
    assert.equal(blocked.shouldExit, false);
    // mutation: if outcome were "pass" for blocked → assert.equal(outcome,"blocked") fails
  });

  test("warning pre-execution gate halts with warn level, not error", () => {
    const warning = decidePreExecutionOutcome(
      { status: "warning", stage: "contract", code: "DOCTOR_WARN", exit_code: 0, message: "warn", contract: { doctor: "d", migration: "m", evidence_path: "e" }, messages: ["[doctor] warn"] },
      { exitOnFailure: false },
    );
    assert.equal(warning.halt, true);
    assert.equal(warning.outcome, "warning");
    assert.equal(warning.logLevel, "warn");
    // mutation: if isWarning were false → outcome would be "blocked" not "warning"
  });

  test("passing pre-execution gate does not halt", () => {
    const passed = decidePreExecutionOutcome(
      { status: "pass", exit_code: 0 },
      { exitOnFailure: true },
    );
    assert.equal(passed.halt, false);
    assert.equal(passed.outcome, "pass");
    // mutation: if pass didn't short-circuit → halt would be true
  });

  test("buildContextPackFailureOutcome extracts failure codes into reason and transition", () => {
    const outcome = buildContextPackFailureOutcome({
      taskId: "T1",
      contextGate: { result: { failures: [{ code: "MISSING_CONTEXT", detail: "x" }, { code: "STALE_PACK", detail: "y" }] } },
      attempt: 2,
    });
    assert.match(outcome.failReason, /context-pack-validator blocked: MISSING_CONTEXT, STALE_PACK/);
    assert.equal(outcome.transition.task_id, "T1");
    assert.equal(outcome.transition.prd_update.phase, "context_pack");
    assert.equal(outcome.result.status, "failed");
    // mutation: if failure codes weren't joined → reason wouldn't contain both codes
  });

  test("mergeReviewResults deduplicates entries across completed/failed/skipped/blocked", () => {
    const taskResults = { completed: ["T1"], failed: ["F1"], skipped: ["S1"], blocked: [] };
    const reviewResults = { completed: ["T1", "T2"], failed: ["F1", "F2"], skipped: ["S1"], blocked: ["B1"] };
    const merged = mergeReviewResults({ taskResults, reviewResults });
    assert.deepEqual(merged.completed, ["T1", "T2"]);
    assert.deepEqual(merged.failed, ["F1", "F2"]);
    assert.deepEqual(merged.skipped, ["S1"]);
    assert.deepEqual(merged.blocked, ["B1"]);
    // mutation: if appendUnique pushed duplicates → completed would have T1 twice
  });

  test("isDryRunPrd detects dry-run by execution_mode, policy, id, and all-task-kind", () => {
    assert.equal(isDryRunPrd({ execution_mode: "dry_run" }), true);
    assert.equal(isDryRunPrd({ review_policy: { allow_prd_mutation: false } }), true);
    assert.equal(isDryRunPrd({ id: "DRY-RUN-001" }), true);
    assert.equal(isDryRunPrd({ tasks: [{ task_kind: "dry_run_artifact" }] }), true);
    assert.equal(isDryRunPrd({ tasks: [{ task_kind: "feature" }] }), false);
    assert.equal(isDryRunPrd(null), false);
    // mutation: if any detection path were removed → corresponding assert fails
  });

  test("shouldSkipReviewForPrd covers dry-run, report_only, and disabled modes", () => {
    assert.equal(shouldSkipReviewForPrd({ execution_mode: "dry_run" }), true);
    assert.equal(shouldSkipReviewForPrd({ review_policy: { mode: "report_only" } }), true);
    assert.equal(shouldSkipReviewForPrd({ review_policy: { mode: "disabled" } }), true);
    assert.equal(shouldSkipReviewForPrd({ review_policy: { mode: "enforce" } }), false);
    // mutation: if report_only check removed → that assert fails
  });

  test("buildAtomicDoctorBlockOutcome: must_split without applied split → prdUpdate not null", () => {
    const outcome = buildAtomicDoctorBlockOutcome({
      task: { id: "T1" },
      doctor: { mode: "must_split", score: 0.9, evidence_file: "e.json", split_suggestions: [{ id: "T1A", files: ["a.ts"] }] },
      splitResult: { applied: false, childIds: [] },
    });
    assert.equal(outcome.taskResult.reason, "atomic_task_must_split");
    assert.equal(outcome.taskResult.split_applied, false);
    assert.notEqual(outcome.prdUpdate, null);
    // mutation: if shouldUpdatePrd logic flipped → prdUpdate would be null when split not applied
  });

  test("buildAtomicDoctorBlockOutcome: must_split with applied split → prdUpdate null", () => {
    const outcome = buildAtomicDoctorBlockOutcome({
      task: { id: "T1" },
      doctor: { mode: "must_split", score: 0.9, evidence_file: "e.json", split_suggestions: [{ id: "T1A", files: ["a.ts"] }] },
      splitResult: { applied: true, childIds: ["T1A"] },
    });
    assert.equal(outcome.taskResult.split_applied, true);
    assert.deepEqual(outcome.taskResult.split_into, ["T1A"]);
    assert.equal(outcome.prdUpdate, null);
    // mutation: if shouldUpdatePrd didn't check splitResult.applied → prdUpdate wouldn't be null
  });

  test("buildAtomicDoctorBlockOutcome: doctor_failed mode → different reason", () => {
    const outcome = buildAtomicDoctorBlockOutcome({
      task: { id: "T1" },
      doctor: { mode: "doctor_failed", error: "crashed" },
      splitResult: { applied: false, childIds: [] },
    });
    assert.equal(outcome.taskResult.reason, "atomic_task_doctor_failed");
    assert.match(outcome.failReason, /atomic_task_doctor_failed: crashed/);
    // mutation: if reason used must_split for doctor_failed → reason wouldn't match
  });

  test("isFileInScopeTargets matches exact file, directory prefix, and parent path", () => {
    assert.equal(isFileInScopeTargets("src/a.ts", [{ file: "src/a.ts" }]), true);
    assert.equal(isFileInScopeTargets("src/sub/b.ts", [{ file: "src" }]), true);
    assert.equal(isFileInScopeTargets("src", [{ file: "src/a.ts" }]), true); // file-dir is parent of target
    assert.equal(isFileInScopeTargets("other/a.ts", [{ file: "src" }]), false);
    // mutation: if parent-match branch (targetPath.startsWith(filePath+"/")) removed → third assert fails
  });

  test("isFileAllowedByScope: allow_new_files permits sibling files in target directory", () => {
    const scope = { allow_new_files: true, targets: [{ file: "src/a.ts" }] };
    assert.equal(isFileAllowedByScope("src/a.ts", scope as any), true);
    assert.equal(isFileAllowedByScope("src/b.ts", scope as any), true); // sibling in same dir
    assert.equal(isFileAllowedByScope("other/c.ts", scope as any), false); // outside target dir
    // mutation: if allow_new_files check removed → src/b.ts would be false
  });

  test("isFileAllowedByScope: without allow_new_files, only exact scope targets pass", () => {
    const scope = { allow_new_files: false, targets: [{ file: "src/a.ts" }] };
    assert.equal(isFileAllowedByScope("src/a.ts", scope as any), true);
    assert.equal(isFileAllowedByScope("src/b.ts", scope as any), false);
    // mutation: if allow_new_files defaulted to true → src/b.ts would be true
  });

  test("isAllowedDryRunArtifactTarget: only dry_run_artifact tasks targeting state/dry-run", () => {
    assert.equal(isAllowedDryRunArtifactTarget({ task_kind: "dry_run_artifact" }, "scripts/yolo/state/dry-run/x.md"), true);
    assert.equal(isAllowedDryRunArtifactTarget({ task_kind: "feature" }, "scripts/yolo/state/dry-run/x.md"), false);
    assert.equal(isAllowedDryRunArtifactTarget({ task_kind: "dry_run_artifact" }, "src/a.ts"), false);
    // mutation: if task_kind check removed → feature task would be allowed
  });

  test("taskTargetsEngineFiles: blocks engine paths except allowed dry-run artifacts", () => {
    assert.equal(taskTargetsEngineFiles({ scope: { targets: [{ file: "scripts/yolo/cli.ts" }] } }), true);
    assert.equal(taskTargetsEngineFiles({ task_kind: "dry_run_artifact", scope: { targets: [{ file: "scripts/yolo/state/dry-run/x.md" }] } }), false);
    assert.equal(taskTargetsEngineFiles({ scope: { targets: [{ file: "src/a.ts" }] } }), false);
    // mutation: if isAllowedDryRunArtifactTarget exemption removed → dry-run case would be true
  });

  test("buildEngineSelfModificationBlockOutcome: blocks engine-targeting tasks", () => {
    const blocked = buildEngineSelfModificationBlockOutcome({ task: { id: "T1", scope: { targets: [{ file: "scripts/yolo/core.ts" }] } } });
    assert.equal(blocked.shouldBlock, true);
    assert.equal(blocked.doneStatus, "blocked");
    assert.match(blocked.transition.prd_update.skipReason, /engine_self_modify_blocked/);
    // mutation: if shouldBlock were always false → assert.equal(blocked.shouldBlock,true) fails
  });

  test("buildEngineSelfModificationBlockOutcome: passes non-engine tasks", () => {
    const passed = buildEngineSelfModificationBlockOutcome({ task: { id: "T1", scope: { targets: [{ file: "src/a.ts" }] } } });
    assert.equal(passed.shouldBlock, false);
    // mutation: if shouldBlock were always true → this assert fails
  });

  test("buildDryRunArtifactBaseRecord records deterministic artifact metadata", () => {
    const record = buildDryRunArtifactBaseRecord({ taskId: "T1", target: "scripts/yolo/state/dry-run/x.md", startedAtMs: 1000, nowMs: 2000 });
    assert.deepEqual(record.scope_targets_touched, ["scripts/yolo/state/dry-run/x.md"]);
    assert.equal(record.scope_targets_missed.length, 0);
    assert.equal(record.deterministic_artifact, true);
    assert.equal(record.files_changed_business, 0);
    // mutation: if scope_targets_touched were empty → deepEqual fails
  });

  test("normalizeBaselineIssueKey strips rootDir prefix and relative ./ prefix", () => {
    assert.equal(normalizeBaselineIssueKey("/repo/src/a.ts", "/repo"), "src/a.ts");
    assert.equal(normalizeBaselineIssueKey("/repo/./src/a.ts", "/repo"), "src/a.ts");
    assert.equal(normalizeBaselineIssueKey("src/a.ts", "/repo"), "src/a.ts");
    // mutation: if rootDir replace removed → /repo prefix wouldn't strip
  });

  test("pruneResolvedBaselineKeys keeps keys still present by file:code match", () => {
    const baseline = ["src/a.ts:no-explicit-any", "src/b.ts:unused-var"];
    const current = ["src/a.ts:123:no-explicit-any", "src/c.ts:other"];
    const pruned = pruneResolvedBaselineKeys(baseline, current, "/repo");
    assert.ok(pruned.includes("src/a.ts:no-explicit-any"));
    assert.ok(!pruned.includes("src/b.ts:unused-var"));
    // mutation: if file:code fuzzy match removed → a.ts key would be pruned
  });

  test("buildPreMergePostconditionFailureOutcome includes failed conditions in reason", () => {
    const outcome = buildPreMergePostconditionFailureOutcome({ taskId: "T1", postResult: { failed: ["conditionA", "conditionB"] }, attempt: 1 });
    assert.match(outcome.reason, /post_conditions failed before merge: conditionA; conditionB/);
    assert.equal(outcome.result.status, "failed");
    assert.equal(outcome.transition.task_id, "T1");
    // mutation: if failed weren't joined → reason wouldn't contain both
  });

  test("shouldRunPostCommitPostconditions requires committed + hasRealCode + not blocked", () => {
    assert.equal(shouldRunPostCommitPostconditions({ committed: true, hasRealCode: true, blocked: false }), true);
    assert.equal(shouldRunPostCommitPostconditions({ committed: true, hasRealCode: true, blocked: true }), false);
    assert.equal(shouldRunPostCommitPostconditions({ committed: true, hasRealCode: false, blocked: false }), false);
    assert.equal(shouldRunPostCommitPostconditions({ committed: false, hasRealCode: true, blocked: false }), false);
    // mutation: if blocked check removed → second assert would be true
  });

  test("buildPostCommitOutcome: dry_run_artifact scope_targets_missed → failed", () => {
    const outcome = buildPostCommitOutcome({
      task: { id: "T1", task_kind: "dry_run_artifact" },
      commitResult: { committed: true, hasRealCode: true, blocked: false },
      baseRecord: { scope_targets_missed: ["targetA"] },
      postResult: { passed: true },
    });
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason, /scope targets missed: targetA/);
    // mutation: if scope_targets_missed check removed → status would be "completed"
  });

  test("buildPostCommitOutcome: postcondition failure → failed", () => {
    const outcome = buildPostCommitOutcome({
      task: { id: "T1" },
      commitResult: { committed: true, hasRealCode: true, blocked: false },
      baseRecord: {},
      postResult: { passed: false, failed: ["condX"] },
    });
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason, /post_conditions failed: condX/);
    // mutation: if !postResult.passed branch removed → status would be "completed"
  });

  test("buildPostCommitOutcome: postcondition pass → completed", () => {
    const outcome = buildPostCommitOutcome({
      task: { id: "T1" },
      commitResult: { committed: true, hasRealCode: true, blocked: false },
      baseRecord: {},
      postResult: { passed: true },
    });
    assert.equal(outcome.status, "completed");
    // mutation: if pass branch returned failed → this assert fails
  });

  test("buildDryRunOutOfScopeBlock: only blocks dry_run_artifact with out-of-scope files", () => {
    assert.ok(buildDryRunOutOfScopeBlock({ task: { task_kind: "dry_run_artifact" }, outOfScope: ["x.ts"] }));
    assert.equal(buildDryRunOutOfScopeBlock({ task: { task_kind: "feature" }, outOfScope: ["x.ts"] }), null);
    assert.equal(buildDryRunOutOfScopeBlock({ task: { task_kind: "dry_run_artifact" }, outOfScope: [] }), null);
    // mutation: if task_kind check removed → feature task would get blocked
  });

  test("buildOutOfScopeBlock: blocks any task with out-of-scope files", () => {
    const blocked = buildOutOfScopeBlock({ outOfScope: ["x.ts", "y.ts"] });
    assert.ok(blocked);
    assert.match(blocked.blockReason, /out_of_scope_files: x.ts, y.ts/);
    assert.equal(buildOutOfScopeBlock({ outOfScope: [] }), null);
    // mutation: if empty-check removed → null case would return a block
  });

  test("buildCommitSkipDecision: no-code, metadata-only, and dry-run paths", () => {
    assert.equal(buildCommitSkipDecision({ code: [] }).reason, "no_code");
    assert.equal(buildCommitSkipDecision({ code: ["README.md"], hasRealCode: false, metadataFiles: ["README.md"] }).reason, "metadata_only");
    const dryRun = buildCommitSkipDecision({ task: { task_kind: "dry_run_artifact" }, code: ["x.md"], hasRealCode: true, metadataFiles: ["x.md"] });
    assert.equal(dryRun.reason, "dry_run_artifact");
    assert.equal(dryRun.result.skippedCommit, true);
    // mutation: if dry_run_artifact branch removed → reason would be null
  });

  test("buildScopeAuditDecision: logs warning when out-of-scope files exist", () => {
    const decision = buildScopeAuditDecision({ task: { id: "T1" }, outOfScope: ["x.ts"], targetFiles: ["a.ts"], modified: ["x.ts", "a.ts"] });
    assert.equal(decision.logs.length, 2);
    assert.match(decision.logs[0].message, /工作区存在非本次任务文件/);
    assert.ok(decision.audit);
    // mutation: if logs were empty for out-of-scope → logs.length === 0
  });

  test("buildScopeAuditDecision: no logs when no out-of-scope files", () => {
    const decision = buildScopeAuditDecision({ task: { id: "T1" }, outOfScope: [] });
    assert.deepEqual(decision.logs, []);
    assert.equal(decision.audit, null);
    // mutation: if empty-out-of-scope check removed → logs wouldn't be empty
  });

  test("hasRepeatedExceptionFailure: detects same exception in last 2 history entries", () => {
    const history = [{ message: "exception:timeout calling provider" }, { message: "exception:timeout calling provider again" }];
    assert.equal(hasRepeatedExceptionFailure(history, "exception:timeout calling provider"), true);
    assert.equal(hasRepeatedExceptionFailure([{ message: "x" }], "exception:timeout"), false);
    assert.equal(hasRepeatedExceptionFailure([], "exception:timeout"), false);
    // mutation: if history.length < 2 check removed → single-entry would match
  });

  test("buildRunTaskExceptionOutcome: stuck exception → return with failed status", () => {
    const history = [{ message: "exception:crash in runTask" }, { message: "exception:crash in runTask again" }];
    const outcome = buildRunTaskExceptionOutcome({ taskId: "T1", error: new Error("crash in runTask"), attempt: 2, history, maxAttempts: 3 });
    assert.equal(outcome.action, "return");
    assert.equal(outcome.result.status, "failed");
    assert.match(outcome.doneReason, /连续异常停机/);
    // mutation: if hasRepeatedExceptionFailure were always false → action would be "retry"
  });

  test("buildRunTaskExceptionOutcome: attempt exhausted → max_retry_exception", () => {
    const outcome = buildRunTaskExceptionOutcome({ taskId: "T1", error: new Error("boom"), attempt: 5, history: [], maxAttempts: 3 });
    assert.equal(outcome.action, "return");
    assert.equal(outcome.result.reason, "max_retry_exception");
    // mutation: if attempt > maxAttempts check removed → action would be "retry"
  });

  test("buildRunTaskExceptionOutcome: retryable → retry action with sleepMs", () => {
    const outcome = buildRunTaskExceptionOutcome({ taskId: "T1", error: new Error("transient"), attempt: 1, history: [], maxAttempts: 3 });
    assert.equal(outcome.action, "retry");
    assert.ok(outcome.sleepMs > 0);
    // mutation: if retry branch removed → action would be "return"
  });

  test("buildDiffQualityFailureOutcome: includes failure codes and recovery hint", () => {
    const outcome = buildDiffQualityFailureOutcome({
      taskId: "T1",
      diffQualityGate: { failures: [{ code: "TOO_MANY_FILES", detail: "3 > 1" }], recovery_hint: "split the task" },
      attempt: 1,
      maxRetry: 1,
    });
    assert.match(outcome.failReason, /diff-quality-gate blocked: TOO_MANY_FILES/);
    assert.match(outcome.lastGateError, /split the task/);
    assert.ok(outcome.historyEntry);
    // mutation: if failure codes weren't mapped → reason wouldn't contain code
  });

  test("buildDiffQualityFailureOutcome: attempt exceeded → terminal failed result", () => {
    const outcome = buildDiffQualityFailureOutcome({
      taskId: "T1",
      diffQualityGate: { failures: [{ code: "X" }], recovery_hint: "" },
      attempt: 3,
      maxRetry: 1,
    });
    assert.equal(outcome.retryMessage, null);
    assert.equal(outcome.result.status, "failed");
    // mutation: if attempt > maxRetry check removed → retryMessage wouldn't be null
  });

  test("buildTestGenerationFailureOutcome: includes failure codes in reason", () => {
    const outcome = buildTestGenerationFailureOutcome({
      taskId: "T1",
      testGenerationGate: { failures: [{ code: "NEW_TESTS_NOT_ALLOWED", detail: "x" }] },
      attempt: 0,
    });
    assert.match(outcome.failReason, /test-generation-validator blocked: NEW_TESTS_NOT_ALLOWED/);
    assert.equal(outcome.transition.prd_update.phase, "test_generation");
    // mutation: if failure codes weren't mapped → reason wouldn't contain code
  });

  test("precheckRequestedSkip: detects PRE-CHECK SKIP marker in stdout", () => {
    assert.equal(precheckRequestedSkip({ stdout: "some output\nPRE-CHECK SKIP\nmore" }), true);
    assert.equal(precheckRequestedSkip({ stdout: "no marker here" }), false);
    // mutation: if marker string changed → detection would fail
  });

  test("buildPrecheckValidSkipOutcome: marks task as valid_skip_already_satisfied", () => {
    const outcome = buildPrecheckValidSkipOutcome({ task: { id: "T1" } });
    assert.equal(outcome.result.skip_kind, "valid_skip_already_satisfied");
    assert.equal(outcome.result.counts_as_completed, true);
    assert.equal(outcome.transition.result.postcondition_verified, true);
    // mutation: if counts_as_completed were false → assert fails
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ARCHITECTURAL WIRING CONTRACTS
  // These verify internal integration wiring: that handler X is called from
  // site Y with args Z. They cannot be exercised behaviorally without running
  // the full runner pipeline with mocked git/provider/state — the wiring IS
  // the behavior under test. All exported decision/outcome functions that
  // these sites call are covered by the behavioral tests above.
  // ═══════════════════════════════════════════════════════════════════════════

  test("spec governance gate wiring: gate functions exist and are wired", () => {
    // Wiring: runPreExecutionGates exists in runner, calls inspect gates
    assert.match(runnerSource, /function\s+runPreExecutionGates/);
    assert.match(preExecutionGatesSource, /inspectPrdContractDoctorGate\(\{/);
    assert.match(preExecutionGatesSource, /inspectSpecGovernanceGate\(\{\s*prd\s*\}\)/);
    // Wiring: spec governance gate enforces all three requirement flags
    assert.match(specGovernanceGateSource, /requireRequirements:\s*options\.requireRequirements\s*!==\s*false/);
    assert.match(specGovernanceGateSource, /requireDesign:\s*options\.requireDesign\s*!==\s*false/);
    assert.match(specGovernanceGateSource, /requireEvidenceForTerminal:\s*options\.requireEvidenceForTerminal\s*!==\s*false/);
    assert.match(specGovernanceGateSource, /PRD_SPEC_GOVERNANCE_BLOCKED/);
  });

  test("review loop wiring: CLAUDE_FIX tasks re-enter mainLoop with PRD path", () => {
    assert.match(runnerSource, /runTaskPipeline\(\{/);
    assert.match(runOrchestratorSource, /reviewLoop\(\{/);
    assert.match(reviewOrchestratorSource, /await\s+mainLoop\(prdPath,\s*preCompleted\)/);
    assert.doesNotMatch(reviewOrchestratorSource, /await\s+mainLoop\(\s*\)/);
  });

  test("review loop wiring: scanner loops until no findings remain", () => {
    assert.match(reviewOrchestratorSource, /执行 provider executor 任务/);
    assert.match(reviewTaskApplicationSource, /本轮 review 任务已处理，继续下一轮扫描/);
    assert.match(reviewOrchestratorSource, /review fix 未全部完成/);
    assert.match(reviewOrchestratorSource, /无新发现，review 完成/);
  });

  test("task loop wiring: merged task state propagation", () => {
    assert.match(taskLoopExpansionSource, /base\.merged_from = allIds/);
    assert.match(taskLoopMainSource, /updateMergedSourceTasks\(\{/);
    assert.match(taskLoopSource, /status:\s*"merged_into"/);
    assert.match(taskLoopSource, /merged task completed:/);
    assert.match(taskLoopSource, /merged task skipped:/);
    assert.match(taskLoopSource, /appendUniqueTaskIds\(results\.blocked,\s*sourceIds\)/);
    assert.match(taskLoopSource, /appendUniqueTaskIds\(results\.failed,\s*sourceIds\)/);
  });

  test("review loop wiring: pending detection reloads PRD after mainLoop", () => {
    assert.match(reviewOrchestratorSource, /const latestPrdAfterReview = loadPRD\(prdPath\)/);
    assert.match(reviewOrchestratorSource, /findPendingReviewTasks\(latestPrdAfterReview\)/);
    assert.match(reviewRoundSource, /task\.id\.startsWith\("FIX-R"\)/);
  });

  test("review loop wiring: execution errors mark review tasks as failed", () => {
    assert.match(reviewOrchestratorSource, /appendUnique\(taskResults\.failed,\s*\[\.\.\.reviewTaskIds\]\)/);
  });

  test("review loop wiring: dry-run PRD mutation policy enforcement", () => {
    assert.match(reviewOrchestratorSource, /shouldSkipReviewForPrdByPolicy\(prd\)/);
    assert.match(reviewLoopSource, /allow_prd_mutation/);
    assert.match(reviewOrchestratorSource, /禁止 review 自动追加任务污染 PRD/);
  });

  test("review loop wiring: hard task limit before PRD mutation", () => {
    assert.match(runnerSource, /MAX_REVIEW_TASKS_PER_ROUND/);
    assert.match(reviewOrchestratorSource, /shouldBlockReviewTaskLimit\(executorTasks\.length,\s*maxReviewTasksPerRound\)/);
    assert.match(reviewTaskApplicationSource, /REVIEW_TASK_LIMIT_BLOCKED/);
    assert.match(reviewTaskApplicationSource, /拒绝写入 PRD/);
  });

  test("pre-session wiring: precheck routing for dry-run and feature tasks", () => {
    assert.match(runnerSource, /function\s+shouldRunPrecheck/);
    assert.match(runnerSource, /task\.task_kind === "dry_run_artifact"/);
    assert.match(runnerSource, /\["feature",\s*"cleanup"\]\.includes\(task\.type\)/);
    assert.match(taskRunnerSource, /handlePreSessionFlow\(\{/);
    assert.match(preSessionFlowSource, /attempt === 0 && shouldRunPrecheck\(task\)/);
  });

  test("pre-session wiring: atomic doctor, engine scope, and read-only deterministic producers", () => {
    assert.match(taskRunnerSource, /handlePreSessionFlow\(\{/);
    assert.match(preSessionFlowSource, /atomicDoctorBlockBuilder = buildAtomicDoctorBlockOutcome/);
    assert.match(preSessionFlowSource, /engineBlockBuilder = buildEngineSelfModificationBlockOutcome/);
    assert.match(preSessionFlowSource, /dryRunTaskCompleter = completeDryRunArtifactTask/);
    assert.match(preSessionFlowSource, /dryRunTaskCompleter\(\{/);
    assert.doesNotMatch(preSessionFlowSource, /deterministicAutoFix|tryDeterministicAutoFixTask/);
    assert.match(preSessionFlowSource, /config\.runner\?\.deterministic_dry_run_artifacts !== false/);
    assert.match(dryRunArtifactSource, /deterministic dry_run_artifact producer/);
  });

  test("commit-flow wiring: scope audit, out-of-scope, and dry-run blocks", () => {
    assert.match(worktreeSessionSource, /function\s+isFileInScopeTargets/);
    assert.match(gatePassFlowSource, /cleanupWorktree\(wt\.path,\s*wt\.branch,\s*true,\s*task\.scope/);
    assert.match(worktreeSessionSource, /existsSync\(join\(wtPath,\s*targetPath\)\)/);
    assert.match(runnerSource, /runTaskCommitFlow\(\{/);
    assert.match(executionCommitFlowSource, /buildDryRunOutOfScopeBlock\(\{/);
    assert.match(executionCommitFlowSource, /buildOutOfScopeBlock\(\{/);
    assert.match(executionCommitFlowSource, /buildCommitSkipDecision\(\{/);
    assert.match(executionCommitFlowSource, /task\.task_kind !== "dry_run_artifact" \|\| outOfScope\.length === 0/);
    assert.match(runnerSource, /buildCommitChangeContext\(\{\s*rootDir:\s*ROOT,\s*task,\s*worktreeFiles,\s*isFileAllowedByScope,\s*config:\s*runtimeConfig,\s*\}\)/);
    assert.match(executionChangeSetSource, /scopedOutOfScopeFiles\(code,\s*task,\s*\{\s*isFileAllowedByScope,\s*\}\)/);
    assert.match(executionChangeSetSource, /!isFileAllowedByScope\(file,\s*scope\)/);
    assert.match(gatePassFlowSource, /buildPostCommitOutcome\(\{/);
    assert.match(executionCommitFlowSource, /buildScopeAuditDecision\(\{\s*task,\s*outOfScope,\s*targetFiles,\s*modified\s*\}\)/);
    assert.match(executionCommitFlowSource, /工作区存在非本次任务文件: \$\{outOfScope\.join\("、"\)\}/);
    assert.match(executionChangeSetSource, /outOfScope: files\.filter\(\(file\) => !isFileAllowedByScope\(file,\s*scope\)\)/);
  });

  test("worktree wiring: merge based on task base commit, not dirty root state", () => {
    assert.match(worktreeSessionSource, /git rev-parse --verify HEAD/);
    assert.match(worktreeSessionSource, /return \{ branch: wtBranch,\s*path: wtPath,\s*base: baseCommit,\s*mode: "git" \}/);
    assert.match(runnerSource, /function cleanupWorktree\(wtPath,\s*wtBranch,\s*mergeToMain = false,\s*allowedScope = \[\],\s*baseRef = null\)/);
    assert.match(worktreeSessionSource, /\["diff",\s*"--name-status",\s*baseRef,\s*"HEAD"\]/);
    assert.match(gatePassFlowSource, /cleanupWorktree\(wt\.path,\s*wt\.branch,\s*true,\s*task\.scope[^)]*wt\.base\)/);
    assert.doesNotMatch(runnerSource, /diff HEAD~1 --name-only/);
    assert.doesNotMatch(runnerSource, /git diff --stat/);
  });

  test("worktree wiring: merge verification uses copied files and scope rules", () => {
    assert.match(worktreeSessionSource, /\["diff",\s*"--name-only",\s*"--",\s*\.\.\.copiedFiles\]/);
    assert.match(worktreeSessionSource, /\["ls-files",\s*"--others",\s*"--exclude-standard",\s*"--",\s*\.\.\.copiedFiles\]/);
    assert.match(worktreeSessionSource, /合并验证通过: \$\{changedCopied\.size\}\/\$\{copiedFiles\.length\} 个本次复制文件有改动/);
    assert.match(runnerSource, /applyScopeAudit\(\{/);
    assert.match(worktreeSessionSource, /function\s+isFileAllowedByScope/);
    assert.match(worktreeSessionSource, /scope\.allow_new_files !== true/);
    assert.match(worktreeSessionSource, /`\$\{dirname\(target\)\}\/`/);
    assert.match(worktreeSessionSource, /!isFileAllowedByScope\(safeFilePath,\s*allowedScope\)/);
  });

  test("recovery wiring: retry completion synced back after postconditions pass", () => {
    assert.match(runOrchestratorSource, /retryPhase\(\{/);
    assert.match(retryOrchestratorSource, /await\s+mainLoop\(retryPrdPath,\s*retryCompleted\)/);
    assert.match(recoverySource, /completedViaRetry: true/);
    assert.match(recoverySource, /retry 声称完成，但主工作区 post_conditions 未满足/);
    assert.match(runnerSource, /taskPostconditionsPass/);
  });

  test("postcondition wiring: pre-merge and post-commit gates", () => {
    assert.match(taskRunnerSource, /handleGatePassFlow\(\{/);
    assert.match(gatePassFlowSource, /buildPreMergePostconditionFailureOutcome\(\{/);
    assert.match(gatePassFlowSource, /taskPostconditionsPass\(task,\s*prdForPreMergePostCheck,\s*wt\.path\)/);
    assert.match(gatePassFlowSource, /shouldRunPostCommitPostconditions\(commitResult\)/);
    assert.match(gatePassFlowSource, /buildPostCommitOutcome\(\{/);
    assert.match(runnerSource, /setContractRoot\(ROOT\)/);
    assert.match(runnerSource, /function\s+taskPostconditionsPass\(task,\s*prd,\s*contractRoot = ROOT,\s*options = Object\(\)\)/);
    assert.doesNotMatch(runnerSource, /if \(task\.task_kind === "dry_run_artifact"\) \{\s*const prdForCheck = loadPRD\(prdPath\)/);
  });

  test("session wiring: provider auto-detect, failure outcomes, and prompt retry", () => {
    assert.match(runnerSource, /function\s+detectModelProvider/);
    assert.match(runnerSource, /detectModelProvider as detectProvider/);
    assert.match(runnerSource, /provider-doctor\.js/);
    assert.match(runnerSource, /detectRunnerModelProvider\(\{/);
    assert.match(runnerTaskRuntimeBindingsSource, /return detectProvider\(\{/);
    assert.match(runnerSource, /function\s+spawnProvider/);
    assert.match(runnerSource, /spawnProviderPrompt/);
    assert.match(providerAdapterSource, /codex/);
    assert.match(providerAdapterSource, /--output-last-message/);
    assert.match(sessionPreGatesSource, /buildProviderFailureOutcome\(\{/);
    assert.match(sessionPreGatesSource, /buildDiffQualityFailureOutcome\(\{/);
    assert.match(sessionPreGatesSource, /buildTestGenerationFailureOutcome\(\{/);
    assert.match(taskRunnerSource, /inspectSessionPreGateChecks\(\{/);
    assert.match(taskRunnerSource, /prepareProviderSession\(\{/);
    assert.match(sessionAttemptSource, /buildContextPackFailureOutcome\(\{/);
    assert.match(sessionAttemptSource, /buildPromptSession\(\{/);
    assert.match(sessionPromptSource, /buildFailureHint/);
    assert.match(sessionPromptSource, /--learnings=/);
    assert.match(sessionPromptSource, /文件超过 150 行限制/);
  });

  test("task-runner wiring: exception, gate-failure, and learning handlers", () => {
    assert.match(taskRunnerSource, /handleRunTaskExceptionFlow\(\{/);
    assert.match(taskRunnerSource, /handleGateFailureFlow\(\{/);
    assert.match(gateFailureFlowSource, /buildGateFailureRetryDecision/);
    assert.match(gateFailureFlowSource, /applyGateFailureLearningEffects/);
    assert.match(gateFailureFlowSource, /gateFailureLearnArgs/);
    assert.match(gateFailureOutcomeSource, /contract_suspect/);
    assert.match(gateFailureOutcomeSource, /max_retry/);
    assert.match(gateFailureOutcomeSource, /连续 2 次同 gate code 失败/);
    assert.match(gateLearningSource, /learn\.js/);
    assert.match(gateLearningSource, /incrementRetryCountFile/);
  });

  test("task-loop wiring: structured skip semantics and valid-skip postconditions", () => {
    assert.match(runnerSource, /function\s+taskCountsAsCompleted/);
    assert.match(runnerSource, /valid_skip_already_satisfied/);
    assert.match(runnerSource, /function\s+skippedTaskPostconditionsPass/);
    assert.match(taskLoopSource, /dependency_blocked/);
    assert.match(taskLoopSource, /blocked_skip_missing_evidence/);
    assert.match(taskLoopSource, /counts_as_completed:\s*true/);
    assert.match(taskLoopSource, /blocked_by:\s*deps/);
    assert.match(taskLoopSource, /invalid_skip_postconditions_failed/);
    assert.doesNotMatch(runnerSource, /filter\(t => t\.status === 'done' \|\| t\.status === 'skipped'\)/);
    assert.match(postPrecheckSource, /expected_zero_business_code:\s*true/);
    assert.match(postPrecheckSource, /code_contains/);
    assert.match(postPrecheckSource, /target_type_check_errors/);
    assert.match(preSessionFlowSource, /buildPrecheckValidSkipOutcome\(\{/);
    assert.match(preSessionFlowSource, /postPrecheckInspector = inspectPostPrecheckSkip/);
    assert.match(preSessionFlowSource, /postPrecheckInspector\(\{/);
  });

  test("baseline wiring: eslint key normalization and refresh after commit", () => {
    assert.match(runnerSource, /function\s+normalizeRepoPath/);
    assert.match(runnerSource, /function\s+lintIssueKey/);
    assert.match(runnerSource, /refreshBaselinesAfterCommit\(\)/);
    assert.match(executionBaselinesSource, /function\s+normalizeBaselineIssueKey/);
    assert.match(executionBaselinesSource, /baseline\.keys = pruneResolvedBaselineKeys\(oldKeys,\s*currentKeys,\s*rootDir\)/);
  });

  test("PRD schema accepts runner transient running status for recovery", () => {
    const taskStatusEnum = prdSchema.definitions.task.properties.status.enum;
    assert.ok(taskStatusEnum.includes("running"));
  });
});
