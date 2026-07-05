import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWithinRoot } from "../../lib/security/path-guard.js";
import {
  RuntimeInvariantViolation,
  isRuntimeInvariantViolation,
} from "../invariants.js";
import { inspectAtomicTask as defaultInspectAtomicTask } from "./atomic-task-doctor.js";

function asArray(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function postConditionPathEntries(condition, index) {
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
      return {
        ok: false,
        result: {
          status: "fail",
          blocks_execution: true,
          failures: error.blockers || [{
            code: error.code,
            detail: error.message,
          }],
        },
      };
    }
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
  if (task.atomic_task_doctor === false) return false;
  return ["bugfix", "feature", "refactor", "cleanup", "security"].includes(task.type || "");
}

function doctorCannotRemediateSplit(result = Object()) {
  return result.mode === "must_split" && (!Array.isArray(result.split_suggestions) || result.split_suggestions.length === 0);
}

function downgradeUnremediatedMustSplit(result = Object()) {
  if (!doctorCannotRemediateSplit(result)) return result;
  return {
    ...result,
    status: "pass",
    mode: "investigate_then_patch",
    no_executable_remediation: true,
    warnings: [
      ...(Array.isArray(result.warnings) ? result.warnings : []),
      { code: "ATOMICITY_NO_SPLIT_SUGGESTIONS", message: "doctor 无法给出拆分建议，降级为先调查再执行。" },
    ],
    remediation: { action: "WARN_AND_CONTINUE", reason: "doctor 无法给出拆分建议" },
    next_action: "force_prompt_to_read_and_report_evidence_before_patch",
  };
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
    const result = downgradeUnremediatedMustSplit(inspectAtomicTask(task, { root: yoloRoot, prdPath, writeEvidence: true }));
    logTaskBash(task.id, "atomic-task-doctor", result.status === "fail" ? "fail" : "pass", JSON.stringify({
      mode: result.mode,
      score: result.score,
      evidence_file: result.evidence_file,
      next_action: result.next_action,
      remediation: result.remediation,
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
