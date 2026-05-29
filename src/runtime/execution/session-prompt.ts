import { buildFailureHint } from "../gates/failure-analysis.js";

export const FRESH_SESSION_CONTEXT_CONTRACT_SCHEMA = "yolo.task.fresh_session_context.v1";

function clean(value) {
  return String(value ?? "").trim();
}

export function buildFreshSessionContextContract({
  task = {},
  prdPath = "",
  attempt = 1,
  sessionId = "",
  rootDir = "",
  stateRoot = "",
  hasFailureHint = false,
} = {}) {
  const targets = (task.scope?.targets || [])
    .map((target) => clean(target?.file || target))
    .filter(Boolean);
  const readonly = (task.scope?.readonly_files || []).map(clean).filter(Boolean);
  return {
    schema: FRESH_SESSION_CONTEXT_CONTRACT_SCHEMA,
    fresh_session: true,
    session_id: clean(sessionId) || `${clean(task.id) || "task"}-attempt-${attempt}`,
    task_id: clean(task.id),
    attempt: Number(attempt) || 1,
    allowed_context_refs: [
      { kind: "prd_slice", ref: prdPath },
      ...targets.map((file) => ({ kind: "scope_target", ref: file })),
      ...readonly.map((file) => ({ kind: "readonly_file", ref: file })),
      ...(stateRoot ? [{ kind: "bounded_learning", ref: stateRoot }] : []),
      ...(hasFailureHint ? [{ kind: "bounded_failure_hint", ref: "last_gate_error_summary" }] : []),
    ],
    forbidden_context: [
      "previous_task_chat_transcript",
      "previous_task_provider_stdout",
      "unbounded_session_memory",
      "unscoped_project_history",
    ],
    project_root: rootDir || null,
    state_root: stateRoot || null,
    max_failure_hint_chars: 2000,
  };
}

export function buildRetryLearningText({
  learnStdout = "",
  failureHint = "",
  lastGateError = "",
} = {}) {
  let learnText = `${learnStdout}\n${failureHint}`.slice(0, 1800);
  if (lastGateError.includes("改动范围") && lastGateError.includes("150")) {
    learnText += "\n上次失败原因：文件超过 150 行限制。这次必须先拆分文件（提取函数到独立文件），再修复 bug，不要让文件超行。";
  }
  return learnText.slice(0, 2000);
}

export function buildPromptSession({
  task = {},
  prdPath,
  attempt,
  mode,
  sessionId = "",
  lastGateError = "",
  learnStdout = "",
  rootDir = "",
  stateRoot = "",
  experienceLimit = null,
  disableExperiencePack = false,
} = {}) {
  const contextContract = buildFreshSessionContextContract({
    task,
    prdPath,
    attempt,
    sessionId,
    rootDir,
    stateRoot,
    hasFailureHint: Boolean(lastGateError),
  });
  const args = [
    `--task=${task.id}`,
    `--prd=${prdPath}`,
    `--attempt=${attempt}`,
    `--mode=${mode}`,
    `--session-id=${contextContract.session_id}`,
  ];
  if (rootDir) args.push(`--cwd=${rootDir}`);
  if (stateRoot) args.push(`--state-root=${stateRoot}`);
  if (experienceLimit != null) args.push(`--experience-limit=${experienceLimit}`);
  if (disableExperiencePack) args.push("--no-experience-pack");

  if (!lastGateError) {
    return { args, failureHint: "", failureHintLog: null, contextContract };
  }

  const failureHint = buildFailureHint(lastGateError, task.scope?.targets?.[0]?.file);
  args.push("--fix", `--learnings=${buildRetryLearningText({ learnStdout, failureHint, lastGateError })}`);
  return {
    args,
    failureHint,
    failureHintLog: `错误注入 (${lastGateError.length} → ${failureHint.length} 字符)`,
    contextContract,
  };
}
