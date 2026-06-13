import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const runnerEntrySource = readFileSync(resolve(YOLO_DIR, "src/cli/yolo.ts"), "utf8");
const runnerCoreSource = readFileSync(resolve(YOLO_DIR, "src/runtime/runner-core.ts"), "utf8");
const runnerCoreHelperSource = readFileSync(resolve(YOLO_DIR, "src/runtime/runner-core-helpers.ts"), "utf8");
const runnerContextSource = readFileSync(resolve(YOLO_DIR, "src/runtime/run-lifecycle/context.ts"), "utf8");
const runnerProcessHandlersSource = readFileSync(resolve(YOLO_DIR, "src/runtime/run-lifecycle/process-handlers.ts"), "utf8");
const runnerRecoveryCheckpointSource = readFileSync(resolve(YOLO_DIR, "src/runtime/run-lifecycle/recovery-checkpoints.ts"), "utf8");
const runnerTaskRuntimeBindingsSource = readFileSync(resolve(YOLO_DIR, "src/runtime/run-lifecycle/task-runtime-bindings.ts"), "utf8");
const runnerSource = `${runnerEntrySource}\n${runnerCoreSource}\n${runnerCoreHelperSource}\n${runnerContextSource}\n${runnerProcessHandlersSource}\n${runnerRecoveryCheckpointSource}\n${runnerTaskRuntimeBindingsSource}`;
const atomicDoctorOutcomeSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/atomic-doctor-outcome.ts"), "utf8");
const preExecutionGatesSource = readFileSync(resolve(YOLO_DIR, "src/runtime/gates/pre-execution-gates.ts"), "utf8");
const specGovernanceGateSource = readFileSync(resolve(YOLO_DIR, "src/runtime/gates/spec-governance-gate.ts"), "utf8");
const outcomeHandlerSource = readFileSync(resolve(YOLO_DIR, "src/runtime/task-loop/outcome-handler.ts"), "utf8");
const taskLoopExpansionSource = readFileSync(resolve(YOLO_DIR, "src/runtime/task-loop/expansion.ts"), "utf8");
const taskLoopMainSource = readFileSync(resolve(YOLO_DIR, "src/runtime/task-loop/main-loop.ts"), "utf8");
const taskRunnerSource = readFileSync(resolve(YOLO_DIR, "src/runtime/task-loop/task-runner.ts"), "utf8");
const splitApplicationSource = readFileSync(resolve(YOLO_DIR, "src/runtime/task-loop/split-application.ts"), "utf8");
const runOrchestratorSource = readFileSync(resolve(YOLO_DIR, "src/runtime/run-lifecycle/run-orchestrator.ts"), "utf8");
const retryRoundSource = readFileSync(resolve(YOLO_DIR, "src/runtime/recovery/retry-round.ts"), "utf8");
const retryOrchestratorSource = readFileSync(resolve(YOLO_DIR, "src/runtime/recovery/retry-orchestrator.ts"), "utf8");
const reviewRoundSource = readFileSync(resolve(YOLO_DIR, "src/runtime/review-loop/round-helpers.ts"), "utf8");
const reviewTaskApplicationSource = readFileSync(resolve(YOLO_DIR, "src/runtime/review-loop/task-application.ts"), "utf8");
const reviewOrchestratorSource = readFileSync(resolve(YOLO_DIR, "src/runtime/review-loop/orchestrator.ts"), "utf8");
const providerAdapterSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/provider-adapter.ts"), "utf8");
const contextPackOutcomeSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/context-pack-outcome.ts"), "utf8");
const executionBaselinesSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/baselines.ts"), "utf8");
const executionChangeSetSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/change-set.ts"), "utf8");
const executionCommitFlowSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/commit-flow.ts"), "utf8");
const deterministicAutoFixSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/deterministic-auto-fix.ts"), "utf8");
const dryRunArtifactSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/dry-run-artifact.ts"), "utf8");
const engineScopeOutcomeSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/engine-scope-outcome.ts"), "utf8");
const exceptionFlowSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/exception-flow.ts"), "utf8");
const exceptionOutcomeSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/exception-outcome.ts"), "utf8");
const gateFailureFlowSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/gate-failure-flow.ts"), "utf8");
const gateFailureOutcomeSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/gate-failure-outcome.ts"), "utf8");
const gateLearningSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/gate-learning.ts"), "utf8");
const gatePassFlowSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/gate-pass-flow.ts"), "utf8");
const gatePassOutcomeSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/gate-pass-outcome.ts"), "utf8");
const postCommitOutcomeSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/post-commit-outcome.ts"), "utf8");
const preSessionFlowSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/pre-session-flow.ts"), "utf8");
const precheckOutcomeSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/precheck-outcome.ts"), "utf8");
const postPrecheckSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/post-precheck.ts"), "utf8");
const sessionAttemptSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/session-attempt.ts"), "utf8");
const sessionFailureOutcomeSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/session-failure-outcome.ts"), "utf8");
const sessionPreGatesSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/session-pre-gates.ts"), "utf8");
const sessionPromptSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/session-prompt.ts"), "utf8");
const worktreeSessionSource = readFileSync(resolve(YOLO_DIR, "src/runtime/execution/worktree-session.ts"), "utf8");
const taskLoopSource = `${runnerSource}\n${outcomeHandlerSource}\n${taskLoopExpansionSource}\n${taskLoopMainSource}\n${taskRunnerSource}\n${splitApplicationSource}`;
const recoverySource = `${runnerSource}\n${runOrchestratorSource}\n${retryRoundSource}\n${retryOrchestratorSource}`;
const reviewLoopSource = `${runnerSource}\n${reviewRoundSource}\n${reviewTaskApplicationSource}\n${reviewOrchestratorSource}`;
const prdSchema = JSON.parse(readFileSync(resolve(YOLO_DIR, "schemas/prd-v2.schema.json"), "utf8"));

describe("runner review fix execution flow", () => {
  test("runner has a fail-closed spec governance gate before execution", () => {
    assert.match(runnerSource, /function\s+runPreExecutionGates/);
    assert.match(runnerSource, /inspectPreExecutionGates\(\{/);
    assert.match(preExecutionGatesSource, /inspectPrdContractDoctorGate\(\{/);
    assert.match(preExecutionGatesSource, /inspectSpecGovernanceGate\(\{\s*prd\s*\}\)/);
    assert.match(specGovernanceGateSource, /requireRequirements:\s*options\.requireRequirements\s*!==\s*false/);
    assert.match(specGovernanceGateSource, /requireDesign:\s*options\.requireDesign\s*!==\s*false/);
    assert.match(specGovernanceGateSource, /requireEvidenceForTerminal:\s*options\.requireEvidenceForTerminal\s*!==\s*false/);
    assert.match(specGovernanceGateSource, /PRD_SPEC_GOVERNANCE_BLOCKED/);
    assert.match(runnerSource, /runPreExecutionGates\(prdPath,\s*\{\s*exitOnFailure:\s*exitOnComplete\s*\}\)/);
  });

  test("context pack failures use a structured outcome helper", () => {
    assert.match(taskRunnerSource, /prepareProviderSession\(\{/);
    assert.match(sessionAttemptSource, /buildContextPackFailureOutcome\(\{/);
    assert.match(contextPackOutcomeSource, /context-pack-validator blocked:/);
    assert.match(contextPackOutcomeSource, /phase:\s*"context_pack"/);
  });

  test("review CLAUDE_FIX tasks re-enter mainLoop with the PRD path", () => {
    assert.match(runnerSource, /runTaskPipeline\(\{/);
    assert.match(runOrchestratorSource, /reviewLoop\(\{/);
    assert.match(reviewOrchestratorSource, /await\s+mainLoop\(prdPath,\s*preCompleted\)/);
    assert.doesNotMatch(reviewOrchestratorSource, /await\s+mainLoop\(\s*\)/);
  });

  test("review mainLoop results are merged into final taskResults", () => {
    assert.match(reviewOrchestratorSource, /mergeReviewResults\(\{\s*taskResults,\s*reviewResults\s*\}\)/);
    assert.match(reviewRoundSource, /appendUnique\(taskResults\.completed,\s*reviewResults\.completed/);
    assert.match(reviewRoundSource, /appendUnique\(taskResults\.failed,\s*reviewResults\.failed/);
    assert.match(reviewRoundSource, /appendUnique\(taskResults\.skipped,\s*reviewResults\.skipped/);
  });

  test("review loops back to scanner after fixes until no findings remain", () => {
    assert.match(reviewOrchestratorSource, /AUTO_FIX 已处理，继续下一轮 review 扫描/);
    assert.match(reviewTaskApplicationSource, /本轮 review 任务已处理，继续下一轮扫描/);
    assert.match(reviewOrchestratorSource, /review fix 未全部完成/);
    assert.match(reviewOrchestratorSource, /无新发现，review 完成/);
  });

  test("merged review tasks preserve source task ids and propagate terminal state", () => {
    assert.match(taskLoopExpansionSource, /base\.merged_from = allIds/);
    assert.match(taskLoopMainSource, /updateMergedSourceTasks\(\{/);
    assert.match(taskLoopSource, /status:\s*"merged_into"/);
    assert.match(taskLoopSource, /merged task completed:/);
    assert.match(taskLoopSource, /merged task skipped:/);
    assert.match(taskLoopSource, /appendUniqueTaskIds\(results\.blocked,\s*sourceIds\)/);
    assert.match(taskLoopSource, /appendUniqueTaskIds\(results\.failed,\s*sourceIds\)/);
  });

  test("review pending detection reloads PRD after mainLoop mutates task statuses", () => {
    assert.match(reviewOrchestratorSource, /const latestPrdAfterReview = loadPRD\(prdPath\)/);
    assert.match(reviewOrchestratorSource, /findPendingReviewTasks\(latestPrdAfterReview\)/);
    assert.match(reviewRoundSource, /task\.id\.startsWith\("FIX-R"\)/);
  });

  test("review task execution errors mark review tasks as failed", () => {
    assert.match(reviewOrchestratorSource, /appendUnique\(taskResults\.failed,\s*\[\.\.\.reviewTaskIds\]\)/);
  });

  test("dry-run PRDs do not enter review task expansion", () => {
    assert.match(reviewRoundSource, /export function isDryRunPrd/);
    assert.match(reviewRoundSource, /export function shouldSkipReviewForPrd/);
    assert.match(reviewOrchestratorSource, /shouldSkipReviewForPrdByPolicy\(prd\)/);
    assert.match(reviewLoopSource, /allow_prd_mutation/);
    assert.match(reviewOrchestratorSource, /禁止 review 自动追加任务污染 PRD/);
  });

  test("review expansion has a hard task limit before PRD mutation", () => {
    assert.match(runnerSource, /MAX_REVIEW_TASKS_PER_ROUND/);
    assert.match(reviewOrchestratorSource, /shouldBlockReviewTaskLimit\(allClaudeTasks\.length,\s*maxReviewTasksPerRound\)/);
    assert.match(reviewTaskApplicationSource, /REVIEW_TASK_LIMIT_BLOCKED/);
    assert.match(reviewTaskApplicationSource, /拒绝写入 PRD/);
  });

  test("dry-run artifact and feature tasks do not use bugfix precheck", () => {
    assert.match(runnerSource, /function\s+shouldRunPrecheck/);
    assert.match(runnerSource, /task\.task_kind === "dry_run_artifact"/);
    assert.match(runnerSource, /\["feature",\s*"cleanup"\]\.includes\(task\.type\)/);
    assert.match(taskRunnerSource, /handlePreSessionFlow\(\{/);
    assert.match(preSessionFlowSource, /attempt === 0 && shouldRunPrecheck\(task\)/);
  });

  test("atomic task doctor blockers use a structured outcome helper", () => {
    assert.match(taskRunnerSource, /handlePreSessionFlow\(\{/);
    assert.match(preSessionFlowSource, /atomicDoctorBlockBuilder = buildAtomicDoctorBlockOutcome/);
    assert.match(atomicDoctorOutcomeSource, /atomic_task_must_split/);
    assert.match(atomicDoctorOutcomeSource, /atomic_task_doctor_failed/);
    assert.match(atomicDoctorOutcomeSource, /split_applied/);
  });

  test("dry-run artifacts hard-fail missed scope targets and out-of-scope writes", () => {
    assert.match(worktreeSessionSource, /function\s+isFileInScopeTargets/);
    assert.match(gatePassFlowSource, /cleanupWorktree\(wt\.path,\s*wt\.branch,\s*true,\s*task\.scope/);
    assert.match(worktreeSessionSource, /existsSync\(join\(wtPath,\s*targetPath\)\)/);
    assert.match(runnerSource, /runTaskCommitFlow\(\{/);
    assert.match(executionCommitFlowSource, /buildDryRunOutOfScopeBlock\(\{/);
    assert.match(executionCommitFlowSource, /buildOutOfScopeBlock\(\{/);
    assert.match(executionCommitFlowSource, /buildCommitSkipDecision\(\{/);
    assert.match(executionCommitFlowSource, /task\.task_kind !== "dry_run_artifact" \|\| outOfScope\.length === 0/);
    assert.match(executionCommitFlowSource, /dry-run artifact 已写入工作区/);
    assert.match(executionCommitFlowSource, /skippedCommit: true/);
    assert.match(executionCommitFlowSource, /blockReason: `out_of_scope_files:/);
    assert.match(gatePassFlowSource, /buildPostCommitOutcome\(\{/);
    assert.match(postCommitOutcomeSource, /task\.task_kind === "dry_run_artifact" && baseRecord\.scope_targets_missed\?\.length > 0/);
    assert.match(postCommitOutcomeSource, /scope targets missed:/);
  });

  test("allow_new_files permits new files beside scoped targets without opening all src", () => {
    assert.match(worktreeSessionSource, /function\s+isFileAllowedByScope/);
    assert.match(worktreeSessionSource, /scope\.allow_new_files !== true/);
    assert.match(worktreeSessionSource, /`\$\{dirname\(target\)\}\/`/);
    assert.match(gatePassFlowSource, /cleanupWorktree\(wt\.path,\s*wt\.branch,\s*true,\s*task\.scope/);
    assert.match(worktreeSessionSource, /!isFileAllowedByScope\(filePath,\s*allowedScope\)/);
    assert.match(runnerSource, /buildCommitChangeContext\(\{\s*rootDir:\s*ROOT,\s*task,\s*worktreeFiles,\s*isFileAllowedByScope,\s*\}\)/);
    assert.match(executionChangeSetSource, /scopedOutOfScopeFiles\(code,\s*task,\s*\{\s*isFileAllowedByScope,\s*\}\)/);
    assert.match(executionChangeSetSource, /!isFileAllowedByScope\(file,\s*scope\)/);
  });

  test("worktree merge is based on task base commit instead of dirty root state", () => {
    assert.match(worktreeSessionSource, /baseCommit = execSync\("git rev-parse HEAD"/);
    assert.match(worktreeSessionSource, /return \{ branch: wtBranch,\s*path: wtPath,\s*base: baseCommit,\s*mode: "git" \}/);
    assert.match(runnerSource, /function cleanupWorktree\(wtPath,\s*wtBranch,\s*mergeToMain = false,\s*allowedScope = \[\],\s*baseRef = null\)/);
    assert.match(worktreeSessionSource, /\["diff",\s*"--name-status",\s*baseRef,\s*"HEAD"\]/);
    assert.match(gatePassFlowSource, /cleanupWorktree\(wt\.path,\s*wt\.branch,\s*true,\s*task\.scope[^)]*wt\.base\)/);
    assert.doesNotMatch(runnerSource, /diff HEAD~1 --name-only/);
    assert.doesNotMatch(runnerSource, /git diff --stat/);
  });

  test("merge verification and stray warning use copied files and scope rules", () => {
    assert.match(worktreeSessionSource, /\["diff",\s*"--name-only",\s*"--",\s*\.\.\.copiedFiles\]/);
    assert.match(worktreeSessionSource, /\["ls-files",\s*"--others",\s*"--exclude-standard",\s*"--",\s*\.\.\.copiedFiles\]/);
    assert.match(worktreeSessionSource, /合并验证通过: \$\{changedCopied\.size\}\/\$\{copiedFiles\.length\} 个本次复制文件有改动/);
    assert.match(runnerSource, /applyScopeAudit\(\{/);
    assert.match(executionCommitFlowSource, /buildScopeAuditDecision\(\{\s*task,\s*outOfScope,\s*targetFiles,\s*modified\s*\}\)/);
    assert.match(executionCommitFlowSource, /工作区存在非本次任务文件: \$\{outOfScope\.join\("、"\)\}/);
    assert.match(executionChangeSetSource, /outOfScope: files\.filter\(\(file\) => !isFileAllowedByScope\(file,\s*scope\)\)/);
  });

  test("dry-run retry completion is synced back only after postconditions pass", () => {
    assert.match(runOrchestratorSource, /retryPhase\(\{/);
    assert.match(retryOrchestratorSource, /await\s+mainLoop\(retryPrdPath,\s*retryCompleted\)/);
    assert.match(recoverySource, /completedViaRetry: true/);
    assert.match(recoverySource, /retry 声称完成，但主工作区 post_conditions 未满足/);
    assert.match(runnerSource, /taskPostconditionsPass/);
  });

  test("all coding tasks must pass postconditions before merge and before done", () => {
    assert.match(taskRunnerSource, /handleGatePassFlow\(\{/);
    assert.match(gatePassFlowSource, /buildPreMergePostconditionFailureOutcome\(\{/);
    assert.match(gatePassOutcomeSource, /post_conditions failed before merge/);
    assert.match(gatePassFlowSource, /taskPostconditionsPass\(task,\s*prdForPreMergePostCheck,\s*wt\.path\)/);
    assert.match(gatePassFlowSource, /shouldRunPostCommitPostconditions\(commitResult\)/);
    assert.match(gatePassFlowSource, /buildPostCommitOutcome\(\{/);
    assert.match(postCommitOutcomeSource, /post_conditions failed:/);
    assert.match(postCommitOutcomeSource, /passTaskTransition/);
    assert.match(runnerSource, /setContractRoot\(ROOT\)/);
    assert.match(runnerSource, /function\s+taskPostconditionsPass\(task,\s*prd,\s*contractRoot = ROOT\)/);
    assert.doesNotMatch(runnerSource, /if \(task\.task_kind === "dry_run_artifact"\) \{\s*const prdForCheck = loadPRD\(prdPath\)/);
  });

  test("dry-run artifacts under state/dry-run are not blocked as engine self-modification", () => {
    assert.match(taskRunnerSource, /handlePreSessionFlow\(\{/);
    assert.match(preSessionFlowSource, /engineBlockBuilder = buildEngineSelfModificationBlockOutcome/);
    assert.match(engineScopeOutcomeSource, /isAllowedDryRunArtifactTarget/);
    assert.match(engineScopeOutcomeSource, /scripts\/yolo\/state\/dry-run\//);
    assert.match(engineScopeOutcomeSource, /engine_self_modify_blocked/);
    assert.match(engineScopeOutcomeSource, /&& !isAllowedDryRunArtifactTarget\(task,\s*file\)/);
  });

  test("dry-run artifacts can be produced deterministically without wasting model calls", () => {
    assert.match(taskRunnerSource, /handlePreSessionFlow\(\{/);
    assert.match(preSessionFlowSource, /dryRunTaskCompleter = completeDryRunArtifactTask/);
    assert.match(preSessionFlowSource, /dryRunTaskCompleter\(\{/);
    assert.match(dryRunArtifactSource, /deterministic dry_run_artifact producer/);
    assert.match(preSessionFlowSource, /config\.runner\?\.deterministic_dry_run_artifacts !== false/);
    assert.match(dryRunArtifactSource, /scope_targets_touched: \[target\]/);
  });

  test("deterministic auto-fix tasks are handled outside the runner loop body", () => {
    assert.match(taskRunnerSource, /handlePreSessionFlow\(\{/);
    assert.match(preSessionFlowSource, /deterministicAutoFix = tryDeterministicAutoFixTask/);
    assert.match(preSessionFlowSource, /deterministicAutoFix\(\{/);
    assert.match(deterministicAutoFixSource, /normalizeAutoFixTask/);
    assert.match(deterministicAutoFixSource, /applyAutoFixTasks/);
    assert.match(deterministicAutoFixSource, /deterministic_auto_fix/);
    assert.match(deterministicAutoFixSource, /回退 provider/);
  });

  test("runner auto-detects Claude or Codex provider without separate project setup", () => {
    assert.match(runnerSource, /function\s+detectModelProvider/);
    assert.match(runnerSource, /detectModelProvider as detectProvider/);
    assert.match(runnerSource, /provider-doctor\.js/);
    assert.match(runnerSource, /detectRunnerModelProvider\(\{/);
    assert.match(runnerTaskRuntimeBindingsSource, /return detectProvider\(\{/);
    assert.match(runnerSource, /function\s+spawnProvider/);
    assert.match(runnerSource, /spawnProviderPrompt/);
    assert.match(providerAdapterSource, /codex/);
    assert.match(providerAdapterSource, /exec/);
    assert.match(providerAdapterSource, /--output-last-message/);
    assert.match(providerAdapterSource, /codex_sandbox/);
    assert.match(providerAdapterSource, /codex_approval/);
    assert.match(sessionPreGatesSource, /buildProviderFailureOutcome\(\{/);
    assert.match(providerAdapterSource, /provider_budget_exceeded/);
    assert.match(sessionFailureOutcomeSource, /provider_budget/);
  });

  test("session failure outcomes are handled outside the runner loop body", () => {
    assert.match(taskRunnerSource, /inspectSessionPreGateChecks\(\{/);
    assert.match(sessionPreGatesSource, /buildDiffQualityFailureOutcome\(\{/);
    assert.match(sessionPreGatesSource, /buildTestGenerationFailureOutcome\(\{/);
    assert.match(sessionFailureOutcomeSource, /diff-quality-gate blocked:/);
    assert.match(sessionFailureOutcomeSource, /test-generation-validator blocked:/);
  });

  test("runTask exception outcomes are handled outside the runner loop body", () => {
    assert.match(taskRunnerSource, /handleRunTaskExceptionFlow\(\{/);
    assert.match(exceptionFlowSource, /buildRunTaskExceptionOutcome\(\{/);
    assert.match(exceptionFlowSource, /cleanupWorktree\(currentWorktree\.path,\s*currentWorktree\.branch,\s*false\)/);
    assert.match(exceptionFlowSource, /await sleep\(exceptionOutcome\.sleepMs\)/);
    assert.match(exceptionOutcomeSource, /连续异常停机/);
    assert.match(exceptionOutcomeSource, /max_retry_exception/);
  });

  test("gate failure retry decisions are handled outside the runner loop body", () => {
    assert.match(taskRunnerSource, /handleGateFailureFlow\(\{/);
    assert.match(gateFailureFlowSource, /buildGateFailureRetryDecision/);
    assert.match(gateFailureOutcomeSource, /contract_suspect/);
    assert.match(gateFailureOutcomeSource, /max_retry/);
    assert.match(gateFailureOutcomeSource, /连续 2 次同 gate code 失败/);
  });

  test("prompt session retry context is built outside the runner loop body", () => {
    assert.match(taskRunnerSource, /prepareProviderSession\(\{/);
    assert.match(sessionAttemptSource, /buildPromptSession\(\{/);
    assert.match(sessionPromptSource, /buildFailureHint/);
    assert.match(sessionPromptSource, /--learnings=/);
    assert.match(sessionPromptSource, /文件超过 150 行限制/);
  });

  test("gate failure learning side effects are handled outside the runner loop body", () => {
    assert.match(gateFailureFlowSource, /applyGateFailureLearningEffects/);
    assert.match(gateFailureFlowSource, /gateFailureLearnArgs/);
    assert.match(gateLearningSource, /learn\.js/);
    assert.match(gateLearningSource, /incrementRetryCountFile/);
  });

  test("runner uses structured skip semantics instead of treating every skipped task as done", () => {
    assert.match(runnerSource, /function\s+taskCountsAsCompleted/);
    assert.match(runnerSource, /valid_skip_already_satisfied/);
    assert.match(taskLoopSource, /dependency_blocked/);
    assert.match(taskLoopSource, /blocked_skip_missing_evidence/);
    assert.match(taskLoopSource, /counts_as_completed:\s*true/);
    assert.match(taskLoopSource, /blocked_by:\s*deps/);
    assert.doesNotMatch(runnerSource, /filter\(t => t\.status === 'done' \|\| t\.status === 'skipped'\)/);
  });

  test("valid skips must pass postconditions before counting as completed", () => {
    assert.match(runnerSource, /function\s+skippedTaskPostconditionsPass/);
    assert.match(postPrecheckSource, /expected_zero_business_code:\s*true/);
    assert.match(precheckOutcomeSource, /precheck 想跳过，但 post_conditions 未满足/);
    assert.match(taskRunnerSource, /handlePreSessionFlow\(\{/);
    assert.match(preSessionFlowSource, /buildPrecheckValidSkipOutcome\(\{/);
    assert.match(precheckOutcomeSource, /PRE-CHECK SKIP/);
    assert.match(precheckOutcomeSource, /postcondition_verified:\s*true/);
    assert.match(preSessionFlowSource, /postPrecheckInspector = inspectPostPrecheckSkip/);
    assert.match(preSessionFlowSource, /postPrecheckInspector\(\{/);
    assert.match(postPrecheckSource, /code_contains/);
    assert.match(postPrecheckSource, /target_tsc_errors/);
    assert.match(taskLoopSource, /invalid_skip_postconditions_failed/);
  });

  test("eslint baseline keys are normalized before comparison", () => {
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
