export function shouldBlockReviewTaskLimit(taskCount, maxTasks) {
  return taskCount > maxTasks;
}

function appendUniqueFallback(target, items = []) {
  for (const item of items) {
    if (!target.includes(item)) target.push(item);
  }
}

export function buildReviewTaskLimitBlock({ round, taskCount, maxTasks, taskIds = [] }) {
  const blockerId = `REVIEW-TASK-LIMIT-R${round}`;
  return {
    blockerId,
    message: `本轮将生成 ${taskCount} 个 CLAUDE_FIX，超过上限 ${maxTasks}，拒绝写入 PRD`,
    errorTitle: "REVIEW_TASK_LIMIT_BLOCKED",
    errorDetail: `generated=${taskCount}, max=${maxTasks}`,
    status: "blocked",
    reason: "review_task_limit",
    human_needed: true,
    recovery_action: "split_review_findings_or_raise_review_task_limit",
    meta: {
      round,
      phase: "REVIEW_TASK_LIMIT_BLOCKED",
      generated_tasks: taskCount,
      max_allowed: maxTasks,
      blocked_task_ids: taskIds.slice(0, 50),
      human_needed: true,
      recoverable: true,
      queue_strategy: "human_needed",
    },
  };
}

export function markReviewTaskLimitBlocked({ taskResults, taskLimitBlock, appendUnique }) {
  if (!taskResults || !taskLimitBlock) return taskResults;
  if (!Array.isArray(taskResults.blocked)) taskResults.blocked = [];
  const append = appendUnique || appendUniqueFallback;
  append(taskResults.blocked, [taskLimitBlock.blockerId]);
  taskResults.review_blocker = {
    id: taskLimitBlock.blockerId,
    status: taskLimitBlock.status,
    reason: taskLimitBlock.reason,
    human_needed: taskLimitBlock.human_needed,
    recovery_action: taskLimitBlock.recovery_action,
    meta: taskLimitBlock.meta,
  };
  return taskResults;
}

export function markReviewOutcome({
  taskResults,
  appendUnique,
  id,
  status = "failed",
  reason,
  message,
  humanNeeded = false,
  meta = Object(),
} = Object()) {
  if (!taskResults || !id) return taskResults;
  if (!Array.isArray(taskResults.failed)) taskResults.failed = [];
  if (!Array.isArray(taskResults.blocked)) taskResults.blocked = [];
  const append = appendUnique || appendUniqueFallback;
  append(taskResults.failed, [id]);
  if (status === "blocked") append(taskResults.blocked, [id]);
  taskResults.review_outcome = {
    id,
    status,
    reason,
    message,
    human_needed: humanNeeded,
    meta,
  };
  return taskResults;
}

export function appendReviewTasksToPrd({
  prd,
  progress,
  tasks = [],
  ensureTaskShape = (task) => task,
}) {
  const added = [];
  if (!Array.isArray(prd.tasks)) prd.tasks = [];
  for (const task of tasks) {
    ensureTaskShape(task);
    prd.tasks.push(task);
    if (progress) progress.total++;
    added.push({
      id: task.id,
      priority: task.priority,
      title: task.title,
    });
  }
  return added;
}

export function reviewTaskIdSet(tasks = []) {
  return new Set(tasks.map((task) => task.id).filter(Boolean));
}

export function hasReviewFixFailures(reviewResults = Object()) {
  return (reviewResults.failed || []).length > 0 || (reviewResults.blocked || []).length > 0;
}

export function reviewFixFailureDetail(reviewResults = Object()) {
  return `failed=${(reviewResults.failed || []).length}, blocked=${(reviewResults.blocked || []).length}`;
}

export function pendingReviewDecision({ pendingReviewTasks = [], prevPendingCount, round }) {
  if (pendingReviewTasks.length === 0) {
    return {
      action: "continue",
      nextPendingCount: 0,
      message: "本轮 review 任务已处理，继续下一轮扫描",
    };
  }
  if (round > 1 && pendingReviewTasks.length === prevPendingCount) {
    return {
      action: "break",
      nextPendingCount: pendingReviewTasks.length,
      message: "连续两轮无进展，退出 review",
    };
  }
  return {
    action: "next-round",
    nextPendingCount: pendingReviewTasks.length,
    message: null,
  };
}
