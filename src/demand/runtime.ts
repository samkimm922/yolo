import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildDemandSession, demandMarkdownArtifacts } from "./artifacts.js";
import { inspectDemandQuality, inspectDemandReadiness } from "./gate.js";
import { inspectAtomicTask } from "../runtime/execution/atomic-task-doctor.js";

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolveRoot(value, fallback = process.cwd()) {
  return resolve(clean(value) || fallback);
}

function resolvePath(root, path) {
  if (!path) return path;
  return isAbsolute(path) ? path : resolve(root, path);
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${String(value).trimEnd()}\n`, "utf8");
  return path;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableJson(value), "utf8");
  return path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stateRootFor(input = {}, options = {}) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  return resolveRoot(input.stateRoot || input.state_root || options.stateRoot || options.state_root, join(projectRoot, ".yolo"));
}

export function demandStateDir(stateRoot, id = "") {
  return id ? join(resolveRoot(stateRoot), "demand", id) : join(resolveRoot(stateRoot), "demand");
}

export function defaultDemandSessionPath(stateRoot, id) {
  return join(demandStateDir(stateRoot, id), "session.json");
}

function outputDirFor(session, input = {}, options = {}) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor(input, options);
  const explicit = input.outputDir || input.output_dir || options.outputDir || options.output_dir;
  return explicit ? resolvePath(projectRoot, explicit) : demandStateDir(stateRoot, session.id);
}

export function writeDemandArtifacts(session = {}, outputDir) {
  const artifacts = [];
  const markdown = demandMarkdownArtifacts(session);
  mkdirSync(outputDir, { recursive: true });
  artifacts.push(writeJson(join(outputDir, "session.json"), session));
  for (const [name, content] of Object.entries(markdown)) {
    artifacts.push(writeText(join(outputDir, name), content));
  }
  artifacts.push(writeJson(join(outputDir, "APPROVAL.json"), session.approval || {}));
  artifacts.push(writeJson(join(outputDir, "READINESS.json"), session.readiness || inspectDemandReadiness(session)));
  return artifacts;
}

export function readDemandSession(pathOrDir) {
  const resolved = resolve(pathOrDir);
  const sessionPath = existsSync(resolved) && !resolved.endsWith(".json")
    ? join(resolved, "session.json")
    : resolved;
  if (!existsSync(sessionPath)) {
    return { ok: false, path: sessionPath, error: `Demand session not found: ${sessionPath}` };
  }
  try {
    return { ok: true, path: sessionPath, dir: dirname(sessionPath), session: readJson(sessionPath) };
  } catch (error) {
    return { ok: false, path: sessionPath, error: `Demand session JSON parse failed: ${error.message}` };
  }
}

function runtimeResult(label, session, outputDir, artifacts, options = {}) {
  const readiness = session.readiness || inspectDemandReadiness(session, { phase: session.phase });
  const blocked = readiness.status === "blocked";
  return {
    status: blocked ? "blocked" : readiness.status === "warning" ? "warning" : "success",
    code: blocked ? "DEMAND_BLOCKED" : "DEMAND_READY",
    summary: blocked
      ? `${label} demand artifacts need more information before PRD.`
      : `${label} demand artifacts created.`,
    demand_id: session.id,
    demand_dir: outputDir,
    session,
    readiness,
    graph: session.graph,
    blockers: readiness.blockers || [],
    warnings: readiness.warnings || [],
    artifacts,
    outputs: artifacts.map((path) => ({ path, type: path.endsWith(".json") ? "demand_json" : "demand_markdown" })),
    next_actions: readiness.next_actions,
    guarantees: {
      writes_business_code: false,
      prd_execution: false,
      provider_execution: false,
      source: options.source || session.source,
    },
  };
}

export function runDemandBrainstormRuntime(input = {}, options = {}) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const session = buildDemandSession({ ...input, projectRoot, stateRoot, phase: "brainstorm", source: "yolo-brainstorm" }, {
    ...options,
    phase: "brainstorm",
    source: "yolo-brainstorm",
  });
  const outputDir = outputDirFor(session, { ...input, projectRoot, stateRoot }, options);
  const shouldWrite = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false;
  const artifacts = shouldWrite ? writeDemandArtifacts(session, outputDir) : [];
  return runtimeResult("Brainstorm", session, outputDir, artifacts, { source: "yolo-brainstorm" });
}

export function runDemandDiscussRuntime(input = {}, options = {}) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const session = buildDemandSession({ ...input, projectRoot, stateRoot, phase: "discuss", source: "yolo-discuss" }, {
    ...options,
    phase: "discuss",
    source: "yolo-discuss",
  });
  const outputDir = outputDirFor(session, { ...input, projectRoot, stateRoot }, options);
  const shouldWrite = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false;
  const artifacts = shouldWrite ? writeDemandArtifacts(session, outputDir) : [];
  return runtimeResult("Discuss", session, outputDir, artifacts, { source: "yolo-discuss" });
}

function targetFiles(session = {}) {
  const files = session.project?.target_files || session.target_files || [];
  return Array.isArray(files) ? files.filter(Boolean) : [files].filter(Boolean);
}

function normalizeBaseCommit(value) {
  const text = clean(value).toLowerCase();
  return /^[a-f0-9]{7,40}$/.test(text) ? text : "";
}

function readBaseCommit(input = {}, options = {}) {
  const explicit = normalizeBaseCommit(options.base_commit || options.baseCommit || input.base_commit || input.baseCommit);
  if (explicit) return explicit;
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  try {
    return normalizeBaseCommit(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })) || "0000000";
  } catch {
    return "0000000";
  }
}

function chunk(values = [], size = 2) {
  const items = values.filter(Boolean);
  const chunks = [];
  const chunkSize = Math.max(1, Number(size) || 1);
  for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
  return chunks.length ? chunks : [[]];
}

function requirementById(session = {}) {
  const map = new Map();
  for (const requirement of asArray(session.requirements?.active || session.requirements)) {
    if (requirement?.id) map.set(requirement.id, requirement);
  }
  return map;
}

function scenarioMatrix(session = {}) {
  return asArray(session.scenario_matrix?.scenarios);
}

function questionTraceIds(value) {
  return [...new Set(asArray(value)
    .map((item) => {
      if (item && typeof item === "object") return clean(item.id || item.question_id || item.questionId);
      return clean(item);
    })
    .filter(Boolean))];
}

function sourceQuestionIds(session = {}, scenario = {}, requirement = {}) {
  return [...new Set([
    ...questionTraceIds(scenario.source_question_ids),
    ...questionTraceIds(scenario.question_trace),
    ...questionTraceIds(requirement.trace?.question_ids),
    ...questionTraceIds(session.question_trace),
    ...questionTraceIds(session.discussion?.rounds),
  ])];
}

function verificationHint({ scenario = {}, surface = {}, proof = "", files = [] } = {}) {
  return clean(surface.verification_hint || scenario.verification_hint)
    || `Verify "${proof || scenario.desired_behavior || "the requested behavior"}" through ${scenario.touchpoint || "the target workflow"} on ${surfaceTitle(surface)}${files.length ? ` (${files.join(", ")})` : ""}.`;
}

function fallbackScenarios(session = {}) {
  const files = targetFiles(session);
  return asArray(session.requirements?.active || session.requirements).map((requirement, index) => {
    const scenarios = asArray(requirement.acceptance_scenarios || requirement.scenarios);
    const firstScenario = scenarios[0] || {};
    return {
      id: `SCN-${String(index + 1).padStart(3, "0")}`,
      requirement_id: requirement.id,
      actor: asArray(session.project?.target_users || session.vision?.target_users)[0] || "target user",
      touchpoint: "primary user workflow",
      trigger: firstScenario.when || "the user reaches this scenario",
      current_behavior: asArray(session.context?.current_state || session.vision?.status_quo)[0] || "Captured in demand context.",
      desired_behavior: requirement.text,
      proof: firstScenario.then || firstScenario.text || requirement.text,
      out_of_scope: session.requirements?.out_of_scope || [],
      constraints: session.requirements?.constraints || [],
      exceptions: [],
      surfaces: [{
        id: `SCN-${String(index + 1).padStart(3, "0")}-SFC-001`,
        kind: "code",
        label: "代码实现",
        target_files: files,
        readonly_files: [],
        session_budget: {
          expected: "single_session",
          max_files: Math.max(1, Math.min(2, files.length || 1)),
          max_lines_per_file: 120,
        },
      }],
      question_trace: [],
    };
  });
}

function taskTypeForSurface(surface = {}) {
  return surface.kind === "test" || surface.kind === "doc" ? "cleanup" : "feature";
}

function surfaceTitle(surface = {}) {
  return clean(surface.label) || clean(surface.kind) || "Implementation surface";
}

function isUiSurface(surface = {}, files = []) {
  const kind = clean(surface.kind).toLowerCase();
  return kind === "ui" || files.some((file) => /(^|\/)(pages?|views?|screens?|components?|ui)\//i.test(clean(file)));
}

function uiStateMatrixForTask({ scenario = {}, surface = {}, proof = "" } = {}) {
  return [
    {
      state: "ready",
      surface_id: surface.id || null,
      touchpoint: scenario.touchpoint || "primary user workflow",
      trigger: scenario.trigger || "the user reaches this UI state",
      expected_visible_result: proof || scenario.desired_behavior || "The requested UI behavior is visible.",
    },
  ];
}

function uiEvidencePlanForTask({ scenario = {}, surface = {}, proof = "", files = [] } = {}) {
  return [
    {
      type: "screenshot",
      surface_id: surface.id || null,
      target_files: files,
      description: `Capture the UI state for ${scenario.touchpoint || surfaceTitle(surface)} and verify: ${proof || scenario.desired_behavior || "requested UI behavior"}.`,
    },
    {
      type: "runtime_log",
      surface_id: surface.id || null,
      description: "Confirm the UI path has no blocking runtime errors during acceptance.",
    },
  ];
}

function pathSafeId(value, fallback = "item") {
  return (clean(value) || fallback)
    .replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
}

function asciiIdPart(value, fallback = "ITEM") {
  const source = clean(value);
  const base = source
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!source) return fallback;
  const hash = createHash("sha1").update(source).digest("hex").slice(0, 8).toUpperCase();
  if (!base) return `${fallback}-${hash}`;
  return base === source.toUpperCase() ? base : `${base}-${hash}`;
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function buildTaskSessionPlan({
  demandId = "",
  taskId = "",
  requirementId = "",
  scenarioId = "",
  surfaceId = "",
} = {}) {
  const safeDemandId = pathSafeId(demandId, "DEMAND");
  const safeTaskId = pathSafeId(taskId, "TASK");
  const taskRoot = `.yolo/demand/${safeDemandId}/tasks/${safeTaskId}`;
  const memoryUpdatePaths = [
    ".yolo/memory/CURRENT_HANDOFF.md",
    ".yolo/memory/PROGRESS.md",
    ".yolo/state/session-memory.jsonl",
  ];
  return {
    schema: "yolo.demand.task_session_plan.v1",
    session_id: `${safeTaskId}-session`,
    task_id: taskId,
    demand_id: demandId,
    requirement_id: requirementId || null,
    scenario_id: scenarioId || null,
    surface_id: surfaceId || null,
    state_path: `${taskRoot}/session.json`,
    handoff_path: `${taskRoot}/handoff.md`,
    evidence_path: `${taskRoot}/evidence.jsonl`,
    memory_update_paths: memoryUpdatePaths,
    progress_update_path: ".yolo/memory/PROGRESS.md",
    resume_instructions: [
      `Start a fresh execution session for task ${taskId}.`,
      `Use ${taskRoot}/session.json as the task session state plan and ${taskRoot}/handoff.md for the next handoff when the session closes.`,
      "Record command results, changed files, blockers, and acceptance evidence in the evidence path.",
      "Update the listed memory and progress targets before handing off.",
    ].join(" "),
  };
}

function summarizeTaskSessionPlans(tasks = []) {
  const plans = tasks.map((task) => task?.handoff?.session).filter(Boolean);
  return {
    planned: tasks.length > 0 && plans.length === tasks.length,
    task_count: tasks.length,
    session_count: plans.length,
    tasks_with_session_plan: plans.length,
    state_paths: uniqueStrings(plans.map((plan) => plan.state_path)),
    handoff_paths: uniqueStrings(plans.map((plan) => plan.handoff_path)),
    evidence_paths: uniqueStrings(plans.map((plan) => plan.evidence_path)),
    memory_update_paths: uniqueStrings(plans.flatMap((plan) => plan.memory_update_paths || [])),
    progress_update_paths: uniqueStrings(plans.map((plan) => plan.progress_update_path)),
  };
}

function modifiedFileCondition(taskId, index, file) {
  return {
    id: `POST-${taskId}-TARGET-${index + 1}`,
    type: "target_file_modified",
    severity: "FAIL",
    params: { file },
    message: `Target file must be modified: ${file}`,
  };
}

function acceptanceCondition(taskId, index, scenario) {
  return {
    id: `POST-${taskId}-SCENARIO-${index + 1}`,
    type: "acceptance_criteria",
    severity: "WARN",
    params: { text: scenario.then || scenario.text || scenario },
    message: scenario.then || scenario.text || scenario,
  };
}

function buildAtomicDemandTasks(session = {}, input = {}, options = {}) {
  const requirements = requirementById(session);
  const scenarios = scenarioMatrix(session).length ? scenarioMatrix(session) : fallbackScenarios(session);
  const allFiles = targetFiles(session);
  const tasks = [];
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const requirement = requirements.get(scenario.requirement_id) || {};
    const surfaces = asArray(scenario.surfaces).length
      ? asArray(scenario.surfaces)
      : [{ id: `${scenario.id}-SFC-001`, kind: "code", label: "代码实现", target_files: allFiles }];
    for (const [surfaceIndex, surface] of surfaces.entries()) {
      const maxFiles = Math.max(1, Number(surface.session_budget?.max_files || input.max_files_per_task || input.maxFilesPerTask || 2));
      const surfaceFiles = asArray(surface.target_files).length ? asArray(surface.target_files) : allFiles;
      const fileChunks = chunk(surfaceFiles, maxFiles);
      for (const [chunkIndex, files] of fileChunks.entries()) {
        const taskId = `DEMAND-${scenario.requirement_id || "REQ"}-${String(scenarioIndex + 1).padStart(3, "0")}${String(surfaceIndex + 1).padStart(2, "0")}${String(chunkIndex + 1).padStart(2, "0")}`;
        const proof = clean(surface.proof || scenario.proof || requirement.text || scenario.desired_behavior);
        const description = clean(scenario.desired_behavior || requirement.text || proof);
        const sourceQuestions = sourceQuestionIds(session, scenario, requirement);
        const taskVerificationHint = verificationHint({ scenario, surface, proof, files });
        const uiTask = isUiSurface(surface, files);
        const sessionPlan = buildTaskSessionPlan({
          demandId: session.id,
          taskId,
          requirementId: scenario.requirement_id || requirement.id,
          scenarioId: scenario.id,
          surfaceId: surface.id,
        });
        tasks.push({
          id: taskId,
          title: `${surfaceTitle(surface)}: ${description}`.slice(0, 100),
          description,
          priority: input.priority || "P1",
          type: taskTypeForSurface(surface),
          status: "pending",
          task_kind: "demand_atomic_task",
          requirement_ids: [scenario.requirement_id || requirement.id].filter(Boolean),
          design_ids: [`DES-${scenario.requirement_id || requirement.id || "DEMAND"}`],
          source_finding_ids: [scenario.requirement_id || requirement.id].filter(Boolean),
          source_question_ids: sourceQuestions,
          verification_hint: taskVerificationHint,
          ...(uiTask ? {
            state_matrix: uiStateMatrixForTask({ scenario, surface, proof }),
            evidence_plan: uiEvidencePlanForTask({ scenario, surface, proof, files }),
          } : {}),
          depends_on: [],
          handoff: {
            type: "agent_brief",
            category: "enhancement",
            session: sessionPlan,
            plain_language_goal: description,
            user_story: `As ${scenario.actor || "the target user"}, I want ${description}, so that ${proof}.`,
            source_question_ids: sourceQuestions,
            current_behavior: clean(scenario.current_behavior) || (session.context?.current_state || session.vision?.status_quo || []).join("; ") || "Captured in demand CONTEXT.md.",
            desired_behavior: description,
            touchpoint: scenario.touchpoint || "primary user workflow",
            trigger: scenario.trigger || "the user reaches this scenario",
            scenario: {
              id: scenario.id,
              actor: scenario.actor || "target user",
              touchpoint: scenario.touchpoint || "primary user workflow",
              trigger: scenario.trigger || "the user reaches this scenario",
              current_behavior: clean(scenario.current_behavior) || "",
              desired_behavior: description,
              proof,
            },
            requirement: {
              id: scenario.requirement_id || requirement.id || null,
              text: requirement.text || description,
            },
            surface: {
              id: surface.id,
              kind: surface.kind || "code",
              label: surfaceTitle(surface),
              target_files: files,
              readonly_files: asArray(surface.readonly_files),
              session_budget: surface.session_budget || null,
            },
            key_interfaces: files,
            read_first: [...new Set([...files, ...asArray(surface.readonly_files)])],
            acceptance_criteria: [proof].filter(Boolean),
            proof,
            verification_hint: taskVerificationHint,
            ...(uiTask ? {
              state_matrix: uiStateMatrixForTask({ scenario, surface, proof }),
              evidence_plan: uiEvidencePlanForTask({ scenario, surface, proof, files }),
            } : {}),
            out_of_scope: scenario.out_of_scope || session.requirements?.out_of_scope || [],
            constraints: scenario.constraints || session.requirements?.constraints || [],
            exceptions: scenario.exceptions || [],
            question_trace: scenario.question_trace || [],
            evidence_chain: {
              intake_schema: session.prd_intake?.schema || session.nontechnical_intake?.schema || null,
              demand_id: session.id,
              scenario_id: scenario.id,
              surface_id: surface.id,
              approval_reason: session.approval_reason || session.approval?.reason || session.approval?.note || "",
            },
          },
          scope: {
            targets: files.map((file) => ({ file, description })),
            readonly_files: asArray(surface.readonly_files),
            allow_new_files: surface.allow_new_files === true || input.allow_new_files !== false,
            allow_delete_files: false,
            max_files: Math.max(1, files.length || maxFiles),
            max_lines_per_file: Number(surface.session_budget?.max_lines_per_file || input.max_lines_per_file || input.maxLinesPerFile || 120),
          },
          pre_conditions: [],
          post_conditions: [
            ...files.map((file, fileIndex) => modifiedFileCondition(taskId, fileIndex, file)),
            acceptanceCondition(taskId, 0, { then: proof || description }),
          ],
          trace: {
            demand_id: session.id,
            requirement_id: scenario.requirement_id || requirement.id,
            scenario_id: scenario.id,
            surface_id: surface.id,
            evidence: requirement.trace?.evidence || [],
            decisions: requirement.trace?.decisions || [],
            question_trace: scenario.question_trace || [],
            source_question_ids: sourceQuestions,
          },
          atomicity: {
            expected_session: surface.session_budget?.expected || "single_session",
            source: "scenario_surface",
          },
          must_fix_before_ship: true,
        });
      }
    }
  }
  return tasks;
}

function inspectAtomicity(tasks = [], input = {}, options = {}) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const results = [];
  const blockers = [];
  const warnings = [];
  for (const task of tasks) {
    try {
      const result = inspectAtomicTask(task, {
        projectRoot,
        root: options.yoloRoot || options.yolo_root || projectRoot,
        writeEvidence: false,
      });
      results.push(result);
      if (result.status === "fail" || result.mode === "must_split") {
        blockers.push({
          code: "ATOMIC_TASK_TOO_COARSE",
          task_id: task.id,
          message: "Atomic task doctor requires this task to be split before PRD execution.",
          result,
        });
      } else if (result.mode === "investigate_then_patch") {
        warnings.push({
          code: "ATOMIC_TASK_NEEDS_INVESTIGATION",
          task_id: task.id,
          message: "Task is session-sized but should force read/report evidence before patching.",
          result,
        });
      }
    } catch (error) {
      warnings.push({
        code: "ATOMIC_TASK_DOCTOR_UNAVAILABLE",
        task_id: task.id,
        message: error.message,
      });
    }
  }
  return {
    status: blockers.length ? "blocked" : warnings.length ? "warning" : "pass",
    results,
    blockers,
    warnings,
  };
}

function buildDemandPrd(session = {}, input = {}, options = {}) {
  const readiness = inspectDemandReadiness(session, { phase: "prd" });
  if (!readiness.executable_prd_ready) {
    const quality = inspectDemandQuality(session, { phase: "prd", readiness });
    return {
      status: "blocked",
      code: "DEMAND_NOT_EXECUTABLE",
      summary: "Demand artifacts are not approved or complete enough for executable PRD.",
      readiness,
      quality_report: quality,
      blockers: readiness.blockers,
      warnings: [...readiness.warnings, ...quality.warnings],
      prd: null,
      next_actions: readiness.next_actions,
    };
  }

  const files = targetFiles(session);
  const requirements = session.requirements?.active || [];
  const now = clean(options.now || input.now) || new Date().toISOString();
  const baseCommit = readBaseCommit(input, options);
  const prdId = clean(input.prd_id || input.prdId) || `PRD-${now.slice(0, 10).replace(/-/g, "")}-${asciiIdPart(session.id.replace(/^DEMAND-/, ""), "DEMAND")}`;
  const tasks = buildAtomicDemandTasks(session, { ...input, projectRoot: input.projectRoot || input.project_root }, options);
  const atomicity = inspectAtomicity(tasks, input, options);
  const sessionHandoff = summarizeTaskSessionPlans(tasks);
  const quality = inspectDemandQuality(session, {
    phase: "prd",
    readiness,
    tasks,
    atomicity,
    requireTasks: true,
  });
  if (atomicity.blockers.length > 0) {
    return {
      status: "blocked",
      code: "DEMAND_ATOMICITY_BLOCKED",
      summary: "Demand PRD contains tasks that are too coarse for one-session execution.",
      readiness,
      atomicity,
      quality_report: quality,
      blockers: atomicity.blockers,
      warnings: [...readiness.warnings, ...atomicity.warnings, ...quality.warnings],
      prd: null,
      next_actions: atomicity.blockers.map((blocker) => `${blocker.task_id}: split scenario surface before PRD generation.`),
    };
  }
  if (quality.status === "blocked") {
    return {
      status: "blocked",
      code: "DEMAND_QUALITY_BLOCKED",
      summary: "Demand PRD quality is below the executable threshold.",
      readiness,
      atomicity,
      quality_report: quality,
      blockers: quality.blockers,
      warnings: [...readiness.warnings, ...atomicity.warnings, ...quality.warnings],
      prd: null,
      next_actions: quality.next_actions,
    };
  }

  return {
    status: quality.status === "warning" ? "warning" : "success",
    code: "DEMAND_PRD_READY",
    summary: "Executable PRD compiled from approved demand artifacts.",
    readiness,
    atomicity,
    quality_report: quality,
    blockers: [],
    warnings: [...readiness.warnings, ...atomicity.warnings, ...quality.warnings],
    prd: {
      $schema: "https://yolo.dev/schemas/prd-v2.schema.json",
      version: "2.0",
      id: prdId,
      title: clean(input.title || session.project?.title || session.vision?.statement).slice(0, 120),
      description: `Compiled from approved demand session ${session.id}.`,
      project: {
        name: clean(input.project_name || input.projectName || session.project?.title || "project"),
        language: clean(input.language || "other"),
        framework: clean(input.framework || "generic"),
      },
      generated_by: "yolo-demand",
      generated_at: now,
      base_commit: baseCommit,
      source: "approved_demand",
      demand_contract_required: true,
      demand: {
        id: session.id,
        source: session.source || "yolo-demand",
        approval: session.approval,
        approval_reason: session.approval_reason || session.approval?.reason || session.approval?.note || "",
        prd_intake: session.prd_intake || session.nontechnical_intake || null,
        interview: session.interview || null,
        question_trace: session.question_trace || [],
        readiness_level: readiness.readiness_level,
        readiness_score: readiness.quality_score,
        quality_score: quality.total_score,
        quality_report: quality,
        scenario_matrix: {
          schema: session.scenario_matrix?.schema || null,
          scenario_count: asArray(session.scenario_matrix?.scenarios).length,
          surface_count: asArray(session.scenario_matrix?.scenarios)
            .reduce((sum, scenario) => sum + asArray(scenario.surfaces).length, 0),
          scenarios: asArray(session.scenario_matrix?.scenarios).map((scenario) => ({
            id: scenario.id,
            requirement_id: scenario.requirement_id,
            proof: scenario.proof || "",
            source_question_ids: sourceQuestionIds(session, scenario, requirements.find((item) => item.id === scenario.requirement_id) || {}),
            surfaces: asArray(scenario.surfaces).map((surface) => ({
              id: surface.id,
              kind: surface.kind || "code",
              label: surfaceTitle(surface),
              session_budget: surface.session_budget || null,
            })),
          })),
        },
        atomicity_contract: {
          rule: session.scenario_matrix?.atomic_task_rule || "one scenario surface maps to one session-sized task",
          session_budget_required: true,
          max_files_per_surface: 2,
          generated_task_count: tasks.length,
          doctor_status: atomicity.status,
          session_handoff: sessionHandoff,
        },
        execution_readiness: {
          level: readiness.readiness_level,
          prd_ready: readiness.prd_ready,
          executable_prd_ready: readiness.executable_prd_ready,
          readiness_score: readiness.quality_score,
          quality_score: quality.total_score,
          quality_report: quality,
          checks: readiness.checks.map((item) => ({ code: item.code, passed: item.passed, severity: item.severity })),
        },
      },
      execution_readiness: {
        level: "L3",
        afk_ready: true,
        source: "approved_demand_report",
        atomic_tasks: true,
        expected_task_session: "single_session",
        demand_id: session.id,
        readiness_score: readiness.quality_score,
        quality_score: quality.total_score,
        quality_status: quality.status,
        quality_report: quality,
        atomicity_status: atomicity.status,
        session_handoff: sessionHandoff,
      },
      requirements: requirements.map((requirement) => ({
        id: requirement.id,
        text: requirement.text,
        demand_trace: requirement.trace || {},
      })),
      designs: requirements.map((requirement) => ({
        id: `DES-${requirement.id}`,
        text: `Implement ${requirement.id} according to approved demand CONTEXT.md and ROADMAP.md.`,
      })),
      tasks,
      conflict_policy: {
        on_overlap: "sequential",
        overlap_detection: "file_only",
      },
    },
    next_actions: quality.status === "warning"
      ? quality.next_actions
      : ["Run yolo check on the compiled PRD before yolo run."],
  };
}

export function runDemandPrdRuntime(input = {}, options = {}) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const demandPath = resolvePath(projectRoot, input.demandPath || input.demand_path || input.demand || defaultDemandSessionPath(stateRoot, input.id || ""));
  const read = readDemandSession(demandPath);
  if (!read.ok) {
    return {
      status: "blocked",
      code: "DEMAND_SESSION_MISSING",
      summary: read.error,
      blockers: [{ code: "DEMAND_SESSION_MISSING", message: read.error }],
      warnings: [],
      artifacts: [],
      outputs: [],
      next_actions: ["Run yolo brainstorm/discuss first, or pass --demand <session.json|dir>."],
    };
  }

  const compiled = buildDemandPrd(read.session, input, options);
  const outputFile = resolvePath(projectRoot, input.outputFile || input.output_file || input.prdPath || input.prd_path || join(read.dir, "prd.json"));
  const shouldWrite = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false;
  const artifacts = [];
  if (shouldWrite && compiled.prd) artifacts.push(writeJson(outputFile, compiled.prd));

  return {
    status: compiled.status,
    code: compiled.code,
    summary: compiled.summary,
    demand_path: read.path,
    demand_id: read.session.id,
    compiled,
    prd: compiled.prd,
    readiness: compiled.readiness,
    quality_report: compiled.quality_report,
    blockers: compiled.blockers || [],
    warnings: compiled.warnings || [],
    artifacts,
    outputs: artifacts.map((path) => ({ path, type: "prd" })),
    next_actions: compiled.next_actions || [],
  };
}
