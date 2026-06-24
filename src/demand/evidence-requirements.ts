import { createHash } from "node:crypto";
import { detectExternalResearchSignal } from "../lib/research-signal.js";

export type EvidenceRequirementKind = "external" | "project";
export type EvidenceRequirementStatus = "pending" | "satisfied";

export interface EvidenceRequirement {
  id: string;
  topic: string;
  kind: EvidenceRequirementKind;
  reason: string;
  matches: string[];
  status: EvidenceRequirementStatus;
}

// Demand sessions/inputs/options are deeply nested, loosely-structured records
// assembled from user input, interview answers, and agent outputs. They are read
// here as `Record<string, unknown>` (the established N4 pattern: inputs typed as
// loose records and narrowed at each touch point, never widened to `any`). The
// `loose()` helper centralizes the narrowing of an `unknown` value to a record so
// nested optional-chained reads like `loose(session.reflection).assumptions` stay
// faithful to the original `session.reflection?.assumptions` shape without `any`.
type Loose = Record<string, unknown>;

function loose(value: unknown): Loose {
  return value && typeof value === "object" ? value as Loose : {};
}

function looseArray(value: unknown): Loose[] {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object") as Loose[];
  return [];
}

const PROJECT_FACT_ASSUMPTION_RE =
  /(already|existing|receives?|contains?|present|available)[^\n.]{0,80}\b(field|payload|row|request|data|threshold|quantity|qty)\b/i;
const PROJECT_FACT_ASSUMPTION_REVERSE =
  /\b(field|payload|row|request|data|threshold|quantity|qty)\b[^\n.]{0,80}(already|existing|receives?|contains?|present|available)/i;
const GREENFIELD_SIGNAL_RE =
  /\b(greenfield|from scratch|from zero|new project|brand[- ]new|scaffold|prototype|mvp)\b|从零|全新|新项目|原型/i;
const FUTURE_DELIVERY_TEXT_RE =
  /\b(success means|success criteria|completion standard|acceptance|post[- ]conditions?|proof|during acceptance|expected output|can run|should|must|will|implement|build|create|handle|reject|return|returns|support|out of scope|non[- ]?goals?|without corrupting|invalid input|missing|unknown|empty|repeated|delete of missing|list on an empty)\b|成功标准|验收|交付后|待实现|异常|边界|优先级/i;
const STRONG_EXISTING_PROJECT_FACT_RE =
  /\b(existing|current|already|legacy|implemented|production|receives?|contains?|available|present)\b[^\n.]{0,100}\b(project|codebase|repo|code|file|module|component|api|service|endpoint|route|schema|database|table|column|field|payload|request|row|threshold|quantity|qty)\b/i;
const STRONG_EXISTING_PROJECT_FACT_REVERSE =
  /\b(project|codebase|repo|code|file|module|component|api|service|endpoint|route|schema|database|table|column|field|payload|request|row|threshold|quantity|qty)\b[^\n.]{0,100}\b(existing|current|already|legacy|implemented|production|receives?|contains?|available|present)\b/i;
const SCOPED_EXISTING_PROJECT_FACT_RE =
  /\b(existing|current|already|legacy|implemented|production)\b[^\n.]{0,60}\b(project|codebase|repo|code|file|module|component|api|service|endpoint|route|schema|database|table|column)\b/i;
const SCOPED_EXISTING_PROJECT_FACT_REVERSE =
  /\b(project|codebase|repo|code|file|module|component|api|service|endpoint|route|schema|database|table|column)\b[^\n.]{0,60}\b(existing|current|already|legacy|implemented|production)\b/i;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function asArray<T = unknown>(value: unknown): T[] {
  if (value == null) return [] as T[];
  return (Array.isArray(value) ? value : [value]) as T[];
}

function uniqueStrings(value: unknown): string[] {
  return [...new Set(asArray(value).map(clean).filter(Boolean))];
}

function targetFilesFromSession(session: Loose = Object()): string[] {
  return uniqueStrings(loose(session.project).target_files || session.target_files);
}

function scenarioSurfaces(session: Loose = Object()): Loose[] {
  const scenarios = asArray(loose(session.scenario_matrix).scenarios || session.scenarios);
  return scenarios.flatMap((scenario) => looseArray(loose(scenario).surfaces));
}

function targetFileFactsFromSession(session: Loose = Object()) {
  return asArray(loose(session.project_facts).target_files || loose(session.project).target_file_facts)
    .filter((fact) => fact && typeof fact === "object")
    .map((fact) => {
      const record = loose(fact);
      return {
        ...record,
        file: clean(record.file || record.path),
        status: clean(record.status).toLowerCase(),
      };
    })
    .filter((fact) => fact.file);
}

function isPlannedNewTargetFact(fact: Loose = Object()): boolean {
  const status = clean(fact.status).toLowerCase();
  return status === "planned_new_file" || fact.new_file === true || fact.allow_new_files === true;
}

function isExistingTargetFact(fact: Loose = Object()): boolean {
  if (isPlannedNewTargetFact(fact)) return false;
  const status = clean(fact.status).toLowerCase();
  return ["verified", "project_read", "existing", "exists"].includes(status)
    || fact.exists === true
    || fact.new_file === false
    || fact.allow_new_files === false;
}

function targetAllowsNewFile(session: Loose = Object(), file: string = ""): boolean {
  const target = clean(file);
  if (!target) return false;
  return scenarioSurfaces(session).some((surface) => (
    surface?.allow_new_files === true
    && uniqueStrings(surface.target_files).includes(target)
  ));
}

function greenfieldText(input: Loose = Object(), session: Loose = Object()): string {
  const reflection = loose(session.reflection);
  const project = loose(session.project);
  const vision = loose(session.vision);
  const projectFacts = loose(session.project_facts);
  const projectFactsGrounding = loose(projectFacts.grounding);
  const sessionGrounding = loose(session.grounding);
  return [
    input.context_type,
    input.contextType,
    input.objective,
    input.idea,
    input.requirement,
    input.text,
    input.problem,
    input.evidence,
    input.assumptions,
    session.context_type,
    session.contextType,
    session.objective,
    session.idea,
    session.problem,
    session.evidence,
    session.assumptions,
    reflection.assumptions,
    project.title,
    vision.statement,
    vision.idea,
    projectFactsGrounding.mode,
    sessionGrounding.mode,
    sessionGrounding.reason,
  ].flatMap(textFromValue).join("\n");
}

export function isGreenfieldDemandSession(input: Loose = Object(), session: Loose = Object(), options: Loose = Object()): boolean {
  if (options.greenfield === true || options.context_type === "greenfield" || options.contextType === "greenfield") return true;
  if (options.greenfield === false || options.context_type === "brownfield" || options.contextType === "brownfield") return false;

  const targetFiles = targetFilesFromSession(session);
  const targetFileSet = new Set(targetFiles);
  const targetFacts = targetFileFactsFromSession(session);
  const executionFacts = targetFileSet.size > 0
    ? targetFacts.filter((fact) => targetFileSet.has(fact.file))
    : targetFacts;
  const hasExistingTargetFact = executionFacts.some(isExistingTargetFact);
  if (hasExistingTargetFact) return false;

  const hasPlannedTargetFact = executionFacts.some(isPlannedNewTargetFact);
  const allTargetsAllowNew = targetFiles.length > 0
    && targetFiles.every((file) => {
      const fact = targetFacts.find((item) => item.file === file);
      return fact ? isPlannedNewTargetFact(fact) : targetAllowsNewFile(session, file);
    });
  const projectFacts = loose(session.project_facts);
  const policy = loose(projectFacts.policy);
  const projectFactsGrounding = loose(projectFacts.grounding);
  const sessionGrounding = loose(session.grounding);
  const policyGreenfield = policy.greenfield_new_files_are_execution_scope === true;
  const groundingGreenfield = /greenfield/.test(clean(projectFactsGrounding.mode || sessionGrounding.mode || sessionGrounding.reason).toLowerCase());
  const textGreenfield = GREENFIELD_SIGNAL_RE.test(greenfieldText(input, session));

  return policyGreenfield
    || groundingGreenfield
    || (hasPlannedTargetFact && (targetFiles.length === 0 || allTargetsAllowNew))
    || (targetFiles.length === 0 && textGreenfield);
}

function hashId(kind: EvidenceRequirementKind, topic: unknown, reason: unknown): string {
  const digest = createHash("sha1").update(`${kind}\n${clean(topic).toLowerCase()}\n${clean(reason)}`).digest("hex").slice(0, 8).toUpperCase();
  return `EVREQ-${kind.toUpperCase()}-${digest}`;
}

function truncate(value: unknown, max: number = 240): string {
  const text = clean(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function textFromValue(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(textFromValue);
  if (typeof value === "object") {
    const record = loose(value);
    return [
      record.text,
      record.title,
      record.summary,
      record.value,
      record.claim,
      record.answer,
      record.question,
      record.message,
      record.reason,
    ].flatMap(textFromValue);
  }
  const text = clean(value);
  return text ? [text] : [];
}

function demandRequirementTextItems(input: Loose = Object(), session: Loose = Object()): string[] {
  const sessionRequirements = loose(session.requirements);
  const sessionScenarioMatrix = loose(session.scenario_matrix);
  const sessionDiscussion = loose(session.discussion);
  const sessionProject = loose(session.project);
  const sessionVision = loose(session.vision);
  const sessionReflection = loose(session.reflection);
  const sessionContext = loose(session.context);
  const requirements = asArray<Loose>(sessionRequirements.active || session.requirements || input.requirements);
  const scenarios = asArray<Loose>(sessionScenarioMatrix.scenarios || session.scenarios);
  const rounds = asArray(sessionDiscussion.rounds || input.question_trace || input.questions);
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
    sessionProject.title,
    sessionVision.statement,
    sessionVision.idea,
    sessionVision.problem,
    sessionVision.target_users,
    sessionVision.status_quo,
    sessionVision.success_criteria,
    sessionRequirements.constraints,
    sessionRequirements.out_of_scope,
    sessionReflection.assumptions,
    sessionReflection.risks,
    sessionContext.visual_style_source,
    sessionDiscussion.open_questions,
    sessionDiscussion.decisions,
    rounds,
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
      scenario.visual_style_source,
      scenario.out_of_scope,
      scenario.constraints,
      scenario.exceptions,
      asArray<Loose>(scenario.surfaces).flatMap((surface) => [
        surface?.proof,
        surface?.verification_hint,
        surface?.label,
        surface?.visual_style_source,
      ]),
    ]),
  ].flatMap(textFromValue);
}

function topicFromExternalMatch(text: unknown, match: unknown): string {
  const source = clean(text);
  const raw = clean(match);
  if (!source || !raw) return raw;
  const index = source.indexOf(raw);
  if (index < 0) return raw;
  if (/^https?:\/\//i.test(raw)) {
    return truncate(source.slice(index).split(/\s+/)[0].replace(/[),.;，。；]+$/u, ""));
  }
  const before = source.slice(Math.max(0, index - 80), index);
  const after = source.slice(index + raw.length, Math.min(source.length, index + raw.length + 120));
  return truncate(`${before}${raw}${after}`);
}

function sentenceForProjectMatch(text: unknown): string {
  const source = clean(text);
  if (!source) return "";
  const direct = source
    .split(/[\r\n。；;]/u)
    .map(clean)
    .find((item) => PROJECT_FACT_ASSUMPTION_RE.test(item) || PROJECT_FACT_ASSUMPTION_REVERSE.test(item));
  return truncate(direct || source);
}

function isFutureDeliveryText(text: unknown): boolean {
  return FUTURE_DELIVERY_TEXT_RE.test(clean(text));
}

function assertsExistingProjectFact(text: unknown): boolean {
  const source = clean(text);
  if (!source) return false;
  const strong = STRONG_EXISTING_PROJECT_FACT_RE.test(source) || STRONG_EXISTING_PROJECT_FACT_REVERSE.test(source);
  if (!strong) return false;
  if (!isFutureDeliveryText(source)) return true;
  return SCOPED_EXISTING_PROJECT_FACT_RE.test(source) || SCOPED_EXISTING_PROJECT_FACT_REVERSE.test(source);
}

function shouldKeepProjectFactAssumption(text: unknown): boolean {
  const source = clean(text);
  if (!(PROJECT_FACT_ASSUMPTION_RE.test(source) || PROJECT_FACT_ASSUMPTION_REVERSE.test(source))) return false;
  return !isFutureDeliveryText(source) || assertsExistingProjectFact(source);
}

export function detectProjectFactAssumptionSignal(...texts: unknown[]): { requires_project: boolean; matches: string[] } {
  const text = texts.map(clean).filter(Boolean).join("\n");
  if (!text) return { requires_project: false, matches: [] };
  const matches: string[] = [];
  for (const item of text.split(/\r?\n/).map(clean).filter(Boolean)) {
    if (shouldKeepProjectFactAssumption(item)) {
      matches.push(sentenceForProjectMatch(item));
    }
  }
  return { requires_project: matches.length > 0, matches: uniqueStrings(matches) };
}

function addRequirement(map: Map<string, EvidenceRequirement>, { kind, topic, reason, matches }: {
  kind: EvidenceRequirementKind;
  topic: unknown;
  reason: string;
  matches: unknown;
}): void {
  const firstMatch = Array.isArray(matches) ? matches[0] : undefined;
  const normalizedTopic = truncate(topic || firstMatch || reason || kind);
  if (!normalizedTopic) return;
  const id = hashId(kind, normalizedTopic, reason);
  const existing = map.get(id);
  if (existing) {
    existing.matches = uniqueStrings([...(existing.matches || []), ...asArray(matches)]);
    return;
  }
  map.set(id, {
    id,
    topic: normalizedTopic,
    kind,
    reason,
    matches: uniqueStrings(matches),
    status: "pending",
  });
}

export function deriveEvidenceRequirements(input: Loose = Object(), session: Loose = Object(), options: Loose = Object()): EvidenceRequirement[] {
  const kinds = new Set(asArray(options.kinds || ["external", "project"]).map(clean));
  const map = new Map<string, EvidenceRequirement>();
  const texts = [
    ...demandRequirementTextItems(input, session),
    ...asArray(options.texts).flatMap(textFromValue),
  ];

  if (kinds.has("external")) {
    for (const text of texts) {
      const signal = detectExternalResearchSignal(text);
      if (!signal.requires_external) continue;
      for (const match of signal.matches) {
        const topic = topicFromExternalMatch(text, match);
        addRequirement(map, {
          kind: "external",
          topic,
          reason: `External evidence required by ${signal.reason || "content"} signal.`,
          matches: [match],
        });
      }
    }
  }

  if (kinds.has("project")) {
    const greenfield = isGreenfieldDemandSession(input, session, options);
    for (const text of texts) {
      if (greenfield && !assertsExistingProjectFact(text)) continue;
      const signal = detectProjectFactAssumptionSignal(text);
      if (!signal.requires_project) continue;
      for (const match of signal.matches) {
        addRequirement(map, {
          kind: "project",
          topic: match,
          reason: "Project fact assertion requires project-scoped evidence.",
          matches: [match],
        });
      }
    }
  }

  return [...map.values()];
}

type EvidenceScope = "project" | "external" | "user" | "unknown";

function evidenceRecordScope(record: unknown = Object()): EvidenceScope {
  if (typeof record === "string" || !record || typeof record !== "object") return "unknown";
  const r = record as Loose;
  const scope = clean(r.scope || r.evidence_scope || r.source_scope || r.kind || r.type).toLowerCase();
  if (["project", "repo", "repository", "codebase", "local"].includes(scope)) return "project";
  if (["external", "web", "internet", "research"].includes(scope)) return "external";
  if (["user", "human", "operator"].includes(scope)) return "user";

  const path = clean(r.path || r.file || r.file_path || r.filename);
  const url = clean(r.url || r.href || r.link);
  if (/^https?:\/\//i.test(url) || /^https?:\/\//i.test(path)) return "external";

  const source = clean(r.source || r.source_type || r.category).toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(external|web|internet|research)_/.test(source)) return "external";
  if (/^(project|repo|repository|local|codebase)_/.test(source)) return "project";
  if (["project_code", "code", "implementation", "repo_code", "project_test", "test", "tests", "fixture", "fixtures", "project_docs", "docs", "doc", "documentation", "project_config", "config", "configuration", "project_log", "log", "logs", "project_artifact", "artifact"].includes(source)) return "project";
  if (["external_web", "web", "webfetch", "websearch", "internet", "external_docs", "external_doc", "external", "research"].includes(source)) return "external";
  if (path) return "project";
  return "unknown";
}

function looksLikeEvidenceRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const r = value as Loose;
  return (
    r.scope != null
    || r.evidence_scope != null
    || r.source_scope != null
    || r.url != null
    || r.href != null
    || r.link != null
    || r.path != null
    || r.file != null
    || r.source != null
  );
}

interface EvidenceRecordEntry {
  record: Loose;
  carrier: Loose;
}

function evidenceRecordsFromValue(value: unknown, carrier: Loose = Object()): EvidenceRecordEntry[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => evidenceRecordsFromValue(item, carrier));
  if (typeof value !== "object") return [];
  const v = value as Loose;
  if (looksLikeEvidenceRecord(v) && !Array.isArray(v.evidence)) return [{ record: v, carrier }];
  const result = loose(v.result);
  const output = loose(v.output);
  const nested = [
    v.evidence,
    result.evidence,
    output.evidence,
    v.sources,
    result.sources,
    output.sources,
    v.findings,
    result.findings,
    output.findings,
  ].flatMap((item) => evidenceRecordsFromValue(item, v));
  if (nested.length > 0) return nested;
  return Object.values(v).flatMap((item) => evidenceRecordsFromValue(item, v));
}

function collectEvidenceRecords(input: Loose = Object(), session: Loose = Object(), options: Loose = Object()): EvidenceRecordEntry[] {
  const investigation = loose(session.investigation);
  return [
    input.evidence_results,
    input.evidenceResults,
    input.evidence_agent_results,
    input.evidenceAgentResults,
    session.evidence_results,
    session.evidenceResults,
    session.evidence_agent_results,
    session.evidenceAgentResults,
    investigation.evidence_results,
    investigation.evidenceResults,
    investigation.agent_results,
    investigation.agentResults,
    investigation.evidence_agents,
    investigation.evidenceAgents,
    input.evidence,
    input.research_results,
    session.evidence,
    investigation.evidence,
    options.evidence_results,
    options.evidenceResults,
    options.evidence_records,
    options.evidenceRecords,
  ].flatMap((source) => evidenceRecordsFromValue(source));
}

function validRecordForRequirement(record: unknown = Object(), requirement: EvidenceRequirement = Object() as EvidenceRequirement): boolean {
  if (!record || typeof record !== "object") return false;
  const r = record as Loose;
  if (evidenceRecordScope(r) !== requirement.kind) return false;
  const source = clean(r.source || r.source_type || r.category || r.kind || r.type);
  const summary = clean(r.summary || r.text || r.title || r.claim);
  if (!source || !summary) return false;
  if (requirement.kind === "external") {
    const url = clean(r.url || r.href || r.link || (/^https?:\/\//i.test(clean(r.path)) ? r.path : ""));
    return /^https?:\/\//i.test(url);
  }
  const path = clean(r.path || r.file || r.file_path || r.filename);
  return Boolean(path) && !/^https?:\/\//i.test(path);
}

function textTokens(value: unknown): string[] {
  return clean(value)
    .toLowerCase()
    .replace(/https?:\/\//g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff_]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function topicMatchesEvidence(requirement: EvidenceRequirement = Object() as EvidenceRequirement, record: Loose = Object(), carrier: Loose = Object()): boolean {
  const covers = uniqueStrings([
    record.covers,
    record.covered_requirements,
    record.covered_requirement_ids,
    record.requirement_ids,
    record.requirement_id,
  ].flat());
  if (covers.length > 0) return covers.includes(requirement.id);

  const topic = clean(requirement.topic).toLowerCase();
  const evidenceText = [
    record.topic,
    record.claim,
    record.summary,
    record.why,
    record.source,
    record.url,
    record.href,
    record.link,
    record.path,
    record.file,
    carrier.claim,
    carrier.summary,
    carrier.reason,
  ].map(clean).filter(Boolean).join("\n").toLowerCase();
  if (topic && evidenceText.includes(topic)) return true;
  if (/^https?:\/\//i.test(clean(requirement.topic))) return false;
  const tokens = textTokens(requirement.topic).filter((token) => !["existing", "already", "field", "payload", "request", "data", "external", "research", "project"].includes(token));
  if (tokens.length === 0) return false;
  const matched = tokens.filter((token) => evidenceText.includes(token));
  return matched.length >= Math.min(2, tokens.length);
}

function externalResearchAttempted(input: Loose = Object(), session: Loose = Object(), options: Loose = Object()): boolean {
  const investigation = loose(session.investigation);
  const nestedAttempted = (value: unknown): boolean => {
    if (value == null) return false;
    if (Array.isArray(value)) return value.some(nestedAttempted);
    if (typeof value !== "object") return false;
    const v = value as Loose;
    if (v.external_research_attempted === true || v.externalResearchAttempted === true) return true;
    return [
      v.result,
      v.output,
      v.evidence_results,
      v.evidenceResults,
      v.agent_results,
      v.agentResults,
    ].some(nestedAttempted);
  };
  return input.external_research_attempted === true
    || input.externalResearchAttempted === true
    || session.external_research_attempted === true
    || session.externalResearchAttempted === true
    || investigation.external_research_attempted === true
    || investigation.externalResearchAttempted === true
    || options.external_research_attempted === true
    || options.externalResearchAttempted === true
    || nestedAttempted(input.evidence_results)
    || nestedAttempted(input.evidenceResults)
    || nestedAttempted(input.evidence_agent_results)
    || nestedAttempted(input.evidenceAgentResults)
    || nestedAttempted(session.evidence_results)
    || nestedAttempted(session.evidenceResults)
    || nestedAttempted(options.evidence_results)
    || nestedAttempted(options.evidenceResults);
}

export function evaluateEvidenceRequirements(requirements: EvidenceRequirement[] = [], input: Loose = Object(), session: Loose = Object(), options: Loose = Object()): EvidenceRequirement[] {
  const records = collectEvidenceRecords(input, session, options);
  const attempted = externalResearchAttempted(input, session, options);
  return asArray<EvidenceRequirement>(requirements).map((requirement) => {
    const satisfied = records.some(({ record, carrier }) => (
      validRecordForRequirement(record, requirement) && topicMatchesEvidence(requirement, record, carrier)
    ));
    const reason = !satisfied && requirement.kind === "external" && attempted
      ? `${clean(requirement.reason)} Tool unavailable or attempted external research produced no valid covered evidence.`
      : requirement.reason;
    return {
      ...requirement,
      reason,
      status: satisfied ? "satisfied" : "pending",
    };
  });
}

export function buildEvidenceRequirements(input: Loose = Object(), session: Loose = Object(), options: Loose = Object()): EvidenceRequirement[] {
  const requirements = deriveEvidenceRequirements(input, session, options);
  if (requirements.length === 0) return [];
  return evaluateEvidenceRequirements(requirements, input, session, options);
}

export function pendingEvidenceRequirements(requirements: EvidenceRequirement[] = []): EvidenceRequirement[] {
  return asArray<EvidenceRequirement>(requirements).filter((item) => item?.status === "pending");
}

export function evidenceRequirementBlockers(requirements: EvidenceRequirement[] = []) {
  return pendingEvidenceRequirements(requirements).map((requirement) => ({
    code: requirement.kind === "external"
      ? "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED"
      : "PROJECT_EVIDENCE_REQUIREMENT_REQUIRED",
    evidence_requirement_id: requirement.id,
    id: requirement.id,
    topic: requirement.topic,
    kind: requirement.kind,
    reason: requirement.reason,
    matches: requirement.matches,
    message: `${requirement.kind} evidence requirement ${requirement.id} is pending: ${requirement.topic}. ${requirement.reason}`,
  }));
}

export function evidenceRequirementSummary(requirements: EvidenceRequirement[] = []) {
  const items = asArray<EvidenceRequirement>(requirements);
  return {
    total: items.length,
    pending: items.filter((item) => item.status === "pending").length,
    satisfied: items.filter((item) => item.status === "satisfied").length,
    pending_items: items.filter((item) => item.status === "pending").map((item) => ({
      id: item.id,
      kind: item.kind,
      topic: item.topic,
      reason: item.reason,
    })),
    satisfied_items: items.filter((item) => item.status === "satisfied").map((item) => ({
      id: item.id,
      kind: item.kind,
      topic: item.topic,
    })),
  };
}

export function evidenceRequirementNextActions(requirements: EvidenceRequirement[] = []): string[] {
  return pendingEvidenceRequirements(requirements).map((requirement) =>
    `必须为证据需求 ${requirement.id}（${requirement.topic}）收集 ${requirement.kind} 证据，并在 evidence.covers 中绑定 ${requirement.id}。`
  );
}
