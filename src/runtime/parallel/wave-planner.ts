import { isSafePathComponent } from "../../lib/security/path-guard.js";
import { PARALLEL_WAVE_PASS_STATUSES } from "../../lib/status-vocab.js";

export const CONTROLLED_PARALLEL_SCHEMA_VERSION = "1.0";
export const CONTROLLED_PARALLEL_PLAN_SCHEMA = "yolo.runtime.controlled_parallel_plan.v1";
export const CONTROLLED_PARALLEL_MERGE_GATE_SCHEMA = "yolo.runtime.parallel_merge_gate.v1";
export const CONTROLLED_PARALLEL_EVIDENCE_SCHEMA = "yolo.runtime.parallel_evidence_merge.v1";
export const CONTROLLED_PARALLEL_WAVE_START_GATE_SCHEMA = "yolo.runtime.parallel_wave_start_gate.v1";

const SAFE_TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === "") return [];
  return [value];
}

function normalizePath(value = "") {
  return clean(value).replace(/\\/g, "/").replace(/^\.\//, "").replace(/:\d+(?:-\d+)?$/, "");
}

function taskId(task = Object()) {
  return clean(task.id || task.task_id);
}

function unsafeTaskIdBlocker(task = Object(), index = 0) {
  const id = taskId(task);
  if (!id) {
    return {
      code: "PARALLEL_UNSAFE_TASK_ID",
      message: "Parallel task id must be a non-empty safe path component before deriving worktree paths or branch names.",
      task_id: null,
      task_index: index,
      reason: "empty",
    };
  }
  if (!isSafePathComponent(id) || !SAFE_TASK_ID_PATTERN.test(id)) {
    return {
      code: "PARALLEL_UNSAFE_TASK_ID",
      message: "Parallel task id must be a non-empty safe path component before deriving worktree paths or branch names.",
      task_id: id,
      task_index: index,
      reason: "unsafe_path_component",
    };
  }
  return null;
}

function taskHasSafeId(task = Object(), index = 0) {
  return unsafeTaskIdBlocker(task, index) === null;
}

function taskStatus(task = Object()) {
  return clean(task.status || "pending").toLowerCase();
}

function taskTargets(task = Object()) {
  return [
    ...asArray(task.scope?.targets).map((target) => normalizePath(target.file || target.path || target)),
    ...asArray(task.files).map(normalizePath),
    ...asArray(task.target_files).map(normalizePath),
  ].filter(Boolean);
}

function taskDependencies(task = Object()) {
  return asArray(task.depends_on || task.dependencies).map(String).filter(Boolean);
}

function taskKind(task = Object()) {
  const text = [task.type, task.task_kind, task.title, task.description].filter(Boolean).join(" ").toLowerCase();
  if (/review|审查/.test(text)) return "review";
  if (/accept|qa|ui|验收/.test(text)) return "qa";
  return "implementation";
}

function agentForTask(task = Object()) {
  const kind = taskKind(task);
  if (kind === "review") return "reviewer-agent";
  if (kind === "qa") return "qa-agent";
  return "implementer-agent";
}

function taskCanRun(task = Object()) {
  return !["done", "completed", "skipped", "merged_into"].includes(taskStatus(task));
}

function intersects(a = [], b = []) {
  const set = new Set(a);
  return b.filter((item) => set.has(item));
}

function isExclusiveTask(task = Object()) {
  const targets = taskTargets(task);
  if (targets.length === 0) return true;
  if (task.parallel === false || task.allow_parallel === false) return true;
  if (task.scope?.exclusive === true || task.scope?.serial === true) return true;
  return false;
}

function conflictBetween(left = Object(), right = Object()) {
  const leftTargets = taskTargets(left);
  const rightTargets = taskTargets(right);
  const shared = intersects(leftTargets, rightTargets);
  if (shared.length > 0) {
    return {
      code: "PARALLEL_FILE_SCOPE_CONFLICT",
      message: "Tasks modify overlapping scope targets and cannot run in the same wave.",
      task_ids: [taskId(left), taskId(right)],
      files: shared,
    };
  }
  if (isExclusiveTask(left) || isExclusiveTask(right)) {
    return {
      code: "PARALLEL_EXCLUSIVE_TASK",
      message: "Unscoped or explicitly serial tasks cannot share a parallel wave.",
      task_ids: [taskId(left), taskId(right)],
      files: [],
    };
  }
  return null;
}

export function detectParallelConflicts(tasks = []) {
  const conflicts = [];
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const conflict = conflictBetween(tasks[leftIndex], tasks[rightIndex]);
      if (conflict) conflicts.push(conflict);
    }
  }
  return conflicts;
}

export function buildTaskDependencyGraph(input = Object()) {
  const sourceTasks = asArray(input.tasks || input.prd?.tasks);
  const idBlockers = sourceTasks.map(unsafeTaskIdBlocker).filter(Boolean);
  const tasks = sourceTasks.filter(taskHasSafeId);
  const ids = new Set(tasks.map(taskId));
  const nodes = tasks.map((task) => {
    const dependencies = taskDependencies(task);
    const targets = taskTargets(task);
    return {
      id: taskId(task),
      status: taskStatus(task),
      dependencies,
      missing_dependencies: dependencies.filter((dependency) => !ids.has(dependency)),
      targets,
      exclusive: isExclusiveTask(task),
      agent_id: agentForTask(task),
      runnable: taskCanRun(task),
    };
  });
  const edges = nodes.flatMap((node) => node.dependencies.map((dependency) => ({
    from: dependency,
    to: node.id,
  })));
  const missing = nodes.flatMap((node) => node.missing_dependencies.map((dependency) => ({
    code: "TASK_DEPENDENCY_MISSING",
    message: "Task depends on an id that is not present in the PRD.",
    task_id: node.id,
    dependency_id: dependency,
  })));
  return {
    schema_version: CONTROLLED_PARALLEL_SCHEMA_VERSION,
    schema: "yolo.runtime.task_dependency_graph.v1",
    nodes,
    edges,
    blockers: [...idBlockers, ...missing],
  };
}

function canJoinWave(task: Record<string, unknown>, waveTasks: Record<string, unknown>[]) {
  return !waveTasks.some((existing) => conflictBetween(task, existing));
}

function worktreeForTask({ task, waveIndex, worktreeRoot }: { task: Record<string, unknown>; waveIndex: number; worktreeRoot: string }) {
  const id = taskId(task);
  return {
    task_id: id,
    path: `${worktreeRoot}/${id}`,
    branch: `yolo-${id}-wave-${waveIndex}`,
    isolation: "git_worktree",
    merge_back: "copy_scoped_files_after_gate",
  };
}

function statusIsPass(value: unknown): boolean {
  return PARALLEL_WAVE_PASS_STATUSES.has(clean(value).toLowerCase());
}

function passedWaveIdsFromReports(waveReports = []) {
  return new Set(asArray(waveReports)
    .filter((report) => statusIsPass(report.status))
    .map((report) => clean(report.wave_id || report.waveId || report.id))
    .filter(Boolean));
}

function waveIdsBefore(waves = [], wave = Object()) {
  return asArray(waves)
    .filter((candidate) => Number(candidate.index || 0) < Number(wave.index || 0))
    .map((candidate) => candidate.id)
    .filter(Boolean);
}

export function inspectParallelWaveStartGate(input = Object(), options = Object()) {
  const wave = input.wave || {};
  const waves = asArray(input.waves || input.plan?.waves || options.waves || options.plan?.waves);
  const completed = new Set(asArray(input.completedTaskIds || input.completed_task_ids || options.completedTaskIds || options.completed_task_ids).map(clean));
  const passedTasks = new Set(asArray(input.passedTaskIds || input.passed_task_ids || options.passedTaskIds || options.passed_task_ids).map(clean));
  const passedWaves = new Set([
    ...asArray(input.passedWaveIds || input.passed_wave_ids || options.passedWaveIds || options.passed_wave_ids).map(clean),
    ...passedWaveIdsFromReports(input.waveReports || input.wave_reports || options.waveReports || options.wave_reports),
  ]);
  const taskById = new Map(asArray(input.tasks || input.prd?.tasks || options.tasks || options.prd?.tasks).map((task) => [taskId(task), task]));
  const blockers = [];

  for (const previousWaveId of waveIdsBefore(waves, wave)) {
    if (!passedWaves.has(previousWaveId)) {
      blockers.push({
        code: "PARALLEL_PREVIOUS_WAVE_NOT_PASSED",
        message: "A later wave cannot start until every previous wave has terminal pass evidence.",
        wave_id: wave.id || null,
        dependency_wave_id: previousWaveId,
      });
    }
  }

  for (const id of asArray(wave.task_ids).map(clean)) {
    const task = taskById.get(id);
    for (const dependency of taskDependencies(task)) {
      if (!completed.has(dependency) && !passedTasks.has(dependency)) {
        blockers.push({
          code: "PARALLEL_DEPENDENCY_NOT_PASSED",
          message: "Task dependency requires pass evidence before this wave can start.",
          wave_id: wave.id || null,
          task_id: id,
          dependency_id: dependency,
        });
      }
    }
  }

  return {
    schema_version: CONTROLLED_PARALLEL_SCHEMA_VERSION,
    schema: CONTROLLED_PARALLEL_WAVE_START_GATE_SCHEMA,
    status: blockers.length > 0 ? "blocked" : "pass",
    wave_id: wave.id || null,
    can_start: blockers.length === 0,
    blockers,
  };
}

function waveRecord({ waveIndex, tasks, worktreeRoot }: { waveIndex: number; tasks: Record<string, unknown>[]; worktreeRoot: string }) {
  const conflicts = detectParallelConflicts(tasks);
  return {
    id: `wave-${String(waveIndex).padStart(2, "0")}`,
    index: waveIndex,
    status: conflicts.length > 0 ? "blocked" : "planned",
    task_ids: tasks.map(taskId),
    agents: tasks.map((task) => ({
      task_id: taskId(task),
      agent_id: agentForTask(task),
      may_edit_code: agentForTask(task) === "implementer-agent",
    })),
    worktrees: tasks.map((task) => worktreeForTask({ task, waveIndex, worktreeRoot })),
    merge_gate: {
      required_after_wave: ["task_result_pass", "post_conditions_pass", "scope_merge_clean", "review_or_skip_recorded", "evidence_recorded"],
      fail_closed: true,
    },
    conflicts,
  };
}

function findCyclicTaskIds(tasks = []) {
  const taskIds = new Set(tasks.map(taskId));
  const adjacency = new Map(tasks.map((task) => [taskId(task), taskDependencies(task).filter((dep) => taskIds.has(dep))]));
  const cyclic = new Set();
  for (const start of taskIds) {
    if (cyclic.has(start)) continue;
    const stack = [{ id: start, path: new Set([start]) }];
    while (stack.length > 0) {
      const { id, path } = stack.pop();
      for (const next of adjacency.get(id) || []) {
        if (path.has(next)) {
          for (const node of path) cyclic.add(node);
          cyclic.add(next);
          continue;
        }
        stack.push({ id: next, path: new Set([...path, next]) });
      }
    }
  }
  return cyclic;
}

export function planControlledParallelWaves(input = Object(), options = Object()) {
  const projectRoot = clean(input.projectRoot || input.project_root || options.projectRoot || options.project_root || process.cwd());
  const worktreeRoot = normalizePath(input.worktreeRoot || input.worktree_root || options.worktreeRoot || options.worktree_root || `${projectRoot}/../.yolo-worktrees`);
  const graph = buildTaskDependencyGraph(input);
  const tasks = asArray(input.tasks || input.prd?.tasks).filter((task, index) => taskHasSafeId(task, index) && taskCanRun(task));
  const taskById = new Map(tasks.map((task) => [taskId(task), task]));
  const completed = new Set(asArray(input.completedTaskIds || input.completed_task_ids));
  for (const node of graph.nodes) {
    if (!taskCanRun({ status: node.status })) completed.add(node.id);
  }
  const planned = new Set();
  const waves: Array<ReturnType<typeof waveRecord> & { start_gate?: ReturnType<typeof inspectParallelWaveStartGate> }> = [];
  const blockers = [...graph.blockers];
  let guard = 0;

  while (planned.size < tasks.length && guard < tasks.length + 5) {
    guard += 1;
    const ready = tasks.filter((task) => {
      const id = taskId(task);
      if (planned.has(id)) return false;
      return taskDependencies(task).every((dependency) => completed.has(dependency));
    });
    if (ready.length === 0) break;

    const waveTasks = [];
    for (const task of ready) {
      if (canJoinWave(task, waveTasks)) waveTasks.push(task);
    }
    if (waveTasks.length === 0) break;

    const waveIndex = waves.length + 1;
    const wave = waveRecord({ waveIndex, tasks: waveTasks, worktreeRoot });
    waves.push(wave);
    for (const task of waveTasks) planned.add(taskId(task));
  }

  const unscheduled = tasks.filter((task) => !planned.has(taskId(task)));
  const cyclicTaskIds = findCyclicTaskIds(tasks);
  for (const task of unscheduled) {
    const id = taskId(task);
    const dependencies = taskDependencies(task);
    const missing = dependencies.filter((dependency) => !taskById.has(dependency) && !completed.has(dependency));
    if (missing.length > 0) {
      blockers.push(Object.assign(Object(), {
        code: "TASK_DEPENDENCY_MISSING",
        message: "Task has missing dependencies and cannot be scheduled.",
        task_id: id,
        dependencies,
        missing_dependencies: missing,
      }));
      continue;
    }
    // Dependency exists but has not completed yet, and the task is not part of a real cycle:
    // this is a legitimate sequential dependency, not a deadlock. Report a recoverable path.
    if (!cyclicTaskIds.has(id)) {
      const pendingDependencies = dependencies.filter((dependency) => !completed.has(dependency));
      blockers.push(Object.assign(Object(), {
        code: "TASK_DEPENDENCY_NOT_YET_COMPLETED",
        message: `Task depends on prerequisite(s) that exist but have not yet completed with pass evidence. Run and pass the dependency task(s) first: ${pendingDependencies.join(", ")}.`,
        task_id: id,
        dependencies,
        missing_dependencies: [],
        pending_dependencies: pendingDependencies,
      }));
      continue;
    }
    blockers.push(Object.assign(Object(), {
      code: "TASK_DEPENDENCY_CYCLE_OR_BLOCKED",
      message: "Task dependencies cannot be satisfied without a cycle or blocked predecessor.",
      task_id: id,
      dependencies,
      missing_dependencies: missing,
    }));
  }

  const startGates = waves.map((wave) => inspectParallelWaveStartGate({
    wave,
    waves,
    tasks: input.tasks || input.prd?.tasks,
    completedTaskIds: [...completed],
    passedTaskIds: input.passedTaskIds || input.passed_task_ids,
    passedWaveIds: input.passedWaveIds || input.passed_wave_ids,
    waveReports: input.waveReports || input.wave_reports,
  }));
  for (const wave of waves) {
    const startGate = startGates.find((gate) => gate.wave_id === wave.id);
    wave.start_gate = startGate;
    if (startGate?.status === "blocked") wave.status = "waiting_previous_pass_evidence";
  }

  const startGateBlockers = startGates.flatMap((gate) => gate.blockers.map((blocker) => ({ ...blocker, wave_id: gate.wave_id })));
  const waveConflicts = waves.flatMap((wave) => wave.conflicts.map((conflict) => ({ ...conflict, wave_id: wave.id })));
  const status = blockers.length > 0 || waveConflicts.length > 0 ? "blocked" : "pass";
  const executionStatus = status === "blocked" || startGateBlockers.length > 0 ? "blocked" : "pass";
  const notYetCompletedPrereqs = [...new Set(
    blockers
      .filter((blocker) => blocker.code === "TASK_DEPENDENCY_NOT_YET_COMPLETED")
      .flatMap((blocker) => (blocker as { pending_dependencies?: string[] }).pending_dependencies || []),
  )].sort();
  const hasUnrecoverableBlockers = blockers.some((blocker) => blocker.code !== "TASK_DEPENDENCY_NOT_YET_COMPLETED")
    || waveConflicts.length > 0
    || startGateBlockers.length > 0;
  let nextActions;
  if (status === "pass" && executionStatus === "pass") {
    nextActions = ["Execute waves sequentially; tasks inside each wave may run in isolated worktrees, then pass the merge gate before the next wave."];
  } else if (status === "pass") {
    nextActions = ["Run only waves whose start_gate is pass; later waves require previous wave merge evidence before start."];
  } else if (notYetCompletedPrereqs.length > 0 && !hasUnrecoverableBlockers) {
    nextActions = [
      `Run and pass the prerequisite task(s) first, then re-plan: ${notYetCompletedPrereqs.join(", ")}. Once each dependency has completed with pass evidence, its dependents become schedulable.`,
    ];
  } else if (notYetCompletedPrereqs.length > 0) {
    nextActions = [
      `Run and pass the prerequisite task(s) first, then re-plan: ${notYetCompletedPrereqs.join(", ")}.`,
      "Resolve any remaining dependency cycle, missing dependency, or conflict blockers before enabling parallel execution.",
    ];
  } else {
    nextActions = ["Fix dependency or conflict blockers before enabling parallel execution."];
  }
  return {
    schema_version: CONTROLLED_PARALLEL_SCHEMA_VERSION,
    schema: CONTROLLED_PARALLEL_PLAN_SCHEMA,
    status,
    project_root: projectRoot,
    worktree_root: worktreeRoot,
    task_count: tasks.length,
    wave_count: waves.length,
    execution_status: executionStatus,
    start_gates: startGates,
    graph,
    waves,
    blockers: [...blockers, ...waveConflicts],
    execution_blockers: startGateBlockers,
    policies: {
      dependency_policy: "dependencies must have completed task pass evidence before scheduling or starting a dependent wave",
      conflict_policy: "overlapping target files or exclusive/unscoped tasks cannot share a wave",
      merge_policy: "each wave must pass merge gate before the next wave starts",
      rollback_policy: "failed wave worktrees are removed without copying files back to mainline",
      retry_policy: "retry only the failed task or wave after fixing the blocker; do not continue later waves",
      escalation_policy: "stop on missing dependency, repeated gate failure, merge conflict, or review blocker",
    },
    next_actions: nextActions,
  };
}

export const buildControlledParallelExecutionPlan = planControlledParallelWaves;

function reportForTask(taskIdValue: string, taskReports = []) {
  return taskReports.find((report) => clean(report.task_id || report.taskId || report.id) === taskIdValue);
}

export function inspectParallelMergeGate(input = Object(), options = Object()) {
  const wave = input.wave || {};
  const taskReports = asArray(input.taskReports || input.task_reports || options.taskReports || options.task_reports);
  const blockers = [];
  const taskChecks = asArray(wave.task_ids).map((id) => {
    const report = reportForTask(id, taskReports);
    const gateStatus = report?.gate_status || report?.gate?.status || report?.post_conditions_status || report?.status;
    const reviewStatus = report?.review_status || report?.review?.status || (report?.review_skipped === true ? "pass" : report?.status);
    const scopeClean = report?.scope_merge_clean !== false && asArray(report?.out_of_scope_files).length === 0;
    const evidenceRecorded = asArray(report?.evidence_refs || report?.artifacts || report?.evidence).length > 0;
    const passed = Boolean(report) && statusIsPass(report.status) && statusIsPass(gateStatus) && statusIsPass(reviewStatus) && scopeClean && evidenceRecorded;
    if (!report) blockers.push({ code: "PARALLEL_TASK_REPORT_MISSING", message: "Wave task is missing a task report.", task_id: id });
    else if (!statusIsPass(report.status)) blockers.push({ code: "PARALLEL_TASK_NOT_PASS", message: "Wave task did not complete successfully.", task_id: id, status: report.status });
    else if (!statusIsPass(gateStatus)) blockers.push({ code: "PARALLEL_GATE_NOT_PASS", message: "Wave task gate did not pass.", task_id: id, gate_status: gateStatus });
    else if (!statusIsPass(reviewStatus)) blockers.push({ code: "PARALLEL_REVIEW_NOT_PASS", message: "Wave task review did not pass or record a skip.", task_id: id, review_status: reviewStatus });
    else if (!scopeClean) blockers.push({ code: "PARALLEL_SCOPE_MERGE_DIRTY", message: "Wave task merge had out-of-scope files.", task_id: id, out_of_scope_files: report.out_of_scope_files || [] });
    else if (!evidenceRecorded) blockers.push({ code: "PARALLEL_EVIDENCE_MISSING", message: "Wave task is missing evidence references.", task_id: id });
    return {
      task_id: id,
      passed,
      status: report?.status || "missing",
      gate_status: gateStatus || "missing",
      review_status: reviewStatus || "missing",
      scope_merge_clean: scopeClean,
      evidence_recorded: evidenceRecorded,
    };
  });
  for (const conflict of asArray(input.conflicts || wave.conflicts)) {
    blockers.push({ ...conflict, code: conflict.code || "PARALLEL_WAVE_CONFLICT" });
  }
  const status = blockers.length > 0 ? "blocked" : "pass";
  return {
    schema_version: CONTROLLED_PARALLEL_SCHEMA_VERSION,
    schema: CONTROLLED_PARALLEL_MERGE_GATE_SCHEMA,
    status,
    wave_id: wave.id || null,
    task_checks: taskChecks,
    blockers,
    next_actions: status === "pass"
      ? ["Merge scoped files, record wave evidence, then continue to the next wave."]
      : ["Stop this wave, discard failed worktrees, and retry only after blockers are fixed."],
  };
}

export function mergeParallelEvidence(input = Object(), options = Object()) {
  const waves = asArray(input.waves || input.plan?.waves || options.waves);
  const taskReports = asArray(input.taskReports || input.task_reports || options.taskReports || options.task_reports);
  const waveReports = waves.map((wave) => inspectParallelMergeGate({ wave, taskReports }));
  const blockers = waveReports.flatMap((report) => report.blockers.map((blocker) => ({ ...blocker, wave_id: report.wave_id })));
  const artifacts = [...new Set(taskReports.flatMap((report) => asArray(report.evidence_refs || report.artifacts || report.evidence)))];
  return {
    schema_version: CONTROLLED_PARALLEL_SCHEMA_VERSION,
    schema: CONTROLLED_PARALLEL_EVIDENCE_SCHEMA,
    status: blockers.length > 0 ? "blocked" : "pass",
    wave_count: waves.length,
    task_report_count: taskReports.length,
    wave_reports: waveReports,
    blockers,
    artifacts,
    summary: {
      waves_passed: waveReports.filter((report) => report.status === "pass").length,
      waves_blocked: waveReports.filter((report) => report.status === "blocked").length,
      artifacts: artifacts.length,
    },
    next_actions: blockers.length === 0
      ? ["Attach merged evidence to the run report and continue review/acceptance."]
      : ["Do not merge later waves until blocked wave evidence is fixed."],
  };
}

export function formatControlledParallelPlanText(plan = Object()) {
  const lines = [`[yolo parallel] ${plan.status}: ${plan.wave_count || 0} wave(s), ${plan.task_count || 0} task(s)`];
  for (const wave of asArray(plan.waves)) {
    lines.push(`- ${wave.id}: ${wave.task_ids.join(", ")} (${wave.status})`);
  }
  for (const blocker of asArray(plan.blockers).slice(0, 10)) {
    lines.push(`blocker: ${blocker.code}${blocker.task_id ? ` task=${blocker.task_id}` : ""} ${blocker.message || ""}`.trim());
  }
  if (plan.next_actions?.length) {
    lines.push("next:");
    for (const action of plan.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}
