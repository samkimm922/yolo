import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildDemandSession, demandMarkdownArtifacts, groundDemandExecutionScope } from "./artifacts.js";
import { inspectDemandQuality, inspectDemandReadiness } from "./gate.js";
import { buildDemandSessionState, demandSessionSchemaError, type DemandSessionStateResult, type DemandTriageResult, type DemandPrdReadinessResult, type DemandBlocker } from "./router.js";
import { inspectAtomicTask } from "../runtime/execution/atomic-task-doctor.js";
import { shouldInspectAtomicity } from "../runtime/gates/readiness-policy.js";
import { writeLifecycleStageReport } from "../lifecycle/progress.js";
import { lifecycleArtifactPath } from "../lifecycle/state.js";
import { preflightPrdDocument } from "../prd/preflight.js";
import { appendJsonlRecord } from "../runtime/evidence/ledger.js";
import { parseCommandToArgv } from "../lib/security/command-guard.js";
import { loadProjectToolchainConfig, resolveBuildCommand, resolveGateTimeout } from "../lib/toolchain.js";

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

function stateRootFor(input = Object(), options = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  return resolveRoot(input.stateRoot || input.state_root || options.stateRoot || options.state_root, join(projectRoot, ".yolo"));
}

function shouldWriteLifecycle(input = Object(), options = Object()) {
  return input.writeLifecycle !== false
    && input.write_lifecycle !== false
    && options.writeLifecycle !== false
    && options.write_lifecycle !== false;
}

function attachLifecycle(result = Object(), stageId, context = Object(), source = "demand-runtime") {
  const lifecycle = writeLifecycleStageReport(stageId, result, {
    projectRoot: context.projectRoot,
    stateRoot: context.stateRoot,
    source,
    writeSessionMemory: context.writeSessionMemory,
    skipSequenceCheck: true,
  });
  result.lifecycle_writes = [...(result.lifecycle_writes || []), lifecycle];
  result.artifacts = [...(result.artifacts || []), lifecycle.artifact_path];
  result.outputs = [
    ...(result.outputs || []),
    { path: lifecycle.artifact_path, type: "lifecycle_report", stage: stageId },
  ];
  return lifecycle;
}

function lifecycleStageReportReady(stateRoot, stageId) {
  try {
    const path = lifecycleArtifactPath(stageId, { stateRoot });
    if (!existsSync(path)) return false;
    const report = readJson(path);
    return ["completed", "pass", "success"].includes(clean(report.status).toLowerCase());
  } catch {
    return false;
  }
}

function attachDemandPrerequisiteLifecycle(result = Object(), read = Object(), context = Object()) {
  const demandReport = {
    status: "success",
    demand_id: read.session?.id || result.demand_id,
    demand_path: read.path,
    demand_dir: read.dir,
    outputs: [
      { path: read.path, type: "demand_json" },
    ],
  };
  if (!lifecycleStageReportReady(context.stateRoot, "discovery")) {
    attachLifecycle({
      ...demandReport,
      summary: "Approved demand session supplied discovery evidence for PRD compilation.",
    }, "discovery", context, "yolo-prd:demand-bootstrap");
  }
  if (!lifecycleStageReportReady(context.stateRoot, "roadmap")) {
    attachLifecycle({
      ...demandReport,
      summary: "Approved demand scenario matrix supplied roadmap evidence for PRD compilation.",
      prd_path: result.prd_path,
    }, "roadmap", context, "yolo-prd:demand-bootstrap");
  }
}

export function demandStateDir(stateRoot, id = "") {
  return id ? join(resolveRoot(stateRoot), "demand", id) : join(resolveRoot(stateRoot), "demand");
}

export function defaultDemandSessionPath(stateRoot, id) {
  return join(demandStateDir(stateRoot, id), "session.json");
}

function outputDirFor(session, input = Object(), options = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor(input, options);
  const explicit = input.outputDir || input.output_dir || options.outputDir || options.output_dir;
  return explicit ? resolvePath(projectRoot, explicit) : demandStateDir(stateRoot, session.id);
}

export function writeDemandArtifacts(session = Object(), outputDir) {
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
    const session = readJson(sessionPath);
    const schemaError = demandSessionSchemaError(session, sessionPath);
    if (schemaError) return { ok: false, path: sessionPath, error: schemaError };
    return { ok: true, path: sessionPath, dir: dirname(sessionPath), session };
  } catch (error) {
    return { ok: false, path: sessionPath, error: `Demand session JSON parse failed: ${error.message}` };
  }
}

function runtimeResult(label, session, outputDir, artifacts, options = Object()) {
  const stateDir = options.stateDir || options.state_dir || null;
  const readiness = stateDir
    ? inspectDemandReadiness(session, { phase: session.phase, stateDir })
    : (session.readiness || inspectDemandReadiness(session, { phase: session.phase }));
  // Update approval effectiveness against freshly computed readiness
  if (stateDir && session.approval) {
    session.approval.effective_for_prd = session.approval.approved === true && readiness.executable_prd_ready === true;
    session.approval.blocked_by = session.approval.approved === true && !session.approval.effective_for_prd
      ? asArray(readiness.blockers).map((blocker) => ({ code: blocker.code, message: blocker.message }))
      : [];
  }
  const blocked = readiness.status === "blocked";
  const warning = readiness.status === "warning";
  return {
    status: blocked ? "blocked" : warning ? "warning" : "success",
    code: blocked ? "DEMAND_BLOCKED" : warning ? "DEMAND_WARNING" : "DEMAND_READY",
    summary: blocked
      ? `${label} demand artifacts need more information before PRD.`
      : warning
        ? `${label} demand artifacts were created as draft-only; warnings must be resolved before executable PRD.`
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

export function runDemandBrainstormRuntime(input = Object(), options = Object()) {
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
  const result = runtimeResult("Brainstorm", session, outputDir, artifacts, { source: "yolo-brainstorm" });
  if (shouldWrite && shouldWriteLifecycle(input, options)) {
    attachLifecycle(result, "discovery", { projectRoot, stateRoot }, "yolo-brainstorm");
  }
  return result;
}

export function runDemandDiscussRuntime(input = Object(), options = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const stateDir = join(stateRoot, "state");
  const session = buildDemandSession({ ...input, projectRoot, stateRoot, phase: "discuss", source: "yolo-discuss" }, {
    ...options,
    phase: "discuss",
    source: "yolo-discuss",
  });
  const outputDir = outputDirFor(session, { ...input, projectRoot, stateRoot }, options);
  const shouldWrite = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false;
  // Write demand evidence ledger before artifacts so evidence_grounded gate can validate chain integrity
  if (shouldWrite) {
    try {
      appendJsonlRecord(join(stateDir, "evidence", "ledger.jsonl"), {
        event: "demand.discuss",
        project_root: projectRoot,
        state_root: stateRoot,
        demand_id: session.id,
        demand_dir: outputDir,
        phase: "discuss",
        ledger: "state",
      });
      if (session.approval?.approved === true) {
        appendJsonlRecord(join(stateDir, "evidence", "ledger.jsonl"), {
          event: "demand.approved",
          project_root: projectRoot,
          state_root: stateRoot,
          demand_id: session.id,
          demand_dir: outputDir,
          phase: "prd_intake",
          ledger: "state",
        });
      }
    } catch (_) {
      // Ledger write is nonblocking; gate will catch missing evidence
    }
  }
  // Recompute readiness with stateDir so evidence_grounded check sees the ledger
  session.readiness = inspectDemandReadiness(session, { phase: session.phase, stateDir });
  if (session.approval) {
    session.approval.effective_for_prd = session.approval.approved === true && session.readiness.executable_prd_ready === true;
    session.approval.blocked_by = session.approval.approved === true && !session.approval.effective_for_prd
      ? asArray(session.readiness.blockers).map((blocker) => ({ code: blocker.code, message: blocker.message }))
      : [];
  }
  const artifacts = shouldWrite ? writeDemandArtifacts(session, outputDir) : [];
  const result = runtimeResult("Discuss", session, outputDir, artifacts, { source: "yolo-discuss" });
  if (shouldWrite && shouldWriteLifecycle(input, options)) {
    attachLifecycle(result, "discovery", { projectRoot, stateRoot }, "yolo-discuss");
    if (result.status !== "blocked") {
      attachLifecycle(result, "roadmap", { projectRoot, stateRoot }, "yolo-discuss");
    }
  }
  return result;
}

export function approvedDemandSpecCommand(demandPath: string) {
  return `yolo spec --demand ${demandPath}`;
}

export function runDemandApprovedRuntime(input = Object(), options = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const stateDir = join(stateRoot, "state");
  const session = buildDemandSession({ ...input, projectRoot, stateRoot, phase: "prd_intake", source: "yolo-approved-demand" }, {
    ...options,
    phase: "prd_intake",
    source: "yolo-approved-demand",
  });
  const outputDir = outputDirFor(session, { ...input, projectRoot, stateRoot }, options);
  const shouldWrite = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false;
  if (shouldWrite) {
    try {
      appendJsonlRecord(join(stateDir, "evidence", "ledger.jsonl"), {
        event: "demand.approved",
        project_root: projectRoot,
        state_root: stateRoot,
        demand_id: session.id,
        demand_dir: outputDir,
        phase: "prd_intake",
        ledger: "state",
      });
    } catch (_) {
      // Ledger write is nonblocking; spec will report any missing evidence explicitly.
    }
  }
  session.readiness = inspectDemandReadiness(session, { phase: session.phase, stateDir });
  if (session.approval) {
    session.approval.effective_for_prd = session.approval.approved === true && session.readiness.executable_prd_ready === true;
    session.approval.blocked_by = session.approval.approved === true && !session.approval.effective_for_prd
      ? asArray(session.readiness.blockers).map((blocker) => ({ code: blocker.code, message: blocker.message }))
      : [];
  }
  const handoffBlockers = [];
  if (session.approval?.approved !== true) {
    handoffBlockers.push({
      code: "APPROVAL_REQUIRED",
      slot: "execution_approval",
      message: "Approved demand handoff requires explicit interview approval.",
    });
  }
  const coverage = input.interview?.coverage || {};
  if (coverage.ready_for_prd_intake === false) {
    for (const slot of asArray(coverage.missing_slots)) {
      handoffBlockers.push({
        code: `MISSING_${String(slot).toUpperCase()}`,
        slot,
        message: `Interview slot ${slot} must be answered before approved demand handoff.`,
      });
    }
    for (const followUp of asArray(coverage.follow_up_questions)) {
      handoffBlockers.push({
        code: followUp.code || `FOLLOW_UP_${String(followUp.slot || "INTERVIEW").toUpperCase()}`,
        slot: followUp.slot,
        message: followUp.plain_language_prompt || followUp.text || followUp.message || "Resolve interview follow-up before approved demand handoff.",
      });
    }
  }
  const artifacts = shouldWrite ? writeDemandArtifacts(session, outputDir) : [];
  const demandPath = artifacts.find((path) => path.endsWith("session.json")) || join(outputDir, "session.json");
  const nextAction = approvedDemandSpecCommand(demandPath);
  const blocked = handoffBlockers.length > 0;
  const result = {
    status: blocked ? "blocked" : "success",
    code: blocked ? "DEMAND_APPROVED_HANDOFF_BLOCKED" : "DEMAND_APPROVED_HANDOFF_READY",
    summary: blocked
      ? "Approved demand handoff is blocked by missing interview approval or slots."
      : "Approved demand artifacts created; hand off to spec for executable PRD generation.",
    demand_id: session.id,
    demand_dir: outputDir,
    demand_path: demandPath,
    session,
    readiness: session.readiness,
    graph: session.graph,
    blockers: handoffBlockers,
    warnings: session.readiness?.warnings || [],
    artifacts,
    outputs: artifacts.map((path) => ({ path, type: path.endsWith(".json") ? "demand_json" : "demand_markdown" })),
    next_action: blocked
      ? "yolo interview status --session <interview.json|dir>"
      : nextAction,
    next_actions: blocked
      ? [
          `Missing demand fields/approvals: ${handoffBlockers.map((blocker) => blocker.slot || blocker.code).filter(Boolean).join(", ")}.`,
          "Next: yolo interview status --session <interview.json|dir>",
        ]
      : [nextAction],
    guarantees: {
      writes_business_code: false,
      prd_execution: false,
      provider_execution: false,
      produces_executable_prd: false,
      source: options.source || session.source,
    },
  };
  if (!blocked && shouldWrite && shouldWriteLifecycle(input, options)) {
    attachLifecycle(result, "discovery", { projectRoot, stateRoot }, "yolo-approved-demand");
    attachLifecycle(result, "roadmap", { projectRoot, stateRoot }, "yolo-approved-demand");
  }
  return result;
}

export type DemandStatusRuntimeResult = DemandSessionStateResult & {
  guarantees: {
    writes_business_code: boolean;
    writes_project_state: boolean;
    prd_execution: boolean;
    provider_execution: boolean;
    source: string;
  };
  blockers?: DemandBlocker[];
  warnings?: string[];
  demand_path?: string;
};

export function runDemandStatusRuntime(input = Object(), options = Object()): DemandStatusRuntimeResult {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || input.cwd || options.projectRoot || options.project_root || options.cwd);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const explicitDemandPath = input.demandPath || input.demand_path || input.demand || input.sessionPath || input.session_path;
  if (explicitDemandPath) {
    const demandPath = resolvePath(projectRoot, explicitDemandPath);
    const read = readDemandSession(demandPath);
    if (!read.ok) {
      const blocker = { code: "DEMAND_SESSION_MISSING", message: read.error, path: read.path };
      const emptyTriage: DemandTriageResult = {
        schema_version: "1.0", schema: "yolo.demand.router.v1",
        context_type: "unknown", route: "fast", evidence_policy: "none",
        reason_codes: [], blocking: false, explanation: "",
      };
      const emptyReadiness: DemandPrdReadinessResult = {
        schema_version: "1.0", schema: "yolo.demand.prd_readiness.v1",
        required_slots: [], slot_values: {}, missing_slots: [],
        next_question: null, question_queue: [],
        blockers: [blocker], assumptions: [],
        required_evidence_agents: [],
        evidence_agreement: { status: "blocked", conflicts: [] },
        evidence_requirements: [],
        evidence_requirement_summary: { total: 0, pending: 0, satisfied: 0, pending_items: [], satisfied_items: [] },
        prd_intake_ready: false,
        executable_prd_ready: false,
        prd_ready: false,
      };
      return {
        status: "blocked",
        code: "DEMAND_SESSION_MISSING",
        summary: read.error,
        triage: emptyTriage,
        readiness: emptyReadiness,
        state: {
          schema_version: "1.0",
          schema: "yolo.demand.session_state.v1",
          context_type: "unknown",
          route: "fast",
          evidence_policy: "none",
          stage: "blocked",
          submode: "fast_intake",
          reason_codes: [],
          missing_slots: [],
          blockers: [blocker],
          assumptions: [],
          next_question: null,
          question_queue: [],
          evidence_tasks: [],
          needed_evidence_agents: [],
          evidence_requirements: [],
          evidence_requirement_summary: { total: 0, pending: 0, satisfied: 0, pending_items: [], satisfied_items: [] },
          prd_intake_ready: false,
          executable_prd_ready: false,
          next_action: "Run yolo brainstorm/discuss first, or pass --demand <session.json|dir>.",
          next_actions: ["Run yolo brainstorm/discuss first, or pass --demand <session.json|dir>."],
        },
        next_question: null,
        question_queue: [],
        next_actions: ["Run yolo brainstorm/discuss first, or pass --demand <session.json|dir>."],
        blockers: [blocker],
        warnings: [],
        demand_path: read.path,
        guarantees: {
          writes_business_code: false,
          writes_project_state: false,
          prd_execution: false,
          provider_execution: false,
          source: "yolo-demand-status",
        },
      };
    }
  }
  // 仅当调用方显式提供项目 root 时才扫描项目文件状态做 brownfield 判定；
  // 否则 projectRoot 是回退的工具 cwd，扫描会误判，关闭它。
  const callerProvidedRoot = Boolean(
    input.projectRoot || input.project_root || input.cwd
    || options.projectRoot || options.project_root || options.cwd,
  );
  const result = buildDemandSessionState({
    ...input,
    projectRoot,
    stateRoot,
  }, {
    ...options,
    projectRoot,
    stateRoot,
    scanProjectState: callerProvidedRoot,
  });
  return {
    ...result,
    guarantees: {
      writes_business_code: false,
      writes_project_state: false,
      prd_execution: false,
      provider_execution: false,
      source: "yolo-demand-status",
    },
  };
}

function leanOfficeHoursMode(input = Object(), options = Object()) {
  const raw = clean(input.officeHoursMode || input.office_hours_mode || input.profile || input.mode || options.profile || options.mode || "startup").toLowerCase();
  if (["builder", "build", "operator"].includes(raw)) return "builder";
  return "startup";
}

function leanOfficeHoursAlternatives(input = Object(), mode = "startup") {
  const provided = asArray(input.alternatives || input.alternative)
    .map(clean)
    .filter(Boolean)
    .slice(0, 3);
  const objective = clean(input.objective || input.idea || input.title || "this idea");
  const defaults = mode === "builder"
    ? [
        `Ship the narrowest manual workflow for ${objective}.`,
        `Prototype one reusable flow and defer integrations.`,
        `Write a draft demand brief only, then ask for approval before PRD.`,
      ]
    : [
        `Validate the smallest painful segment for ${objective}.`,
        `Run a concierge or manual version before productizing.`,
        `Narrow the offer to one buyer, one moment, and one proof.`,
      ];
  return (provided.length >= 2 ? provided : defaults).slice(0, 3).map((text, index) => ({
    id: String.fromCharCode(65 + index),
    label: text,
    tradeoff: mode === "builder"
      ? "Keeps implementation bounded while preserving learning."
      : "Keeps market risk visible before committing build effort.",
  }));
}

function resolveLeanOfficeHoursChoice(choice, alternatives = []) {
  const value = clean(choice).toLowerCase();
  if (!value) return null;
  return alternatives.find((item, index) =>
    item.id.toLowerCase() === value
    || String(index + 1) === value
    || item.label.toLowerCase() === value
  ) || null;
}

export function runDemandOfficeHoursRuntime(input = Object(), options = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const mode = leanOfficeHoursMode(input, options);
  const objective = clean(input.objective || input.idea || input.title || "Untitled office-hours idea");
  const alternatives = leanOfficeHoursAlternatives({ ...input, objective }, mode);
  const selected = resolveLeanOfficeHoursChoice(input.choice || input.selected || input.selection || input.decision, alternatives);
  const explicitChoiceRequired = selected == null;
  const premiseChallenge = clean(input.premise_challenge || input.premise || input.challenge)
    || (mode === "builder"
      ? "What evidence says this must be built now instead of tested manually first?"
      : "What has to be true about the buyer, pain, and willingness to act for this to be worth building?");
  const nextQuestion = {
    id: "office_hours_choice",
    slot: "explicit_user_choice",
    text: `Choose A, B, or C: ${alternatives.map((item) => `${item.id}) ${item.label}`).join(" ")}`,
    one_question_only: true,
  };
  const id = clean(input.id || input.demand_id || input.demandId)
    || `OFFICE-HOURS-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${asciiIdPart(objective, "BRIEF")}`;
  const draftBrief = {
    schema: "yolo.demand.office_hours_brief.v1",
    id,
    generated_at: new Date().toISOString(),
    profile: "lean_office_hours",
    mode,
    objective,
    premise_challenge: premiseChallenge,
    alternatives,
    selected_alternative: selected,
    explicit_user_choice_required: explicitChoiceRequired,
    handoff: {
      type: "draft_brief",
      prd_execution: false,
      code_execution: false,
      next_step: explicitChoiceRequired
        ? "Ask the single choice question and wait for the user to pick one alternative."
        : "Convert the selected alternative into normal demand intake; do not generate executable PRD until approved demand and preflight pass.",
    },
  };
  const outputDir = resolvePath(projectRoot, input.outputDir || input.output_dir || options.outputDir || join(stateRoot, "demand", "office-hours", id));
  const shouldWrite = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false;
  const artifacts = shouldWrite ? [writeJson(join(outputDir, "brief.json"), draftBrief)] : [];

  return {
    status: explicitChoiceRequired ? "blocked" : "success",
    code: explicitChoiceRequired ? "OFFICE_HOURS_CHOICE_REQUIRED" : "OFFICE_HOURS_DRAFT_READY",
    summary: explicitChoiceRequired
      ? "Lean office-hours captured a draft brief and needs one explicit user choice."
      : "Lean office-hours draft brief is ready for demand handoff; PRD and code execution remain disabled.",
    profile: "lean_office_hours",
    mode,
    objective,
    next_question: explicitChoiceRequired ? nextQuestion : null,
    premise_challenge: premiseChallenge,
    alternatives,
    selected_alternative: selected,
    draft_brief: draftBrief,
    blockers: explicitChoiceRequired ? [{
      code: "EXPLICIT_USER_CHOICE_REQUIRED",
      message: "User must choose one alternative before the draft brief can be handed to normal demand intake.",
    }] : [],
    warnings: [],
    artifacts,
    outputs: artifacts.map((path) => ({ path, type: "office_hours_draft_brief" })),
    next_actions: explicitChoiceRequired
      ? [nextQuestion.text]
      : ["Run yolo demand discuss with the selected draft brief details; do not run PRD/code yet."],
    guarantees: {
      writes_business_code: false,
      prd_execution: false,
      provider_execution: false,
      produces_executable_prd: false,
      source: "yolo-demand:office-hours",
    },
  };
}

function targetFiles(session = Object()) {
  const files = session.project?.target_files || session.target_files || [];
  return Array.isArray(files) ? files.filter(Boolean) : [files].filter(Boolean);
}

function structuredProjectFacts(session = Object()) {
  return session.project_facts && typeof session.project_facts === "object" ? session.project_facts : null;
}

function normalizeBaseCommit(value) {
  const text = clean(value).toLowerCase();
  return /^[a-f0-9]{7,40}$/.test(text) ? text : "";
}

function readBaseCommit(input = Object(), options = Object()) {
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

function requirementById(session = Object()) {
  const map = new Map();
  for (const requirement of asArray(session.requirements?.active || session.requirements)) {
    if (requirement?.id) map.set(requirement.id, requirement);
  }
  return map;
}

function scenarioMatrix(session = Object()) {
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

function sourceQuestionIds(session = Object(), scenario = Object(), requirement = Object()) {
  return [...new Set([
    ...questionTraceIds(scenario.source_question_ids),
    ...questionTraceIds(scenario.question_trace),
    ...questionTraceIds(requirement.trace?.question_ids),
    ...questionTraceIds(session.question_trace),
    ...questionTraceIds(session.discussion?.rounds),
  ])];
}

function verificationHint({ scenario = Object(), surface = Object(), proof = "", files = [] } = Object()) {
  return clean(surface.verification_hint || scenario.verification_hint)
    || `Verify "${proof || scenario.desired_behavior || "the requested behavior"}" through ${scenario.touchpoint || "the target workflow"} on ${surfaceTitle(surface)}${files.length ? ` (${files.join(", ")})` : ""}.`;
}

function fallbackScenarios(session = Object()) {
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

function taskTypeForSurface(surface = Object()) {
  return surface.kind === "test" || surface.kind === "doc" ? "cleanup" : "feature";
}

function fileKind(file = "") {
  const path = clean(file).toLowerCase();
  if (/(^|\/)(__tests__|tests?|specs?)\//.test(path) || /\.(test|spec)\./.test(path)) return "test";
  if (/(^|\/)(pages?|views?|screens?|components?|ui)\//.test(path)) return "ui";
  if (/(^|\/)(routes?|api|controllers?|server)\//.test(path)) return "api";
  if (/(^|\/)(models?|repositories|migrations?|database|db)\//.test(path)) return "data";
  if (/(^|\/)(services?|hooks?|stores?|lib|utils|domain)\//.test(path)) return "service";
  if (/(^|\/)(docs?|specs?)\//.test(path) || path.endsWith(".md")) return "doc";
  return "code";
}

function surfaceTitle(surface = Object()) {
  return clean(surface.label) || clean(surface.kind) || "Implementation surface";
}

function isUiSurface(surface = Object(), files = []) {
  const kind = clean(surface.kind).toLowerCase();
  return kind === "ui" || files.some((file) => /(^|\/)(pages?|views?|screens?|components?|ui)\//i.test(clean(file)));
}

function uiStateMatrixForTask({ scenario = Object(), surface = Object(), proof = "" } = Object()) {
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

function uiEvidencePlanForTask({ scenario = Object(), surface = Object(), proof = "", files = [] } = Object()) {
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

function normalizedTaskTargetFiles(files = []) {
  return uniqueStrings(files).sort((a, b) => a.localeCompare(b));
}

function scenarioTaskDedupKey({ files = [], kind = "", title = "" } = Object()) {
  return JSON.stringify({
    files: normalizedTaskTargetFiles(files),
    kind: clean(kind).toLowerCase() || "code",
    title: clean(title).toLowerCase(),
  });
}

function scenarioTaskScopeKey({ files = [], kind = "" } = Object()) {
  return JSON.stringify({
    files: normalizedTaskTargetFiles(files),
    kind: clean(kind).toLowerCase() || "code",
  });
}

const ACTION_SEQUENCE_PATTERN = /(?<![\w./-])([A-Za-z][A-Za-z0-9_-]{1,31}(?:\s*(?:\/|→|->|=>|\+)\s*[A-Za-z][A-Za-z0-9_-]{1,31}){1,})(?![\w./-])/g;
const ACTION_SEQUENCE_SEPARATOR = /\s*(?:\/|→|->|=>|\+)\s*/u;
const ASCII_TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9_-]{1,31}/g;
const ACTION_TOKEN_STOP_WORDS = new Set([
  "api", "build", "ci", "cli", "e2e", "home", "http", "https", "javascript", "jest",
  "json", "lint", "node", "rest", "smoke", "src", "test", "tests", "tsx", "typescript",
  "typecheck", "unit", "vitest", "task", "tasks",
]);

function actionTokenList(tokens = []) {
  return uniqueStrings(tokens.map((token) => clean(token).toLowerCase()))
    .filter((token) => token.length >= 2 && !ACTION_TOKEN_STOP_WORDS.has(token));
}

function compactActionTokens(text = "") {
  return actionTokenList([...clean(text).matchAll(ACTION_SEQUENCE_PATTERN)]
    .flatMap((match) => clean(match[1]).split(ACTION_SEQUENCE_SEPARATOR)));
}

function scenarioActionTokens(text = "") {
  const compact = compactActionTokens(text);
  if (compact.length > 0) return compact;
  const source = clean(text).toLowerCase();
  const capability = source.match(/\b(?:supports?|can|allows?|lets?|includes?|provide|provides)\s+([a-z][a-z0-9_-]{1,31})\b/i);
  if (capability) return actionTokenList([capability[1]]);
  const commandUse = source.match(/(?:可以用|使用|运行|执行)\s+([a-z][a-z0-9_-]{1,31})(?:\s+([a-z][a-z0-9_-]{1,31}))?/i);
  if (commandUse) return actionTokenList([commandUse[2] || commandUse[1]]);
  const asciiTokens = actionTokenList(source.match(ASCII_TOKEN_PATTERN) || []);
  return asciiTokens.length <= 2 ? asciiTokens : [];
}

function scenarioConceptText({ scenario = Object(), requirement = Object(), proof = "" } = Object()) {
  return [
    scenario.desired_behavior,
    scenario.proof,
    proof,
    requirement.text,
  ].map(clean).filter(Boolean).join("\n");
}

function verificationOnlyConcept(text = "") {
  const source = clean(text).toLowerCase();
  if (!source || compactActionTokens(source).length >= 2) return false;
  const hasVerificationSignal = /\b(vitest|jest|tests?|unit|integration|typecheck|lint|build|ci|smoke)\b|测试|验证|验收/.test(source);
  const hasPassSignal = /\b(pass|passes|passing|green|success|succeed|succeeds|ok)\b|全绿|通过|跑通/.test(source);
  const hasChangeSignal = /\b(add|create|update|delete|remove|persist|store|save|return|show|display|support|handle|fallback|error)\b|添加|创建|修改|删除|保存|持久|返回|显示|支持|处理|降级|报错|不崩溃/.test(source);
  return hasVerificationSignal && hasPassSignal && !hasChangeSignal;
}

function cjkBigrams(text = "") {
  const values = [];
  for (const run of clean(text).match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let index = 0; index < run.length - 1; index += 1) values.push(run.slice(index, index + 2));
    if (run.length <= 4) values.push(run);
  }
  return values;
}

function conceptFingerprint(text = "") {
  const source = clean(text)
    .toLowerCase()
    .replace(/requirement outcome:/g, " ")
    .replace(/成功标准是/g, " ")
    .replace(/\s+/g, " ");
  return new Set([
    ...scenarioActionTokens(source),
    ...cjkBigrams(source),
  ]);
}

function conceptCategories(text = "") {
  const source = clean(text).toLowerCase();
  const categories = [];
  if (/\b(persist|persistence|save|store|survive|reload|rerun|refresh)\b|持久|保存|保持|刷新|重新执行/.test(source)) {
    categories.push("persistence");
  }
  if (/\b(invalid|error|non-?zero|exit|missing|not found|empty)\b|非法|错误|空文本|不存在|友好|报错|非零|退出/.test(source)) {
    categories.push("error_handling");
  }
  if (/\b(corrupt|corrupted|malformed|fallback|degrade|graceful)\b|损坏|降级|不崩溃/.test(source)) {
    categories.push("corrupt_state");
  }
  if (/\b(filter|stable|deterministic)\b|过滤|稳定/.test(source)) {
    categories.push("stable_filtering");
  }
  return uniqueStrings(categories);
}

function overlapCount(left, right) {
  let count = 0;
  for (const item of left) {
    if (right.has(item)) count += 1;
  }
  return count;
}

function sameActionConcept(left = [], right = []) {
  if (left.length === 0 || right.length === 0) return true;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const overlap = overlapCount(leftSet, rightSet);
  return overlap / Math.max(leftSet.size, rightSet.size) >= 0.75;
}

function nearDuplicateConcept(left, right) {
  if (!sameActionConcept(left.actionTokens, right.actionTokens)) return false;
  const leftSize = left.fingerprint.size;
  const rightSize = right.fingerprint.size;
  if (leftSize === 0 || rightSize === 0) return false;
  const overlap = overlapCount(left.fingerprint, right.fingerprint);
  const containment = overlap / Math.min(leftSize, rightSize);
  const union = leftSize + rightSize - overlap;
  const jaccard = union > 0 ? overlap / union : 0;
  return containment >= 0.72 || jaccard >= 0.58;
}

function coveredActionSummary(concept, seenConcepts = []) {
  const summaryTokens = compactActionTokens(concept.text);
  if (summaryTokens.length < 2) return false;
  const coveredTokens = new Set(seenConcepts.flatMap((item) => item.actionTokens));
  if (!summaryTokens.every((token) => coveredTokens.has(token))) return false;
  return /\b(flow|flows|workflow|smoke|e2e|end-to-end)\b|一条龙|跑通|干净环境|干净 home/i.test(concept.text);
}

function coveredCategoryDetail(concept, seenConcepts = []) {
  if (concept.categories.length === 0) return false;
  return seenConcepts.some((seen) => {
    if (!sameActionConcept(concept.actionTokens, seen.actionTokens)) return false;
    if (seen.categories.length <= concept.categories.length) return false;
    return concept.categories.every((category) => seen.categories.includes(category));
  });
}

function taskConceptRecord({ scenario = Object(), requirement = Object(), proof = "" } = Object()) {
  const text = scenarioConceptText({ scenario, requirement, proof });
  return {
    text,
    actionTokens: scenarioActionTokens(text),
    categories: conceptCategories(text),
    fingerprint: conceptFingerprint(text),
  };
}

function redundantScenarioTask(concept, seenConcepts = []) {
  if (seenConcepts.length > 0 && verificationOnlyConcept(concept.text)) return true;
  if (coveredActionSummary(concept, seenConcepts)) return true;
  if (coveredCategoryDetail(concept, seenConcepts)) return true;
  return seenConcepts.some((seen) => nearDuplicateConcept(concept, seen));
}

function buildTaskSessionPlan({
  demandId = "",
  taskId = "",
  requirementId = "",
  scenarioId = "",
  surfaceId = "",
} = Object()) {
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

function deferredFollowUp(deferred = []) {
  const items = asArray(deferred).map((text, index) => ({
    id: `DEF-${String(index + 1).padStart(3, "0")}`,
    text,
    status: "deferred",
  }));
  return {
    required: items.length > 0,
    items,
    next_session_prompt: items.length
      ? `Before expanding this demand, ask the user whether to reopen deferred scope: ${items.map((item) => item.text).join("; ")}.`
      : "",
  };
}

function deferredScopeConfirmation(session = Object()) {
  const confirmation = session.discussion?.deferred_scope_confirmation || {};
  return {
    required: confirmation.required === true,
    confirmed: confirmation.confirmed === true,
    status: confirmation.status || (confirmation.required ? "needs_confirmation" : "not_required"),
    items: asArray(confirmation.items || session.discussion?.deferred),
    prompt: confirmation.prompt || "",
    confirmed_by: confirmation.confirmed_by || null,
    confirmed_at: confirmation.confirmed_at || null,
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
  const params = Object.assign(Object(), { text: scenario.then || scenario.text || scenario });
  const verifyCommand = scenario.verify_command || scenario.verifyCommand;
  // P10.S1 compile-time validation: reject verify commands with unquoted shell metacharacters
  if (verifyCommand && !parseCommandToArgv(verifyCommand).ok) {
    // Strip the unsafe command; acceptance stays WARN (manual)
    return {
      id: `POST-${taskId}-SCENARIO-${index + 1}`,
      type: "acceptance_criteria",
      severity: "WARN",
      params,
      message: `${scenario.then || scenario.text || scenario} [verify_command rejected at compile time: shell metacharacters forbidden]`,
    };
  }
  if (verifyCommand) params.verify_command = verifyCommand;
  return {
    id: `POST-${taskId}-SCENARIO-${index + 1}`,
    type: "acceptance_criteria",
    severity: verifyCommand ? "FAIL" : "WARN",
    params,
    message: scenario.then || scenario.text || scenario,
  };
}

function demandAutomationText(session = Object()) {
  return [
    session.vision?.statement,
    session.vision?.idea,
    session.prd_intake?.desired_outcomes,
    session.prd_intake?.success_proof,
    session.nontechnical_intake?.desired_outcomes,
    session.nontechnical_intake?.success_proof,
    session.success_criteria,
    session.acceptance_criteria,
    asArray(session.requirements?.active || session.requirements)
      .flatMap((requirement) => [
        requirement?.text,
        requirement?.acceptance_criteria,
        asArray(requirement?.acceptance_scenarios || requirement?.scenarios).flatMap((scenario) => [
          scenario?.then,
          scenario?.text,
          scenario?.proof,
          scenario?.verify_command,
          scenario?.verifyCommand,
        ]),
      ]),
  ].flatMap((item) => asArray(item)).map(clean).filter(Boolean).join("\n");
}

function demandRequiresAutomatedAcceptance(session = Object()) {
  const text = demandAutomationText(session);
  return /\b(automated|machine[- ]verifiable|executable|assert(?:ion)?|fixture|npm test|pnpm test|yarn test|vitest|jest|playwright|unit test|integration test|verify_command)\b|自动验证|自动验收|可自动验证|机器可执行|断言|测试内置|内置 fixture|不包含 manual|不含 manual|不包含人工|不含人工/i.test(text);
}

function hasVerifyCommand(condition = Object()) {
  return Boolean(condition.verify_command || condition.verifyCommand || condition.params?.verify_command || condition.params?.verifyCommand);
}

function machineAcceptanceConditions(taskId, scenario = Object(), context = Object()) {
  const verifyCommand = scenario.verify_command || scenario.verifyCommand;
  if (verifyCommand) return [acceptanceCondition(taskId, 0, scenario)];
  return [testsPassCondition(taskId, context)];
}

function buildConfigValue(config = Object(), key = "") {
  const build = config.build && typeof config.build === "object" && !Array.isArray(config.build)
    ? config.build
    : Object();
  return clean(build[key]);
}

function taskToolchainKinds(task = Object()) {
  const kinds = new Set();
  for (const condition of asArray(task.post_conditions)) {
    if (condition?.type === "tests_pass" || condition?.type === "test_file_passes") kinds.add("test");
    if (condition?.type === "no_new_type_errors") kinds.add("type_check");
    if (condition?.type === "build_pass") kinds.add("build");
  }
  return kinds;
}

function requiresGreenfieldScaffold(tasks = [], context = Object()) {
  const kinds = new Set<string>(tasks.flatMap((task) => [...taskToolchainKinds(task)].map(String)));
  if (kinds.size === 0) return false;
  const projectRoot = context.projectRoot || process.cwd();
  const hasPackageJson = existsSync(join(projectRoot, "package.json"));
  if (!hasPackageJson) return true;
  const config = context.config || Object();
  return [...kinds].some((kind) => !buildConfigValue(config, kind === "type_check" ? "type_check" : kind));
}

const INSTRUCTION_TOOL_PACKAGE_NAMES = new Map([["jest", "jest"], ["tsc", "typescript"], ["typescript", "typescript"], ["vitest", "vitest"]]);

function generatedTaskInstructionsText(task = Object()) {
  const instructions = task.instructions ?? task.instruction ?? task.handoff?.instructions ?? [];
  return asArray(instructions)
    .flatMap((item) => asArray(item))
    .map(clean)
    .filter(Boolean)
    .join("\n");
}

function collectInstructionToolReferences(text = "") {
  const tools = new Set<string>();
  const source = clean(text);
  for (const tool of INSTRUCTION_TOOL_PACKAGE_NAMES.keys()) {
    if (new RegExp(`\\b${tool}\\b`, "i").test(source)) tools.add(tool);
  }
  const patterns = [/\bnpm\s+(?:exec|x)\s+(@?[A-Za-z0-9._-][A-Za-z0-9._/-]*)/gi, /\bnpx\s+(@?[A-Za-z0-9._-][A-Za-z0-9._/-]*)/gi, /\bpnpm\s+(?!(?:add|install|run|test)\b)(@?[A-Za-z0-9._-][A-Za-z0-9._/-]*)/gi, /\byarn\s+(?!(?:add|install|run|test)\b)(@?[A-Za-z0-9._-][A-Za-z0-9._/-]*)/gi];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const tool = clean(match[1]).split("/").pop() || clean(match[1]);
      if (tool && INSTRUCTION_TOOL_PACKAGE_NAMES.has(tool)) tools.add(tool);
    }
  }
  return [...tools];
}

function instructionInstallsPackage(text = "", packageName = "") {
  if (!packageName) return false;
  return new RegExp(`\\b(?:npm\\s+(?:install|i)|pnpm\\s+add|yarn\\s+add)\\b[^\\n;]*\\b${packageName}\\b`, "i").test(text);
}

function conditionCommandExecutable(condition = Object()) {
  const command = clean(condition?.params?.command || condition?.command);
  const parsed = parseCommandToArgv(command);
  return parsed.ok ? clean(parsed.argv?.[0]) : "";
}

function taskHasToolAvailabilityGuarantee(task = Object(), tool = "") {
  const packageName = INSTRUCTION_TOOL_PACKAGE_NAMES.get(tool) || tool;
  const conditions = [...asArray(task.pre_conditions), ...asArray(task.post_conditions)];
  return conditions.some((condition) => {
    if (condition?.type !== "build_command_available") return false;
    const executable = conditionCommandExecutable(condition);
    return executable === tool || executable === packageName;
  });
}

export function inspectGeneratedTaskInstructionsSelfConsistent(tasks = []) {
  const blockers = [];
  for (const task of asArray(tasks)) {
    const instructions = generatedTaskInstructionsText(task);
    if (!instructions) continue;
    for (const tool of collectInstructionToolReferences(instructions)) {
      const packageName = INSTRUCTION_TOOL_PACKAGE_NAMES.get(tool) || tool;
      if (instructionInstallsPackage(instructions, packageName) || taskHasToolAvailabilityGuarantee(task, tool)) continue;
      blockers.push({ code: "TASK_INSTRUCTIONS_TOOL_UNGUARANTEED", task_id: task?.id || null, tool, package: packageName, message: `Task instructions reference "${tool}" without installing "${packageName}" or declaring a command-availability gate.`, suggestion: `Install ${packageName} in the same task instructions or add a build_command_available condition for ${tool}.` });
    }
  }
  return blockers;
}

export function assertGeneratedTaskInstructionsSelfConsistent(tasks = []) {
  const blockers = inspectGeneratedTaskInstructionsSelfConsistent(tasks);
  if (blockers.length > 0) {
    const error = Object.assign(
      new Error(`Generated task instructions are not self-consistent: ${blockers.map((blocker) => `${blocker.task_id || "unknown"}:${blocker.tool}`).join(", ")}`),
      { blockers },
    );
    throw error;
  }
}

function scaffoldInstructions(needsTypecheck = false) {
  const steps = [
    "Create package.json for a minimal Node.js project using built-in Node tooling.",
    "Set scripts.test to \"node --test\" so the test command uses the node:test runner with zero test-framework dependencies.",
  ];
  if (needsTypecheck) {
    steps.push(
      "Run npm install --save-dev typescript --package-lock=false so node_modules/.bin/tsc exists for type-check gates.",
      "Set scripts.typecheck to \"tsc --noEmit\".",
    );
  }
  steps.push("Do not add extra test framework dependencies for this scaffold task.");
  return steps;
}

function buildCommandAvailableCondition(taskId, kind, command) {
  return {
    id: `POST-${taskId}-${kind === "type_check" ? "TYPECHECK" : kind.toUpperCase()}-COMMAND-AVAILABLE`,
    type: "build_command_available",
    severity: "FAIL",
    params: { kind, command },
    message: `Configured ${kind} command must be available before downstream gates run.`,
  };
}

function scaffoldPostConditions(taskId, context = Object(), needsTypecheck = false) {
  const conditions: Array<Record<string, unknown>> = [
    {
      id: `POST-${taskId}-PACKAGE`,
      type: "file_exists",
      severity: "FAIL",
      params: { file: "package.json" },
      message: "Greenfield scaffold must create package.json before toolchain gates run.",
    },
    {
      id: `POST-${taskId}-TEST-SCRIPT`,
      type: "code_contains",
      severity: "FAIL",
      params: { file: "package.json", text: "\"test\"" },
      message: "package.json must expose a test script for config.build.test.",
    },
    {
      id: `POST-${taskId}-NODE-TEST-SCRIPT`,
      type: "code_contains",
      severity: "FAIL",
      params: { file: "package.json", text: "node --test" },
      message: "package.json test script must use the built-in node:test runner.",
    },
    buildCommandAvailableCondition(taskId, "test", "node --test"),
    testsPassCondition(taskId, context),
  ];
  if (needsTypecheck) {
    conditions.splice(3, 0, {
      id: `POST-${taskId}-TYPECHECK-SCRIPT`,
      type: "code_contains",
      severity: "FAIL",
      params: { file: "package.json", text: "\"typecheck\"" },
      message: "package.json must expose a typecheck script before type gates run.",
    }, {
      id: `POST-${taskId}-TYPECHECK-COMMAND`,
      type: "code_contains",
      severity: "FAIL",
      params: { file: "package.json", text: "tsc --noEmit" },
      message: "package.json typecheck script must invoke the TypeScript compiler.",
    }, {
      id: `POST-${taskId}-TYPESCRIPT-DEVDEP`,
      type: "code_contains",
      severity: "FAIL",
      params: { file: "package.json", text: "\"typescript\"" },
      message: "package.json must record TypeScript as a dev dependency before type gates run.",
    });
    conditions.push(buildCommandAvailableCondition(taskId, "type_check", "tsc --noEmit"));
  }
  return conditions;
}

function buildGreenfieldScaffoldTask(session = Object(), tasks = [], context = Object()) {
  if (!requiresGreenfieldScaffold(tasks, context)) return null;
  const requirements = asArray(session.requirements?.active || session.requirements);
  const firstRequirement = requirements[0] || {};
  const requirementId = firstRequirement.id || tasks[0]?.requirement_ids?.[0] || "REQ-GREENFIELD-SCAFFOLD";
  const designId = `DES-${requirementId}`;
  const taskId = "DEMAND-GREENFIELD-SCAFFOLD-001";
  const needsTypecheck = tasks.some((task) => taskToolchainKinds(task).has("type_check"));
  const sourceQuestions = uniqueStrings(tasks.flatMap((task) => asArray(task.source_question_ids)));
  const sessionPlan = buildTaskSessionPlan({
    demandId: session.id,
    taskId,
    requirementId,
    scenarioId: "SCN-GREENFIELD-SCAFFOLD",
    surfaceId: "SFC-GREENFIELD-SCAFFOLD",
  });
  return {
    id: taskId,
    title: "Scaffold greenfield Node toolchain",
    description: "Create package.json with the project toolchain scripts.",
    priority: "P0",
    type: "feature",
    status: "pending",
    task_kind: "greenfield_scaffold",
    requirement_ids: [requirementId].filter(Boolean),
    design_ids: [designId],
    source_finding_ids: [requirementId].filter(Boolean),
    source_question_ids: sourceQuestions,
    verification_hint: "Run the configured test command after package.json is created.",
    instructions: scaffoldInstructions(needsTypecheck),
    inputs: [".yolo/config.json"],
    expected_output: ["package.json"],
    depends_on: [],
    handoff: {
      type: "agent_brief",
      category: "scaffold",
      session: sessionPlan,
      plain_language_goal: "Create package.json with the project toolchain scripts.",
      user_story: "As the automation runner, I need package.json scripts before downstream tasks run.",
      source_question_ids: sourceQuestions,
      current_behavior: "The greenfield target has no package.json, so toolchain gates fail before implementation.",
      desired_behavior: "package.json contains executable project toolchain scripts.",
      touchpoint: "project scaffold",
      trigger: "before any generated task with type/test post_conditions runs",
      scenario: {
        id: "SCN-GREENFIELD-SCAFFOLD",
        actor: "automation runner",
        touchpoint: "project scaffold",
        trigger: "toolchain gate setup",
        current_behavior: "package.json is missing",
        desired_behavior: "package.json toolchain scripts are available",
        proof: "The configured test command executes successfully.",
      },
      requirement: {
        id: requirementId,
        text: firstRequirement.text || "Greenfield project needs an executable scaffold before toolchain gates.",
      },
      surface: {
        id: "SFC-GREENFIELD-SCAFFOLD",
        kind: "code",
        label: "Project scaffold",
        target_files: ["package.json"],
        readonly_files: [],
        visual_style_source: [],
        session_budget: { expected: "single_session", max_files: 1, max_lines_per_file: 120 },
      },
      key_interfaces: ["package.json"],
      read_first: [".yolo/config.json"],
      acceptance_criteria: ["package.json exposes node --test and TypeScript command availability when type gates are required."],
      instructions: scaffoldInstructions(needsTypecheck),
      proof: "package.json exists, npm test succeeds with node --test, and required toolchain commands are available.",
      verification_hint: "Run npm test after package.json is created; when type gates are required, verify node_modules/.bin/tsc is available.",
      project_facts: structuredProjectFacts(session),
      deferred_scope: asArray(session.discussion?.deferred),
      deferred_scope_confirmation: deferredScopeConfirmation(session),
      deferred_follow_up: deferredFollowUp(session.discussion?.deferred),
      out_of_scope: session.requirements?.out_of_scope || [],
      constraints: session.requirements?.constraints || [],
      exceptions: [],
      question_trace: sourceQuestions,
      evidence_chain: {
        intake_schema: session.prd_intake?.schema || session.nontechnical_intake?.schema || null,
        demand_id: session.id,
        scenario_id: "SCN-GREENFIELD-SCAFFOLD",
        surface_id: "SFC-GREENFIELD-SCAFFOLD",
        approval_reason: session.approval_reason || session.approval?.reason || session.approval?.note || "",
      },
      must_haves: {
        truths: ["Greenfield type/test gates require a local executable toolchain before downstream tasks run."],
        artifacts: [
          sessionPlan.state_path,
          sessionPlan.handoff_path,
          sessionPlan.evidence_path,
          ...sessionPlan.memory_update_paths,
        ],
        key_links: [
          `demand:${session.id}`,
          `requirement:${requirementId}`,
          "scenario:SCN-GREENFIELD-SCAFFOLD",
          "surface:SFC-GREENFIELD-SCAFFOLD",
        ],
      },
    },
    acceptance_criteria: ["package.json exposes node --test and TypeScript command availability when type gates are required."],
    scope: {
      targets: [{ file: "package.json", description: "Minimal greenfield toolchain scaffold" }],
      readonly_files: [],
      allow_new_files: true,
      allow_delete_files: false,
      max_files: 1,
      max_lines_per_file: 120,
    },
    pre_conditions: [],
    post_conditions: scaffoldPostConditions(taskId, context, needsTypecheck),
    trace: {
      demand_id: session.id,
      requirement_id: requirementId,
      scenario_id: "SCN-GREENFIELD-SCAFFOLD",
      surface_id: "SFC-GREENFIELD-SCAFFOLD",
      evidence: uniqueStrings(requirements.flatMap((requirement) => requirement.trace?.evidence || [])),
      decisions: uniqueStrings(requirements.flatMap((requirement) => requirement.trace?.decisions || [])),
      question_trace: sourceQuestions,
      source_question_ids: sourceQuestions,
    },
    deferred_scope: asArray(session.discussion?.deferred),
    deferred_scope_confirmation: deferredScopeConfirmation(session),
    deferred_follow_up: deferredFollowUp(session.discussion?.deferred),
    atomicity: {
      expected_session: "single_session",
      source: "greenfield_toolchain_scaffold",
    },
    must_fix_before_ship: true,
  };
}

function addScaffoldDependency(tasks = [], scaffold = null) {
  if (!scaffold) return tasks;
  for (const task of tasks) {
    if (taskToolchainKinds(task).size === 0) continue;
    task.depends_on = [...new Set([...(task.depends_on || []), scaffold.id])];
  }
  return [scaffold, ...tasks];
}

function uniqueConditions(conditions = []) {
  const seen = new Set();
  const result = [];
  for (const condition of conditions.filter(Boolean)) {
    const key = condition.id || JSON.stringify([condition.type, condition.params || {}, condition.message || ""]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(condition);
  }
  return result;
}

function toolchainContext(input = Object(), options = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const config = loadProjectToolchainConfig(projectRoot, {
    config: input.config || options.config,
    configPath: input.configPath || input.config_path || options.configPath || options.config_path,
  });
  return { projectRoot, config };
}

function testsPassCondition(taskId, context = Object()) {
  const projectRoot = context.projectRoot || process.cwd();
  const config = context.config || Object();
  return {
    id: `POST-${taskId}-TESTS`,
    type: "tests_pass",
    severity: "FAIL",
    params: { command: resolveBuildCommand("test", config, projectRoot), timeout_ms: resolveGateTimeout("test", config) },
    message: "Project tests must pass after this task.",
  };
}

function typecheckCondition(taskId, context = Object()) {
  const projectRoot = context.projectRoot || process.cwd();
  const config = context.config || Object();
  return {
    id: `POST-${taskId}-TYPECHECK`,
    type: "no_new_type_errors",
    severity: "FAIL",
    params: { command: resolveBuildCommand("type_check", config, projectRoot) },
    message: "Project typecheck must pass after this task.",
  };
}

function behaviorCodeConditions(taskId, files = [], text = "", uiTask = false) {
  const sourceFiles = files.filter((file) => fileKind(file) !== "test");
  const primary = sourceFiles[0] || files[0];
  if (!primary) return [];
  const conditions = [];
  const add = (suffix, file, pattern, message) => {
    const value = clean(pattern);
    if (!value || value.length <= 1) return;
    if (conditions.some((condition) => condition.params?.file === file && condition.params?.text === value)) return;
    conditions.push({
      id: `POST-${taskId}-${suffix}`,
      type: "code_contains",
      severity: "FAIL",
      params: { file, text: value },
      message,
    });
  };
  const quoted = clean(text).match(/['"`]([^'"`]{2,40})['"`]/);
  if (uiTask && quoted?.[1]) {
    add("UI-LABEL", primary, quoted[1], `Target UI must contain visible label text: ${quoted[1]}`);
  }
  const identifiers = [...new Set((clean(text).match(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:Threshold|Stock|Quantity|Qty|Signal|Badge)[A-Za-z0-9_$]*\b/g) || [])
    .filter((value) => !["Inventory", "Stock", "Quantity"].includes(value)))];
  for (const identifier of identifiers.slice(0, 2)) {
    add(`IDENT-${conditions.length + 1}`, primary, identifier, `Target code must contain behavior identifier: ${identifier}`);
  }
  if (/(<=|less than or equal|at or below)/i.test(text)) add("COMPARE-LTE", primary, "<=", "Target code must implement the stated <= comparison.");
  else if (/(<\s*0|below zero|negative)/i.test(text)) add("COMPARE-LT-ZERO", primary, "< 0", "Target code must implement the stated negative-value comparison.");
  return conditions.slice(0, 3);
}

function relatedReadFirst(files = [], scenarioFiles = [], surface = Object()) {
  const own = asArray(files);
  const readonly = asArray(surface.readonly_files);
  const kind = clean(surface.kind);
  const related = [];
  if (kind === "test") {
    related.push(...scenarioFiles.filter((file) => fileKind(file) !== "test"));
  } else if (kind === "ui") {
    related.push(...scenarioFiles.filter((file) => ["service", "api", "data", "code"].includes(fileKind(file))));
  }
  return [...new Set([...own, ...readonly, ...related].filter(Boolean))];
}

function addTaskDependencies(tasks = []) {
  const byScenario = new Map();
  for (const task of tasks) {
    const scenarioId = task.trace?.scenario_id || task.handoff?.scenario?.id || "";
    if (!scenarioId) continue;
    if (!byScenario.has(scenarioId)) byScenario.set(scenarioId, []);
    byScenario.get(scenarioId).push(task);
  }
  for (const scenarioTasks of byScenario.values()) {
    const implementationTasks = scenarioTasks.filter((task) => !asArray(task.scope?.targets).some((target) => fileKind(target.file || target) === "test"));
    const testTasks = scenarioTasks.filter((task) => asArray(task.scope?.targets).some((target) => fileKind(target.file || target) === "test"));
    for (const task of testTasks) {
      task.depends_on = [...new Set([...(task.depends_on || []), ...implementationTasks.map((item) => item.id).filter(Boolean)])];
    }
    const uiTasksInScenario = scenarioTasks.filter((task) => asArray(task.scope?.targets).some((target) => fileKind(target.file || target) === "ui"));
    const serviceTasks = implementationTasks.filter((task) => asArray(task.scope?.targets).some((target) => ["service", "api", "data", "code"].includes(fileKind(target.file || target))));
    for (const task of uiTasksInScenario) {
      task.depends_on = [...new Set([...(task.depends_on || []), ...serviceTasks.map((item) => item.id).filter((id) => id && id !== task.id)])];
    }
  }
  return tasks;
}

function deriveFileDependencies(tasks = []) {
  for (const taskB of tasks) {
    const bInputs = asArray(taskB.inputs).map(clean).filter(Boolean);
    const bOutputs = new Set(asArray(taskB.expected_output).map(clean).filter(Boolean));
    for (const taskA of tasks) {
      if (taskA.id === taskB.id) continue;
      const aOutputs = new Set(asArray(taskA.expected_output).map(clean).filter(Boolean));
      const overlap = bInputs.filter((input) => aOutputs.has(input));
      // Own targets are read-before-edit context, not cross-task prerequisites.
      const meaningfulOverlap = overlap.filter((file) => fileKind(file) !== "test" && !bOutputs.has(file));
      if (meaningfulOverlap.length > 0) {
        taskB.depends_on = [...new Set([...(taskB.depends_on || []), taskA.id])];
      }
    }
  }
  return tasks;
}

function buildAtomicDemandTasks(session = Object(), input = Object(), options = Object()) {
  const buildContext = toolchainContext(input, options);
  const automatedAcceptanceRequired = demandRequiresAutomatedAcceptance(session);
  const requirements = requirementById(session);
  const scenarios = scenarioMatrix(session).length ? scenarioMatrix(session) : fallbackScenarios(session);
  const allFiles = targetFiles(session);
  const tasks = [];
  const compileErrors = [];
  const taskConceptsByScope = new Map();
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const requirement = requirements.get(scenario.requirement_id) || {};
    const surfaces = asArray(scenario.surfaces).length
      ? asArray(scenario.surfaces)
      : [{ id: `${scenario.id}-SFC-001`, kind: "code", label: "代码实现", target_files: allFiles }];
    const scenarioTaskKeys = new Set();
    for (const [surfaceIndex, surface] of surfaces.entries()) {
      const maxFiles = Math.max(1, Number(surface.session_budget?.max_files || input.max_files_per_task || input.maxFilesPerTask || 2));
      const surfaceFiles = asArray(surface.target_files).length ? asArray(surface.target_files) : allFiles;
      const scenarioFiles = [...new Set(surfaces.flatMap((item) => asArray(item.target_files)).concat(allFiles).filter(Boolean))];
      const fileChunks = chunk(surfaceFiles, maxFiles);
      for (const [chunkIndex, files] of fileChunks.entries()) {
        const taskTitle = `${surfaceTitle(surface)}: ${scenario.requirement_id || requirement.id || scenario.id || "DEMAND"}`;
        const taskKind = clean(surface.kind).toLowerCase() || fileKind(files[0]) || "code";
        const dedupKey = scenarioTaskDedupKey({ files, kind: taskKind, title: taskTitle });
        if (scenarioTaskKeys.has(dedupKey)) continue;
        scenarioTaskKeys.add(dedupKey);

        const proof = clean(surface.proof || scenario.proof || requirement.text || scenario.desired_behavior);
        const scopeKey = scenarioTaskScopeKey({ files, kind: taskKind });
        const seenConcepts = taskConceptsByScope.get(scopeKey) || [];
        const concept = taskConceptRecord({ scenario, requirement, proof });
        if (redundantScenarioTask(concept, seenConcepts)) continue;

        const taskId = `DEMAND-${scenario.requirement_id || "REQ"}-${String(scenarioIndex + 1).padStart(3, "0")}${String(surfaceIndex + 1).padStart(2, "0")}${String(chunkIndex + 1).padStart(2, "0")}`;
        const verifyCommand = scenario.verify_command || scenario.verifyCommand;
        if (verifyCommand && !parseCommandToArgv(verifyCommand).ok) {
          const parsed = parseCommandToArgv(verifyCommand);
          compileErrors.push({
            code: "ILLEGAL_VERIFY_COMMAND",
            task_id: taskId,
            original_command: verifyCommand,
            illegal_chars: parsed.ok ? "" : (parsed.detail.match(/"(.+?)"/)?.[1] || "shell_metachar"),
            suggestion: `Replace "${verifyCommand}" with a single safe command without shell metacharacters ($ ; & | > < \` ( ) { } etc.).`,
          });
        }
        const description = clean(scenario.desired_behavior || requirement.text || proof);
        const sourceQuestions = sourceQuestionIds(session, scenario, requirement);
        const taskVerificationHint = verificationHint({ scenario, surface, proof, files });
        const uiTask = isUiSurface(surface, files);
        const readFirst = relatedReadFirst(files, scenarioFiles, surface);
        const behaviorText = [
          description,
          proof,
          taskVerificationHint,
          ...asArray(scenario.constraints || session.requirements?.constraints),
          ...asArray(surface.visual_style_source || scenario.visual_style_source || session.context?.visual_style_source),
          ...asArray(session.discussion?.decisions).map((item) => item.text || item),
        ].join("\n");
        const projectFacts = {
          schema: "yolo.demand.task_project_facts.v1",
          structured: structuredProjectFacts(session),
          target_files: asArray(session.project_facts?.target_files),
          candidate_target_files: asArray(session.project_facts?.candidate_target_files || session.project?.candidate_target_files),
          current_state: asArray(session.context?.current_state || session.vision?.status_quo),
          evidence: asArray(session.investigation?.evidence).map((item) => item.text || item).filter(Boolean),
          assumptions: asArray(session.project_facts?.assumptions || session.reflection?.assumption_records || session.reflection?.assumptions || session.assumptions),
          decisions: asArray(session.discussion?.decisions).map((item) => item.text || item).filter(Boolean),
          constraints: asArray(scenario.constraints || session.requirements?.constraints),
          out_of_scope: asArray(scenario.out_of_scope || session.requirements?.out_of_scope),
          deferred_scope: asArray(session.discussion?.deferred),
          deferred_scope_confirmation: deferredScopeConfirmation(session),
        };
        const followUp = deferredFollowUp(session.discussion?.deferred);
        const currentBehavior = clean(scenario.current_behavior) || (session.context?.current_state || session.vision?.status_quo || []).join("; ") || "Captured in demand CONTEXT.md.";
        const currentBehaviorWithEvidence = [
          currentBehavior,
          projectFacts.evidence.length ? `Evidence: ${projectFacts.evidence.slice(0, 3).join("; ")}` : "",
        ].filter(Boolean).join(" ");
        const desiredOutcomes = asArray(session.prd_intake?.desired_outcomes || session.nontechnical_intake?.desired_outcomes)
          .map(clean)
          .filter(Boolean);
        const evidenceLikeProof = /\b(screenshot|test|assert|verify|observe|component|regression)\b|截图|测试|验证/i.test(proof);
        const outcomeValue = desiredOutcomes.find((item) => item !== description && item !== proof);
        const userValue = outcomeValue
          || (currentBehavior ? `they no longer rely on the current behavior: ${currentBehavior}` : "")
          || (proof && proof !== description && !evidenceLikeProof ? proof : "")
          || "the workflow has a clear, user-visible outcome";
        const sessionPlan = buildTaskSessionPlan({
          demandId: session.id,
          taskId,
          requirementId: scenario.requirement_id || requirement.id,
          scenarioId: scenario.id,
          surfaceId: surface.id,
        });
        tasks.push({
          id: taskId,
          title: taskTitle,
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
          inputs: readFirst,
          expected_output: files,
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
            user_story: `As ${scenario.actor || "the target user"}, I want ${description}, so that ${userValue}.`,
            source_question_ids: sourceQuestions,
            current_behavior: currentBehaviorWithEvidence,
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
              visual_style_source: asArray(surface.visual_style_source || scenario.visual_style_source || session.context?.visual_style_source),
              session_budget: surface.session_budget || null,
            },
            key_interfaces: files,
            read_first: readFirst,
            acceptance_criteria: [proof].filter(Boolean),
            proof,
            verification_hint: taskVerificationHint,
            project_facts: projectFacts,
            deferred_scope: asArray(session.discussion?.deferred),
            deferred_scope_confirmation: deferredScopeConfirmation(session),
            deferred_follow_up: followUp,
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
            must_haves: {
              truths: [
                ...projectFacts.assumptions.map((a) => (typeof a === "string" ? a : a.text || "")).filter(Boolean),
                ...projectFacts.constraints.filter(Boolean),
                ...projectFacts.evidence.filter(Boolean),
              ].slice(0, 20),
              artifacts: [
                sessionPlan.state_path,
                sessionPlan.handoff_path,
                sessionPlan.evidence_path,
                ...sessionPlan.memory_update_paths,
              ],
              key_links: [
                `demand:${session.id}`,
                `requirement:${scenario.requirement_id || requirement.id}`,
                `scenario:${scenario.id}`,
                `surface:${surface.id}`,
              ],
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
          post_conditions: uniqueConditions([
            ...files.map((file, fileIndex) => modifiedFileCondition(taskId, fileIndex, file)),
            ...behaviorCodeConditions(taskId, files, behaviorText, uiTask),
            ...(hasVerifyCommand({ verify_command: scenario.verify_command || scenario.verifyCommand })
              ? [acceptanceCondition(taskId, 0, { then: proof || description, verify_command: scenario.verify_command || scenario.verifyCommand })]
              : automatedAcceptanceRequired
                ? machineAcceptanceConditions(taskId, { then: proof || description }, buildContext)
                : []),
            typecheckCondition(taskId, buildContext),
            ...(files.some((file) => fileKind(file) === "test") ? [testsPassCondition(taskId, buildContext)] : []),
          ]),
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
          deferred_scope: asArray(session.discussion?.deferred),
          deferred_scope_confirmation: deferredScopeConfirmation(session),
          deferred_follow_up: followUp,
          atomicity: {
            expected_session: surface.session_budget?.expected || "single_session",
            source: "scenario_surface",
          },
          must_fix_before_ship: true,
        });
        taskConceptsByScope.set(scopeKey, [...seenConcepts, concept]);
      }
    }
  }
  addTaskDependencies(tasks);
  deriveFileDependencies(tasks);
  const scaffold = buildGreenfieldScaffoldTask(session, tasks, buildContext);
  const generatedTasks = addScaffoldDependency(tasks, scaffold);
  return { tasks: generatedTasks, compileErrors: [...compileErrors, ...inspectGeneratedTaskInstructionsSelfConsistent(generatedTasks)] };
}

function inspectAtomicity(tasks = [], input = Object(), options = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const results = [];
  const blockers = [];
  const warnings = [];
  for (const task of tasks) {
    if (!shouldInspectAtomicity(task, "demand")) continue;
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

export interface DemandPrdCompiledResult {
  status: string;
  code: string;
  summary: string;
  grounding?: Record<string, unknown>;
  grounded_session?: Record<string, unknown>;
  readiness: ReturnType<typeof inspectDemandReadiness>;
  atomicity?: ReturnType<typeof inspectAtomicity>;
  quality_report: ReturnType<typeof inspectDemandQuality>;
  blockers: ReturnType<typeof inspectDemandReadiness>["blockers"];
  warnings: ReturnType<typeof inspectDemandReadiness>["warnings"];
  prd: Record<string, unknown> | null;
  next_actions: string[];
}

function buildDemandPrd(session = Object(), input = Object(), options = Object()): DemandPrdCompiledResult {
  const projectRoot = input.projectRoot || input.project_root || options.projectRoot || options.project_root;
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const stateDir = join(stateRoot, "state");
  const grounding = groundDemandExecutionScope(session, {
    ...options,
    ...input,
    projectRoot,
    stateRoot,
  });
  session = grounding.session || session;
  const readiness = inspectDemandReadiness(session, { phase: "prd", projectRoot, stateDir });
  if (!readiness.executable_prd_ready) {
    const quality = inspectDemandQuality(session, {
      phase: "prd",
      readiness,
      projectRoot,
      stateDir,
    });
    return {
      status: "blocked",
      code: "DEMAND_NOT_EXECUTABLE",
      summary: "Demand artifacts are not approved or complete enough for executable PRD.",
      grounding,
      grounded_session: session,
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
  const { tasks, compileErrors } = buildAtomicDemandTasks(session, { ...input, projectRoot: input.projectRoot || input.project_root }, options);
  if (compileErrors.length > 0) {
    const verifyOnly = compileErrors.every((err) => (err.code || "ILLEGAL_VERIFY_COMMAND") === "ILLEGAL_VERIFY_COMMAND");
    return {
      status: "blocked",
      code: verifyOnly ? "DEMAND_VERIFY_COMMAND_BLOCKED" : "DEMAND_TASK_INSTRUCTIONS_BLOCKED",
      summary: verifyOnly
        ? "PRD compilation blocked by illegal verify_command in task acceptance criteria."
        : "PRD compilation blocked by generated task instructions that reference unavailable tools.",
      grounding,
      grounded_session: session,
      readiness,
      quality_report: { status: "blocked", warnings: [], blockers: compileErrors.map((err) => err.task_id) } as ReturnType<typeof inspectDemandQuality>,
      blockers: compileErrors.map((err) => ({
        code: err.code || "ILLEGAL_VERIFY_COMMAND",
        task_id: err.task_id,
        message: err.message || `Task ${err.task_id} contains illegal verify_command: "${err.original_command}". Illegal characters: ${err.illegal_chars}. ${err.suggestion}`,
        ...err,
      })),
      warnings: readiness.warnings,
      prd: null,
      next_actions: compileErrors.map((err) => err.suggestion || `Fix verify_command for task ${err.task_id}.`),
    };
  }
  const atomicity = inspectAtomicity(tasks, input, options);
  const sessionHandoff = summarizeTaskSessionPlans(tasks);
  const quality = inspectDemandQuality(session, {
    phase: "prd",
    readiness,
    tasks,
    atomicity,
    requireTasks: true,
    projectRoot,
    stateDir,
  });
  if (atomicity.blockers.length > 0) {
    return {
      status: "blocked",
      code: "DEMAND_ATOMICITY_BLOCKED",
      summary: "Demand PRD contains tasks that are too coarse for one-session execution.",
      grounding,
      grounded_session: session,
      readiness,
      atomicity,
      quality_report: quality,
      blockers: atomicity.blockers,
      warnings: [...readiness.warnings, ...atomicity.warnings, ...quality.warnings],
      prd: null,
      next_actions: atomicity.blockers.map((blocker) => `${blocker.task_id}: split scenario surface before PRD generation.`),
    };
  }
  if (quality.status === "blocked" || quality.status === "warning") {
    const qualityWarningsAsBlockers = asArray(quality.warnings).map((warning) => ({
      code: warning.code || "DEMAND_QUALITY_WARNING",
      message: warning.message || warning.detail || "Demand PRD quality warning must be resolved before executable PRD.",
      warning,
    }));
    return {
      status: "blocked",
      code: quality.status === "blocked" ? "DEMAND_QUALITY_BLOCKED" : "DEMAND_QUALITY_WARNING",
      summary: quality.status === "blocked"
        ? "Demand PRD quality is below the executable threshold."
        : "Demand PRD quality has warnings; executable PRD requires a clean pass.",
      grounding,
      grounded_session: session,
      readiness,
      atomicity,
      quality_report: quality,
      blockers: quality.status === "blocked" ? quality.blockers : qualityWarningsAsBlockers,
      warnings: [...readiness.warnings, ...atomicity.warnings, ...quality.warnings],
      prd: null,
      next_actions: quality.next_actions,
    };
  }

  const prd = {
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
      approval: {
        ...session.approval,
        effective_for_prd: session.approval?.approved === true && readiness.executable_prd_ready === true,
      },
      approval_reason: session.approval_reason || session.approval?.reason || session.approval?.note || "",
      deferred_scope: asArray(session.discussion?.deferred),
      deferred_scope_confirmation: deferredScopeConfirmation(session),
      deferred_follow_up: deferredFollowUp(session.discussion?.deferred),
      out_of_scope: asArray(session.requirements?.out_of_scope),
      prd_intake: session.prd_intake || session.nontechnical_intake || null,
      interview: session.interview || null,
      question_trace: session.question_trace || [],
      grounding: grounding.applied ? grounding : null,
      readiness_level: readiness.readiness_level,
      readiness_score: readiness.quality_score,
      quality_score: quality.total_score,
      quality_report: quality,
      project_facts: structuredProjectFacts(session),
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
            visual_style_source: asArray(surface.visual_style_source || scenario.visual_style_source),
            session_budget: surface.session_budget || null,
          })),
        })),
      },
      atomicity_contract: {
        rule: session.scenario_matrix?.atomic_task_rule || "one user-visible story with one proof maps to one task",
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
      text: [
        `Implement ${requirement.id}: ${requirement.text}`,
        `Proof: ${asArray(requirement.acceptance_scenarios).map((scenario) => scenario.then || scenario.text).filter(Boolean).join("; ") || "Use task-level proof and post_conditions."}`,
        `Constraints: ${asArray(session.requirements?.constraints).join("; ") || "None recorded."}`,
        `Out of scope: ${asArray(session.requirements?.out_of_scope).join("; ") || "None recorded."}`,
      ].join("\n"),
    })),
    tasks,
    conflict_policy: {
      on_overlap: "sequential",
      overlap_detection: "file_only",
    },
  };

  return {
    status: "success",
    code: "DEMAND_PRD_READY",
    summary: "Executable PRD compiled from approved demand artifacts.",
    grounding,
    grounded_session: session,
    readiness,
    atomicity,
    quality_report: quality,
    blockers: [],
    warnings: [...readiness.warnings, ...atomicity.warnings, ...quality.warnings],
    prd,
    next_actions: ["Run yolo check on the compiled PRD before yolo run."],
  };
}

function groundingArtifact(value = Object()) {
  const { session: _session, ...artifact } = value || {};
  return artifact;
}

export function runDemandPrdRuntime(input = Object(), options = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const demandPath = resolvePath(projectRoot, input.demandPath || input.demand_path || input.demand || defaultDemandSessionPath(stateRoot, input.id || ""));
  const read = readDemandSession(demandPath);
  if (!read.ok) {
    return {
      status: "blocked",
      code: "DEMAND_SESSION_MISSING",
      summary: read.error,
      demand_path: demandPath,
      demand_id: undefined,
      compiled: { status: "blocked", code: "DEMAND_SESSION_MISSING", summary: read.error, readiness: undefined, quality_report: undefined, blockers: [{ code: "DEMAND_SESSION_MISSING", message: read.error }], warnings: [], prd: null, next_actions: [] },
      prd: null,
      preflight: null,
      readiness: undefined,
      quality_report: undefined,
      blockers: [{ code: "DEMAND_SESSION_MISSING", message: read.error }],
      warnings: [],
      artifacts: [],
      outputs: [],
      next_actions: ["Run yolo brainstorm/discuss first, or pass --demand <session.json|dir>."],
    };
  }

  const compiled = buildDemandPrd(read.session, input, options);
  const outputFile = resolvePath(projectRoot, input.outputFile || input.output_file || input.prdPath || input.prd_path || join(read.dir, "prd.json"));
  let preflight = null;
  if (compiled.prd) {
    preflight = preflightPrdDocument(compiled.prd, {
      file: outputFile,
      projectRoot,
      mode: "verify",
      strictExecution: true,
      requireDemandContract: true,
      strictWarnings: true,
    });
    if (preflight.status !== "pass") {
      compiled.status = "blocked";
      compiled.code = "DEMAND_PRD_PREFLIGHT_BLOCKED";
      compiled.summary = "Approved demand PRD failed runner preflight and was not written as executable.";
      compiled.blockers = [
        ...(compiled.blockers || []),
        ...asArray(preflight.blocked_reasons).map((reason) => ({
          code: reason.code || "PRD_PREFLIGHT_BLOCKED",
          message: reason.message || reason.detail || "PRD preflight blocked execution.",
          source: reason.source || "preflight",
          reason,
        })),
      ];
      compiled.warnings = [...(compiled.warnings || []), ...asArray(preflight.warnings)];
      compiled.next_actions = preflight.runner_readiness?.next_actions || ["Fix PRD preflight blockers before writing executable PRD."];
    }
  }
  const shouldWrite = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false;
  const artifacts = [];
  const outputs = [];
  let prdPath = null;
  if (shouldWrite && compiled.prd && compiled.status === "success") {
    prdPath = writeJson(outputFile, compiled.prd);
    artifacts.push(prdPath);
    outputs.push({ path: prdPath, type: "prd" });
  }
  if (shouldWrite && compiled.grounding?.applied && compiled.grounded_session) {
    const demandSessionPath = writeJson(read.path, compiled.grounded_session);
    const groundingPath = writeJson(join(read.dir, "GROUNDING.json"), groundingArtifact(compiled.grounding));
    const readinessPath = writeJson(join(read.dir, "READINESS.json"), compiled.readiness);
    artifacts.push(demandSessionPath, groundingPath, readinessPath);
    outputs.push(
      { path: demandSessionPath, type: "demand_session" },
      { path: groundingPath, type: "grounding" },
      { path: readinessPath, type: "readiness" },
    );
  }

  const result = {
    status: compiled.status,
    code: compiled.code,
    summary: compiled.summary,
    demand_path: read.path,
    demand_id: read.session.id,
    prd_path: prdPath,
    output_path: prdPath,
    compiled,
    prd: compiled.status === "success" ? compiled.prd : null,
    preflight,
    grounding: compiled.grounding || null,
    readiness: compiled.readiness,
    quality_report: compiled.quality_report,
    blockers: compiled.blockers || [],
    warnings: compiled.warnings || [],
    artifacts,
    outputs,
    next_actions: compiled.next_actions || [],
  };
  if (shouldWrite && compiled.prd && compiled.status === "success" && shouldWriteLifecycle(input, options)) {
    attachDemandPrerequisiteLifecycle(result, read, { projectRoot, stateRoot });
    attachLifecycle(result, "prd", { projectRoot, stateRoot }, "yolo-prd");
  }
  return result;
}

export function runDemandTaskRuntime(input = Object(), options = Object()) {
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
      next_actions: ["Run yolo interview to-demand first, or pass --demand <session.json|dir>."],
    };
  }

  const readiness = inspectDemandReadiness(read.session, { phase: read.session.phase, stateDir: join(stateRoot, "state") });
  if (readiness.status === "blocked") {
    return {
      status: "blocked",
      code: "DEMAND_TASKS_BLOCKED",
      summary: "Demand is not ready for task planning.",
      demand_path: read.path,
      demand_id: read.session.id,
      readiness,
      blockers: readiness.blockers || [],
      warnings: readiness.warnings || [],
      artifacts: [],
      outputs: [],
      next_actions: readiness.next_actions || ["Resolve demand blockers before task planning."],
    };
  }

  const taskBuild = buildAtomicDemandTasks(read.session, input, options);
  const atomicity = inspectAtomicity(taskBuild.tasks, input, options);
  const blockers = [
    ...taskBuild.compileErrors.map((error) => ({
      code: error.code === "TASK_INSTRUCTIONS_TOOL_UNGUARANTEED" ? "DEMAND_TASK_INSTRUCTIONS_TOOL_UNGUARANTEED" : "DEMAND_TASK_VERIFY_COMMAND_UNSAFE",
      message: error.message || `Task ${error.task_id} has an unsafe verify command.`,
      error,
    })),
    ...(atomicity.status === "blocked" ? atomicity.blockers || [] : []),
  ];
  const plan = {
    schema: "yolo.demand.tasks.v1",
    demand_id: read.session.id,
    demand_path: read.path,
    generated_at: new Date().toISOString(),
    status: blockers.length ? "blocked" : "success",
    task_count: taskBuild.tasks.length,
    tasks: taskBuild.tasks,
    readiness: {
      status: readiness.status,
      readiness_level: readiness.readiness_level,
      executable_prd_ready: readiness.executable_prd_ready,
    },
    atomicity,
  };
  const shouldWrite = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false;
  const outputFile = resolvePath(projectRoot, input.outputFile || input.output_file || join(read.dir, "tasks.json"));
  const artifacts = shouldWrite ? [writeJson(outputFile, plan)] : [];
  const result = {
    status: plan.status,
    code: plan.status === "success" ? "DEMAND_TASKS_READY" : "DEMAND_TASKS_BLOCKED",
    summary: plan.status === "success"
      ? "Demand task plan artifact created."
      : "Demand task plan is blocked by atomicity or compile issues.",
    demand_path: read.path,
    demand_id: read.session.id,
    plan,
    readiness,
    atomicity,
    blockers,
    warnings: [...(readiness.warnings || []), ...(atomicity.warnings || [])],
    artifacts,
    outputs: artifacts.map((path) => ({ path, type: "demand_task_plan" })),
    next_actions: plan.status === "success"
      ? ["Use yolo spec --demand <session.json|dir> to compile the executable PRD."]
      : blockers.map((blocker) => blocker.message).filter(Boolean),
  };
  if (shouldWrite && plan.status === "success" && shouldWriteLifecycle(input, options)) {
    attachLifecycle(result, "roadmap", { projectRoot, stateRoot }, "yolo-tasks");
  }
  return result;
}
