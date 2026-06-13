import { createHash } from "node:crypto";

import { EVIDENCE_SCHEMA_VERSION } from "../runtime/evidence/schema.js";

export const REVIEW_FINDING_SCHEMA = "yolo.review.finding.v1";
export const REVIEW_OUTPUT_SCHEMA = "yolo.review.output.v1";

const SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO", "UNKNOWN"]);
const FIX_TYPES = new Set(["AUTO_FIX", "CLAUDE_FIX", "INFO", "MANUAL_REVIEW", "UNKNOWN"]);

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function cleanCode(value) {
  return String(value || "review-finding")
    .trim()
    .replace(/[^A-Z0-9_.:-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "review-finding";
}

function shortHash(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 10).toUpperCase();
}

export function normalizeReviewPath(value) {
  const text = cleanText(value);
  if (!text) return null;
  return text
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?:-\d+)?$/, "");
}

function parseLocation(input = Object()) {
  const rawFile = input.file || input.path || input.filename || input.location?.file || input.files?.[0] || null;
  const rawText = typeof rawFile === "object" && rawFile !== null ? rawFile.file : rawFile;
  const match = String(rawText || "").match(/^(.+?):(\d+)(?:-\d+)?$/);
  const file = normalizeReviewPath(match ? match[1] : rawText);
  const line = Number(input.line ?? input.location?.line ?? (match ? match[2] : null));
  return {
    file,
    line: Number.isFinite(line) && line > 0 ? line : null,
  };
}

function normalizeSeverity(value) {
  const severity = String(value || "UNKNOWN").toUpperCase();
  return SEVERITIES.has(severity) ? severity : "UNKNOWN";
}

function normalizeFixType(value) {
  const fixType = String(value || "UNKNOWN").toUpperCase();
  return FIX_TYPES.has(fixType) ? fixType : "UNKNOWN";
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function collectFiles(input, primaryFile) {
  const files = Array.isArray(input.files) ? input.files : [];
  return unique([
    primaryFile,
    ...files.map((file) => normalizeReviewPath(typeof file === "object" && file !== null ? file.file : file)),
  ]);
}

function buildFindingId({ input, code, file, line, message, index }) {
  const explicit = cleanText(input.finding_id || input.id);
  if (explicit) return explicit;
  const basis = `${code}|${file || ""}|${line || ""}|${message || ""}|${input.match || ""}|${index ?? ""}`;
  return `REV-${cleanCode(code).slice(0, 28).toUpperCase()}-${shortHash(basis)}`;
}

export function normalizeReviewFinding(input = Object(), options = Object()) {
  const location = parseLocation(input);
  const code = cleanCode(input.code || input.scanner_id || input.rule_id || input.id || input.finding_id);
  const message = cleanText(input.message || input.description || input.title || input.summary || code);
  const suggestedFix = cleanText(input.suggested_fix || input.suggestion || input.recommendation);
  const source = cleanText(input.source || options.source) || "review";
  const finding = Object.assign(Object(), {
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

export function normalizeReviewFindings(findings = [], options = Object()) {
  return findings.map((finding, index) => normalizeReviewFinding(finding, { ...options, index }));
}

export function summarizeReviewFindings(findings = []) {
  const summary = {
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
    if (Object.prototype.hasOwnProperty.call(summary, key)) {
      summary[key] += 1;
    } else {
      summary.unknown += 1;
    }
  }
  return summary;
}

export function buildReviewOutput(findings = [], options = Object()) {
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

export function validateReviewFinding(finding = Object()) {
  const errors = [];
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
