import { buildFailureHint } from "../gates/failure-analysis.js";

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
  lastGateError = "",
  learnStdout = "",
  rootDir = "",
  stateRoot = "",
  experienceLimit = null,
  disableExperiencePack = false,
} = {}) {
  const args = [
    `--task=${task.id}`,
    `--prd=${prdPath}`,
    `--attempt=${attempt}`,
    `--mode=${mode}`,
  ];
  if (rootDir) args.push(`--cwd=${rootDir}`);
  if (stateRoot) args.push(`--state-root=${stateRoot}`);
  if (experienceLimit != null) args.push(`--experience-limit=${experienceLimit}`);
  if (disableExperiencePack) args.push("--no-experience-pack");

  if (!lastGateError) {
    return { args, failureHint: "", failureHintLog: null };
  }

  const failureHint = buildFailureHint(lastGateError, task.scope?.targets?.[0]?.file);
  args.push("--fix", `--learnings=${buildRetryLearningText({ learnStdout, failureHint, lastGateError })}`);
  return {
    args,
    failureHint,
    failureHintLog: `错误注入 (${lastGateError.length} → ${failureHint.length} 字符)`,
  };
}
