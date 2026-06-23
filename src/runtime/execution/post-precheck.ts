import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { safeExecSync as defaultExecSync } from "../../lib/security/safe-exec.js";
import { parseCommandToArgv } from "../../lib/security/command-guard.js";
import { skipTaskTransition } from "../task-state/transitions.js";

export function taskForValidSkipPostconditions(task = Object()) {
  return {
    ...task,
    scope: {
      ...(task.scope || {}),
      expected_zero_business_code: true,
    },
  };
}

export function explicitCodePostconditionsPass({
  task = Object(),
  rootDir,
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
} = Object()) {
  const postConditions = task.post_conditions || [];
  if (postConditions.length === 0) {
    return { passed: false, reason: "no_post_conditions" };
  }

  for (const condition of postConditions) {
    if (condition.type !== "code_contains" && condition.type !== "code_not_contains") {
      continue;
    }
    const file = condition.params?.file;
    const text = condition.params?.text;
    if (!file || !text) continue;

    const absolutePath = resolve(rootDir, file);
    if (!existsSync(absolutePath)) {
      return { passed: false, reason: "target_missing", file };
    }

    const content = readFileSync(absolutePath, "utf8");
    const contains = content.includes(text);
    if (condition.type === "code_contains" && !contains) {
      return { passed: false, reason: "code_contains_failed", file };
    }
    if (condition.type === "code_not_contains" && contains) {
      return { passed: false, reason: "code_not_contains_failed", file };
    }
  }

  return { passed: true };
}

export function parseTscErrorFiles(tscOutput = "") {
  const errorLines = String(tscOutput)
    .split("\n")
    .filter((line) => /error TS\d+:/.test(line));
  const files = new Set(
    errorLines
      .map((line) => line.split("(")[0].trim())
      .filter((file) => file.endsWith(".ts") || file.endsWith(".tsx")),
  );
  return { errorLines, files };
}

export function targetFilesHaveTscErrors(targetFiles = [], errorFiles = new Set()) {
  return targetFiles.some((file) => {
    const rel = String(file || "").replace(/^\.\//, "");
    return errorFiles.has(rel) || [...errorFiles].some((errorFile) => String(errorFile).endsWith(rel) || rel.endsWith(String(errorFile)));
  });
}

export function inspectPostPrecheckSkip({
  task = Object(),
  rootDir,
  typeCheckCommand,
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
  execSync = defaultExecSync,
} = Object()) {
  const explicit = explicitCodePostconditionsPass({
    task,
    rootDir,
    existsSync,
    readFileSync,
  });
  if (!explicit.passed) {
    return { shouldSkip: false, reason: explicit.reason, file: explicit.file };
  }

  const targetFiles = (task.scope?.targets || []).map((target) => target.file).filter(Boolean);
  if (targetFiles.length > 0 && typeCheckCommand) {
    // P12.I1: default executor is safeExecSync (argv parse, reject shell metacharacters,
    // no shell). Tests may inject a mock execSync for unit control.
    // Defense-in-depth: pre-validate command string — reject shell metacharacters
    // before any executor sees the command, regardless of DI override.
    const parsed = parseCommandToArgv(typeCheckCommand);
    if (!parsed.ok) {
      return {
        shouldSkip: false,
        reason: "invalid_command",
        logMessage: `[precheck] 类型检查命令包含不合法内容（${parsed.detail}），跳过预检`,
      };
    }
    try {
      execSync(typeCheckCommand, { cwd: rootDir, encoding: "utf8", timeout: 120000 });
    } catch (error) {
      const tscOutput = `${String(error?.stdout || "")}${String(error?.stderr || "")}`;
      const { errorLines, files } = parseTscErrorFiles(tscOutput);
      if (errorLines.length > 0 && targetFilesHaveTscErrors(targetFiles, files)) {
        return {
          shouldSkip: false,
          reason: "target_tsc_errors",
          logMessage: `[precheck] TSC 编译错误仍涉及目标文件（${errorLines.length} 条错误中有目标文件），不跳过`,
        };
      }
    }
  }

  const skipTask = taskForValidSkipPostconditions(task);
  return {
    shouldSkip: true,
    reason: "post-precheck: 已修复",
    logMessage: "已修复预检: 显式 POST conditions 全部通过（主目录），跳过",
    transition: skipTaskTransition({
      taskId: task.id,
      reason: "post-precheck: 主目录已满足修复条件",
      result: {
        skip_kind: "valid_skip_already_satisfied",
        counts_as_completed: true,
      },
      prdUpdate: {
        scope: skipTask.scope,
        skip_kind: "valid_skip_already_satisfied",
        counts_as_completed: true,
        phase: "done",
        phaseDetail: "post-precheck: 已修复",
      },
    }),
    result: {
      status: "skipped",
      skip_kind: "valid_skip_already_satisfied",
      counts_as_completed: true,
      reason: "post-precheck: 已修复",
    },
  };
}
