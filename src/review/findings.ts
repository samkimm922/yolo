import { createHash } from "node:crypto";

import { EVIDENCE_SCHEMA_VERSION } from "../runtime/evidence/schema.js";

export const REVIEW_FINDING_SCHEMA = "yolo.review.finding.v1";
export const REVIEW_OUTPUT_SCHEMA = "yolo.review.output.v1";

const SEVERITY_VALUES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO", "UNKNOWN"] as const;
const FIX_TYPE_VALUES = ["AUTO_FIX", "CLAUDE_FIX", "INFO", "MANUAL_REVIEW", "UNKNOWN"] as const;

export type ReviewSeverity = (typeof SEVERITY_VALUES)[number];
export type ReviewFixType = (typeof FIX_TYPE_VALUES)[number];

export type ReviewLocation = {
  file: string | null;
  line: number | null;
};

export type ReviewFindingInput = {
  [key: string]: unknown;
  finding_id?: unknown;
  id?: unknown;
  scanner_id?: unknown;
  rule_id?: unknown;
  code?: unknown;
  file?: unknown;
  path?: unknown;
  filename?: unknown;
  location?: { [key: string]: unknown; file?: unknown; line?: unknown } | null;
  files?: unknown[];
  line?: unknown;
  message?: unknown;
  description?: unknown;
  title?: unknown;
  summary?: unknown;
  suggested_fix?: unknown;
  suggestion?: unknown;
  recommendation?: unknown;
  source?: unknown;
  dimension?: unknown;
  category?: unknown;
  severity?: unknown;
  fix_type?: unknown;
  match?: unknown;
  evidence_text?: unknown;
  pattern?: unknown;
  context?: unknown;
  risk?: unknown;
  must_fix_before_ship?: unknown;
  evidence?: unknown;
};

export type NormalizeReviewOptions = {
  [key: string]: unknown;
  source?: unknown;
  index?: number;
  now?: string;
};

export type NormalizedReviewFinding = {
  [key: string]: unknown;
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  schema: typeof REVIEW_FINDING_SCHEMA;
  finding_id: string;
  source: string;
  code: string;
  scanner_id: string;
  rule_id: string;
  dimension: string;
  severity: ReviewSeverity;
  fix_type: ReviewFixType;
  file: string | null;
  line: number | null;
  location: ReviewLocation;
  files: string[];
  message: string;
  description: string;
  match: string | null;
  context: string | null;
  suggested_fix: string | null;
  recommendation: string | null;
  risk: string | null;
  must_fix_before_ship: boolean;
  evidence?: unknown[];
};

export type ReviewFindingsSummary = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  unknown: number;
  total: number;
};

export type ReviewOutput = {
  schema_version: typeof EVIDENCE_SCHEMA_VERSION;
  schema: typeof REVIEW_OUTPUT_SCHEMA;
  generated_at: string;
  source: string;
  summary: ReviewFindingsSummary;
  findings: NormalizedReviewFinding[];
};

const SEVERITIES = new Set<string>(SEVERITY_VALUES);
const FIX_TYPES = new Set<string>(FIX_TYPE_VALUES);
const SUMMARY_KEYS = new Set<string>(["critical", "high", "medium", "low", "info", "unknown"]);

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function cleanCode(value: unknown): string {
  return String(value || "review-finding")
    .trim()
    .replace(/[^A-Z0-9_.:-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "review-finding";
}

function shortHash(value: unknown): string {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 10).toUpperCase();
}

export function normalizeReviewPath(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  return text
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?:-\d+)?$/, "");
}

function parseLocation(input: ReviewFindingInput = Object()): ReviewLocation {
  const location = input.location || Object();
  const rawFile = input.file || input.path || input.filename || location.file || input.files?.[0] || null;
  const rawFileSlot = fileSlot(rawFile);
  const rawText = rawFileSlot ? rawFileSlot.file : rawFile;
  const match = String(rawText || "").match(/^(.+?):(\d+)(?:-\d+)?$/);
  const file = normalizeReviewPath(match ? match[1] : rawText);
  const line = Number(input.line ?? input.location?.line ?? (match ? match[2] : null));
  return {
    file,
    line: Number.isFinite(line) && line > 0 ? line : null,
  };
}

function normalizeSeverity(value: unknown): ReviewSeverity {
  const severity = String(value || "UNKNOWN").toUpperCase();
  switch (severity) {
    case "CRITICAL":
    case "HIGH":
    case "MEDIUM":
    case "LOW":
    case "INFO":
    case "UNKNOWN":
      return severity;
    default:
      return "UNKNOWN";
  }
}

function normalizeFixType(value: unknown): ReviewFixType {
  const fixType = String(value || "UNKNOWN").toUpperCase();
  switch (fixType) {
    case "AUTO_FIX":
    case "CLAUDE_FIX":
    case "INFO":
    case "MANUAL_REVIEW":
    case "UNKNOWN":
      return fixType;
    default:
      return "UNKNOWN";
  }
}

function unique(values: Array<string | null | undefined> = []): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function fileSlot(value: unknown): { file?: unknown } | null {
  return typeof value === "object" && value !== null ? value : null;
}

function collectFiles(input: ReviewFindingInput, primaryFile: string | null): string[] {
  const files = Array.isArray(input.files) ? input.files : [];
  return unique([
    primaryFile,
    ...files.map((file) => normalizeReviewPath(fileSlot(file)?.file ?? file)),
  ]);
}

function buildFindingId({
  input,
  code,
  file,
  line,
  message,
  index,
}: {
  input: ReviewFindingInput;
  code: string;
  file: string | null;
  line: number | null;
  message: string | null;
  index?: number;
}): string {
  const explicit = cleanText(input.finding_id || input.id);
  if (explicit) return explicit;
  const basis = `${code}|${file || ""}|${line || ""}|${message || ""}|${input.match || ""}|${index ?? ""}`;
  return `REV-${cleanCode(code).slice(0, 28).toUpperCase()}-${shortHash(basis)}`;
}

export function normalizeReviewFinding(
  input: ReviewFindingInput = Object(),
  options: NormalizeReviewOptions = Object(),
): NormalizedReviewFinding {
  const location = parseLocation(input);
  const code = cleanCode(input.code || input.scanner_id || input.rule_id || input.id || input.finding_id);
  const message = cleanText(input.message || input.description || input.title || input.summary || code) || code;
  const suggestedFix = cleanText(input.suggested_fix || input.suggestion || input.recommendation);
  const source = cleanText(input.source || options.source) || "review";
  const finding: NormalizedReviewFinding = Object.assign(Object(), {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    schema: REVIEW_FINDING_SCHEMA,
    finding_id: buildFindingId({
      input,
      code,
      file: location.file,
      line: location.line,
      message,
      index: options.index,
    }),
    source,
    code,
    scanner_id: cleanText(input.scanner_id) || code,
    rule_id: cleanText(input.rule_id) || cleanText(input.scanner_id) || code,
    dimension: cleanText(input.dimension || input.category) || "code",
    severity: normalizeSeverity(input.severity),
    fix_type: normalizeFixType(input.fix_type),
    file: location.file,
    line: location.line,
    location,
    files: collectFiles(input, location.file),
    message,
    description: message,
    match: cleanText(input.match || input.evidence_text || input.pattern),
    context: cleanText(input.context),
    suggested_fix: suggestedFix,
    recommendation: suggestedFix,
    risk: cleanText(input.risk),
    must_fix_before_ship: input.must_fix_before_ship === true || ["CRITICAL", "HIGH"].includes(normalizeSeverity(input.severity)),
  });

  if (Array.isArray(input.evidence)) finding.evidence = input.evidence;
  return finding;
}

export function normalizeReviewFindings(
  findings: ReviewFindingInput[] = [],
  options: NormalizeReviewOptions = Object(),
): NormalizedReviewFinding[] {
  return findings.map((finding, index) => normalizeReviewFinding(finding, { ...options, index }));
}

function isSummaryKey(key: string): key is keyof Omit<ReviewFindingsSummary, "total"> {
  return SUMMARY_KEYS.has(key);
}

export function summarizeReviewFindings(findings: NormalizedReviewFinding[] = []): ReviewFindingsSummary {
  const summary: ReviewFindingsSummary = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    unknown: 0,
    total: findings.length,
  };
  for (const finding of findings) {
    const key = String(finding.severity || "UNKNOWN").toLowerCase();
    if (isSummaryKey(key)) {
      summary[key] += 1;
    } else {
      summary.unknown += 1;
    }
  }
  return summary;
}

export function buildReviewOutput(
  findings: ReviewFindingInput[] = [],
  options: NormalizeReviewOptions = Object(),
): ReviewOutput {
  const normalizedFindings = normalizeReviewFindings(findings, options);
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    schema: REVIEW_OUTPUT_SCHEMA,
    generated_at: options.now || nowIso(),
    source: cleanText(options.source) || "review",
    summary: summarizeReviewFindings(normalizedFindings),
    findings: normalizedFindings,
  };
}

export function validateReviewFinding(finding: Partial<NormalizedReviewFinding> = Object()) {
  const errors: string[] = [];
  if (finding.schema_version !== EVIDENCE_SCHEMA_VERSION) errors.push("schema_version must be 1.0");
  if (finding.schema !== REVIEW_FINDING_SCHEMA) errors.push(`schema must be ${REVIEW_FINDING_SCHEMA}`);
  if (!cleanText(finding.finding_id)) errors.push("finding_id is required");
  if (!cleanText(finding.source)) errors.push("source is required");
  if (!cleanText(finding.code)) errors.push("code is required");
  if (!cleanText(finding.message)) errors.push("message is required");
  if (!SEVERITIES.has(String(finding.severity || "").toUpperCase())) errors.push("severity is invalid");
  if (!FIX_TYPES.has(String(finding.fix_type || "").toUpperCase())) errors.push("fix_type is invalid");
  return {
    ok: errors.length === 0,
    errors,
  };
}
