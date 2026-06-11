import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectAtomicTask as defaultInspectAtomicTask } from "./atomic-task-doctor.js";

export async function validateContextPackBeforeSession({
  task,
  attempt,
  rootDir,
  runtimeDir,
  loadContextPackModule = () => import("./context-pack-validator.js"),
} = Object()) {
  try {
    const { buildContextPackForTask, validateContextPack } = await loadContextPackModule();
    const pack = buildContextPackForTask(task, { root: rootDir, attempt });
    const result = validateContextPack(pack, { root: rootDir });
    const artifact = join(runtimeDir, `context-pack-${task.id}-${attempt}.json`);
    writeFileSync(artifact, JSON.stringify({ pack, result }, null, 2), "utf8");
    return { ok: !result.blocks_execution, result, artifact };
  } catch (error) {
    return {
      ok: false,
      result: {
        status: "fail",
        blocks_execution: true,
        failures: [{ code: "CONTEXT_PACK_VALIDATOR_ERROR", detail: error.message }],
      },
    };
  }
}

export async function validateTestGenerationAfterSession({
  task,
  cwd,
  loadTestGenerationModule = () => import("../gates/test-generation-validator.js"),
} = Object()) {
  try {
    const { validateTestGeneration } = await loadTestGenerationModule();
    return validateTestGeneration(task, { cwd });
  } catch (error) {
    return {
      status: "fail",
      blocks_execution: true,
      failures: [{ code: "TEST_GENERATION_VALIDATOR_ERROR", detail: error.message }],
    };
  }
}

export function shouldRunAtomicTaskDoctor(task) {
  if (!task || task.status === "done" || task.status === "completed") return false;
  if (task.task_kind === "dry_run_artifact") return false;
  if (task.task_kind === "yolo_engine_change") return false;
  if (task.atomic_task_doctor === false) return false;
  return ["bugfix", "feature", "refactor", "cleanup", "security"].includes(task.type || "");
}

export function runAtomicTaskDoctorGate({
  task,
  prdPath,
  yoloRoot,
  inspectAtomicTask = defaultInspectAtomicTask,
  logTaskBash = (..._args) => {},
} = Object()) {
  if (!shouldRunAtomicTaskDoctor(task)) return { ok: true, skipped: true };
  try {
    const result = inspectAtomicTask(task, { root: yoloRoot, prdPath, writeEvidence: true });
    logTaskBash(task.id, "atomic-task-doctor", result.status === "fail" ? "fail" : "pass", JSON.stringify({
      mode: result.mode,
      score: result.score,
      evidence_file: result.evidence_file,
      next_action: result.next_action,
    }).slice(0, 500));
    if (result.mode === "must_split") {
      return { ok: false, result };
    }
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      result: {
        status: "error",
        mode: "research_only",
        task_id: task.id,
        score: 999,
        evidence_file: null,
        next_action: "fix_atomic_task_doctor_error",
        error: error.message,
      },
    };
  }
}
