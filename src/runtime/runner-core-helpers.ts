import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export function createRunnerError(message, exitCode = 1, details = {}) {
  const error = new Error(message);
  error.exitCode = exitCode;
  Object.assign(error, details);
  return error;
}

function cleanOption(value) {
  return String(value ?? "").trim();
}

export function withExecutionConfig(baseConfig, options = {}) {
  const agentCommand = cleanOption(options.agentCommand || options.agent_command || options.customCommand || options.custom_command);
  const executor = cleanOption(options.executor || options.provider || (agentCommand ? "custom" : ""));
  const provider = cleanOption(options.provider || options.executor || (agentCommand ? "custom" : ""));
  const model = cleanOption(options.model);
  const ai = { ...(baseConfig.ai || {}) };
  if (executor) Object.assign(ai, { executor, provider: provider || executor });
  if (model) {
    ai.model = model;
    if ((executor || provider) === "codex") ai.codex_model = model;
  }
  if (agentCommand) ai.custom_command = agentCommand;
  return { ...baseConfig, ai };
}

export function loadRunnerPrd(prdPath, { runnerError = createRunnerError } = {}) {
  const prd = JSON.parse(readFileSync(resolve(prdPath), "utf8"));
  if (!prd.version || prd.version !== "2.0") {
    const message = `[yolo-runner] PRD ${prdPath} 不是 v2 格式（version=${prd.version || "缺失"}）。请先用 convert.js --write 转换。`;
    throw runnerError(message, 1, { code: "INVALID_PRD_VERSION" });
  }
  if (!Array.isArray(prd.tasks)) {
    const message = `[yolo-runner] PRD ${prdPath} 缺少 tasks 数组`;
    throw runnerError(message, 1, { code: "PRD_MISSING_TASKS" });
  }
  return prd;
}

export function computeTaskTimeout(targets, { rootDir }) {
  let totalLines = 0;
  for (const target of (targets || [])) {
    try {
      totalLines += readFileSync(resolve(rootDir, target.file), "utf8").split("\n").length;
    } catch {}
  }
  return Math.max(480000, Math.min(totalLines * 2500, 1800000));
}

export function execNodeScript(script, args = [], { toolsRoot, cwd, timeout = 120000 } = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync("node", [resolve(toolsRoot, script), ...args], {
        cwd,
        encoding: "utf8",
        timeout: timeout || 120000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim(),
      stderr: "",
    };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || "").trim(),
      stderr: (err.stderr || "").trim(),
    };
  }
}

export function killTree(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch {}
    try {
      const cpids = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8", timeout: 5000 })
        .trim().split("\n").filter(Boolean).map(Number);
      cpids.forEach((cpid) => {
        try { process.kill(-cpid, "SIGKILL"); } catch {
          try { process.kill(cpid, "SIGKILL"); } catch {}
        }
      });
    } catch {}
  }
}

export function normalizeRepoPath(filePath, { rootDir }) {
  return String(filePath || "").replace(`${rootDir}/`, "").replace(/^\.\//, "");
}

export function lintIssueKey(filePath, line, ruleId, { rootDir }) {
  return `${normalizeRepoPath(filePath, { rootDir })}:${line}:${ruleId}`;
}

export function shouldRunPrecheck(task) {
  if (!task) return false;
  if (task.task_kind === "dry_run_artifact") return false;
  if (["feature", "cleanup"].includes(task.type)) return false;
  return task.type === "bugfix" || task.task_kind === "review_fix";
}

export function taskCountsAsCompleted(taskOrStatus) {
  const task = typeof taskOrStatus === "string" ? { status: taskOrStatus } : (taskOrStatus || {});
  if (task.status === "done" || task.status === "completed" || task.status === "merged_into") return true;
  return task.status === "skipped" && task.skip_kind === "valid_skip_already_satisfied";
}

export function taskIsSplitParent(task) {
  return task?.status === "split" || task?.status === "blocked_by_split" || (Array.isArray(task?.split_into) && task.split_into.length > 0);
}

export function appendUnique(target, items = []) {
  const seen = new Set(target);
  for (const item of items) {
    if (!seen.has(item)) {
      target.push(item);
      seen.add(item);
    }
  }
}
