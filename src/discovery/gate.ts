export const DISCOVERY_GATE_SCHEMA_VERSION = "1.0";
export const DISCOVERY_BRIEF_SCHEMA = "yolo.discovery.brief.v1";
export const DISCOVERY_READINESS_SCHEMA = "yolo.discovery.readiness.v1";

import {
  buildEvidenceRequirements,
  evidenceRequirementBlockers,
} from "../demand/evidence-requirements.js";
import type { DemandSession } from "../demand/graph.js";

type LabelList = readonly string[];
type DiscoveryRecord = Record<string, unknown>;

export type DiscoveryInput = DiscoveryRecord | string;
export type DiscoveryOptions = Record<string, unknown>;
export type DiscoverySeverity = string;

export interface DiscoveryCheck extends Record<string, unknown> {
  code: string;
  passed: boolean;
  severity: DiscoverySeverity;
  message: string;
}

export interface DiscoveryBrief extends Record<string, unknown> {
  schema_version: string;
  schema: string;
  id: string;
  idea: string;
  problem: string;
  target_users: string[];
  success_criteria: string[];
  constraints: string[];
  non_goals: string[];
  target_files: string[];
  open_questions: string[];
  risks: string[];
  ready_for_prd: boolean;
}

export interface DiscoveryReadiness extends Record<string, unknown> {
  schema_version: string;
  schema: string;
  status: string;
  ready_for_plan: boolean;
  ready_for_prd: boolean;
  brief: DiscoveryBrief;
  checks: DiscoveryCheck[];
  blockers: DiscoveryCheck[];
  warnings: DiscoveryCheck[];
  next_actions: string[];
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function uniqueStrings(values: unknown | unknown[] | null | undefined): string[] {
  return [...new Set(asArray(values).map((value) => clean(value)).filter(Boolean))];
}

const LABELS = {
  problem: ["Problem", "问题"],
  target_users: ["Target User", "Target Users", "User", "Users", "用户", "对象"],
  success_criteria: ["Success", "Success Criteria", "Acceptance", "验收", "成功标准"],
  constraints: ["Constraint", "Constraints", "限制", "约束"],
  non_goals: ["Non-goal", "Non-goals", "Out of scope", "不做", "非目标"],
  target_files: ["Target", "Targets", "Files", "Scope", "范围", "文件"],
} as const;

const ALL_LABELS: string[] = Object.values(LABELS).flat().sort((a, b) => b.length - a.length);

function labelPattern(labels: LabelList): string {
  return labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

function extractLabel(text: unknown, labels: LabelList): string {
  const source = clean(text);
  if (!source) return "";
  const current = labelPattern(labels);
  const all = labelPattern(ALL_LABELS);
  const pattern = new RegExp(`(?:^|[\\n.;])\\s*(?:${current})\\s*[:：]\\s*([\\s\\S]*?)(?=(?:[\\n.;]\\s*(?:${all})\\s*[:：])|$)`, "i");
  return clean(source.match(pattern)?.[1] || "");
}

const LIST_ITEM_PREFIX = /^(?:[-*•]\s+|\d{1,3}[.)、](?!\d)\s*|[（(]\d{1,3}[）)]\s*|[一二三四五六七八九十]{1,4}[.)、]\s*)/u;
const INLINE_NUMBERED_ITEM = /\s+(?=(?:\d{1,3}[.)、](?!\d)\s*|[（(]\d{1,3}[）)]\s*|[一二三四五六七八九十]{1,4}[.)、]\s*))/u;

function splitStructuredListItem(value: unknown): string[] {
  return clean(value)
    .split(INLINE_NUMBERED_ITEM)
    .flatMap((item) => item.split(/;\s+|\s+\|\s+/))
    .map((item) => clean(item).replace(LIST_ITEM_PREFIX, "").trim())
    .filter(Boolean);
}

function splitList(value: unknown | unknown[] | null | undefined): string[] {
  return uniqueStrings(asArray(value)
    .flatMap((item) => String(item ?? "").split(/\r?\n/))
    .flatMap(splitStructuredListItem));
}

function mergeLabeled(inputValue: unknown | unknown[] | null | undefined, idea: unknown, labels: LabelList): string[] {
  return splitList([...asArray(inputValue), extractLabel(idea, labels)]);
}

function hasSignal(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function check(
  code: string,
  passed: unknown,
  severity: DiscoverySeverity,
  message: string,
  extra: Record<string, unknown> = Object(),
): DiscoveryCheck {
  return { code, passed: Boolean(passed), severity, message, ...extra };
}

export function buildDiscoveryBrief(input: DiscoveryInput = Object(), options: DiscoveryOptions = Object()): DiscoveryBrief {
  const inputRecord: DiscoveryRecord = typeof input === "string" ? {} : input;
  const idea = typeof input === "string" ? input : inputRecord.idea || inputRecord.requirement || inputRecord.text;
  const ideaText = clean(idea);
  return {
    schema_version: DISCOVERY_GATE_SCHEMA_VERSION,
    schema: DISCOVERY_BRIEF_SCHEMA,
    id: clean(inputRecord.id || options.id || "DISCOVERY-001"),
    idea: ideaText,
    problem: clean(inputRecord.problem || extractLabel(ideaText, LABELS.problem)),
    target_users: mergeLabeled(inputRecord.target_users || inputRecord.users || inputRecord.audience, ideaText, LABELS.target_users),
    success_criteria: mergeLabeled(inputRecord.success_criteria || inputRecord.acceptance_criteria, ideaText, LABELS.success_criteria),
    constraints: mergeLabeled(inputRecord.constraints, ideaText, LABELS.constraints),
    non_goals: mergeLabeled(inputRecord.non_goals || inputRecord.nonGoals, ideaText, LABELS.non_goals),
    target_files: mergeLabeled(inputRecord.target_files || inputRecord.files, ideaText, LABELS.target_files),
    open_questions: uniqueStrings(inputRecord.open_questions || inputRecord.questions),
    risks: uniqueStrings(inputRecord.risks),
    ready_for_prd: inputRecord.ready_for_prd === true || inputRecord.readyForPrd === true,
  };
}

// Fail-closed: when the demand/brief content signals external research is
// required (URL or external-reference intent), discovery must not declare
// ready_for_prd unless external-scoped evidence is present. Prevents the
// discovery→PRD path from silently passing when a web tool was unavailable
// or external research was never triggered.
function externalEvidenceChecks(input: DiscoveryInput = Object(), brief: DiscoveryBrief = Object()): DiscoveryCheck[] {
  const inputRecord: DiscoveryRecord = typeof input === "string" ? {} : input;
  const texts = [
    brief.idea,
    brief.problem,
    brief.success_criteria.join(" "),
    brief.constraints.join(" "),
  ];
  const attempted = inputRecord.external_research_attempted === true
    || inputRecord.externalResearchAttempted === true;
  const requirements = buildEvidenceRequirements(input as DemandSession, {}, {
    kinds: ["external"],
    texts,
    evidence_records: [...asArray<unknown>(inputRecord.evidence), ...asArray<unknown>(inputRecord.research_results)],
    external_research_attempted: attempted,
  });
  const blockers = evidenceRequirementBlockers(requirements);
  if (blockers.length === 0) return [];

  const message = attempted
    ? "External research was required and attempted, but no scope=external evidence was produced (web tool unavailable or produced nothing)."
    : "External research is required by the content but no scope=external evidence is present (research was not triggered).";

  return blockers.map((blocker) => check(
    blocker.code,
    false,
    "error",
    message,
    {
      evidence_requirement_id: blocker.evidence_requirement_id,
      topic: blocker.topic,
      kind: blocker.kind,
      reason: blocker.reason,
      matches: blocker.matches,
    },
  ));
}

export function inspectDiscoveryReadiness(input: DiscoveryInput = Object(), options: DiscoveryOptions = Object()): DiscoveryReadiness {
  const brief = buildDiscoveryBrief(input, options);
  const text = [
    brief.idea,
    brief.problem,
    brief.success_criteria.join(" "),
    brief.constraints.join(" "),
    brief.target_files.join(" "),
  ].join(" ").toLowerCase();

  const checks = [
    check(
      "DISCOVERY_IDEA_PRESENT",
      brief.idea.length >= 10,
      "error",
      "idea or requirement must have enough text to inspect",
    ),
    check(
      "DISCOVERY_PROBLEM_PRESENT",
      Boolean(brief.problem) || hasSignal(text, [/because|problem|pain|用户|问题|目标|为了|希望/]),
      "warning",
      "problem or user outcome should be explicit",
    ),
    check(
      "DISCOVERY_TARGET_USER_PRESENT",
      brief.target_users.length > 0 || hasSignal(text, [/for [a-z][a-z\s-]{2,40},|用户|角色|operator|manager|admin/i]),
      "error",
      "target user must be explicit before PRD or execution",
    ),
    check(
      "DISCOVERY_SUCCESS_CRITERIA_PRESENT",
      brief.success_criteria.length > 0,
      "error",
      "success criteria must be explicit and structured before PRD or execution",
    ),
    check(
      "DISCOVERY_SCOPE_SIGNAL_PRESENT",
      brief.target_files.length > 0 || hasSignal(text, [/file|path|api|page|component|service|database|src\/|页面|接口|组件|服务|数据库/]),
      "error",
      "scope, surface, target files, or affected system area must be explicit",
    ),
    check(
      "DISCOVERY_CONSTRAINTS_RECORDED",
      brief.constraints.length > 0 || hasSignal(text, [/constraint|risk|non-goal|兼容|限制|不能|不要|风险/]),
      "warning",
      "constraints and non-goals should be recorded before execution",
    ),
    check(
      "DISCOVERY_REQUIREMENTS_ACTIVE",
      brief.success_criteria.length > 0,
      "error",
      "discovery must produce at least one active requirement before planning",
    ),
    ...externalEvidenceChecks(input, brief),
  ];

  const blockers = checks.filter((item) => item.severity === "error" && item.passed !== true);
  const warnings = checks.filter((item) => item.severity === "warning" && item.passed !== true);
  const status = blockers.length > 0 ? "blocked" : (warnings.length > 0 ? "warning" : "pass");

  return {
    schema_version: DISCOVERY_GATE_SCHEMA_VERSION,
    schema: DISCOVERY_READINESS_SCHEMA,
    status,
    ready_for_plan: blockers.length === 0,
    ready_for_prd: blockers.length === 0 && warnings.length === 0,
    brief,
    checks,
    blockers,
    warnings,
    next_actions: blockers.length > 0
      ? [
          "Run /yolo-discover with the idea and answer the missing problem, success criteria, and scope questions.",
          "Do not generate executable PRD or run implementation until discovery readiness passes.",
        ]
      : warnings.length > 0
        ? ["Proceed to /yolo-plan, but record constraints and non-goals before execution."]
        : ["Proceed to /yolo-plan or /yolo-prd with this discovery brief."],
  };
}
