type TaskStateRecord = Record<string, unknown>;

type TaskResultRecord = TaskStateRecord & {
  timestamp?: unknown;
};

type EmptyTaskStateRecord = Record<never, never>;

type MergePrepend<TDefaults extends TaskStateRecord, TRecord extends TaskStateRecord> =
  Omit<TDefaults, keyof TRecord> & TRecord;

type MergeOverride<TRecord extends TaskStateRecord, TOverride extends TaskStateRecord> =
  Omit<TRecord, keyof TOverride> & TOverride;

type CreatedResult<TResult extends TaskResultRecord> =
  TaskStateRecord & MergePrepend<{ id: string }, TResult> & { timestamp: unknown };

type CreatedPrdUpdate<TPrdUpdate extends TaskStateRecord | null> =
  TPrdUpdate extends TaskStateRecord ? TaskStateRecord & TPrdUpdate : null;

type CreateTaskTransitionInput = {
  taskId: string;
  result?: TaskResultRecord | null;
  prdUpdate?: TaskStateRecord | null;
  now?: string | undefined;
};

type CreateTaskTransitionResult<
  TResult extends TaskResultRecord,
  TPrdUpdate extends TaskStateRecord | null,
> = {
  task_id: string;
  result: CreatedResult<TResult>;
  prd_update: CreatedPrdUpdate<TPrdUpdate> | null;
};

type EmptyTaskTransitionResult<TPrdUpdate extends TaskStateRecord | null> = {
  task_id: string;
  result: null;
  prd_update: CreatedPrdUpdate<TPrdUpdate> | null;
};

type TerminalTaskTransitionInput<
  TResult extends TaskStateRecord = EmptyTaskStateRecord,
  TPrdUpdate extends TaskStateRecord = EmptyTaskStateRecord,
> = {
  taskId: string;
  reason: string;
  result?: TResult;
  prdUpdate?: TPrdUpdate;
  now?: string | undefined;
};

type PassTaskTransitionInput<
  TResult extends TaskStateRecord = EmptyTaskStateRecord,
  TPrdUpdate extends TaskStateRecord = EmptyTaskStateRecord,
> = {
  taskId: string;
  result?: TResult;
  prdUpdate?: TPrdUpdate;
  now?: string | undefined;
};

type FailTaskResult<TResult extends TaskStateRecord> =
  CreatedResult<MergeOverride<TResult, { status: string; reason: string }>>;

type PassTaskResult<TResult extends TaskStateRecord> =
  CreatedResult<MergeOverride<TResult, { status: string }>>;

type TerminalTaskPrdUpdate<
  TPrdUpdate extends TaskStateRecord,
  TDefaults extends TaskStateRecord,
> = TaskStateRecord & MergePrepend<TDefaults, TPrdUpdate>;

type TaskTransition = {
  task_id: string;
  result: TaskResultRecord | null;
  prd_update: TaskStateRecord | null;
};

type TaskTransitionWriters = {
  writeTaskResult(record: TaskResultRecord): void;
  updatePrdTaskStatus(taskId: string, update: TaskStateRecord): void;
};

export function createTaskTransition<
  TResult extends TaskResultRecord,
  TPrdUpdate extends TaskStateRecord | null = null,
>(
  input: { taskId: string; result: TResult; prdUpdate?: TPrdUpdate; now?: string | undefined },
): CreateTaskTransitionResult<TResult, TPrdUpdate>;
export function createTaskTransition<TPrdUpdate extends TaskStateRecord | null = null>(
  input: { taskId: string; result?: null; prdUpdate?: TPrdUpdate; now?: string | undefined },
): EmptyTaskTransitionResult<TPrdUpdate>;
export function createTaskTransition<
  TResult extends TaskResultRecord,
  TPrdUpdate extends TaskStateRecord | null = null,
>(
  input: { taskId: string; result?: TResult | null; prdUpdate?: TPrdUpdate; now?: string | undefined },
): CreateTaskTransitionResult<TResult, TPrdUpdate> | EmptyTaskTransitionResult<TPrdUpdate>;
export function createTaskTransition({ taskId, result = null, prdUpdate = null, now = new Date().toISOString() }: CreateTaskTransitionInput) {
  return {
    task_id: taskId,
    result: result ? { id: taskId, ...result, timestamp: result.timestamp || now } : null,
    prd_update: prdUpdate,
  };
}

export function failTaskTransition<
  TResult extends TaskStateRecord = EmptyTaskStateRecord,
  TPrdUpdate extends TaskStateRecord = EmptyTaskStateRecord,
>(
  input: TerminalTaskTransitionInput<TResult, TPrdUpdate>,
): {
  task_id: string;
  result: FailTaskResult<TResult>;
  prd_update: TerminalTaskPrdUpdate<TPrdUpdate, { status: string; failReason: string }>;
};
export function failTaskTransition({ taskId, reason, result = Object(), prdUpdate = Object(), now = undefined }: TerminalTaskTransitionInput) {
  return createTaskTransition({
    taskId,
    result: { ...result, status: "FAIL", reason },
    prdUpdate: { status: "failed", failReason: reason, ...prdUpdate },
    now,
  });
}

export function passTaskTransition<
  TResult extends TaskStateRecord = EmptyTaskStateRecord,
  TPrdUpdate extends TaskStateRecord = EmptyTaskStateRecord,
>(
  input: PassTaskTransitionInput<TResult, TPrdUpdate>,
): {
  task_id: string;
  result: PassTaskResult<TResult>;
  prd_update: TerminalTaskPrdUpdate<TPrdUpdate, { status: string; phase: string }>;
};
export function passTaskTransition({ taskId, result = Object(), prdUpdate = Object(), now = undefined }: PassTaskTransitionInput) {
  return createTaskTransition({
    taskId,
    result: { ...result, status: "PASS" },
    prdUpdate: { status: "done", phase: "done", ...prdUpdate },
    now,
  });
}

export function skipTaskTransition<
  TResult extends TaskStateRecord = EmptyTaskStateRecord,
  TPrdUpdate extends TaskStateRecord = EmptyTaskStateRecord,
>(
  input: TerminalTaskTransitionInput<TResult, TPrdUpdate>,
): {
  task_id: string;
  result: FailTaskResult<TResult>;
  prd_update: TerminalTaskPrdUpdate<TPrdUpdate, { status: string }>;
};
export function skipTaskTransition({ taskId, reason, result = Object(), prdUpdate = Object(), now = undefined }: TerminalTaskTransitionInput) {
  return createTaskTransition({
    taskId,
    result: { ...result, status: "SKIP", reason },
    prdUpdate: { status: "skipped", ...prdUpdate },
    now,
  });
}

export function blockedTaskTransition<
  TResult extends TaskStateRecord = EmptyTaskStateRecord,
  TPrdUpdate extends TaskStateRecord = EmptyTaskStateRecord,
>(
  input: TerminalTaskTransitionInput<TResult, TPrdUpdate>,
): {
  task_id: string;
  result: FailTaskResult<TResult>;
  prd_update: TerminalTaskPrdUpdate<TPrdUpdate, { status: string; failReason: string }>;
};
export function blockedTaskTransition({ taskId, reason, result = Object(), prdUpdate = Object(), now = undefined }: TerminalTaskTransitionInput) {
  return createTaskTransition({
    taskId,
    result: { ...result, status: "BLOCKED", reason },
    prdUpdate: { status: "blocked", failReason: reason, ...prdUpdate },
    now,
  });
}

export function applyTaskTransition<TTransition extends TaskTransition>(
  transition: TTransition,
  { writeTaskResult, updatePrdTaskStatus }: TaskTransitionWriters,
) {
  if (transition.result) writeTaskResult(transition.result);
  if (transition.prd_update) updatePrdTaskStatus(transition.task_id, transition.prd_update);
  return transition;
}
