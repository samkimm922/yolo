import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildDemandSession, demandMarkdownArtifacts, groundDemandExecutionScope } from "./artifacts.js";
import { inspectDemandQuality, inspectDemandReadiness } from "./gate.js";
import { buildDemandSessionState, demandSessionSchemaError, type DemandSessionStateResult, type DemandTriageResult, type DemandPrdReadinessResult, type DemandBlocker } from "./router.js";
import { inspectAtomicTask } from "../runtime/execution/atomic-task-doctor.js";
import { writeLifecycleStageReport } from "../lifecycle/progress.js";
import { lifecycleArtifactPath } from "../lifecycle/state.js";
import { preflightPrdDocument } from "../prd/preflight.js";
import { appendJsonlRecord } from "../runtime/evidence/ledger.js";
import { parseCommandToArgv } from "../lib/security/command-guard.js";

// Loose input/session/options/result records (N4 pattern): the demand runtime
// reads/writes deeply nested session/result data as `Record<string, unknown>`,
// narrowed at each touch point, never widened to `any`.
type Loose = Record<string, unknown>;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function asArray<T = unknown>(value: unknown): T[] {
  if (value == null) return [] as T[];
  return (Array.isArray(value) ? value : [value]) as T[];
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolveRoot(value: unknown, fallback: string = process.cwd()): string {
  return resolve(clean(value) || fallback);
}

function resolvePath(root: string, path: unknown): unknown {
  if (!path) return path;
  const p = clean(path);
  return p && isAbsolute(p) ? p : resolve(root, p);
}

function writeText(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${String(value).trimEnd()}\n`, "utf8");
  return path;
}

function writeJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableJson(value), "utf8");
  return path;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stateRootFor(input: Loose = Object(), options: Loose = Object()): string {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  return resolveRoot(input.stateRoot || input.state_root || options.stateRoot || options.state_root, join(projectRoot, ".yolo"));
}

function shouldWriteLifecycle(input: Loose = Object(), options: Loose = Object()): boolean {
  return input.writeLifecycle !== false
    && input.write_lifecycle !== false
    && options.writeLifecycle !== false
    && options.write_lifecycle !== false;
}

function attachLifecycle(result: Loose = Object(), stageId: string, context: Loose = Object(), source: string = "demand-runtime") {
  const lifecycle = writeLifecycleStageReport(stageId, result, {
    projectRoot: context.projectRoot,
    stateRoot: context.stateRoot,
    source,
    writeSessionMemory: context.writeSessionMemory,
    skipSequenceCheck: true,
  }) as Loose;
  result.lifecycle_writes = [...(result.lifecycle_writes as unknown[] || []), lifecycle];
  result.artifacts = [...(result.artifacts as unknown[] || []), lifecycle.artifact_path];
  result.outputs = [
    ...((result.outputs as unknown[]) || []),
    { path: lifecycle.artifact_path, type: "lifecycle_report", stage: stageId },
  ];
  return lifecycle;
}

function lifecycleStageReportReady(stateRoot: unknown, stageId: string): boolean {
  try {
    const path = lifecycleArtifactPath(stageId, { stateRoot: clean(stateRoot) });
    if (!existsSync(path)) return false;
    const report = readJson(path) as Loose;
    return ["completed", "pass", "success"].includes(clean(report.status).toLowerCase());
  } catch {
    return false;
  }
}

function attachDemandPrerequisiteLifecycle(result: Loose = Object(), read: Loose = Object(), context: Loose = Object()) {
  const readSession = read.session as Loose | undefined;
  const demandReport = {
    status: "success",
    demand_id: readSession?.id || result.demand_id,
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

export function demandStateDir(stateRoot: unknown, id: unknown = ""): string {
  return clean(id) ? join(resolveRoot(stateRoot), "demand", clean(id)) : join(resolveRoot(stateRoot), "demand");
}

export function defaultDemandSessionPath(stateRoot: unknown, id: unknown): string {
  return join(demandStateDir(stateRoot, id), "session.json");
}

function outputDirFor(session: Loose, input: Loose = Object(), options: Loose = Object()): string {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor(input, options);
  const explicit = input.outputDir || input.output_dir || options.outputDir || options.output_dir;
  return explicit ? (resolvePath(projectRoot, explicit) as string) : demandStateDir(stateRoot, session.id);
}

export function writeDemandArtifacts(session: Loose = Object(), outputDir: string): string[] {
  const artifacts: string[] = [];
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

export function readDemandSession(pathOrDir: string) {
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
    return { ok: false, path: sessionPath, error: `Demand session JSON parse failed: ${(error as Error).message}` };
  }
}

function runtimeResult(label: string, session: Loose, outputDir: string, artifacts: string[], options: Loose = Object()) {
  const stateDir = options.stateDir || options.state_dir || null;
  const readiness = stateDir
    ? inspectDemandReadiness(session, { phase: session.phase, stateDir })
    : (session.readiness || inspectDemandReadiness(session, { phase: session.phase }));
  // Update approval effectiveness against freshly computed readiness
  if (stateDir && session.approval) {
    const sessionApproval = session.approval as Loose;
    sessionApproval.effective_for_prd = sessionApproval.approved === true && (readiness as Loose).executable_prd_ready === true;
    sessionApproval.blocked_by = sessionApproval.approved === true && !sessionApproval.effective_for_prd
      ? asArray<Loose>((readiness as Loose).blockers).map((blocker) => ({ code: blocker.code, message: blocker.message }))
      : [];
  }
  const blocked = (readiness as Loose).status === "blocked";
  const warning = (readiness as Loose).status === "warning";
  const readinessLoose = readiness as Loose;
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
    blockers: readinessLoose.blockers || [],
    warnings: readinessLoose.warnings || [],
    artifacts,
    outputs: artifacts.map((path) => ({ path, type: path.endsWith(".json") ? "demand_json" : "demand_markdown" })),
    next_actions: readinessLoose.next_actions,
    guarantees: {
      writes_business_code: false,
      prd_execution: false,
      provider_execution: false,
      source: options.source || session.source,
    },
  };
}

export function runDemandBrainstormRuntime(input: Loose = Object(), options: Loose = Object()) {
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

export function runDemandDiscussRuntime(input: Loose = Object(), options: Loose = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const stateDir = join(stateRoot, "state");
  const session = buildDemandSession({ ...input, projectRoot, stateRoot, phase: "discuss", source: "yolo-discuss" }, {
    ...options,
    phase: "discuss",
    source: "yolo-discuss",
  }) as Loose;
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
      if ((session.approval as Loose)?.approved === true) {
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
    const sessionApproval = session.approval as Loose;
    const sessionReadiness = session.readiness as Loose;
    sessionApproval.effective_for_prd = sessionApproval.approved === true && sessionReadiness.executable_prd_ready === true;
    sessionApproval.blocked_by = sessionApproval.approved === true && !sessionApproval.effective_for_prd
      ? asArray<Loose>(sessionReadiness.blockers).map((blocker) => ({ code: blocker.code, message: blocker.message }))
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

export function approvedDemandSpecCommand(demandPath: string): string {
  return `yolo spec --demand ${demandPath}`;
}

// Result of runDemandApprovedRuntime. The fields the CLI (src/cli/split) reads
// dynamically (artifacts.find, demand_dir) are typed so the public boundary
// keeps working without `any` (the N7 alignment pitfall).
export interface DemandApprovedRuntimeResult {
  status: string;
  code: string;
  summary: string;
  demand_id: string;
  demand_dir: string;
  demand_path: string;
  session: Loose;
  readiness: unknown;
  graph: unknown;
  blockers: Loose[];
  warnings: Loose[];
  artifacts: string[];
  outputs: Loose[];
  next_action: string;
  next_actions: string[];
  guarantees: Loose;
  [key: string]: unknown;
}

export function runDemandApprovedRuntime(input: Loose = Object(), options: Loose = Object()): DemandApprovedRuntimeResult {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const stateDir = join(stateRoot, "state");
  const session = buildDemandSession({ ...input, projectRoot, stateRoot, phase: "prd_intake", source: "yolo-approved-demand" }, {
    ...options,
    phase: "prd_intake",
    source: "yolo-approved-demand",
  }) as Loose;
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
    const sessionApproval = session.approval as Loose;
    const sessionReadiness = session.readiness as Loose;
    sessionApproval.effective_for_prd = sessionApproval.approved === true && sessionReadiness.executable_prd_ready === true;
    sessionApproval.blocked_by = sessionApproval.approved === true && !sessionApproval.effective_for_prd
      ? asArray<Loose>(sessionReadiness.blockers).map((blocker) => ({ code: blocker.code, message: blocker.message }))
      : [];
  }
  const handoffBlockers: Loose[] = [];
  if ((session.approval as Loose)?.approved !== true) {
    handoffBlockers.push({
      code: "APPROVAL_REQUIRED",
      slot: "execution_approval",
      message: "Approved demand handoff requires explicit interview approval.",
    });
  }
  const coverage = ((input.interview as Loose)?.coverage as Loose) || {};
  if (coverage.ready_for_prd_intake === false) {
    for (const slot of asArray(coverage.missing_slots)) {
      handoffBlockers.push({
        code: `MISSING_${String(slot).toUpperCase()}`,
        slot,
        message: `Interview slot ${slot} must be answered before approved demand handoff.`,
      });
    }
    for (const followUp of asArray<Loose>(coverage.follow_up_questions)) {
      handoffBlockers.push({
        code: followUp.code || `FOLLOW_UP_${String(clean(followUp.slot) || "INTERVIEW").toUpperCase()}`,
        slot: followUp.slot,
        message: clean(followUp.plain_language_prompt) || clean(followUp.text) || clean(followUp.message) || "Resolve interview follow-up before approved demand handoff.",
      });
    }
  }
  const artifacts = shouldWrite ? writeDemandArtifacts(session, outputDir) : [];
  const demandPath = artifacts.find((path) => path.endsWith("session.json")) || join(outputDir, "session.json");
  const nextAction = approvedDemandSpecCommand(demandPath);
  const blocked = handoffBlockers.length > 0;
  const result: DemandApprovedRuntimeResult = {
    status: blocked ? "blocked" : "success",
    code: blocked ? "DEMAND_APPROVED_HANDOFF_BLOCKED" : "DEMAND_APPROVED_HANDOFF_READY",
    summary: blocked
      ? "Approved demand handoff is blocked by missing interview approval or slots."
      : "Approved demand artifacts created; hand off to spec for executable PRD generation.",
    demand_id: clean(session.id),
    demand_dir: outputDir,
    demand_path: demandPath,
    session,
    readiness: session.readiness,
    graph: session.graph,
    blockers: handoffBlockers,
    warnings: ((session.readiness as Loose)?.warnings as Loose[]) || [],
    artifacts,
    outputs: artifacts.map((path) => ({ path, type: path.endsWith(".json") ? "demand_json" : "demand_markdown" })),
    next_action: blocked
      ? "yolo interview status --session <interview.json|dir>"
      : nextAction,
    next_actions: blocked
      ? [
          `Missing demand fields/approvals: ${handoffBlockers.map((blocker) => clean(blocker.slot) || clean(blocker.code)).filter(Boolean).join(", ")}.`,
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

export function runDemandStatusRuntime(input: Loose = Object(), options: Loose = Object()): DemandStatusRuntimeResult {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || input.cwd || options.projectRoot || options.project_root || options.cwd);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const explicitDemandPath = input.demandPath || input.demand_path || input.demand || input.sessionPath || input.session_path;
  if (explicitDemandPath) {
    const demandPath = resolvePath(projectRoot, explicitDemandPath) as string;
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

function leanOfficeHoursMode(input: Loose = Object(), options: Loose = Object()): string {
  const raw = clean(input.officeHoursMode || input.office_hours_mode || input.profile || input.mode || options.profile || options.mode || "startup").toLowerCase();
  if (["builder", "build", "operator"].includes(raw)) return "builder";
  return "startup";
}

function leanOfficeHoursAlternatives(input: Loose = Object(), mode: string = "startup") {
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

function resolveLeanOfficeHoursChoice(choice: unknown, alternatives: Loose[] = []): Loose | null {
  const value = clean(choice).toLowerCase();
  if (!value) return null;
  return alternatives.find((item, index) =>
    clean(item.id).toLowerCase() === value
    || String(index + 1) === value
    || clean(item.label).toLowerCase() === value
  ) || null;
}

export function runDemandOfficeHoursRuntime(input: Loose = Object(), options: Loose = Object()) {
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
    text: `Choose A, B, or C: ${alternatives.map((item) => `${clean(item.id)}) ${clean(item.label)}`).join(" ")}`,
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
  const outputDir = resolvePath(projectRoot, input.outputDir || input.output_dir || options.outputDir || join(stateRoot, "demand", "office-hours", id)) as string;
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
    warnings: [] as Loose[],
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

function targetFiles(session: Loose = Object()): string[] {
  const project = session.project as Loose | undefined;
  const files = project?.target_files || session.target_files || [];
  return (Array.isArray(files) ? files : [files]).filter((file) => Boolean(clean(file)));
}

function structuredProjectFacts(session: Loose = Object()): Loose | null {
  return session.project_facts && typeof session.project_facts === "object" ? session.project_facts as Loose : null;
}

function normalizeBaseCommit(value: unknown): string {
  const text = clean(value).toLowerCase();
  return /^[a-f0-9]{7,40}$/.test(text) ? text : "";
}

function readBaseCommit(input: Loose = Object(), options: Loose = Object()): string {
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

function chunk(values: unknown[] = [], size: number = 2): unknown[][] {
  const items = values.filter(Boolean);
  const chunks: unknown[][] = [];
  const chunkSize = Math.max(1, Number(size) || 1);
  for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
  return chunks.length ? chunks : [[]];
}

function requirementById(session: Loose = Object()): Map<string, Loose> {
  const map = new Map<string, Loose>();
  const sessionRequirements = session.requirements as Loose | undefined;
  for (const requirement of asArray<Loose>(sessionRequirements?.active || session.requirements)) {
    if (requirement?.id) map.set(clean(requirement.id), requirement);
  }
  return map;
}

function scenarioMatrix(session: Loose = Object()): Loose[] {
  const scenarioMatrixField = session.scenario_matrix as Loose | undefined;
  return asArray<Loose>(scenarioMatrixField?.scenarios);
}

function questionTraceIds(value: unknown): string[] {
  return [...new Set(asArray<Loose>(value)
    .map((item) => {
      if (item && typeof item === "object") return clean(item.id || item.question_id || item.questionId);
      return clean(item);
    })
    .filter(Boolean))];
}

function sourceQuestionIds(session: Loose = Object(), scenario: Loose = Object() as Loose, requirement: Loose = Object() as Loose): string[] {
  const discussion = session.discussion as Loose | undefined;
  const requirementTrace = requirement.trace as Loose | undefined;
  return [...new Set([
    ...questionTraceIds(scenario.source_question_ids),
    ...questionTraceIds(scenario.question_trace),
    ...questionTraceIds(requirementTrace?.question_ids),
    ...questionTraceIds(session.question_trace),
    ...questionTraceIds(discussion?.rounds),
  ])];
}

function verificationHint({ scenario = Object() as Loose, surface = Object() as Loose, proof = "", files = [] as string[] } = Object() as { scenario?: Loose; surface?: Loose; proof?: string; files?: string[] }): string {
  return clean(surface.verification_hint || scenario.verification_hint)
    || `Verify "${proof || clean(scenario.desired_behavior) || "the requested behavior"}" through ${clean(scenario.touchpoint) || "the target workflow"} on ${surfaceTitle(surface)}${files.length ? ` (${files.join(", ")})` : ""}.`;
}

function fallbackScenarios(session: Loose = Object()): Loose[] {
  const files = targetFiles(session);
  const sessionRequirements = session.requirements as Loose | undefined;
  const project = session.project as Loose | undefined;
  const vision = session.vision as Loose | undefined;
  const context = session.context as Loose | undefined;
  return asArray<Loose>(sessionRequirements?.active || session.requirements).map((requirement, index) => {
    const scenarios = asArray<Loose>(requirement.acceptance_scenarios || requirement.scenarios);
    const firstScenario: Loose = scenarios[0] || {};
    return {
      id: `SCN-${String(index + 1).padStart(3, "0")}`,
      requirement_id: requirement.id,
      actor: asArray<Loose>(project?.target_users || vision?.target_users)[0] || "target user",
      touchpoint: "primary user workflow",
      trigger: firstScenario.when || "the user reaches this scenario",
      current_behavior: asArray<Loose>(context?.current_state || vision?.status_quo)[0] || "Captured in demand context.",
      desired_behavior: requirement.text,
      proof: firstScenario.then || firstScenario.text || requirement.text,
      out_of_scope: sessionRequirements?.out_of_scope || [],
      constraints: sessionRequirements?.constraints || [],
      exceptions: [] as string[],
      surfaces: [{
        id: `SCN-${String(index + 1).padStart(3, "0")}-SFC-001`,
        kind: "code",
        label: "代码实现",
        target_files: files,
        readonly_files: [] as string[],
        session_budget: {
          expected: "single_session",
          max_files: Math.max(1, Math.min(2, files.length || 1)),
          max_lines_per_file: 120,
        },
      }],
      question_trace: [] as string[],
    };
  });
}

function taskTypeForSurface(surface: Loose = Object()): string {
  return surface.kind === "test" || surface.kind === "doc" ? "cleanup" : "feature";
}

function fileKind(file: unknown = ""): string {
  const path = clean(file).toLowerCase();
  if (/(^|\/)(__tests__|tests?|specs?)\//.test(path) || /\.(test|spec)\./.test(path)) return "test";
  if (/(^|\/)(pages?|views?|screens?|components?|ui)\//.test(path)) return "ui";
  if (/(^|\/)(routes?|api|controllers?|server)\//.test(path)) return "api";
  if (/(^|\/)(models?|repositories|migrations?|database|db)\//.test(path)) return "data";
  if (/(^|\/)(services?|hooks?|stores?|lib|utils|domain)\//.test(path)) return "service";
  if (/(^|\/)(docs?|specs?)\//.test(path) || path.endsWith(".md")) return "doc";
  return "code";
}

function surfaceTitle(surface: Loose = Object()): string {
  return clean(surface.label) || clean(surface.kind) || "Implementation surface";
}

function isUiSurface(surface: Loose = Object(), files: string[] = []): boolean {
  const kind = clean(surface.kind).toLowerCase();
  return kind === "ui" || files.some((file) => /(^|\/)(pages?|views?|screens?|components?|ui)\//i.test(clean(file)));
}

function uiStateMatrixForTask({ scenario = Object() as Loose, surface = Object() as Loose, proof = "" } = Object() as { scenario?: Loose; surface?: Loose; proof?: string }) {
  return [
    {
      state: "ready",
      surface_id: surface.id || null,
      touchpoint: clean(scenario.touchpoint) || "primary user workflow",
      trigger: clean(scenario.trigger) || "the user reaches this UI state",
      expected_visible_result: proof || clean(scenario.desired_behavior) || "The requested UI behavior is visible.",
    },
  ];
}

function uiEvidencePlanForTask({ scenario = Object() as Loose, surface = Object() as Loose, proof = "", files = [] as string[] } = Object() as { scenario?: Loose; surface?: Loose; proof?: string; files?: string[] }) {
  return [
    {
      type: "screenshot",
      surface_id: surface.id || null,
      target_files: files,
      description: `Capture the UI state for ${clean(scenario.touchpoint) || surfaceTitle(surface)} and verify: ${proof || clean(scenario.desired_behavior) || "requested UI behavior"}.`,
    },
    {
      type: "runtime_log",
      surface_id: surface.id || null,
      description: "Confirm the UI path has no blocking runtime errors during acceptance.",
    },
  ];
}

function pathSafeId(value: unknown, fallback: string = "item"): string {
  return (clean(value) || fallback)
    .replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
}

function asciiIdPart(value: unknown, fallback: string = "ITEM"): string {
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

function uniqueStrings(values: unknown[] = []): string[] {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function normalizedTaskTargetFiles(files: unknown[] = []): string[] {
  return uniqueStrings(files).sort((a, b) => a.localeCompare(b));
}

function scenarioTaskDedupKey({ files = [] as string[], kind = "", title = "" } = Object() as { files?: string[]; kind?: string; title?: string }): string {
  return JSON.stringify({
    files: normalizedTaskTargetFiles(files),
    kind: clean(kind).toLowerCase() || "code",
    title: clean(title).toLowerCase(),
  });
}

function scenarioTaskScopeKey({ files = [] as string[], kind = "" } = Object() as { files?: string[]; kind?: string }): string {
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

function actionTokenList(tokens: unknown[] = []): string[] {
  return uniqueStrings(tokens.map((token) => clean(token).toLowerCase()))
    .filter((token) => token.length >= 2 && !ACTION_TOKEN_STOP_WORDS.has(token));
}

function compactActionTokens(text: unknown = ""): string[] {
  return actionTokenList([...clean(text).matchAll(ACTION_SEQUENCE_PATTERN)]
    .flatMap((match) => clean(match[1]).split(ACTION_SEQUENCE_SEPARATOR)));
}

function scenarioActionTokens(text: unknown = ""): string[] {
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

function scenarioConceptText({ scenario = Object() as Loose, requirement = Object() as Loose, proof = "" } = Object() as { scenario?: Loose; requirement?: Loose; proof?: string }): string {
  return [
    scenario.desired_behavior,
    scenario.proof,
    proof,
    requirement.text,
  ].map(clean).filter(Boolean).join("\n");
}

function verificationOnlyConcept(text: unknown = ""): boolean {
  const source = clean(text).toLowerCase();
  if (!source || compactActionTokens(source).length >= 2) return false;
  const hasVerificationSignal = /\b(vitest|jest|tests?|unit|integration|typecheck|lint|build|ci|smoke)\b|测试|验证|验收/.test(source);
  const hasPassSignal = /\b(pass|passes|passing|green|success|succeed|succeeds|ok)\b|全绿|通过|跑通/.test(source);
  const hasChangeSignal = /\b(add|create|update|delete|remove|persist|store|save|return|show|display|support|handle|fallback|error)\b|添加|创建|修改|删除|保存|持久|返回|显示|支持|处理|降级|报错|不崩溃/.test(source);
  return hasVerificationSignal && hasPassSignal && !hasChangeSignal;
}

function cjkBigrams(text: unknown = ""): string[] {
  const values: string[] = [];
  for (const run of clean(text).match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let index = 0; index < run.length - 1; index += 1) values.push(run.slice(index, index + 2));
    if (run.length <= 4) values.push(run);
  }
  return values;
}

function conceptFingerprint(text: unknown = ""): Set<string> {
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

function conceptCategories(text: unknown = ""): string[] {
  const source = clean(text).toLowerCase();
  const categories: string[] = [];
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

function overlapCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const item of left) {
    if (right.has(item)) count += 1;
  }
  return count;
}

function sameActionConcept(left: string[] = [], right: string[] = []): boolean {
  if (left.length === 0 || right.length === 0) return true;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const overlap = overlapCount(leftSet, rightSet);
  return overlap / Math.max(leftSet.size, rightSet.size) >= 0.75;
}

interface ScenarioConcept {
  text: string;
  actionTokens: string[];
  fingerprint: Set<string>;
  categories: string[];
}

function nearDuplicateConcept(left: ScenarioConcept, right: ScenarioConcept): boolean {
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

function coveredActionSummary(concept: ScenarioConcept, seenConcepts: ScenarioConcept[] = []): boolean {
  const summaryTokens = compactActionTokens(concept.text);
  if (summaryTokens.length < 2) return false;
  const coveredTokens = new Set(seenConcepts.flatMap((item) => item.actionTokens));
  if (!summaryTokens.every((token) => coveredTokens.has(token))) return false;
  return /\b(flow|flows|workflow|smoke|e2e|end-to-end)\b|一条龙|跑通|干净环境|干净 home/i.test(concept.text);
}

function coveredCategoryDetail(concept: ScenarioConcept, seenConcepts: ScenarioConcept[] = []): boolean {
  if (concept.categories.length === 0) return false;
  return seenConcepts.some((seen) => {
    if (!sameActionConcept(concept.actionTokens, seen.actionTokens)) return false;
    if (seen.categories.length <= concept.categories.length) return false;
    return concept.categories.every((category) => seen.categories.includes(category));
  });
}

function taskConceptRecord({ scenario = Object() as Loose, requirement = Object() as Loose, proof = "" } = Object() as { scenario?: Loose; requirement?: Loose; proof?: string }): ScenarioConcept {
  const text = scenarioConceptText({ scenario, requirement, proof });
  return {
    text,
    actionTokens: scenarioActionTokens(text),
    categories: conceptCategories(text),
    fingerprint: conceptFingerprint(text),
  };
}

function redundantScenarioTask(concept: ScenarioConcept, seenConcepts: ScenarioConcept[] = []): boolean {
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
} = Object() as { demandId?: string; taskId?: string; requirementId?: string; scenarioId?: string; surfaceId?: string }) {
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

function summarizeTaskSessionPlans(tasks: Loose[] = []) {
  const plans = tasks.map((task) => (task?.handoff as Loose)?.session as Loose | undefined).filter(Boolean) as Loose[];
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

function deferredFollowUp(deferred: unknown[] = []) {
  const items = asArray(deferred).map((text, index) => ({
    id: `DEF-${String(index + 1).padStart(3, "0")}`,
    text: clean(text),
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

function deferredScopeConfirmation(session: Loose = Object()) {
  const discussion = session.discussion as Loose | undefined;
  const confirmation = (discussion?.deferred_scope_confirmation as Loose) || {};
  return {
    required: confirmation.required === true,
    confirmed: confirmation.confirmed === true,
    status: confirmation.status || (confirmation.required ? "needs_confirmation" : "not_required"),
    items: asArray(confirmation.items || discussion?.deferred),
    prompt: confirmation.prompt || "",
    confirmed_by: confirmation.confirmed_by || null,
    confirmed_at: confirmation.confirmed_at || null,
  };
}

function modifiedFileCondition(taskId: string, index: number, file: string): Loose {
  return {
    id: `POST-${taskId}-TARGET-${index + 1}`,
    type: "target_file_modified",
    severity: "FAIL",
    params: { file },
    message: `Target file must be modified: ${file}`,
  };
}

function acceptanceCondition(taskId: string, index: number, scenario: Loose): Loose {
  const params: Loose = Object.assign(Object() as Loose, { text: scenario.then || scenario.text || scenario });
  const verifyCommand = scenario.verify_command || scenario.verifyCommand;
  // P10.S1 compile-time validation: reject verify commands with unquoted shell metacharacters
  if (verifyCommand && !parseCommandToArgv(verifyCommand as string).ok) {
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

function testsPassCondition(taskId: string): Loose {
  return {
    id: `POST-${taskId}-TESTS`,
    type: "tests_pass",
    severity: "FAIL",
    params: { command: "npm test", timeout_ms: 120000 },
    message: "Project tests must pass after this task.",
  };
}

function typecheckCondition(taskId: string): Loose {
  return {
    id: `POST-${taskId}-TYPECHECK`,
    type: "no_new_type_errors",
    severity: "FAIL",
    params: { command: "npm run typecheck" },
    message: "Project typecheck must pass after this task.",
  };
}

function behaviorCodeConditions(taskId: string, files: string[] = [], text: unknown = "", uiTask: boolean = false): Loose[] {
  const sourceFiles = files.filter((file) => fileKind(file) !== "test");
  const primary = sourceFiles[0] || files[0];
  if (!primary) return [];
  const conditions: Loose[] = [];
  const add = (suffix: string, file: string, pattern: unknown, message: string) => {
    const value = clean(pattern);
    if (!value || value.length <= 1) return;
    if (conditions.some((condition) => (condition.params as Loose)?.file === file && (condition.params as Loose)?.text === value)) return;
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
  if (/(<=|less than or equal|at or below)/i.test(clean(text))) add("COMPARE-LTE", primary, "<=", "Target code must implement the stated <= comparison.");
  else if (/(<\s*0|below zero|negative)/i.test(clean(text))) add("COMPARE-LT-ZERO", primary, "< 0", "Target code must implement the stated negative-value comparison.");
  return conditions.slice(0, 3);
}

function relatedReadFirst(files: string[] = [], scenarioFiles: string[] = [], surface: Loose = Object()): string[] {
  const own = asArray<string>(files);
  const readonly = asArray<string>(surface.readonly_files);
  const kind = clean(surface.kind);
  const related: string[] = [];
  if (kind === "test") {
    related.push(...scenarioFiles.filter((file) => fileKind(file) !== "test"));
  } else if (kind === "ui") {
    related.push(...scenarioFiles.filter((file) => ["service", "api", "data", "code"].includes(fileKind(file))));
  }
  return [...new Set([...own, ...readonly, ...related].filter(Boolean))];
}

function addTaskDependencies(tasks: Loose[] = []): Loose[] {
  const byScenario = new Map<string, Loose[]>();
  for (const task of tasks) {
    const taskTrace = task.trace as Loose | undefined;
    const handoff = task.handoff as Loose | undefined;
    const handoffScenario = handoff?.scenario as Loose | undefined;
    const scenarioId = clean(taskTrace?.scenario_id) || clean(handoffScenario?.id) || "";
    if (!scenarioId) continue;
    if (!byScenario.has(scenarioId)) byScenario.set(scenarioId, []);
    byScenario.get(scenarioId)!.push(task);
  }
  for (const scenarioTasks of byScenario.values()) {
    const implementationTasks = scenarioTasks.filter((task) => !asArray<Loose>((task.scope as Loose)?.targets).some((target) => fileKind(clean(target.file) || target) === "test"));
    const testTasks = scenarioTasks.filter((task) => asArray<Loose>((task.scope as Loose)?.targets).some((target) => fileKind(clean(target.file) || target) === "test"));
    for (const task of testTasks) {
      task.depends_on = [...new Set([...(task.depends_on as string[] || []), ...implementationTasks.map((item) => clean(item.id)).filter(Boolean)])];
    }
    const uiTasksInScenario = scenarioTasks.filter((task) => asArray<Loose>((task.scope as Loose)?.targets).some((target) => fileKind(clean(target.file) || target) === "ui"));
    const serviceTasks = implementationTasks.filter((task) => asArray<Loose>((task.scope as Loose)?.targets).some((target) => ["service", "api", "data", "code"].includes(fileKind(clean(target.file) || target))));
    for (const task of uiTasksInScenario) {
      task.depends_on = [...new Set([...(task.depends_on as string[] || []), ...serviceTasks.map((item) => clean(item.id)).filter((id) => id && id !== clean(task.id))])];
    }
  }
  return tasks;
}

function deriveFileDependencies(tasks: Loose[] = []): Loose[] {
  for (const taskB of tasks) {
    const bInputs = asArray<string>(taskB.inputs).map(clean).filter(Boolean);
    const bOutputs = new Set(asArray<string>(taskB.expected_output).map(clean).filter(Boolean));
    for (const taskA of tasks) {
      if (taskA.id === taskB.id) continue;
      const aOutputs = new Set(asArray<string>(taskA.expected_output).map(clean).filter(Boolean));
      const overlap = bInputs.filter((input) => aOutputs.has(input));
      // Own targets are read-before-edit context, not cross-task prerequisites.
      const meaningfulOverlap = overlap.filter((file) => fileKind(file) !== "test" && !bOutputs.has(file));
      if (meaningfulOverlap.length > 0) {
        taskB.depends_on = [...new Set([...(taskB.depends_on as string[] || []), clean(taskA.id)])];
      }
    }
  }
  return tasks;
}

function buildAtomicDemandTasks(session: Loose = Object(), input: Loose = Object(), options: Loose = Object()) {
  const requirements = requirementById(session);
  const scenarios = scenarioMatrix(session).length ? scenarioMatrix(session) : fallbackScenarios(session);
  const allFiles = targetFiles(session);
  const tasks: Loose[] = [];
  const compileErrors: Loose[] = [];
  const taskConceptsByScope = new Map<string, ScenarioConcept[]>();
  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    const requirement = requirements.get(clean(scenario.requirement_id)) || {} as Loose;
    const surfaces = asArray<Loose>(scenario.surfaces).length
      ? asArray<Loose>(scenario.surfaces)
      : [{ id: `${clean(scenario.id)}-SFC-001`, kind: "code", label: "代码实现", target_files: allFiles }];
    const scenarioTaskKeys = new Set<string>();
    for (const [surfaceIndex, surface] of surfaces.entries()) {
      const sessionBudget = surface.session_budget as Loose | undefined;
      const maxFiles = Math.max(1, Number(sessionBudget?.max_files || input.max_files_per_task || input.maxFilesPerTask || 2));
      const surfaceFiles = asArray<string>(surface.target_files).length ? asArray<string>(surface.target_files) : allFiles;
      const scenarioFiles = [...new Set(surfaces.flatMap((item) => asArray<string>(item.target_files)).concat(allFiles).filter(Boolean))];
      const fileChunks = chunk(surfaceFiles, maxFiles);
      for (const [chunkIndex, files] of fileChunks.entries()) {
        const taskTitle = `${surfaceTitle(surface)}: ${clean(scenario.requirement_id) || clean(requirement.id) || clean(scenario.id) || "DEMAND"}`;
        const taskKind = clean(surface.kind).toLowerCase() || fileKind(files[0]) || "code";
        const dedupKey = scenarioTaskDedupKey({ files: files as string[], kind: taskKind, title: taskTitle });
        if (scenarioTaskKeys.has(dedupKey)) continue;
        scenarioTaskKeys.add(dedupKey);

        const proof = clean(surface.proof || scenario.proof || requirement.text || scenario.desired_behavior);
        const scopeKey = scenarioTaskScopeKey({ files: files as string[], kind: taskKind });
        const seenConcepts = taskConceptsByScope.get(scopeKey) || [];
        const concept = taskConceptRecord({ scenario, requirement, proof });
        if (redundantScenarioTask(concept, seenConcepts)) continue;

        const taskId = `DEMAND-${clean(scenario.requirement_id) || "REQ"}-${String(scenarioIndex + 1).padStart(3, "0")}${String(surfaceIndex + 1).padStart(2, "0")}${String(chunkIndex + 1).padStart(2, "0")}`;
        const verifyCommand = scenario.verify_command || scenario.verifyCommand;
        if (verifyCommand && !parseCommandToArgv(verifyCommand as string).ok) {
          const parsed = parseCommandToArgv(verifyCommand as string);
          compileErrors.push({
            task_id: taskId,
            original_command: verifyCommand,
            illegal_chars: parsed.ok ? "" : (clean(parsed.detail).match(/"(.+?)"/)?.[1] || "shell_metachar"),
            suggestion: `Replace "${verifyCommand}" with a single safe command without shell metacharacters ($ ; & | > < \` ( ) { } etc.).`,
          });
        }
        const description = clean(scenario.desired_behavior || requirement.text || proof);
        const sourceQuestions = sourceQuestionIds(session, scenario, requirement);
        const taskVerificationHint = verificationHint({ scenario, surface, proof, files: files as string[] });
        const uiTask = isUiSurface(surface, files as string[]);
        const readFirst = relatedReadFirst(files as string[], scenarioFiles, surface);
        const sessionRequirements = session.requirements as Loose | undefined;
        const sessionContext = session.context as Loose | undefined;
        const sessionDiscussion = session.discussion as Loose | undefined;
        const behaviorText = [
          description,
          proof,
          taskVerificationHint,
          ...asArray(scenario.constraints || sessionRequirements?.constraints),
          ...asArray(surface.visual_style_source || scenario.visual_style_source || sessionContext?.visual_style_source),
          ...asArray<Loose>(sessionDiscussion?.decisions).map((item) => clean(item.text) || item),
        ].join("\n");
        const projectFacts = {
          schema: "yolo.demand.task_project_facts.v1",
          structured: structuredProjectFacts(session),
          target_files: asArray((session.project_facts as Loose)?.target_files),
          candidate_target_files: asArray((session.project_facts as Loose)?.candidate_target_files || (session.project as Loose)?.candidate_target_files),
          current_state: asArray(sessionContext?.current_state || (session.vision as Loose)?.status_quo),
          evidence: asArray<Loose>((session.investigation as Loose)?.evidence).map((item) => clean(item.text) || item).filter(Boolean),
          assumptions: asArray((session.project_facts as Loose)?.assumptions || (session.reflection as Loose)?.assumption_records || (session.reflection as Loose)?.assumptions || session.assumptions),
          decisions: asArray<Loose>(sessionDiscussion?.decisions).map((item) => clean(item.text) || item).filter(Boolean),
          constraints: asArray(scenario.constraints || sessionRequirements?.constraints),
          out_of_scope: asArray(scenario.out_of_scope || sessionRequirements?.out_of_scope),
          deferred_scope: asArray(sessionDiscussion?.deferred),
          deferred_scope_confirmation: deferredScopeConfirmation(session),
        };
        const followUp = deferredFollowUp(asArray(sessionDiscussion?.deferred));
        const currentBehavior = clean(scenario.current_behavior) || (asArray(sessionContext?.current_state || (session.vision as Loose)?.status_quo)).join("; ") || "Captured in demand CONTEXT.md.";
        const currentBehaviorWithEvidence = [
          currentBehavior,
          projectFacts.evidence.length ? `Evidence: ${projectFacts.evidence.slice(0, 3).join("; ")}` : "",
        ].filter(Boolean).join(" ");
        const desiredOutcomes = asArray<string>((session.prd_intake as Loose)?.desired_outcomes || (session.nontechnical_intake as Loose)?.desired_outcomes)
          .map(clean)
          .filter(Boolean);
        const evidenceLikeProof = /\b(screenshot|test|assert|verify|observe|component|regression)\b|截图|测试|验证/i.test(proof);
        const outcomeValue = desiredOutcomes.find((item) => item !== description && item !== proof);
        const userValue = outcomeValue
          || (currentBehavior ? `they no longer rely on the current behavior: ${currentBehavior}` : "")
          || (proof && proof !== description && !evidenceLikeProof ? proof : "")
          || "the workflow has a clear, user-visible outcome";
        const sessionPlan = buildTaskSessionPlan({
          demandId: clean(session.id),
          taskId,
          requirementId: clean(scenario.requirement_id) || clean(requirement.id),
          scenarioId: clean(scenario.id),
          surfaceId: clean(surface.id),
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
            evidence_plan: uiEvidencePlanForTask({ scenario, surface, proof, files: files as string[] }),
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
              visual_style_source: asArray(surface.visual_style_source || scenario.visual_style_source || sessionContext?.visual_style_source),
              session_budget: surface.session_budget || null,
            },
            key_interfaces: files,
            read_first: readFirst,
            acceptance_criteria: [proof].filter(Boolean),
            proof,
            verification_hint: taskVerificationHint,
            project_facts: projectFacts,
            deferred_scope: asArray(sessionDiscussion?.deferred),
            deferred_scope_confirmation: deferredScopeConfirmation(session),
            deferred_follow_up: followUp,
            ...(uiTask ? {
              state_matrix: uiStateMatrixForTask({ scenario, surface, proof }),
              evidence_plan: uiEvidencePlanForTask({ scenario, surface, proof, files: files as string[] }),
            } : {}),
            out_of_scope: scenario.out_of_scope || sessionRequirements?.out_of_scope || [],
            constraints: scenario.constraints || sessionRequirements?.constraints || [],
            exceptions: scenario.exceptions || [],
            question_trace: scenario.question_trace || [],
            evidence_chain: {
              intake_schema: (session.prd_intake as Loose)?.schema || (session.nontechnical_intake as Loose)?.schema || null,
              demand_id: session.id,
              scenario_id: scenario.id,
              surface_id: surface.id,
              approval_reason: session.approval_reason || (session.approval as Loose)?.reason || (session.approval as Loose)?.note || "",
            },
            must_haves: {
              truths: [
                ...projectFacts.assumptions.map((a) => (typeof a === "string" ? a : clean((a as Loose).text) || "")).filter(Boolean),
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
                `requirement:${clean(scenario.requirement_id) || clean(requirement.id)}`,
                `scenario:${scenario.id}`,
                `surface:${surface.id}`,
              ],
            },
          },
          scope: {
            targets: (files as string[]).map((file) => ({ file, description })),
            readonly_files: asArray(surface.readonly_files),
            allow_new_files: surface.allow_new_files === true || input.allow_new_files !== false,
            allow_delete_files: false,
            max_files: Math.max(1, files.length || maxFiles),
            max_lines_per_file: Number((sessionBudget as Loose)?.max_lines_per_file || input.max_lines_per_file || input.maxLinesPerFile || 120),
          },
          pre_conditions: [],
          post_conditions: [
            ...(files as string[]).map((file, fileIndex) => modifiedFileCondition(taskId, fileIndex, file)),
            ...behaviorCodeConditions(taskId, files as string[], behaviorText, uiTask),
            acceptanceCondition(taskId, 0, { then: proof || description, verify_command: scenario.verify_command || scenario.verifyCommand } as Loose),
            typecheckCondition(taskId),
            ...((files as string[]).some((file) => fileKind(file) === "test") ? [testsPassCondition(taskId)] : []),
          ],
          trace: {
            demand_id: session.id,
            requirement_id: scenario.requirement_id || requirement.id,
            scenario_id: scenario.id,
            surface_id: surface.id,
            evidence: (requirement.trace as Loose)?.evidence || [],
            decisions: (requirement.trace as Loose)?.decisions || [],
            question_trace: scenario.question_trace || [],
            source_question_ids: sourceQuestions,
          },
          deferred_scope: asArray(sessionDiscussion?.deferred),
          deferred_scope_confirmation: deferredScopeConfirmation(session),
          deferred_follow_up: followUp,
          atomicity: {
            expected_session: sessionBudget?.expected || "single_session",
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
  return { tasks, compileErrors };
}

function inspectAtomicity(tasks: Loose[] = [], input: Loose = Object(), options: Loose = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const results: Loose[] = [];
  const blockers: Loose[] = [];
  const warnings: Loose[] = [];
  for (const task of tasks) {
    try {
      const result = inspectAtomicTask(task, {
        projectRoot,
        root: options.yoloRoot || options.yolo_root || projectRoot,
        writeEvidence: false,
      }) as Loose;
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
        message: (error as Error).message,
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
  quality_report: ReturnType<typeof inspectDemandQuality> | Loose;
  // blockers/warnings are Loose[]: the compiled result combines readiness blockers,
  // atomicity blockers, quality warnings, and compile errors — heterogeneous shapes
  // carried opaquely (the original implicit-any version treated them as any[]).
  blockers: Loose[];
  warnings: Loose[];
  prd: Record<string, unknown> | null;
  next_actions: string[];
}

function buildDemandPrd(session: Loose = Object(), input: Loose = Object(), options: Loose = Object()): DemandPrdCompiledResult {
  const projectRoot = input.projectRoot || input.project_root || options.projectRoot || options.project_root;
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const stateDir = join(stateRoot, "state");
  const grounding = groundDemandExecutionScope(session, {
    ...options,
    ...input,
    projectRoot,
    stateRoot,
  }) as Loose;
  session = (grounding.session || session) as Loose;
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
  const sessionRequirements = session.requirements as Loose | undefined;
  const requirements = (sessionRequirements?.active as Loose[]) || [];
  const now = clean(options.now || input.now) || new Date().toISOString();
  const baseCommit = readBaseCommit(input, options);
  const prdId = clean(input.prd_id || input.prdId) || `PRD-${now.slice(0, 10).replace(/-/g, "")}-${asciiIdPart(clean(session.id).replace(/^DEMAND-/, ""), "DEMAND")}`;
  const { tasks, compileErrors } = buildAtomicDemandTasks(session, { ...input, projectRoot: input.projectRoot || input.project_root }, options);
  const readinessLoose = readiness as Loose;
  if (compileErrors.length > 0) {
    return {
      status: "blocked",
      code: "DEMAND_VERIFY_COMMAND_BLOCKED",
      summary: "PRD compilation blocked by illegal verify_command in task acceptance criteria.",
      grounding,
      grounded_session: session,
      readiness,
      quality_report: { status: "blocked", warnings: [] as Loose[], blockers: compileErrors.map((err) => clean(err.task_id)) } as Loose,
      blockers: compileErrors.map((err) => ({
        code: "ILLEGAL_VERIFY_COMMAND",
        task_id: err.task_id,
        message: `Task ${clean(err.task_id)} contains illegal verify_command: "${err.original_command}". Illegal characters: ${err.illegal_chars}. ${err.suggestion}`,
        ...err,
      })) as Loose[],
      warnings: (readinessLoose.warnings as Loose[]) || [],
      prd: null,
      next_actions: compileErrors.map((err) => `Fix verify_command for task ${clean(err.task_id)}: ${err.suggestion}`),
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
  const qualityLoose = quality as Loose;
  const atomicityBlockers = (atomicity as Loose).blockers as Loose[] | undefined;
  if (atomicityBlockers && atomicityBlockers.length > 0) {
    return {
      status: "blocked",
      code: "DEMAND_ATOMICITY_BLOCKED",
      summary: "Demand PRD contains tasks that are too coarse for one-session execution.",
      grounding,
      grounded_session: session,
      readiness,
      atomicity,
      quality_report: quality,
      blockers: atomicityBlockers,
      warnings: [...(readinessLoose.warnings as Loose[] || []), ...((atomicity as Loose).warnings as Loose[] || []), ...(qualityLoose.warnings as Loose[] || [])],
      prd: null,
      next_actions: atomicityBlockers.map((blocker) => `${clean((blocker as Loose).task_id)}: split scenario surface before PRD generation.`),
    };
  }
  if (quality.status === "blocked" || quality.status === "warning") {
    const qualityWarningsAsBlockers = asArray<Loose>(qualityLoose.warnings).map((warning) => ({
      code: warning.code || "DEMAND_QUALITY_WARNING",
      message: clean(warning.message) || clean(warning.detail) || "Demand PRD quality warning must be resolved before executable PRD.",
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
      blockers: quality.status === "blocked" ? quality.blockers as Loose[] : qualityWarningsAsBlockers,
      warnings: [...(readinessLoose.warnings as Loose[] || []), ...((atomicity as Loose).warnings as Loose[] || []), ...(qualityLoose.warnings as Loose[] || [])],
      prd: null,
      next_actions: qualityLoose.next_actions as string[],
    };
  }

  const project = session.project as Loose | undefined;
  const vision = session.vision as Loose | undefined;
  const sessionApproval = session.approval as Loose | undefined;
  const discussion = session.discussion as Loose | undefined;
  const scenarioMatrixField = session.scenario_matrix as Loose | undefined;
  const prd = {
    $schema: "https://yolo.dev/schemas/prd-v2.schema.json",
    version: "2.0",
    id: prdId,
    title: clean(input.title || project?.title || vision?.statement).slice(0, 120),
    description: `Compiled from approved demand session ${session.id}.`,
    project: {
      name: clean(input.project_name || input.projectName || project?.title || "project"),
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
        ...(sessionApproval || {}),
        effective_for_prd: sessionApproval?.approved === true && readiness.executable_prd_ready === true,
      },
      approval_reason: session.approval_reason || sessionApproval?.reason || sessionApproval?.note || "",
      deferred_scope: asArray(discussion?.deferred),
      deferred_scope_confirmation: deferredScopeConfirmation(session),
      deferred_follow_up: deferredFollowUp(asArray(discussion?.deferred)),
      out_of_scope: asArray(sessionRequirements?.out_of_scope),
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
        schema: scenarioMatrixField?.schema || null,
        scenario_count: asArray<Loose>(scenarioMatrixField?.scenarios).length,
        surface_count: asArray<Loose>(scenarioMatrixField?.scenarios)
          .reduce((sum, scenario) => sum + asArray<Loose>(scenario.surfaces).length, 0),
        scenarios: asArray<Loose>(scenarioMatrixField?.scenarios).map((scenario) => ({
          id: scenario.id,
          requirement_id: scenario.requirement_id,
          proof: clean(scenario.proof) || "",
          source_question_ids: sourceQuestionIds(session, scenario, requirements.find((item) => clean(item.id) === clean(scenario.requirement_id)) || {} as Loose),
          surfaces: asArray<Loose>(scenario.surfaces).map((surface) => ({
            id: surface.id,
            kind: surface.kind || "code",
            label: surfaceTitle(surface),
            visual_style_source: asArray(surface.visual_style_source || scenario.visual_style_source),
            session_budget: surface.session_budget || null,
          })),
        })),
      },
      atomicity_contract: {
        rule: scenarioMatrixField?.atomic_task_rule || "one user-visible story with one proof maps to one task",
        session_budget_required: true,
        max_files_per_surface: 2,
        generated_task_count: tasks.length,
        doctor_status: (atomicity as Loose).status,
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
      id: `DES-${clean(requirement.id)}`,
      text: [
        `Implement ${clean(requirement.id)}: ${clean(requirement.text)}`,
        `Proof: ${asArray<Loose>(requirement.acceptance_scenarios).map((scenario) => clean(scenario.then) || clean(scenario.text)).filter(Boolean).join("; ") || "Use task-level proof and post_conditions."}`,
        `Constraints: ${asArray(sessionRequirements?.constraints).join("; ") || "None recorded."}`,
        `Out of scope: ${asArray(sessionRequirements?.out_of_scope).join("; ") || "None recorded."}`,
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
    blockers: [] as Loose[],
    warnings: [...(readinessLoose.warnings as Loose[] || []), ...((atomicity as Loose).warnings as Loose[] || []), ...(qualityLoose.warnings as Loose[] || [])],
    prd,
    next_actions: ["Run yolo check on the compiled PRD before yolo run."],
  };
}

function groundingArtifact(value: Loose = Object()): Loose {
  const { session: _session, ...artifact } = value || {};
  return artifact as Loose;
}

export function runDemandPrdRuntime(input: Loose = Object(), options: Loose = Object()): Loose {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const demandPath = resolvePath(projectRoot, input.demandPath || input.demand_path || input.demand || defaultDemandSessionPath(stateRoot, input.id || "")) as string;
  const read = readDemandSession(demandPath);
  if (!read.ok) {
    return {
      status: "blocked",
      code: "DEMAND_SESSION_MISSING",
      summary: read.error,
      demand_path: demandPath,
      demand_id: undefined,
      compiled: { status: "blocked", code: "DEMAND_SESSION_MISSING", summary: read.error, readiness: undefined, quality_report: undefined, blockers: [{ code: "DEMAND_SESSION_MISSING", message: read.error }], warnings: [] as Loose[], prd: null, next_actions: [] as string[] },
      prd: null,
      preflight: null,
      readiness: undefined,
      quality_report: undefined,
      blockers: [{ code: "DEMAND_SESSION_MISSING", message: read.error }],
      warnings: [] as Loose[],
      artifacts: [] as string[],
      outputs: [] as Loose[],
      next_actions: ["Run yolo brainstorm/discuss first, or pass --demand <session.json|dir>."],
    };
  }

  const compiled = buildDemandPrd(read.session as Loose, input, options);
  const outputFile = resolvePath(projectRoot, input.outputFile || input.output_file || input.prdPath || input.prd_path || join(read.dir, "prd.json")) as string;
  let preflight: Loose | null = null;
  if (compiled.prd) {
    preflight = preflightPrdDocument(compiled.prd, {
      file: outputFile,
      projectRoot,
      mode: "verify",
      strictExecution: true,
      requireDemandContract: true,
      strictWarnings: true,
    }) as Loose;
    if (preflight.status !== "pass") {
      compiled.status = "blocked";
      compiled.code = "DEMAND_PRD_PREFLIGHT_BLOCKED";
      compiled.summary = "Approved demand PRD failed runner preflight and was not written as executable.";
      compiled.blockers = [
        ...(compiled.blockers || []),
        ...asArray<Loose>(preflight.blocked_reasons).map((reason) => ({
          code: reason.code || "PRD_PREFLIGHT_BLOCKED",
          message: clean(reason.message) || clean(reason.detail) || "PRD preflight blocked execution.",
          source: reason.source || "preflight",
          reason,
        })),
      ];
      compiled.warnings = [...(compiled.warnings || []), ...asArray<Loose>(preflight.warnings)];
      const runnerReadiness = preflight.runner_readiness as Loose | undefined;
      compiled.next_actions = (runnerReadiness?.next_actions as string[]) || ["Fix PRD preflight blockers before writing executable PRD."];
    }
  }
  const shouldWrite = input.writeArtifacts !== false && input.write_artifacts !== false && options.writeArtifacts !== false;
  const artifacts: string[] = [];
  const outputs: Loose[] = [];
  let prdPath: string | null = null;
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

  const result: Loose = {
    status: compiled.status,
    code: compiled.code,
    summary: compiled.summary,
    demand_path: read.path,
    demand_id: (read.session as Loose).id,
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
    attachDemandPrerequisiteLifecycle(result, read as Loose, { projectRoot, stateRoot });
    attachLifecycle(result, "prd", { projectRoot, stateRoot }, "yolo-prd");
  }
  return result;
}

export function runDemandTaskRuntime(input: Loose = Object(), options: Loose = Object()): Loose {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || options.projectRoot || options.project_root);
  const stateRoot = stateRootFor({ ...input, projectRoot }, options);
  const demandPath = resolvePath(projectRoot, input.demandPath || input.demand_path || input.demand || defaultDemandSessionPath(stateRoot, input.id || "")) as string;
  const read = readDemandSession(demandPath);
  if (!read.ok) {
    return {
      status: "blocked",
      code: "DEMAND_SESSION_MISSING",
      summary: read.error,
      blockers: [{ code: "DEMAND_SESSION_MISSING", message: read.error }],
      warnings: [] as Loose[],
      artifacts: [] as string[],
      outputs: [] as Loose[],
      next_actions: ["Run yolo interview to-demand first, or pass --demand <session.json|dir>."],
    };
  }

  const readSession = read.session as Loose;
  const readiness = inspectDemandReadiness(readSession, { phase: readSession.phase, stateDir: join(stateRoot, "state") }) as Loose;
  if (readiness.status === "blocked") {
    return {
      status: "blocked",
      code: "DEMAND_TASKS_BLOCKED",
      summary: "Demand is not ready for task planning.",
      demand_path: read.path,
      demand_id: readSession.id,
      readiness,
      blockers: readiness.blockers || [],
      warnings: readiness.warnings || [],
      artifacts: [] as string[],
      outputs: [] as Loose[],
      next_actions: readiness.next_actions || ["Resolve demand blockers before task planning."],
    };
  }

  const taskBuild = buildAtomicDemandTasks(readSession, input, options);
  const atomicity = inspectAtomicity(taskBuild.tasks, input, options) as Loose;
  const blockers: Loose[] = [
    ...taskBuild.compileErrors.map((error) => ({
      code: "DEMAND_TASK_VERIFY_COMMAND_UNSAFE",
      message: `Task ${clean(error.task_id)} has an unsafe verify command.`,
      error,
    })),
    ...((atomicity.status === "blocked" ? atomicity.blockers || [] : []) as Loose[]),
  ];
  const plan: Loose = {
    schema: "yolo.demand.tasks.v1",
    demand_id: readSession.id,
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
  const outputFile = resolvePath(projectRoot, input.outputFile || input.output_file || join(read.dir, "tasks.json")) as string;
  const artifacts = shouldWrite ? [writeJson(outputFile, plan)] : [];
  const result: Loose = {
    status: plan.status,
    code: plan.status === "success" ? "DEMAND_TASKS_READY" : "DEMAND_TASKS_BLOCKED",
    summary: plan.status === "success"
      ? "Demand task plan artifact created."
      : "Demand task plan is blocked by atomicity or compile issues.",
    demand_path: read.path,
    demand_id: readSession.id,
    plan,
    readiness,
    atomicity,
    blockers,
    warnings: [...(readiness.warnings as Loose[] || []), ...(atomicity.warnings as Loose[] || [])],
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
