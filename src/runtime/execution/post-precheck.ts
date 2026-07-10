import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
} from "node:fs";
import { safeExecSync as defaultExecSync } from "../../lib/security/safe-exec.js";
import { parseCommandToArgv } from "../../lib/security/command-guard.js";
import { resolveWithinRoot } from "../../lib/security/path-guard.js";
import { skipTaskTransition } from "../task-state/transitions.js";
import {
  assertBuildCommandAvailable,
  buildCommandEnv,
  resolveBuildCommand,
  resolveGateTimeout,
} from "../../lib/toolchain.js";

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

    const guarded = resolveWithinRoot(rootDir, file);
    if (!guarded.ok || !guarded.path) {
      return { passed: false, reason: "unsafe_path", file };
    }
    if (!existsSync(guarded.path)) {
      return { passed: false, reason: "target_missing", file };
    }

    const content = readFileSync(guarded.path, "utf8");
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

export function commandOutputLines(output = "") {
  return String(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function targetFilesHaveCommandOutput(targetFiles = [], output: string | string[] = "") {
  const text = Array.isArray(output) ? output.join("\n") : String(output || "");
  return targetFiles.some((file) => {
    const rel = String(file || "").replace(/^\.\//, "");
    return Boolean(rel) && text.includes(rel);
  });
}

export function inspectPostPrecheckSkip({
  task = Object(),
  rootDir,
  typeCheckCommand,
  config = Object(),
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
  const command = typeCheckCommand || resolveBuildCommand("type_check", config, rootDir);
  if (targetFiles.length > 0 && command) {
    // P12.I1: default executor is safeExecSync (argv parse, reject shell metacharacters,
    // no shell). Tests may inject a mock execSync for unit control.
    // Defense-in-depth: pre-validate command string — reject shell metacharacters
    // before any executor sees the command, regardless of DI override.
    const parsed = parseCommandToArgv(command);
    if (!parsed.ok) {
      return {
        shouldSkip: false,
        reason: "invalid_command",
        logMessage: `[precheck] 类型检查命令包含不合法内容（${parsed.detail}），跳过预检`,
      };
    }
    const build = config?.build && typeof config.build === "object" ? config.build : Object();
    const commandConfig = { ...config, build: { ...build, type_check: command } };
    const available = assertBuildCommandAvailable("type_check", commandConfig, rootDir);
    if (!available.ok) {
      return {
        shouldSkip: false,
        reason: "command_unavailable",
        logMessage: `[precheck] ${available.message}`,
      };
    }
    try {
      execSync(command, {
        cwd: rootDir,
        encoding: "utf8",
        timeout: resolveGateTimeout("type_check", config),
        env: buildCommandEnv(rootDir),
      });
    } catch (error) {
      const commandOutput = `${String(error?.stdout || "")}${String(error?.stderr || "")}`;
      const outputLines = commandOutputLines(commandOutput);
      if (outputLines.length > 0 && targetFilesHaveCommandOutput(targetFiles, outputLines)) {
        return {
          shouldSkip: false,
          reason: "target_type_check_errors",
          logMessage: `[precheck] type_check 输出仍涉及目标文件（${outputLines.length} 条输出中有目标文件），不跳过`,
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
