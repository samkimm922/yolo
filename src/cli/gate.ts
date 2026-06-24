import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluatePostConditions, toGateFormat } from "../prd/contract.js";
import { loadConfig } from "../lib/config.js";
import { readJsonFileBounded } from "../lib/bounded-read.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const yoloRoot = resolve(__dirname, "../..");
const defaultProjectRoot = resolve(yoloRoot, "../..");
const defaultLogDir = join(yoloRoot, "state", "runtime");
const learnCli = existsSync(join(yoloRoot, "src/runtime/learning/learn.js"))
  ? join(yoloRoot, "src/runtime/learning/learn.js")
  : join(yoloRoot, "dist/src/runtime/learning/learn.js");

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const B = "\x1b[1m";
const X = "\x1b[0m";

function argValue(args, name) {
  const arg = args.find((item) => item.startsWith(`${name}=`));
  return arg ? arg.split("=").slice(1).join("=") : null;
}

function loadTask(prdPath, taskId) {
  if (!prdPath || !existsSync(prdPath)) return { prd: null, task: null };
  const prd = readJsonFileBounded(prdPath, { errorCode: "PRD_JSON_SIZE_LIMIT_EXCEEDED" });
  const task = (prd.tasks || []).find((item) => item.id === taskId) || null;
  return { prd, task };
}

function resolveGateConfig({ argv, contractRoot, stateRoot } = Object()) {
  const explicitConfigPath = argValue(argv, "--config") || argValue(argv, "--config-path");
  if (explicitConfigPath) {
    return loadConfig({ path: explicitConfigPath, forceReload: true });
  }

  const candidates = [
    stateRoot ? join(resolve(stateRoot), "config.json") : null,
    contractRoot ? join(resolve(contractRoot), ".yolo", "config.json") : null,
  ].filter(Boolean);
  const configPath = candidates.find((path) => existsSync(path));
  if (configPath) return loadConfig({ path: configPath, forceReload: true });
  return loadConfig(true);
}

function applyWarnEscalation(task, { stateRoot } = Object()) {
  try {
    const args = [learnCli, "--escalate"];
    if (stateRoot) args.push(`--state-root=${stateRoot}`);
    const escalateResult = execFileSync(process.execPath, args, {
      cwd: yoloRoot,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const escalated = JSON.parse(escalateResult.trim());
    if (!Array.isArray(escalated) || escalated.length === 0) return [];

    const escalatedNames = new Set(escalated.map((entry) => entry.name));
    const changed = [];
    for (const condition of task.post_conditions || []) {
      if (condition.severity === "WARN" && escalatedNames.has(condition.id)) {
        condition.severity = "FAIL";
        changed.push(condition.id);
      }
    }
    return changed;
  } catch {
    return [];
  }
}

function writeGateLog({ logDir = defaultLogDir, taskId, gateFormat, durationMs }) {
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `gate-${taskId}-${Date.now()}.json`);
  writeFileSync(
    logFile,
    JSON.stringify(
      {
        task_id: taskId,
        timestamp: new Date().toISOString(),
        result: gateFormat.allPass ? "PASS" : gateFormat.failHigh ? "FAIL" : "WARN",
        duration_ms: durationMs,
        gates: gateFormat.gates,
        failConditions: gateFormat.failConditions,
        warnConditions: gateFormat.warnConditions,
      },
      null,
      2,
    ),
  );
  return logFile;
}

export function runGateCli(argv = process.argv.slice(2), io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const taskId = argValue(argv, "--task") || "unknown";
  const prdPath = argValue(argv, "--prd");
  const mode = argValue(argv, "--mode") || "fix";
  const contractRoot = argValue(argv, "--cwd") || defaultProjectRoot;
  const stateRoot = argValue(argv, "--state-root");
  const logDir = io.logDir || argValue(argv, "--log-dir") || (stateRoot ? join(resolve(stateRoot), "state/runtime") : defaultLogDir);
  const gateConfig = resolveGateConfig({ argv, contractRoot, stateRoot });
  const startTime = Date.now();

  stdout.write(`\n${C}${B}═══ YOLO Gate (Contract) ═══${X}  Task: ${taskId}  Mode: ${mode}\n\n`);

  let prd;
  let task;
  try {
    ({ prd, task } = loadTask(prdPath, taskId));
  } catch (error) {
    stderr.write(`${R}PRD 解析失败: ${error.message}${X}\n`);
    return 1;
  }

  if (!task) {
    stderr.write(`${R}未找到任务 ${taskId}，无法评估 post_conditions；按 fail-closed 处理${X}\n`);
    return 1;
  }

  for (const conditionId of applyWarnEscalation(task, { stateRoot })) {
    stdout.write(`${Y}  WARN→FAIL 升级: ${conditionId}（已出现 ≥5 次）${X}\n`);
  }

  const contractResult = evaluatePostConditions(task, prd, { root: contractRoot, config: gateConfig });
  const gateFormat = toGateFormat(contractResult);

  for (const gate of gateFormat.gates) {
    const icon = gate.passed ? `${G}PASS${X}` : `${R}FAIL${X}`;
    const message = gate.passed ? "" : ` ${R}(${gate.detail.slice(0, 120)})${X}`;
    stdout.write(`  ${icon}  ${gate.name}${message}\n`);
  }

  const durationMs = Date.now() - startTime;
  if (gateFormat.allPass) {
    stdout.write(`\nResult: ${G}ALL PASSED${X}\n`);
  } else if (gateFormat.failHigh) {
    stdout.write(`\nResult: ${R}HAS FAILURE${X}\n`);
  } else {
    stdout.write(`\nResult: ${Y}WARN ONLY${X}\n`);
  }
  stdout.write(`Duration: ${durationMs}ms\n`);

  const logFile = writeGateLog({ logDir, taskId, gateFormat, durationMs });
  stdout.write(`日志: ${logFile}\n`);

  return gateFormat.allPass ? 0 : gateFormat.failHigh ? 1 : 2;
}
