import { existsSync } from "node:fs";
import { join } from "node:path";

function runtimeScript(packageRoot, relativePath) {
  const direct = join(packageRoot, relativePath);
  if (existsSync(direct)) return direct;
  return join(packageRoot, "dist", relativePath);
}

export const MEMORY_CHECKPOINT_STATUSES = new Set([
  "running",
  "done",
  "failed",
  "blocked",
  "skipped",
  "failed_no_code",
  "needs_contract_review",
  "split",
  "blocked_by_split",
]);

export function createRunnerLedgerWriters({
  getStateDir,
  getRunId = () => null,
  appendStateEvent,
  appendRunEvent,
  error = console.error,
} = Object()) {
  return {
    logEvent(event, data = Object()) {
      try {
        const runId = getRunId();
        const payload = runId && data?.run_id == null ? { ...data, run_id: runId } : data;
        appendStateEvent(getStateDir(), event, payload);
      } catch (e) {
        error("[runner] logEvent 写入失败:", e.message);
      }
    },
    logRun(event, data = Object()) {
      try {
        const runId = getRunId();
        const payload = runId && data?.run_id == null ? { ...data, run_id: runId } : data;
        appendRunEvent(getStateDir(), event, payload);
      } catch (e) {
        error("[runner] logRun 写入失败:", e.message);
      }
    },
  };
}

export function writeRunnerStateSnapshot({
  reason,
  prdPath = null,
  packageRoot,
  stateRoot,
  rootDir,
  normalizeRepoPath,
  spawnSync,
  processExecPath,
  warn = console.warn,
} = Object()) {
  try {
    const args = [runtimeScript(packageRoot, "src/runtime/evidence/state-snapshot.js"), `--state-root=${stateRoot}`];
    if (prdPath) args.push(`--prd=${normalizeRepoPath(prdPath, { rootDir }).replace(/^scripts\/yolo\//, "")}`);
    args.push("--json");
    const result = spawnSync(processExecPath, args, {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    if (result.status !== 0) {
      warn(`[state:snapshot] ${reason} failed: ${(result.stderr || result.stdout || "").slice(0, 200)}`);
    }
  } catch (error) {
    warn(`[state:snapshot] ${reason} failed: ${error.message}`);
  }
}

export function recordRunnerMemoryCheckpoint({
  reason,
  prdPath,
  taskId,
  update = Object(),
  packageRoot,
  stateRoot,
  rootDir,
  normalizeRepoPath,
  spawnSync,
  processExecPath,
  warn = console.warn,
} = Object()) {
  const status = update.status || "updated";
  if (!MEMORY_CHECKPOINT_STATUSES.has(status)) return;
  try {
    const prdRef = prdPath ? normalizeRepoPath(prdPath, { rootDir }).replace(/^scripts\/yolo\//, "") : null;
    const details = [
      `任务 ${taskId}`,
      `状态 ${status}`,
      update.phase ? `阶段 ${update.phase}` : null,
      update.failReason ? `原因 ${String(update.failReason).slice(0, 120)}` : null,
    ].filter(Boolean).join("，");
    const refs = [prdRef, "state/handoff.json", "state/HANDOFF.md", "state/progress-snapshots/latest.json"]
      .filter(Boolean)
      .join(",");
    const result = spawnSync(processExecPath, [
      runtimeScript(packageRoot, "src/runtime/evidence/session-memory.js"),
      `--state-root=${stateRoot}`,
      "--type=runner_checkpoint",
      "--source=yolo-runner",
      `--summary=${reason}: ${details}`,
      `--refs=${refs}`,
      "--json",
    ], {
      cwd: packageRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    if (result.status !== 0) {
      warn(`[session-memory] ${reason} failed: ${(result.stderr || result.stdout || "").slice(0, 200)}`);
    }
  } catch (error) {
    warn(`[session-memory] ${reason} failed: ${error.message}`);
  }
}

export function writeRunnerRecoveryCheckpoint(options = Object()) {
  recordRunnerMemoryCheckpoint(options);
  writeRunnerStateSnapshot(options);
}
