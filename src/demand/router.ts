import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { detectProjectState } from "./project-state-detector.js";
import { DEMAND_SESSION_SCHEMA, DEMAND_SESSION_SCHEMA_VERSION } from "./artifacts.js";
import {
  buildEvidenceRequirements,
  evidenceRequirementBlockers,
  evidenceRequirementNextActions,
  evidenceRequirementSummary,
  type EvidenceRequirement,
} from "./evidence-requirements.js";
import { targetUserRoleItems } from "./interview.js";

export interface DemandTriageResult {
  schema_version: string;
  schema: string;
  context_type: string;
  route: string;
  evidence_policy: string;
  reason_codes: string[];
  blocking: boolean;
  explanation: string;
}

export interface DemandQuestion {
  slot: string;
  text: string;
}

export interface DemandBlocker {
  code: string;
  slot?: string;
  message: string;
  role?: string;
}

export interface DemandPrdReadinessResult {
  schema_version: string;
  schema: string;
  required_slots: string[];
  slot_values: Record<string, string[]>;
  missing_slots: string[];
  next_question: DemandQuestion | null;
  question_queue: DemandQuestion[];
  blockers: DemandBlocker[];
  assumptions: string[];
  required_evidence_agents: string[];
  evidence_agreement: { status: string; conflicts: DemandBlocker[] };
  evidence_requirements: EvidenceRequirement[];
  evidence_requirement_summary: unknown;
  prd_intake_ready: boolean;
  executable_prd_ready: boolean;
  prd_ready?: boolean;
}

export interface DemandSessionStateResult {
  status: string;
  code: string;
  summary: string;
  triage: DemandTriageResult;
  readiness: DemandPrdReadinessResult;
  state: {
    schema_version: string;
    schema: string;
    context_type: string;
    route: string;
    evidence_policy: string;
    stage: string;
    submode: string;
    reason_codes: string[];
    missing_slots: string[];
    blockers: DemandBlocker[];
    assumptions: string[];
    next_question: DemandQuestion | null;
    question_queue: DemandQuestion[];
    evidence_tasks: { role: string; protocol: unknown; reason: string }[];
    needed_evidence_agents: string[];
    evidence_requirements: EvidenceRequirement[];
    evidence_requirement_summary: unknown;
    prd_intake_ready: boolean;
    executable_prd_ready: boolean;
    prd_ready?: boolean;
    next_action: string;
    next_actions: string[];
  };
  next_question: DemandQuestion | null;
  question_queue: DemandQuestion[];
  next_actions: string[];
}

export const DEMAND_ROUTER_SCHEMA_VERSION = "1.0";
export const DEMAND_ROUTER_SCHEMA = "yolo.demand.router.v1";
export const DEMAND_SESSION_STATE_SCHEMA_VERSION = "1.0";
export const DEMAND_SESSION_STATE_SCHEMA = "yolo.demand.session_state.v1";
export const DEMAND_PRD_READINESS_SCHEMA_VERSION = "1.0";
export const DEMAND_PRD_READINESS_SCHEMA = "yolo.demand.prd_readiness.v1";
export const DEMAND_EVIDENCE_RESULT_SCHEMA_VERSION = "1.0";
export const DEMAND_EVIDENCE_RESULT_SCHEMA = "yolo.demand.evidence_result.v1";

export const DEMAND_STAGES = [
  "intake",
  "clarify",
  "evidence",
  "discuss",
  "requirements",
  "roadmap",
  "approval",
  "prd_ready",
];

export const DEMAND_REQUIRED_PRD_SLOTS = [
  "problem",
  "target_user",
  "status_quo",
  "desired_outcome",
  "scope_in",
  "scope_out",
  "constraints",
  "acceptance_criteria",
  "risks",
  "approval",
];

const DEMAND_PRD_SLOT_QUESTIONS = {
  problem: {
    category: "问题",
    text: "你要解决的业务问题是什么？请用一句话说明谁在什么场景下遇到什么困扰。",
  },
  target_user: {
    category: "用户/角色",
    text: "谁会使用、受影响或负责这个需求？请用业务角色描述，不需要写技术身份。",
  },
  status_quo: {
    category: "当前现状",
    text: "现在遇到这个场景时，大家是怎么做的？可以写人工流程、表格、临时办法或现有系统表现。",
  },
  desired_outcome: {
    category: "目标结果",
    text: "如果这个需求做好了，用户应该能完成什么，或者业务上应该变成什么样？",
  },
  scope_in: {
    category: "范围内",
    text: "这次明确要覆盖哪些流程、用户、页面、接口、数据或功能？请写最小必须范围。",
  },
  scope_out: {
    category: "范围外",
    text: "这次明确不做什么？有哪些流程、用户、渠道、数据或功能不要碰？",
  },
  constraints: {
    category: "约束",
    text: "有哪些必须遵守的限制？例如平台、兼容性、权限、数据来源、时间或不能改动的部分。",
  },
  acceptance_criteria: {
    category: "验收标准",
    text: "做到什么程度才算通过？请写用户看得见或业务能确认的验收结果。",
  },
  risks: {
    category: "风险",
    text: "如果这个需求做错了，最大的业务风险是什么？请写会影响谁、造成什么后果。",
  },
  approval: {
    category: "批准",
    text: "以上需求信息和边界都确认后，是否批准进入 PRD？请明确回答“批准”或“暂不批准”。",
  },
};

export const DEMAND_EVIDENCE_RESULT_SCHEMA_DEFINITION = {
  schema_version: DEMAND_EVIDENCE_RESULT_SCHEMA_VERSION,
  schema: DEMAND_EVIDENCE_RESULT_SCHEMA,
  required: ["claim", "confidence", "evidence", "assumptions", "risks", "missing", "recommendation"],
  fields: {
    claim: "Factual statement being checked.",
    confidence: "low | medium | high",
    evidence: "Array of { path?, url?, line?, scope, source, summary, why } records. scope is project | external | user | unknown; project facts require project-scoped evidence.",
    assumptions: "Unverified assumptions separated from facts.",
    risks: "Risk list if the claim is wrong.",
    missing: "Information still needed to verify the claim.",
    recommendation: "proceed | clarify | cross_check | block",
  },
};

const VALID_EVIDENCE_SCOPES = new Set(["project", "external", "user", "unknown"]);

export const DEMAND_EVIDENCE_AGENT_PROTOCOLS = {
  explorer: {
    role: "explorer",
    objective: "Find primary project facts for the requested demand without editing files.",
    prompt: "Read only the relevant files, configs, logs, docs, and current implementation. Return claims with exact paths/lines or source summaries. Separate assumptions from facts.",
    writes_code: false,
    result_schema: DEMAND_EVIDENCE_RESULT_SCHEMA,
  },
  cross_checker: {
    role: "cross-checker",
    objective: "Independently verify high-risk factual claims and challenge the explorer result.",
    prompt: "Use independent reads or sources. Confirm, weaken, or contradict each claim. Any conflict must become a blocker instead of being averaged away.",
    writes_code: false,
    required_when: "evidence_policy === cross_check or claim risk is high",
    result_schema: DEMAND_EVIDENCE_RESULT_SCHEMA,
  },
  verifier: {
    role: "verifier",
    objective: "Check whether gathered evidence is enough to support PRD readiness and acceptance criteria.",
    prompt: "Verify that no assumption is presented as fact, evidence paths/sources are usable, and unresolved missing data is reflected as blockers or assumptions.",
    writes_code: false,
    result_schema: DEMAND_EVIDENCE_RESULT_SCHEMA,
  },
};

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function stringItems(value) {
  return asArray(value)
    .flatMap((item) => {
      if (item && typeof item === "object") return [item.text, item.title, item.summary, item.value, item.claim].filter(Boolean);
      return String(item ?? "").split(/\r?\n/);
    })
    .map(clean)
    .filter(Boolean);
}

function isNonMissingStatusItem(value) {
  const text = clean(value).toLowerCase();
  if (!text) return true;
  if (/\b(but|except|however|unless)\b/.test(text)) return false;
  if (/^(no|none|nothing)\b.*\b(missing|unresolved|open|remaining|blockers?|gaps?)\b/.test(text)) return true;
  if (/^all\b.*\b(complete|completed|covered|satisfied|verified|resolved)\b/.test(text)) return true;
  if (/\b(no conflicts?|100%)\b/.test(text) && !/\b(missing|needed|required|unresolved|gap|blocker|blocked)\b/.test(text)) return true;
  return false;
}

function actionableMissingItems(value) {
  return stringItems(value).filter((item) => !isNonMissingStatusItem(item));
}

function hasItems(value) {
  return stringItems(value).length > 0;
}

function firstItems(...values) {
  for (const value of values) {
    const items = stringItems(value);
    if (items.length > 0) return items;
  }
  return [];
}

function firstTargetUserItems(...values) {
  for (const value of values) {
    const items = targetUserRoleItems(value);
    if (items.length > 0) return items;
  }
  return [];
}

function unique(value) {
  return [...new Set(asArray(value).map(clean).filter(Boolean))];
}

function stageForSlot(slot) {
  if (["scope_in", "scope_out", "constraints", "acceptance_criteria", "risks"].includes(slot)) return "requirements";
  if (slot === "approval") return "approval";
  return "clarify";
}

function questionForSlot(slot) {
  const prompt = DEMAND_PRD_SLOT_QUESTIONS[slot] || {};
  return {
    id: `ASK_${String(slot).toUpperCase()}`,
    slot,
    stage: stageForSlot(slot),
    category: prompt.category || slot,
    text: prompt.text || `请补充 ${slot}，以便继续判断 PRD 就绪状态。`,
    plain_language_prompt: prompt.text || `请补充 ${slot}，以便继续判断 PRD 就绪状态。`,
    required_for: ["prd_readiness"],
  };
}

function questionQueueFor(missingSlots = [], options = Object()) {
  const missing = new Set(asArray(missingSlots).map(clean).filter(Boolean));
  const nonApprovalSlots = DEMAND_REQUIRED_PRD_SLOTS
    .filter((slot) => slot !== "approval" && missing.has(slot));
  const askableSlots = nonApprovalSlots.length > 0
    ? nonApprovalSlots
    : missing.has("approval") && options.suppressApproval !== true ? ["approval"] : [];
  return askableSlots
    .map((slot) => questionForSlot(slot));
}

function textFrom(...values) {
  return values
    .flatMap((value) => {
      if (value && typeof value === "object") return Object.values(value);
      return value;
    })
    .flatMap((value) => stringItems(value))
    .join("\n")
    .toLowerCase();
}

function demandTextItems(input = Object(), session = Object()) {
  const requirements = requirementItems(session, input);
  const scenarios = asArray(session.scenario_matrix?.scenarios || session.scenarios);
  return [
    input.objective,
    input.idea,
    input.requirement,
    input.text,
    input.problem,
    input.target_user,
    input.target_users,
    input.status_quo,
    input.success_criteria,
    input.desired_outcome,
    input.constraints,
    input.non_goals,
    input.scope_in,
    input.scope_out,
    input.risks,
    input.assumptions,
    input.acceptance_criteria,
    input.open_questions,
    session.objective,
    session.idea,
    session.problem,
    session.target_users,
    session.status_quo,
    session.success_criteria,
    session.desired_outcome,
    session.constraints,
    session.non_goals,
    session.scope_in,
    session.scope_out,
    session.risks,
    session.assumptions,
    session.open_questions,
    session.project?.title,
    session.vision?.statement,
    session.vision?.idea,
    session.vision?.problem,
    session.vision?.target_users,
    session.vision?.status_quo,
    session.vision?.success_criteria,
    session.requirements?.constraints,
    session.requirements?.out_of_scope,
    session.reflection?.assumptions,
    session.reflection?.risks,
    session.discussion?.open_questions,
    session.discussion?.decisions,
    requirements.flatMap((requirement) => [
      requirement.text,
      requirement.title,
      requirement.acceptance_criteria,
      requirement.acceptance_scenarios,
      requirement.scenarios,
    ]),
    scenarios.flatMap((scenario) => [
      scenario.current_behavior,
      scenario.desired_behavior,
      scenario.proof,
      scenario.acceptance,
      scenario.trigger,
      scenario.out_of_scope,
      scenario.constraints,
      scenario.exceptions,
    ]),
  ];
}

function resolveRoot(input = Object(), options = Object()) {
  return resolve(clean(input.projectRoot || input.project_root || input.cwd || options.projectRoot || options.project_root || options.cwd) || process.cwd());
}

function resolvePath(root, path) {
  if (!path) return "";
  return isAbsolute(path) ? path : resolve(root, path);
}

function readJsonIfExists(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readDemandSessionFile(pathOrDir) {
  const resolved = resolve(pathOrDir);
  const sessionPath = existsSync(resolved) && !resolved.endsWith(".json")
    ? join(resolved, "session.json")
    : resolved;
  if (!existsSync(sessionPath)) {
    return { ok: false, path: sessionPath, error: `Demand session not found: ${sessionPath}` };
  }
  try {
    const session = JSON.parse(readFileSync(sessionPath, "utf8"));
    const schemaError = demandSessionSchemaError(session, sessionPath);
    if (schemaError) return { ok: false, path: sessionPath, error: schemaError };
    return { ok: true, path: sessionPath, dir: dirname(sessionPath), session };
  } catch (error) {
    return { ok: false, path: sessionPath, error: `Demand session JSON parse failed: ${error.message}` };
  }
}

// Demand sessions are forward-only evidence: a stale, future, or malformed
// schema_version can silently change downstream behavior. Reject anything that
// is not the canonical yolo.demand.session.v1 / 1.0 shape so callers fail
// closed at the read boundary instead of drifting further down the pipeline.
export function demandSessionSchemaError(session, sessionPath = "") {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return `Demand session ${sessionPath} must be a JSON object`;
  }
  if (session.schema_version !== DEMAND_SESSION_SCHEMA_VERSION) {
    return `Demand session ${sessionPath} has unsupported schema_version "${session.schema_version}"; expected "${DEMAND_SESSION_SCHEMA_VERSION}"`;
  }
  if (session.schema !== DEMAND_SESSION_SCHEMA) {
    return `Demand session ${sessionPath} has unsupported schema "${session.schema}"; expected "${DEMAND_SESSION_SCHEMA}"`;
  }
  return null;
}

function loadSession(input = Object(), options = Object()) {
  if (input.session && typeof input.session === "object") return input.session;
  const projectRoot = resolveRoot(input, options);
  const demandPath = clean(input.demandPath || input.demand_path || input.sessionPath || input.session_path);
  if (demandPath) {
    const read = readDemandSessionFile(resolvePath(projectRoot, demandPath));
    if (read.ok) return read.session;
  }
  const explicit = readJsonIfExists(resolvePath(projectRoot, clean(input.path || "")));
  if (explicit?.schema === "yolo.demand.session.v1") return explicit;
  return null;
}

function buildStatusSession(input = Object(), options = Object()) {
  const loaded = loadSession(input, options);
  if (loaded) return loaded;
  const objective = clean(input.objective || input.idea || input.requirement || input.text);
  if (!objective && !hasItems(input.target_users) && !hasItems(input.success_criteria)) return {};
  return {
    schema: "yolo.demand.session_state_input.v1",
    source: "yolo-demand-status",
    phase: input.phase || "status",
    objective,
    idea: input.idea || objective,
    problem: input.problem,
    target_users: input.target_users,
    status_quo: input.status_quo,
    success_criteria: input.success_criteria,
    desired_outcome: input.desired_outcome,
    constraints: input.constraints,
    non_goals: input.non_goals,
    scope_in: input.scope_in,
    scope_out: input.scope_out,
    risks: input.risks,
    assumptions: input.assumptions,
    evidence: input.evidence,
    approval: { approved: input.approve === true || input.approved === true },
    requirements: input.requirements,
    target_files: input.target_files || input.targetFiles,
    open_questions: input.open_questions,
  };
}

function targetFiles(session = Object(), input = Object()) {
  return unique([
    ...asArray(input.target_files || input.targetFiles),
    ...asArray(session.project?.target_files || session.target_files),
  ]);
}

function requirementItems(session = Object(), input = Object()) {
  return asArray(session.requirements?.active || session.requirements || input.requirements);
}

function acceptanceItems(session = Object(), input = Object()) {
  const requirements = requirementItems(session, input);
  return firstItems(
    input.acceptance_criteria,
    input.success_criteria,
    session.acceptance_criteria,
    session.success_criteria,
    session.vision?.success_criteria,
    requirements.flatMap((requirement) => asArray(requirement.acceptance_criteria || requirement.acceptance_scenarios || requirement.scenarios)),
    session.scenario_matrix?.scenarios?.map((scenario) => scenario.proof || scenario.acceptance),
  );
}

function assumptions(session = Object(), input = Object()) {
  return [
    ...stringItems(input.assumptions),
    ...stringItems(session.assumptions),
    ...stringItems(session.reflection?.assumptions),
  ];
}

function evidenceItems(session = Object(), input = Object()) {
  return firstItems(input.evidence, session.evidence, session.investigation?.evidence);
}

function normalizeEvidenceRole(value) {
  const role = clean(value).toLowerCase().replace(/_/g, "-");
  if (role === "crosschecker") return "cross-checker";
  if (role === "cross-checker") return "cross-checker";
  if (role === "cross-check") return "cross-checker";
  return role;
}

function evidenceResultSources(session = Object(), input = Object()) {
  return [
    input.evidence_results,
    input.evidenceResults,
    input.evidence_agent_results,
    input.evidenceAgentResults,
    session.evidence_results,
    session.evidenceResults,
    session.evidence_agent_results,
    session.evidenceAgentResults,
    session.investigation?.evidence_results,
    session.investigation?.evidenceResults,
    session.investigation?.agent_results,
    session.investigation?.agentResults,
    session.investigation?.evidence_agents,
    session.investigation?.evidenceAgents,
    input.evidence,
    session.evidence,
    session.investigation?.evidence,
  ];
}

function evidenceResultItems(session = Object(), input = Object()) {
  return evidenceResultSources(session, input)
    .flatMap((value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.entries(value).map(([key, item]) => (
          item && typeof item === "object" ? { role: key, ...item } : item
        ));
      }
      return asArray(value);
    })
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      ...item,
      role: normalizeEvidenceRole(item.role || item.agent || item.agent_role || item.agentRole || item.name),
    }))
    .filter((item) => item.role);
}

function evidenceRecords(result = Object()) {
  return [
    result.evidence,
    result.result?.evidence,
    result.output?.evidence,
    result.sources,
    result.result?.sources,
    result.output?.sources,
    result.findings,
    result.result?.findings,
    result.output?.findings,
  ].flatMap((value) => asArray(value)).filter(Boolean);
}

function evidenceRecordScope(record = Object()) {
  if (typeof record === "string") return "unknown";
  if (!record || typeof record !== "object") return "unknown";
  const scope = clean(record.scope || record.evidence_scope || record.source_scope || record.kind || record.type).toLowerCase();
  if (["project", "repo", "repository", "codebase", "local"].includes(scope)) return "project";
  if (["external", "web", "internet", "research"].includes(scope)) return "external";
  if (["user", "human", "operator"].includes(scope)) return "user";
  if (["unknown", "unverified"].includes(scope)) return "unknown";

  const path = clean(record.path || record.file || record.file_path || record.filename);
  const url = clean(record.url || record.href || record.link);
  if (/^https?:\/\//i.test(url) || /^https?:\/\//i.test(path)) return "external";

  const source = clean(record.source || record.source_type || record.category).toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(external|web|internet|research)_/.test(source)) return "external";
  if (/^(project|repo|repository|local|codebase)_/.test(source)) return "project";
  if (["project_code", "code", "implementation", "repo_code"].includes(source)) return "project";
  if (["project_test", "test", "tests", "fixture", "fixtures"].includes(source)) return "project";
  if (["project_docs", "docs", "doc", "documentation", "project_config", "config", "configuration", "project_log", "log", "logs", "project_artifact", "artifact"].includes(source)) return "project";
  if (["external_web", "web", "webfetch", "websearch", "internet", "external_docs", "external_doc", "external", "research"].includes(source)) return "external";
  if (["user", "user_input", "human", "operator"].includes(source)) return "user";

  if (path) return "project";
  return "unknown";
}

function evidenceRecordHasDeclaredScope(record = Object()) {
  if (!record || typeof record !== "object") return false;
  const scope = clean(record.scope || record.evidence_scope || record.source_scope).toLowerCase();
  return VALID_EVIDENCE_SCOPES.has(scope);
}

function evidenceRecordHasProjectLocator(record = Object()) {
  if (!record || typeof record !== "object") return false;
  const path = clean(record.path || record.file || record.file_path || record.filename);
  if (!path || /^https?:\/\//i.test(path)) return false;
  return true;
}

function evidenceScopeSummary(result = Object()) {
  const records = evidenceRecords(result);
  const analyzed = records.map((record) => ({
    scope: evidenceRecordScope(record),
    has_project_locator: evidenceRecordHasProjectLocator(record),
  }));
  const scopes = analyzed.map((record) => record.scope);
  return {
    records,
    scopes,
    has_project_scope: scopes.includes("project"),
    has_project: analyzed.some((record) => record.scope === "project" && record.has_project_locator),
    has_external: scopes.includes("external"),
    has_unknown: scopes.includes("unknown"),
  };
}

function evidenceScopeDeclarationIssues(result = Object()) {
  const role = normalizeEvidenceRole(result.role || result.agent || result.agent_role || result.agentRole || result.name);
  const invalid = evidenceRecords(result).filter((record) => !evidenceRecordHasDeclaredScope(record));
  if (invalid.length === 0) return [];
  return [{
    code: "EVIDENCE_SCOPE_REQUIRED",
    role,
    message: `${role || "Evidence agent"} evidence records must declare scope as project, external, user, or unknown before they can satisfy readiness.`,
  }];
}

function resultEvidencePresent(result = Object()) {
  return hasItems(result.evidence)
    || hasItems(result.sources)
    || hasItems(result.findings)
    || hasItems(result.claims)
    || hasItems(result.result?.evidence)
    || hasItems(result.output?.evidence);
}

function resultPayloadPresent(result = Object()) {
  return result.result != null
    || result.output != null
    || result.claim != null
    || result.recommendation != null
    || result.summary != null
    || result.verdict != null;
}

function evidenceResultComplete(result = Object()) {
  const status = clean(result.status || result.state || result.completed_status).toLowerCase();
  const completed = result.completed === true
    || result.complete === true
    || ["completed", "complete", "done", "success", "passed", "pass"].includes(status);
  return completed && resultEvidencePresent(result) && resultPayloadPresent(result);
}

function requiredEvidenceRoles(policy) {
  if (policy === "cross_check") return ["explorer", "cross-checker", "verifier"];
  if (policy === "single_agent") return ["explorer", "verifier"];
  return [];
}

function evidenceResultBlockingIssues(result = Object()) {
  const issues = [];
  const role = normalizeEvidenceRole(result.role || result.agent || result.agent_role || result.agentRole || result.name);
  const recommendation = clean(result.recommendation || result.result?.recommendation || result.output?.recommendation).toLowerCase();
  const verdict = clean(result.verdict || result.result?.verdict || result.output?.verdict).toLowerCase();
  const missing = actionableMissingItems(result.missing || result.result?.missing || result.output?.missing);
  const status = clean(result.status || result.state || result.completed_status).toLowerCase();
  const errorCode = clean(result.error_code || result.result?.error_code || result.output?.error_code);
  if (errorCode) {
    issues.push({
      code: errorCode,
      role,
      message: `${role || "Evidence agent"} returned provider/runtime error ${errorCode}.`,
    });
  }
  if (missing.length > 0) {
    issues.push({
      code: "EVIDENCE_AGENT_MISSING",
      role,
      message: `${role || "Evidence agent"} reported unresolved missing evidence: ${missing.join("; ")}`,
    });
  }
  if (["clarify", "blocked", "block"].includes(recommendation) || ["blocked", "block", "fail", "failed"].includes(verdict) || ["blocked", "failed", "error"].includes(status)) {
    issues.push({
      code: recommendation === "clarify" ? "EVIDENCE_AGENT_CLARIFICATION_REQUIRED" : "EVIDENCE_AGENT_BLOCKED",
      role,
      message: `${role || "Evidence agent"} returned ${recommendation || verdict || status}; keep PRD readiness blocked until resolved.`,
    });
  }
  return issues;
}

function projectEvidenceBlockingIssues(result = Object()) {
  const role = normalizeEvidenceRole(result.role || result.agent || result.agent_role || result.agentRole || result.name);
  const summary = evidenceScopeSummary(result);
  if (summary.records.length === 0 || summary.has_project) return [];
  if (summary.has_project_scope) {
    return [{
      code: "PROJECT_EVIDENCE_PATH_REQUIRED",
      role,
      message: `${role || "Evidence agent"} marked evidence as project-scoped but did not provide a repo-relative path or file locator; existing-project facts require project evidence with a concrete locator.`,
    }];
  }
  const nonProjectScopes = unique(summary.scopes.length ? summary.scopes : ["unknown"]);
  return [{
    code: "PROJECT_FACT_REQUIRES_PROJECT_EVIDENCE",
    role,
    message: `${role || "Evidence agent"} evidence is ${nonProjectScopes.join(", ")} only; existing-project facts require project-scoped evidence from code, tests, docs, config, logs, or artifacts.`,
  }];
}

function activeBlockers(...sources) {
  return sources
    .flatMap((source) => asArray(source))
    .filter((item) => item && typeof item === "object")
    .filter((item) => item.cleared !== true && item.resolved !== true && !["cleared", "resolved", "dismissed"].includes(clean(item.status).toLowerCase()))
    .map((item) => ({
      ...item,
      code: clean(item.code || item.id || "EXISTING_BLOCKER"),
      message: clean(item.message || item.text || item.summary || item.reason || item.code || "Existing blocker is still active."),
    }));
}

function uniqueBlockers(blockers = []) {
  const seen = new Set();
  const result = [];
  for (const blocker of blockers) {
    const key = `${blocker.code}\u0000${blocker.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(blocker);
  }
  return result;
}

function riskItems(session = Object(), input = Object()) {
  return firstItems(input.risks, session.risks, session.reflection?.risks, session.investigation?.risks);
}

function slotValues(session = Object(), input = Object()) {
  const requirements = requirementItems(session, input);
  const scopeIn = firstItems(
    input.scope_in,
    session.scope_in,
    session.requirements?.scope_in,
    requirements.map((requirement) => requirement.text || requirement.title || requirement.id),
    targetFiles(session, input),
  );
  return {
    problem: firstItems(input.problem, session.problem, session.vision?.problem, session.vision?.statement, session.vision?.idea, session.idea, session.objective),
    target_user: firstTargetUserItems(input.target_user, input.target_users, session.target_users, session.project?.target_users, session.vision?.target_users),
    status_quo: firstItems(input.status_quo, session.status_quo, session.vision?.status_quo),
    desired_outcome: firstItems(input.desired_outcome, input.success_criteria, session.desired_outcome, session.success_criteria, session.vision?.success_criteria),
    scope_in: scopeIn,
    scope_out: firstItems(input.scope_out, input.non_goals, session.scope_out, session.out_of_scope, session.non_goals, session.requirements?.out_of_scope),
    constraints: firstItems(input.constraints, session.constraints, session.requirements?.constraints),
    acceptance_criteria: acceptanceItems(session, input),
    risks: riskItems(session, input),
    approval: session.approval?.approved === true || input.approve === true || input.approved === true ? ["approved"] : [],
  };
}

function unresolvedAssumptions(session = Object(), input = Object()) {
  const raw = [
    ...asArray(input.assumptions),
    ...asArray(session.assumptions),
    ...asArray(session.reflection?.assumptions),
  ];
  return raw
    .filter((item) => {
      if (item && typeof item === "object") return item.confirmed !== true && item.status !== "confirmed";
      return clean(item).length > 0;
    })
    .map((item) => {
      if (item && typeof item === "object") return clean(item.text || item.summary || item.value || item.claim);
      return clean(item);
    })
    .filter(Boolean);
}

function hasGreenfieldSignal(text) {
  return /\b(new|greenfield|from scratch|startup|mvp|idea|prototype)\b|新项目|从零|全新|想法|原型/.test(text);
}

function hasExistingSignal(text, files = [], input = Object()) {
  return files.length > 0
    || Boolean(clean(input.demandPath || input.demand_path || input.sessionPath || input.session_path))
    || /\b(existing|current|legacy|brownfield|already|implemented|bug|fix|regression|refactor|production)\b|已有|现有|当前|线上|半成品|实现|修复|改造|回归/.test(text);
}

function hasHybridSignal(text) {
  return /\b(add|new feature|extend|integrate|support)\b|新增|增加|接入|扩展|加一个|做一个/.test(text);
}

function hasTechnicalRiskSignal(text) {
  const copyOnlyEmptyState = /\bempty[- ]state copy\b|空状态文案/.test(text);
  const nonStateTechnical = /\b(field|schema|api|auth|authorization|authentication|permission|role|data flow|dataflow|migration|database|db|table|column|model|endpoint|route|session|token|oauth|cache|queue|event)\b|字段|表结构|模式|接口|认证|鉴权|权限|角色|数据流|迁移|数据库|数据表|模型|端点|路由|令牌|缓存|队列/.test(text);
  const stateTechnical = !copyOnlyEmptyState && (/\bstate\b|状态/.test(text));
  return nonStateTechnical || stateTechnical;
}

function hasHighCostSignal(text) {
  return /\b(payment|billing|invoice|security|privacy|compliance|legal|medical|health|money|delete|loss|production|rollback|irreversible)\b|支付|账单|发票|安全|隐私|合规|法律|医疗|金额|删除|数据丢失|线上|不可逆|回滚/.test(text);
}

function hasPrdIntent(text) {
  return /\b(prd|requirements?|acceptance|ship|implement|execute|build now)\b|需求文档|验收|执行|实现|交付/.test(text);
}

export function inspectDemandTriage(input = Object(), options = Object()): DemandTriageResult {
  const session = options.session || buildStatusSession(input, options);
  const files = targetFiles(session, input);
  const sourceText = textFrom(...demandTextItems(input, session));
  // brownfield 检测优先看项目实际文件状态，而非用户措辞。仅在显式传入 projectRoot/cwd 时扫描，
  // 避免在纯文本 triage（projectRoot 回退到工具自身 cwd）时误判。
  const explicitRoot = clean(
    input.projectRoot || input.project_root || input.cwd
    || options.projectRoot || options.project_root || options.cwd,
  );
  // 仅当调用方显式要求扫描项目状态时才扫描（默认开）。runtime 在调用方未提供真实项目 root 时
  // 传 scanProjectState:false，避免在纯文本 triage（root 回退到工具自身 cwd）时误判 brownfield。
  const scanProjectState = options.scanProjectState !== false && input.scanProjectState !== false;
  const projectState = (explicitRoot && scanProjectState) ? detectProjectState(resolve(explicitRoot)) : null;
  const existing = hasExistingSignal(sourceText, files, input) || projectState?.has_existing_code === true;
  const greenfield = hasGreenfieldSignal(sourceText);
  const hybrid = existing && (greenfield || hasHybridSignal(sourceText));
  const technicalRisk = hasTechnicalRiskSignal(sourceText);
  const highCost = hasHighCostSignal(sourceText);
  const acceptanceMissingForPrd = hasPrdIntent(sourceText) && acceptanceItems(session, input).length === 0;
  const unclearApprovalForPrd = hasPrdIntent(sourceText) && !(session.approval?.approved === true || input.approve === true || input.approved === true);

  const reasonCodes = [];
  if (existing) reasonCodes.push("EXISTING_PROJECT_FACTS");
  if (hybrid) reasonCodes.push("HYBRID_NEW_WORK_ON_EXISTING_SYSTEM");
  if (technicalRisk) reasonCodes.push("TECHNICAL_CONTRACT_OR_DATA_RISK");
  if (highCost) reasonCodes.push("HIGH_COST_OF_ERROR");
  if (acceptanceMissingForPrd) reasonCodes.push("ACCEPTANCE_CRITERIA_UNCLEAR");
  if (unclearApprovalForPrd) reasonCodes.push("APPROVAL_UNCLEAR");
  if (greenfield && !existing) reasonCodes.push("GREENFIELD_IDEA");
  if (reasonCodes.length === 0) reasonCodes.push("DEFAULT_FAST");

  const contextType = clean(input.context_type || input.contextType)
    || (hybrid ? "hybrid" : existing ? "brownfield" : greenfield || sourceText ? "greenfield" : "unknown");
  const hardTrigger = technicalRisk || highCost || acceptanceMissingForPrd || unclearApprovalForPrd || (existing && (technicalRisk || highCost));
  const route = hardTrigger ? "careful" : "fast";
  const evidencePolicy = technicalRisk || highCost
    ? "cross_check"
    : existing
      ? "single_agent"
      : "none";
  const blocking = acceptanceMissingForPrd || unclearApprovalForPrd;
  const explanation = route === "careful"
    ? "Careful route required by hard triggers; factual or risky claims need evidence before PRD."
    : "Fast route by default; no hard factual risk trigger was found.";

  return {
    schema_version: DEMAND_ROUTER_SCHEMA_VERSION,
    schema: DEMAND_ROUTER_SCHEMA,
    context_type: contextType,
    route,
    evidence_policy: evidencePolicy,
    reason_codes: unique(reasonCodes),
    blocking,
    explanation,
  };
}

export function inspectDemandPrdReadiness(input = Object(), options = Object()): DemandPrdReadinessResult {
  const session = options.session || buildStatusSession(input, options);
  const triage = options.triage || inspectDemandTriage(input, { ...options, session });
  const slots = slotValues(session, input);
  const missingSlots = DEMAND_REQUIRED_PRD_SLOTS.filter((slot) => !hasItems(slots[slot]));
  const blockerList = Object.assign([], missingSlots.map((slot) => ({
    code: `MISSING_${slot.toUpperCase()}`,
    slot,
    message: `PRD readiness requires ${slot}.`,
  })));
  blockerList.push(...activeBlockers(input.blockers, session.blockers, session.readiness?.blockers));
  const openQuestions = asArray(session.discussion?.open_questions || session.open_questions || input.open_questions)
    .map((item) => typeof item === "string" ? { text: clean(item), blocking: true } : {
      ...item,
      text: clean(item.text || item.question || item.message),
      blocking: item.blocking !== false,
    })
    .filter((item) => item.text && item.blocking);
  for (const question of openQuestions) {
    blockerList.push({
      code: "BLOCKING_OPEN_QUESTION",
      message: question.text,
    });
  }
  const pendingAssumptions = unresolvedAssumptions(session, input);
  for (const assumption of pendingAssumptions) {
    blockerList.push({
      code: "UNCONFIRMED_ASSUMPTION",
      message: `Assumption must be confirmed or kept out of facts: ${assumption}`,
    });
  }
  const agentResults = evidenceResultItems(session, input);
  const crossCheckRequested = agentResults.some((result) => {
    const recommendation = clean(result.recommendation || result.result?.recommendation || result.output?.recommendation).toLowerCase();
    return recommendation === "cross_check";
  });
  const requiredRoles = crossCheckRequested
    ? unique([...requiredEvidenceRoles(triage.evidence_policy), "explorer", "cross-checker", "verifier"])
    : requiredEvidenceRoles(triage.evidence_policy);
  for (const role of requiredRoles) {
    const roleResults = agentResults.filter((result) => result.role === role);
    if (!roleResults.some(evidenceResultComplete)) {
      blockerList.push({
        code: "EVIDENCE_AGENT_RESULT_REQUIRED",
        role,
        message: `${role} must complete with evidence and a result before cross_check PRD readiness.`,
      });
    }
    for (const result of roleResults) {
      blockerList.push(...evidenceResultBlockingIssues(result));
      if (evidenceResultComplete(result)) {
        blockerList.push(...evidenceScopeDeclarationIssues(result));
        blockerList.push(...projectEvidenceBlockingIssues(result));
      }
    }
  }
  const agreement = inspectEvidenceAgreement(agentResults);
  for (const conflict of agreement.conflicts) {
    blockerList.push(conflict);
  }
  const evidenceRequirements = buildEvidenceRequirements(input, session);
  blockerList.push(...evidenceRequirementBlockers(evidenceRequirements));
  if (triage.evidence_policy !== "none" && evidenceItems(session, input).length === 0 && requiredRoles.length === 0) {
    blockerList.push({
      code: "EVIDENCE_REQUIRED",
      message: `${triage.evidence_policy} evidence is required before factual claims can become PRD facts.`,
    });
  }
  const blockers = uniqueBlockers(blockerList);
  const evidenceBlocked = blockers.some((blocker) => clean(blocker.code).startsWith("EVIDENCE"));
  const questionQueue = questionQueueFor(missingSlots, { suppressApproval: evidenceBlocked });
  const prdIntakeReady = blockers.length === 0;

  return {
    schema_version: DEMAND_PRD_READINESS_SCHEMA_VERSION,
    schema: DEMAND_PRD_READINESS_SCHEMA,
    required_slots: [...DEMAND_REQUIRED_PRD_SLOTS],
    slot_values: slots,
    missing_slots: missingSlots,
    next_question: questionQueue[0] || null,
    question_queue: questionQueue,
    blockers,
    assumptions: pendingAssumptions,
    required_evidence_agents: requiredRoles,
    evidence_agreement: agreement,
    evidence_requirements: evidenceRequirements,
    evidence_requirement_summary: evidenceRequirementSummary(evidenceRequirements),
    prd_intake_ready: prdIntakeReady,
    executable_prd_ready: false,
    prd_ready: prdIntakeReady,
  };
}

export function buildDemandEvidenceTasks(triage = Object(), readiness = Object()) {
  if (triage.evidence_policy === "none") return [];
  const tasks = [{
    role: "explorer",
    protocol: DEMAND_EVIDENCE_AGENT_PROTOCOLS.explorer,
    reason: "Factual project claims need primary evidence.",
  }];
  if (triage.evidence_policy === "cross_check") {
    tasks.push({
      role: "cross-checker",
      protocol: DEMAND_EVIDENCE_AGENT_PROTOCOLS.cross_checker,
      reason: "High-risk facts require independent cross-check.",
    });
  }
  tasks.push({
    role: "verifier",
    protocol: DEMAND_EVIDENCE_AGENT_PROTOCOLS.verifier,
    reason: readiness.prd_intake_ready ? "Verify evidence supports PRD intake readiness." : "Verify blockers and assumptions are not promoted to facts.",
  });
  return tasks;
}

export function inspectEvidenceAgreement(results = []) {
  const items = asArray(results).filter(Boolean);
  const conflicts = [];
  const byClaim = new Map();
  for (const result of items) {
    const claim = clean(result.claim).toLowerCase();
    if (!claim) continue;
    if (!byClaim.has(claim)) byClaim.set(claim, []);
    byClaim.get(claim).push(result);
  }
  for (const [claim, claimResults] of byClaim) {
    const recommendations = unique(claimResults.map((item) => item.recommendation));
    if (recommendations.includes("block") || (recommendations.includes("proceed") && claimResults.some((item) => ["clarify", "cross_check"].includes(clean(item.recommendation))))) {
      conflicts.push({
        code: "EVIDENCE_AGENT_CONFLICT",
        claim,
        message: "Evidence agents disagree; keep the claim blocked until reconciled.",
        recommendations,
      });
    }
  }
  return {
    status: conflicts.length > 0 ? "blocked" : "pass",
    conflicts,
  };
}

function stageFrom(readiness = Object(), triage = Object()) {
  if (readiness.prd_intake_ready) return "prd_ready";
  if (asArray(readiness.evidence_requirements).some((item) => item?.status === "pending")) return "evidence";
  const missingSlots = asArray(readiness.missing_slots).map(clean).filter(Boolean);
  const nonApprovalMissing = missingSlots.filter((slot) => slot !== "approval");
  const firstMissing = DEMAND_REQUIRED_PRD_SLOTS.find((slot) => nonApprovalMissing.includes(slot));
  if (firstMissing) return stageForSlot(firstMissing);
  if (triage.evidence_policy !== "none" && readiness.blockers?.some((blocker) => clean(blocker.code).startsWith("EVIDENCE"))) return "evidence";
  if (missingSlots.includes("approval")) return "approval";
  return "discuss";
}

function nextActionsFor(stage, triage = Object(), readiness = Object(), evidenceTasks = [], nextQuestion = null) {
  const requirementActions = evidenceRequirementNextActions(readiness.evidence_requirements);
  const actions = [];
  actions.push(...requirementActions);
  if (readiness.prd_intake_ready) actions.push("Run yolo spec --demand <session.json|dir> after approved demand artifacts exist.");
  else if (nextQuestion?.text) {
    actions.push(`请回答：${nextQuestion.text}`);
    actions.push(`Next: yolo interview answer --session <interview.json|dir> --question ${nextQuestion.slot || nextQuestion.id || "<slot>"} --answer "<answer>"`);
  }
  else if (stage === "evidence") actions.push(`Run ${evidenceTasks.map((task) => task.role).join(" + ")} before treating project claims as facts.`);
  else if (stage === "approval") actions.push("Ask for explicit approval after missing slots and assumptions are resolved.");
  else if (stage === "requirements") actions.push("Fill missing PRD contract slots, especially acceptance criteria and scope boundaries.");
  else if (stage === "clarify") actions.push("Ask focused clarification questions for the missing slots.");
  else actions.push(triage.route === "careful" ? "Discuss risks and evidence blockers before PRD." : "Continue fast demand clarification.");
  return [...new Set(actions.filter(Boolean))];
}

function nextActionFor(stage, triage = Object(), readiness = Object(), evidenceTasks = [], nextQuestion = null) {
  const actions = nextActionsFor(stage, triage, readiness, evidenceTasks, nextQuestion);
  if (actions.length > 0) return actions[0];
  if (readiness.prd_intake_ready) return "Run yolo spec --demand <session.json|dir> after approved demand artifacts exist.";
  if (nextQuestion?.text) return `请回答：${nextQuestion.text}`;
  if (stage === "evidence") return `Run ${evidenceTasks.map((task) => task.role).join(" + ")} before treating project claims as facts.`;
  if (stage === "approval") return "Ask for explicit approval after missing slots and assumptions are resolved.";
  if (stage === "requirements") return "Fill missing PRD contract slots, especially acceptance criteria and scope boundaries.";
  if (stage === "clarify") return "Ask focused clarification questions for the missing slots.";
  return triage.route === "careful" ? "Discuss risks and evidence blockers before PRD." : "Continue fast demand clarification.";
}

export function buildDemandSessionState(input = Object(), options = Object()): DemandSessionStateResult {
  const session = buildStatusSession(input, options);
  const triage = inspectDemandTriage(input, { ...options, session });
  const readiness = inspectDemandPrdReadiness(input, { ...options, session, triage });
  const evidenceTasks = buildDemandEvidenceTasks(triage, readiness);
  const stage = stageFrom(readiness, triage);
  const questionQueue = asArray(readiness.question_queue);
  const nextQuestion = readiness.next_question || questionQueue[0] || null;
  const nextActions = nextActionsFor(stage, triage, readiness, evidenceTasks, nextQuestion);
  const state = {
    schema_version: DEMAND_SESSION_STATE_SCHEMA_VERSION,
    schema: DEMAND_SESSION_STATE_SCHEMA,
    context_type: triage.context_type,
    route: triage.route,
    evidence_policy: triage.evidence_policy,
    stage,
    submode: triage.route === "careful" ? "evidence_guarded" : "fast_intake",
    reason_codes: triage.reason_codes,
    missing_slots: readiness.missing_slots,
    blockers: readiness.blockers,
    assumptions: readiness.assumptions,
    next_question: nextQuestion,
    question_queue: questionQueue,
    evidence_tasks: evidenceTasks,
    needed_evidence_agents: evidenceTasks.map((task) => task.role),
    evidence_requirements: readiness.evidence_requirements,
    evidence_requirement_summary: readiness.evidence_requirement_summary,
    prd_intake_ready: readiness.prd_intake_ready,
    executable_prd_ready: readiness.executable_prd_ready,
    next_action: nextActions[0] || nextActionFor(stage, triage, readiness, evidenceTasks, nextQuestion),
    next_actions: nextActions,
  };
  return {
    status: readiness.prd_intake_ready ? "success" : "blocked",
    code: readiness.prd_intake_ready ? "DEMAND_PRD_INTAKE_READY" : "DEMAND_PRD_INTAKE_BLOCKED",
    summary: readiness.prd_intake_ready
      ? "Demand intake is ready for approved-demand handoff to spec."
      : "Demand intake is blocked; missing slots, blockers, assumptions, or evidence remain.",
    triage,
    readiness,
    state,
    next_question: nextQuestion,
    question_queue: questionQueue,
    next_actions: nextActions,
  };
}
