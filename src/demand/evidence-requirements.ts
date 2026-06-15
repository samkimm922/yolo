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

const PROJECT_FACT_ASSUMPTION_RE =
  /(already|existing|receives?|contains?|present|available)[^\n.]{0,80}\b(field|payload|row|request|data|threshold|quantity|qty)\b/i;
const PROJECT_FACT_ASSUMPTION_REVERSE =
  /\b(field|payload|row|request|data|threshold|quantity|qty)\b[^\n.]{0,80}(already|existing|receives?|contains?|present|available)/i;

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueStrings(value) {
  return [...new Set(asArray(value).map(clean).filter(Boolean))];
}

function hashId(kind, topic, reason) {
  const digest = createHash("sha1").update(`${kind}\n${clean(topic).toLowerCase()}\n${clean(reason)}`).digest("hex").slice(0, 8).toUpperCase();
  return `EVREQ-${kind.toUpperCase()}-${digest}`;
}

function truncate(value, max = 240) {
  const text = clean(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function textFromValue(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(textFromValue);
  if (typeof value === "object") {
    return [
      value.text,
      value.title,
      value.summary,
      value.value,
      value.claim,
      value.answer,
      value.question,
      value.message,
      value.reason,
    ].flatMap(textFromValue);
  }
  const text = clean(value);
  return text ? [text] : [];
}

function demandRequirementTextItems(input = Object(), session = Object()) {
  const requirements = asArray(session.requirements?.active || session.requirements || input.requirements);
  const scenarios = asArray(session.scenario_matrix?.scenarios || session.scenarios);
  const rounds = asArray(session.discussion?.rounds || input.question_trace || input.questions);
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
    session.context?.visual_style_source,
    session.discussion?.open_questions,
    session.discussion?.decisions,
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
      asArray(scenario.surfaces).flatMap((surface) => [
        surface?.proof,
        surface?.verification_hint,
        surface?.label,
        surface?.visual_style_source,
      ]),
    ]),
  ].flatMap(textFromValue);
}

function topicFromExternalMatch(text, match) {
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

function sentenceForProjectMatch(text) {
  const source = clean(text);
  if (!source) return "";
  const direct = source
    .split(/[\r\n。；;]/u)
    .map(clean)
    .find((item) => PROJECT_FACT_ASSUMPTION_RE.test(item) || PROJECT_FACT_ASSUMPTION_REVERSE.test(item));
  return truncate(direct || source);
}

export function detectProjectFactAssumptionSignal(...texts) {
  const text = texts.map(clean).filter(Boolean).join("\n");
  if (!text) return { requires_project: false, matches: [] };
  const matches = [];
  for (const item of text.split(/\r?\n/).map(clean).filter(Boolean)) {
    if (PROJECT_FACT_ASSUMPTION_RE.test(item) || PROJECT_FACT_ASSUMPTION_REVERSE.test(item)) {
      matches.push(sentenceForProjectMatch(item));
    }
  }
  return { requires_project: matches.length > 0, matches: uniqueStrings(matches) };
}

function addRequirement(map, { kind, topic, reason, matches }) {
  const normalizedTopic = truncate(topic || matches?.[0] || reason || kind);
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

export function deriveEvidenceRequirements(input = Object(), session = Object(), options = Object()): EvidenceRequirement[] {
  const kinds = new Set(asArray(options.kinds || ["external", "project"]).map(clean));
  const map = new Map();
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
    for (const text of texts) {
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

function evidenceRecordScope(record = Object()) {
  if (typeof record === "string" || !record || typeof record !== "object") return "unknown";
  const scope = clean(record.scope || record.evidence_scope || record.source_scope || record.kind || record.type).toLowerCase();
  if (["project", "repo", "repository", "codebase", "local"].includes(scope)) return "project";
  if (["external", "web", "internet", "research"].includes(scope)) return "external";
  if (["user", "human", "operator"].includes(scope)) return "user";

  const path = clean(record.path || record.file || record.file_path || record.filename);
  const url = clean(record.url || record.href || record.link);
  if (/^https?:\/\//i.test(url) || /^https?:\/\//i.test(path)) return "external";

  const source = clean(record.source || record.source_type || record.category).toLowerCase().replace(/[\s-]+/g, "_");
  if (/^(external|web|internet|research)_/.test(source)) return "external";
  if (/^(project|repo|repository|local|codebase)_/.test(source)) return "project";
  if (["project_code", "code", "implementation", "repo_code", "project_test", "test", "tests", "fixture", "fixtures", "project_docs", "docs", "doc", "documentation", "project_config", "config", "configuration", "project_log", "log", "logs", "project_artifact", "artifact"].includes(source)) return "project";
  if (["external_web", "web", "webfetch", "websearch", "internet", "external_docs", "external_doc", "external", "research"].includes(source)) return "external";
  if (path) return "project";
  return "unknown";
}

function looksLikeEvidenceRecord(value) {
  return value && typeof value === "object" && (
    value.scope != null
    || value.evidence_scope != null
    || value.source_scope != null
    || value.url != null
    || value.href != null
    || value.link != null
    || value.path != null
    || value.file != null
    || value.source != null
  );
}

function evidenceRecordsFromValue(value, carrier = Object()) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => evidenceRecordsFromValue(item, carrier));
  if (typeof value !== "object") return [];
  if (looksLikeEvidenceRecord(value) && !Array.isArray(value.evidence)) return [{ record: value, carrier }];
  const nested = [
    value.evidence,
    value.result?.evidence,
    value.output?.evidence,
    value.sources,
    value.result?.sources,
    value.output?.sources,
    value.findings,
    value.result?.findings,
    value.output?.findings,
  ].flatMap((item) => evidenceRecordsFromValue(item, value));
  if (nested.length > 0) return nested;
  return Object.values(value).flatMap((item) => evidenceRecordsFromValue(item, value));
}

function collectEvidenceRecords(input = Object(), session = Object(), options = Object()) {
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
    input.research_results,
    session.evidence,
    session.investigation?.evidence,
    options.evidence_results,
    options.evidenceResults,
    options.evidence_records,
    options.evidenceRecords,
  ].flatMap((source) => evidenceRecordsFromValue(source));
}

function validRecordForRequirement(record = Object(), requirement = Object()) {
  if (!record || typeof record !== "object") return false;
  if (evidenceRecordScope(record) !== requirement.kind) return false;
  const source = clean(record.source || record.source_type || record.category || record.kind || record.type);
  const summary = clean(record.summary || record.text || record.title || record.claim);
  if (!source || !summary) return false;
  if (requirement.kind === "external") {
    const url = clean(record.url || record.href || record.link || (/^https?:\/\//i.test(clean(record.path)) ? record.path : ""));
    return /^https?:\/\//i.test(url);
  }
  const path = clean(record.path || record.file || record.file_path || record.filename);
  return Boolean(path) && !/^https?:\/\//i.test(path);
}

function textTokens(value) {
  return clean(value)
    .toLowerCase()
    .replace(/https?:\/\//g, " ")
    .replace(/[^a-z0-9\u4e00-\u9fff_]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function topicMatchesEvidence(requirement = Object(), record = Object(), carrier = Object()) {
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

function externalResearchAttempted(input = Object(), session = Object(), options = Object()) {
  const nestedAttempted = (value) => {
    if (value == null) return false;
    if (Array.isArray(value)) return value.some(nestedAttempted);
    if (typeof value !== "object") return false;
    if (value.external_research_attempted === true || value.externalResearchAttempted === true) return true;
    return [
      value.result,
      value.output,
      value.evidence_results,
      value.evidenceResults,
      value.agent_results,
      value.agentResults,
    ].some(nestedAttempted);
  };
  return input.external_research_attempted === true
    || input.externalResearchAttempted === true
    || session.external_research_attempted === true
    || session.externalResearchAttempted === true
    || session.investigation?.external_research_attempted === true
    || session.investigation?.externalResearchAttempted === true
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

export function evaluateEvidenceRequirements(requirements = [], input = Object(), session = Object(), options = Object()): EvidenceRequirement[] {
  const records = collectEvidenceRecords(input, session, options);
  const attempted = externalResearchAttempted(input, session, options);
  return asArray(requirements).map((requirement) => {
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

export function buildEvidenceRequirements(input = Object(), session = Object(), options = Object()): EvidenceRequirement[] {
  const requirements = deriveEvidenceRequirements(input, session, options);
  if (requirements.length === 0) return [];
  return evaluateEvidenceRequirements(requirements, input, session, options);
}

export function pendingEvidenceRequirements(requirements = []) {
  return asArray(requirements).filter((item) => item?.status === "pending");
}

export function evidenceRequirementBlockers(requirements = []) {
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

export function evidenceRequirementSummary(requirements = []) {
  const items = asArray(requirements);
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

export function evidenceRequirementNextActions(requirements = []) {
  return pendingEvidenceRequirements(requirements).map((requirement) =>
    `必须为证据需求 ${requirement.id}（${requirement.topic}）收集 ${requirement.kind} 证据，并在 evidence.covers 中绑定 ${requirement.id}。`
  );
}
