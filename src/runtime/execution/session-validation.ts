import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWithinRoot } from "../../lib/security/path-guard.js";
import {
  RuntimeInvariantViolation,
  isRuntimeInvariantViolation,
} from "../invariants.js";
import { inspectAtomicTask as defaultInspectAtomicTask } from "./atomic-task-doctor.js";

function asArray<T = unknown>(value: T | readonly T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : value == null ? [] : [value as T];
}

function errorMessage(error: unknown): string {
  return (error as { message?: string } | null | undefined)?.message || String(error || "unknown error");
}

type PostCondition = {
  params?: {
    file?: unknown;
    file_path?: unknown;
    files?: unknown;
  };
};

function postConditionPathEntries(condition: PostCondition | null | undefined, index: number) {
  const params = condition?.params || {};
  return [
    ...asArray(params.file).map((value) => ({ role: `post_conditions[${index}].params.file`, value })),
    ...asArray(params.file_path).map((value) => ({ role: `post_conditions[${index}].params.file_path`, value })),
    ...asArray(params.files).map((value) => ({ role: `post_conditions[${index}].params.files`, value })),
  ];
}

export function assertTaskExecutionPathsWithinProjectRoot({ task, rootDir } = Object()) {
  if (!rootDir) return;
  const violations = [];
  for (const [index, target] of asArray(task?.scope?.targets).entries()) {
    const file = typeof target === "string" ? target : target?.file;
    if (!file) continue;
    const resolved = resolveWithinRoot(rootDir, file);
    if (!resolved.ok) {
      violations.push({
        role: `scope.targets[${index}].file`,
        path: String(file),
        reason: resolved.reason,
        detail: resolved.detail,
      });
    }
  }
  for (const [index, condition] of asArray(task?.post_conditions).entries()) {
    for (const entry of postConditionPathEntries(condition, index)) {
      const resolved = resolveWithinRoot(rootDir, entry.value);
      if (!resolved.ok) {
        violations.push({
          role: entry.role,
          path: String(entry.value),
          reason: resolved.reason,
          detail: resolved.detail,
        });
      }
    }
  }
  if (violations.length === 0) return;
  throw new RuntimeInvariantViolation(
    "task_path_outside_project_root",
    "Task target or post-condition path resolves outside the project root.",
    {
      task_id: task?.id || null,
      root_dir: rootDir,
      violations,
    },
  );
}

export async function validateContextPackBeforeSession({
  task,
  attempt,
  rootDir,
  runtimeDir,
  loadContextPackModule = () => import("./context-pack-validator.js"),
} = Object()) {
  try {
    assertTaskExecutionPathsWithinProjectRoot({ task, rootDir });
    const { buildContextPackForTask, validateContextPack } = await loadContextPackModule();
    const pack = buildContextPackForTask(task, { root: rootDir, attempt });
    const result = validateContextPack(pack, { root: rootDir });
    const artifact = join(runtimeDir, `context-pack-${task.id}-${attempt}.json`);
    writeFileSync(artifact, JSON.stringify({ pack, result }, null, 2), "utf8");
    return { ok: !result.blocks_execution, result, artifact };
  } catch (error) {
    if (isRuntimeInvariantViolation(error)) {
      const invariant = error as { blockers?: unknown[]; code?: string; message?: string };
      return {
        ok: false,
        result: {
          status: "fail",
          blocks_execution: true,
          failures: invariant.blockers || [{
            code: invariant.code,
            detail: invariant.message,
          }],
        },
      };
    }
    return {
      ok: false,
      result: {
        status: "fail",
        blocks_execution: true,
        failures: [{ code: "CONTEXT_PACK_VALIDATOR_ERROR", detail: errorMessage(error) }],
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
      failures: [{ code: "TEST_GENERATION_VALIDATOR_ERROR", detail: errorMessage(error) }],
    };
  }
}

export function shouldRunAtomicTaskDoctor(task: {
  status?: unknown;
  task_kind?: unknown;
  atomic_task_doctor?: unknown;
  type?: unknown;
} | null | undefined) {
  if (!task || task.status === "done" || task.status === "completed") return false;
  if (task.task_kind === "dry_run_artifact") return false;
  if (task.task_kind === "yolo_engine_change") return false;
  if (task.atomic_task_doctor === false) return false;
  return ["bugfix", "feature", "refactor", "cleanup", "security"].includes(String(task?.type || ""));
}

export function runAtomicTaskDoctorGate({
  task,
  prdPath,
  yoloRoot,
  inspectAtomicTask = defaultInspectAtomicTask,
  logTaskBash = (..._args: unknown[]) => {},
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
        error: errorMessage(error),
      },
    };
  }
}
