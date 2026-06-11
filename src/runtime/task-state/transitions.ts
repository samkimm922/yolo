export function createTaskTransition({ taskId, result = null, prdUpdate = null, now = new Date().toISOString() }) {
  return {
    task_id: taskId,
    result: result ? { id: taskId, ...result, timestamp: result.timestamp || now } : null,
    prd_update: prdUpdate,
  };
}

export function failTaskTransition({ taskId, reason, result = Object(), prdUpdate = Object(), now = undefined }) {
  return createTaskTransition({
    taskId,
    result: { ...result, status: "FAIL", reason },
    prdUpdate: { status: "failed", failReason: reason, ...prdUpdate },
    now,
  });
}

export function passTaskTransition({ taskId, result = Object(), prdUpdate = Object(), now = undefined }) {
  return createTaskTransition({
    taskId,
    result: { ...result, status: "PASS" },
    prdUpdate: { status: "done", phase: "done", ...prdUpdate },
    now,
  });
}

export function skipTaskTransition({ taskId, reason, result = Object(), prdUpdate = Object(), now = undefined }) {
  return createTaskTransition({
    taskId,
    result: { ...result, status: "SKIP", reason },
    prdUpdate: { status: "skipped", ...prdUpdate },
    now,
  });
}

export function blockedTaskTransition({ taskId, reason, result = Object(), prdUpdate = Object(), now = undefined }) {
  return createTaskTransition({
    taskId,
    result: { ...result, status: "BLOCKED", reason },
    prdUpdate: { status: "blocked", failReason: reason, ...prdUpdate },
    now,
  });
}

export function applyTaskTransition(transition, { writeTaskResult, updatePrdTaskStatus }) {
  if (transition.result) writeTaskResult(transition.result);
  if (transition.prd_update) updatePrdTaskStatus(transition.task_id, transition.prd_update);
  return transition;
}
