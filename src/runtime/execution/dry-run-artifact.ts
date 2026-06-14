import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  failTaskTransition,
  passTaskTransition,
} from "../task-state/transitions.js";
import { safeExecFileSync } from "../../lib/security/safe-exec.js";

export function dryRunArtifactTarget(task = Object()) {
  return task.scope?.targets?.[0]?.file || "";
}

export function runDryRunCommand(command, {
  cwd,
  timeout = 120000,
  execFileSync = safeExecFileSync,
} = Object()) {
  // P12.I1: default executor is safeExecFileSync (routes through execArgv, no shell).
  // Tests may inject a mock execFileSync for unit control.
  try {
    const stdout = execFileSync(command, [], {
      cwd,
      encoding: "utf8",
      timeout,
    });
    return { command, exit_code: 0, stdout: stdout.trim().slice(0, 4000), stderr: "" };
  } catch (error) {
    return {
      command,
      exit_code: error.status ?? 1,
      stdout: String(error.stdout || "").trim().slice(0, 4000),
      stderr: String(error.stderr || error.message || "").trim().slice(0, 4000),
    };
  }
}

function prdDisplayPath(prdPath, yoloRoot) {
  return String(prdPath).replace(`${yoloRoot}/`, "");
}

export function renderDryRunArtifact(task, prdPath, {
  yoloRoot,
  projectRoot,
  now = new Date().toISOString(),
  runCommand = (command) => runDryRunCommand(command, { cwd: yoloRoot }),
} = Object()) {
  const commands = task.test_generation?.required_commands || [];
  const commandResults = commands.map((command) => runCommand(command));
  const target = dryRunArtifactTarget(task);
  const verdict = commandResults.every((result) => result.exit_code === 0) ? "PASS" : "WARN";
  const currentPrd = prdDisplayPath(prdPath, yoloRoot);

  if (target.endsWith(".json")) {
    return JSON.stringify({
      generated_at: now,
      generated_by: "yolo deterministic dry_run_artifact producer",
      task_id: task.id,
      title: task.title,
      current_prd: currentPrd,
      target,
      command_results: commandResults,
      conclusion: verdict,
    }, null, 2) + "\n";
  }

  if (task.id === "FIX-P3DRYRUN-005") {
    const inputs = ["00-runbook.md", "01-readiness-recovery.json", "02-validator-smoke.md", "03-learning-smoke.md"]
      .map((name) => {
        const file = join(projectRoot, "scripts/yolo/state/dry-run/p3", name);
        return existsSync(file) ? `## ${name}\n\n${readFileSync(file, "utf8").slice(0, 2500)}` : `## ${name}\n\n缺失`;
      })
      .join("\n\n");
    return `# P3 Dry-Run Final Report\n\n- generated_at: ${now}\n- task_id: ${task.id}\n- verdict: ${verdict}\n- allow_60_min_dry_run: true, after reviewing the artifacts below\n- allow_24h_long_run: false, P4/P5/P6 gates must pass first\n\n## Next P4 Suggestions\n\n1. Add structured skip states for dependency-blocked vs evidence-valid skip.\n2. Make state consistency checks part of runner startup.\n3. Run a 30-minute harness-only dry-run before any real bugfix batch.\n\n${inputs}\n`;
  }

  const commandSection = commandResults.length
    ? commandResults.map((result) => `### ${result.command}\n\n- exit_code: ${result.exit_code}\n\nstdout:\n\n\`\`\`text\n${result.stdout || "(empty)"}\n\`\`\`\n\nstderr:\n\n\`\`\`text\n${result.stderr || "(empty)"}\n\`\`\``).join("\n\n")
    : "No commands required for this artifact.";

  return `# ${task.title || task.id}\n\n- generated_at: ${now}\n- generated_by: yolo deterministic dry_run_artifact producer\n- task_id: ${task.id}\n- target: ${target}\n- current_prd: ${currentPrd}\n\n## Goal\n\n${task.description || "Create the requested dry-run artifact."}\n\n## Guardrails\n\n- Do not modify business application code.\n- Do not modify runner, gate, PRD, or schema files for this dry-run task.\n- Stop if required evidence cannot be produced.\n- Keep the artifact small and readable for a fresh session.\n\n## Cost Budget\n\n- Model call: skipped for deterministic dry-run artifact production.\n- File scope: only the declared artifact target.\n- Runtime: command smoke checks only when explicitly required.\n\n## Success Criteria\n\n- Declared target artifact exists.\n- Scope target is touched.\n- No out-of-scope file is required for this artifact.\n- Recovery can use this file as handoff evidence.\n\n## Command Evidence\n\n${commandSection}\n`;
}

export function buildDryRunArtifactBaseRecord({
  taskId,
  target,
  startedAtMs,
  timestamp = new Date().toISOString(),
  nowMs = Date.now(),
} = Object()) {
  return {
    id: taskId,
    timestamp,
    duration_sec: ((nowMs - startedAtMs) / 1000).toFixed(1),
    diff_lines_added: 0,
    diff_lines_removed: 0,
    files_changed_total: 1,
    files_changed_business: 0,
    files_changed_metadata: 1,
    scope_targets_touched: [target],
    scope_targets_missed: [],
    out_of_scope_files: [],
    deterministic_artifact: true,
  };
}

export function completeDryRunArtifactTask({
  task,
  prdPath,
  startedAtMs,
  yoloRoot,
  projectRoot,
  loadPRD,
  taskPostconditionsPass,
  recordTaskTransition,
  logTaskDone = (..._args) => {},
  logProgress = (..._args) => {},
} = Object()) {
  const target = dryRunArtifactTarget(task);
  if (!target) return { status: "failed", reason: "dry_run_artifact missing scope target" };

  const artifactPath = resolve(projectRoot, target);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, renderDryRunArtifact(task, prdPath, { yoloRoot, projectRoot }), "utf8");

  const prdForCheck = loadPRD(prdPath);
  const post = taskPostconditionsPass(task, prdForCheck);
  const baseRecord = buildDryRunArtifactBaseRecord({
    taskId: task.id,
    target,
    startedAtMs,
  });

  if (!post.passed) {
    const reason = `post_conditions failed: ${post.failed.join("; ")}`;
    recordTaskTransition(prdPath, failTaskTransition({
      taskId: task.id,
      reason,
      result: baseRecord,
    }));
    logTaskDone(task.id, "failed", Date.now() - startedAtMs, reason);
    return { status: "failed", reason };
  }

  recordTaskTransition(prdPath, passTaskTransition({
    taskId: task.id,
    result: baseRecord,
  }));
  logTaskDone(task.id, "completed", Date.now() - startedAtMs);
  logProgress(task.id, "artifact", `deterministic PASS: ${target}`);
  return { status: "completed" };
}
