import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { filterVerifiedSuccessLearningRecords } from "./verified-success.js";

export const LEARNING_CENTER_SCHEMA_VERSION = "1.0";

/** A loose JSON record, used for external input/options coming from callers/tests. */
type JsonRecord = Record<string, unknown>;

/** Narrows an unknown value to a JSON record (non-null, non-array object). */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A parsed JSONL line; either a valid JSON object or a malformed-line marker. */
interface JsonlRecord extends JsonRecord {
  parse_error?: boolean;
  raw?: string;
}

/** The deterministic fingerprint embedded in every learning record. */
interface LearningFingerprint extends JsonRecord {
  type: string;
  gate: string;
  files: string[];
  directories: string[];
  error_codes: string[];
  risk_patterns: string[];
  task_type: string;
}

/** A normalized learning record as written to the learning ledger. */
export interface LearningRecord extends JsonRecord {
  schema_version: string;
  id: string;
  ts: string;
  type: string;
  source: string;
  source_outcome: string;
  status: string;
  confidence: number;
  task_id: string;
  gate: string;
  lesson: string;
  prevention: string;
  fingerprint: LearningFingerprint;
  fingerprint_key: string;
  occurrence_count: number;
  evidence_refs: string[];
  tags: string[];
  legacy_source: string;
  legacy_id: string;
}

/** Resolved filesystem paths used by the learning center. */
export interface LearningPaths extends JsonRecord {
  projectRoot: string;
  packageMode: boolean;
  stateRoot: string;
  stateDir: string;
  memoryDir: string;
  learningFile: string;
  legacyKnowledgeFile: string;
  legacyLessonsFile: string;
  legacyRedTeamFile: string;
  learnedRulesFile: string;
}

function toPosix(path: unknown): string {
  return String(path || "").replaceAll("\\", "/");
}

function rel(root: string, file: string): string {
  return toPosix(relative(root, file));
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readJson(filePath: string, fallback: unknown = null): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string): unknown[] {
  const text = readText(filePath);
  if (!text.trim()) return [];
  const records: unknown[] = [];
  for (const line of text.split("\n").filter(Boolean)) {
    try {
      records.push(JSON.parse(line));
    } catch {
      records.push({ parse_error: true, raw: line.slice(0, 500) });
    }
  }
  return records;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hashId(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function isYoloPackageRoot(projectRoot: string): boolean {
  const pkg = readJson(join(projectRoot, "package.json"), {}) as JsonRecord | null;
  return pkg?.name === "yolo" && existsSync(join(projectRoot, "src/runtime"));
}

export function resolveLearningPaths(options: JsonRecord = Object()): LearningPaths {
  const projectRoot = resolve(String(options.projectRoot || options.yoloRoot || options.cwd || process.cwd()));
  const explicitPackageMode = options.packageMode;
  const packageMode: boolean = explicitPackageMode === undefined ? isYoloPackageRoot(projectRoot) : Boolean(explicitPackageMode);
  const stateRoot = resolve(String(options.stateRoot || options.state_root || (packageMode ? projectRoot : join(projectRoot, ".yolo"))));
  const stateDir = resolve(String(options.stateDir || options.state_dir || join(stateRoot, "state")));
  const memoryDir = resolve(String(options.memoryDir || options.memory_dir || (packageMode ? join(projectRoot, "docs/memory") : join(stateRoot, "memory"))));
  return {
    projectRoot,
    packageMode,
    stateRoot,
    stateDir,
    memoryDir,
    learningFile: resolve(String(options.learningFile || options.learning_file || join(stateDir, "learning.jsonl"))),
    legacyKnowledgeFile: resolve(String(options.legacyKnowledgeFile || join(projectRoot, "closed-loop/knowledge-base.jsonl"))),
    legacyLessonsFile: resolve(String(options.legacyLessonsFile || join(projectRoot, "closed-loop/lessons.jsonl"))),
    legacyRedTeamFile: resolve(String(options.legacyRedTeamFile || join(projectRoot, "closed-loop/red-team-report.jsonl"))),
    learnedRulesFile: resolve(String(options.learnedRulesFile || join(projectRoot, "learned-rules.json"))),
  };
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (!value) return [];
  return [String(value)];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function directoriesForFiles(files: string[] = []): string[] {
  return unique(files.map((file) => {
    const normalized = toPosix(file);
    if (!normalized.includes("/")) return "";
    return normalized.split("/").slice(0, -1).join("/");
  }).filter(Boolean));
}

function extractErrorCodes(text: unknown = ""): string[] {
  const matches = String(text).match(/\b(?:TS|E|ERR|R)\d{3,5}\b/g) || [];
  return unique(matches);
}

function extractRiskPatterns(text: unknown = ""): string[] {
  const source = String(text).toLowerCase();
  const patterns: string[] = [];
  for (const [needle, label] of [
    ["as unknown as", "double_type_assertion"],
    ["as any", "unsafe_any"],
    ["console.log", "console_log"],
    ["window/document", "dom_api"],
    ["document.", "dom_api"],
    ["hardcoded", "hardcoded_secret"],
    ["密钥", "hardcoded_secret"],
    ["文件超", "file_size_limit"],
    ["file scope", "file_scope"],
    ["must_use", "prd_constraint"],
    ["must_not_use", "prd_constraint"],
  ] as const) {
    if (source.includes(needle.toLowerCase())) patterns.push(label);
  }
  return unique(patterns);
}

function gateFromText(text: unknown = ""): string {
  const match = String(text).match(/^([^:：]{2,80})[:：]/);
  return match ? match[1].trim() : "";
}

function normalizedType(type: unknown = ""): string {
  const value = String(type || "").toLowerCase();
  if (["trap", "pitfall"].includes(value)) return "pitfall";
  if (["error", "failure", "gate_knowledge"].includes(value)) return "failure";
  if (["pattern", "rule"].includes(value)) return "rule";
  if (["validation", "red_team"].includes(value)) return value;
  return value || "lesson";
}

function normalizedSourceOutcome(input: JsonRecord, type: string): string {
  const outcome = String(input.source_outcome || input.sourceOutcome || input.result || "").trim().toLowerCase();
  if (["pass", "passed", "success", "succeeded", "completed", "done"].includes(outcome)) return "success";
  if (["fail", "failed", "failure", "error", "blocked", "timeout", "timed_out"].includes(outcome)) return "failure";
  if (["failure", "pitfall"].includes(type)) return "failure";
  return "unverified";
}

function defaultPrevention(input: JsonRecord = Object()): string {
  if (input.prevention) return String(input.prevention);
  if (input.strategy) return String(input.strategy);
  if (input.type === "red_team" || input.attack_type) return `Keep blocking ${input.attack_type || "this risk pattern"} with deterministic gates.`;
  return String(input.lesson || input.content || input.knowledge || input.summary || "");
}

/** Formats an optional `now` value (a Date, or a date-like with toISOString, or an ISO string) into an ISO timestamp. */
function toIsoNow(now: unknown): string {
  if (now && typeof now === "object" && typeof (now as { toISOString?: unknown }).toISOString === "function") {
    return (now as Date).toISOString();
  }
  return now ? String(now) : new Date().toISOString();
}

export function createLearningRecord(input: JsonRecord = Object(), options: JsonRecord = Object()): LearningRecord {
  const now = toIsoNow(options.now);
  const files = unique(asArray(input.files || input.related_files || input.file || input.filename));
  const directories = unique([
    ...asArray(input.directories),
    ...directoriesForFiles(files),
  ]);
  const lesson = String(input.lesson || input.content || input.knowledge || input.rule || input.summary || input.message || "").trim();
  const prevention = defaultPrevention({ ...input, lesson }).trim();
  const gate = String(input.gate || input.failed_gate || gateFromText(lesson) || "").trim();
  const errorCodes = unique([
    ...asArray(input.error_codes),
    ...extractErrorCodes(lesson),
    ...extractErrorCodes(prevention),
  ]);
  const riskPatterns = unique([
    ...asArray(input.risk_patterns),
    ...extractRiskPatterns(lesson),
    ...extractRiskPatterns(prevention),
  ]);
  const type = normalizedType(input.type || input.knowledge_type || input.result);
  const sourceOutcome = normalizedSourceOutcome(input, type);
  const status = String(input.status || (input.promoted ? "promoted" : "advisory")).toLowerCase();
  const confidence = Number.isFinite(Number(input.confidence))
    ? Math.max(0, Math.min(10, Number(input.confidence)))
    : (status === "promoted" ? 8 : 5);
  const fingerprint: LearningFingerprint = {
    type,
    gate,
    files,
    directories,
    error_codes: errorCodes,
    risk_patterns: riskPatterns,
    task_type: String(input.task_type || ""),
  };
  const fingerprintKey = hashId(fingerprint);
  const id = input.id
    ? String(input.id)
    : `learn_${fingerprintKey}`;
  return {
    schema_version: LEARNING_CENTER_SCHEMA_VERSION,
    id,
    ts: String(input.ts || input.timestamp || input.learned_at || input.last_used || now),
    type,
    source: String(input.source || input.legacy_source || "learning_center"),
    source_outcome: sourceOutcome,
    status,
    confidence,
    task_id: String(input.task_id || input.source_task || ""),
    gate,
    lesson,
    prevention,
    fingerprint,
    fingerprint_key: fingerprintKey,
    occurrence_count: Number.isFinite(Number(input.occurrence_count)) ? Number(input.occurrence_count) : 1,
    evidence_refs: unique(asArray(input.evidence_refs || input.refs || input.related_files || input.filename)),
    tags: unique(asArray(input.tags)),
    legacy_source: String(input.legacy_source || ""),
    legacy_id: String(input.legacy_id || ""),
  };
}

/** True unless the value is a malformed-JSONL marker ({ parse_error: true }). */
function isParsableRecord(value: unknown): boolean {
  if (!value) return false;
  return !(isRecord(value) && value.parse_error === true);
}

/** Type guard: a non-null object JSONL line that is not a malformed-line marker. */
function isLegacyEntry(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !(isRecord(value) && value.parse_error === true);
}

export function readLearningRecords(filePath: string): LearningRecord[] {
  return readJsonl(filePath)
    .filter(isParsableRecord) as LearningRecord[];
}

function mergeRecord(base: LearningRecord, next: LearningRecord): LearningRecord {
  return {
    ...base,
    ts: String(next.ts || "") > String(base.ts || "") ? next.ts : base.ts,
    confidence: Math.max(Number(base.confidence || 0), Number(next.confidence || 0)),
    occurrence_count: Number(base.occurrence_count || 1) + Number(next.occurrence_count || 1),
    evidence_refs: unique([...(base.evidence_refs || []), ...(next.evidence_refs || [])]),
    tags: unique([...(base.tags || []), ...(next.tags || [])]),
    lesson: base.lesson || next.lesson,
    prevention: base.prevention || next.prevention,
    status: base.status === "promoted" || next.status === "promoted" ? "promoted" : (base.status || next.status || "advisory"),
    source_outcome: base.source_outcome && base.source_outcome === next.source_outcome ? base.source_outcome : "mixed",
  };
}

export function dedupeLearningRecords(records: LearningRecord[] = []): LearningRecord[] {
  const byKey = new Map<string, LearningRecord>();
  for (const record of records) {
    const normalized = record.schema_version === LEARNING_CENTER_SCHEMA_VERSION
      ? record
      : createLearningRecord(record);
    const key = normalized.fingerprint_key || normalized.id;
    byKey.set(key, byKey.has(key) ? mergeRecord(byKey.get(key) as LearningRecord, normalized) : normalized);
  }
  return [...byKey.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function writeLearningRecords(filePath: string, records: LearningRecord[] = [], options: JsonRecord = Object()) {
  const dryRun = options.dryRun === true || options.dry_run === true;
  const content = records.map((record) => JSON.stringify(record)).join("\n");
  if (!dryRun) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content ? `${content}\n` : "", "utf8");
  }
  return { file: filePath, records: records.length, dry_run: dryRun };
}

export function appendLearningRecord(input: JsonRecord = Object(), options: JsonRecord = Object()) {
  const paths = resolveLearningPaths(options);
  const record = createLearningRecord(input, options);
  if (options.dryRun === true || options.dry_run === true) {
    return { status: "ok", dry_run: true, file: paths.learningFile, record };
  }
  mkdirSync(dirname(paths.learningFile), { recursive: true });
  appendFileSync(paths.learningFile, `${JSON.stringify(record)}\n`, "utf8");
  return { status: "ok", dry_run: false, file: paths.learningFile, record };
}

function legacyKnowledgeRecords(paths: LearningPaths): LearningRecord[] {
  return readJsonl(paths.legacyKnowledgeFile)
    .filter(isLegacyEntry)
    .map((entry) => createLearningRecord({
      type: entry.type,
      lesson: entry.content,
      prevention: entry.strategy || entry.content,
      confidence: entry.confidence,
      status: entry.status === "active" ? "advisory" : "deprecated",
      source: "legacy_knowledge",
      legacy_source: rel(paths.projectRoot, paths.legacyKnowledgeFile),
      legacy_id: entry.id,
      task_id: entry.source_task,
      related_files: entry.related_files,
      evidence_refs: entry.related_files,
      ts: entry.last_used,
    }));
}

function legacyLessonRecords(paths: LearningPaths): LearningRecord[] {
  return readJsonl(paths.legacyLessonsFile)
    .filter(isLegacyEntry)
    .filter((entry) => entry.knowledge || entry.result === "FAIL" || entry.result === "PARTIAL")
    .map((entry) => createLearningRecord({
      type: entry.knowledge_type || "failure",
      lesson: entry.knowledge || `${entry.result || "UNKNOWN"} task outcome`,
      prevention: entry.knowledge || "Review similar gate failure before retrying.",
      confidence: entry.result === "FAIL" ? 6 : 5,
      status: "advisory",
      source: "legacy_lessons",
      legacy_source: rel(paths.projectRoot, paths.legacyLessonsFile),
      legacy_id: entry.task_id ? `${entry.task_id}:${entry.timestamp || ""}` : "",
      task_id: entry.task_id,
      gate: gateFromText(entry.knowledge || ""),
      ts: entry.timestamp,
      tags: [entry.result].filter(Boolean),
    }));
}

function legacyRedTeamRecords(paths: LearningPaths): LearningRecord[] {
  return readJsonl(paths.legacyRedTeamFile)
    .filter(isLegacyEntry)
    .map((entry) => createLearningRecord({
      type: "red_team",
      lesson: `${entry.attack_type || "red-team case"} was ${entry.blocked ? "blocked" : "not blocked"}`,
      prevention: entry.blocked
        ? `Keep deterministic protection for ${entry.attack_type || "this red-team case"}.`
        : `Add deterministic protection for ${entry.attack_type || "this red-team case"}.`,
      confidence: entry.blocked ? 7 : 8,
      status: entry.blocked ? "advisory" : "candidate",
      source: "legacy_red_team",
      legacy_source: rel(paths.projectRoot, paths.legacyRedTeamFile),
      legacy_id: entry.filename || entry.attack_type || "",
      filename: entry.filename,
      ts: entry.timestamp,
      tags: ["red_team", entry.blocked ? "blocked" : "unblocked"],
    }));
}

function learnedRuleRecords(paths: LearningPaths): LearningRecord[] {
  const rules = readJson(paths.learnedRulesFile, {}) as JsonRecord | null;
  return Object.entries(rules || {}).map(([key, entry]) => {
    const rule = isRecord(entry) ? entry : {};
    return createLearningRecord({
      type: "rule",
      lesson: rule.rule || key,
      prevention: rule.strategy || rule.rule || key,
      confidence: 7,
      status: "candidate",
      source: "learned_rules",
      legacy_source: rel(paths.projectRoot, paths.learnedRulesFile),
      legacy_id: key,
      gate: rule.gate || key,
      ts: rule.learned_at || rule.since,
      tags: ["learned_rule"],
    });
  });
}

export function collectLegacyLearningRecords(options: JsonRecord = Object()) {
  const paths = resolveLearningPaths(options);
  const sources = [
    { name: "legacy_knowledge", records: legacyKnowledgeRecords(paths) },
    { name: "legacy_lessons", records: legacyLessonRecords(paths) },
    { name: "legacy_red_team", records: legacyRedTeamRecords(paths) },
    { name: "learned_rules", records: learnedRuleRecords(paths) },
  ];
  return {
    paths,
    sources: Object.fromEntries(sources.map((source) => [source.name, source.records.length])),
    records: sources.flatMap((source) => source.records),
  };
}

export function migrateLegacyLearning(options: JsonRecord = Object()) {
  const paths = resolveLearningPaths(options);
  const current = readLearningRecords(paths.learningFile);
  const legacy = collectLegacyLearningRecords(paths);
  const merged = dedupeLearningRecords([...current, ...legacy.records]);
  const write = writeLearningRecords(paths.learningFile, merged, options);
  return {
    schema_version: LEARNING_CENTER_SCHEMA_VERSION,
    status: "ok",
    dry_run: options.dryRun === true || options.dry_run === true,
    learning_file: paths.learningFile,
    existing_count: current.length,
    legacy_candidate_count: legacy.records.length,
    total_count: merged.length,
    imported_count: Math.max(0, merged.length - current.length),
    sources: legacy.sources,
    write,
  };
}

export function summarizeLearningCenter(options: JsonRecord = Object()) {
  const paths = resolveLearningPaths(options);
  const records = readLearningRecords(paths.learningFile);
  const byType: Record<string, number> = Object();
  const byStatus: Record<string, number> = Object();
  const bySource: Record<string, number> = Object();
  const byGate: Record<string, number> = Object();
  const byRisk: Record<string, number> = Object();
  for (const record of records) {
    byType[record.type] = (byType[record.type] || 0) + 1;
    byStatus[record.status] = (byStatus[record.status] || 0) + 1;
    bySource[record.source] = (bySource[record.source] || 0) + 1;
    if (record.gate) byGate[record.gate] = (byGate[record.gate] || 0) + Number(record.occurrence_count || 1);
    for (const risk of record.fingerprint?.risk_patterns || []) {
      byRisk[risk] = (byRisk[risk] || 0) + Number(record.occurrence_count || 1);
    }
  }
  return {
    schema_version: LEARNING_CENTER_SCHEMA_VERSION,
    learning_file: paths.learningFile,
    record_count: records.length,
    by_type: byType,
    by_status: byStatus,
    by_source: bySource,
    top_gates: Object.entries(byGate).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 10),
    top_risks: Object.entries(byRisk).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 10),
    records,
  };
}

function taskText(task: JsonRecord = Object(), extraText = ""): string {
  const acceptance = asArray(task.acceptance_criteria)
    .map((item) => {
      if (typeof item === "string") return item;
      const record: JsonRecord = isRecord(item) ? item : Object();
      return String(record.description || record.message || "");
    })
    .join("\n");
  const conditions = [...asArray(task.pre_conditions), ...asArray(task.post_conditions)]
    .map((condition) => JSON.stringify(condition))
    .join("\n");
  return [
    task.id,
    task.type,
    task.title,
    task.description,
    acceptance,
    conditions,
    extraText,
  ].filter((value) => value !== undefined && value !== null && value !== false && value !== 0 && value !== "").map((value) => String(value)).join("\n");
}

function learningQueryFromTask(input: JsonRecord = Object()) {
  const task: JsonRecord = isRecord(input.task) ? input.task : {};
  const scope = isRecord(task.scope) ? task.scope : {};
  const targetFiles = unique([
    ...asArray(input.files || input.targetFiles || input.target_files),
    ...asArray(scope.targets).map((target) => String(isRecord(target) ? (target.file ?? "") : "")),
    ...asArray(scope.readonly_files),
  ]);
  const queryText = taskText(task, [input.lastGateError, input.failureText, input.gate].filter(Boolean).map(String).join("\n"));
  return {
    task_id: String(task.id || input.taskId || ""),
    task_type: String(task.type || input.taskType || input.task_type || ""),
    gate: String(input.gate || input.failedGate || input.failed_gate || "").trim(),
    files: targetFiles,
    directories: unique([
      ...asArray(input.directories),
      ...directoriesForFiles(targetFiles),
    ]),
    error_codes: unique([
      ...asArray(input.errorCodes || input.error_codes),
      ...extractErrorCodes(queryText),
    ]),
    risk_patterns: unique([
      ...asArray(input.riskPatterns || input.risk_patterns),
      ...extractRiskPatterns(queryText),
    ]),
    text: queryText,
  };
}

function intersects(a: string[] = [], b: string[] = []): string[] {
  const set = new Set(a.filter(Boolean));
  return b.filter(Boolean).filter((item) => set.has(item));
}

function relatedPathMatches(queryFiles: string[] = [], recordFiles: string[] = []): string[] {
  const matches: string[] = [];
  for (const queryFile of queryFiles) {
    for (const recordFile of recordFiles) {
      if (!queryFile || !recordFile) continue;
      if (queryFile === recordFile || queryFile.includes(recordFile) || recordFile.includes(queryFile)) {
        matches.push(queryFile);
      }
    }
  }
  return unique(matches);
}

function recordLearningFiles(record: LearningRecord = Object()): string[] {
  return unique([
    ...asArray(record.fingerprint?.files),
    ...asArray(record.evidence_refs),
  ]);
}

function scoreStatus(status = ""): number {
  if (status === "promoted") return 2;
  if (status === "candidate") return 1;
  if (status === "deprecated") return -4;
  return 0;
}

/** Structured query used to score and select learning records. */
interface LearningQuery {
  files?: string[];
  directories?: string[];
  error_codes?: string[];
  risk_patterns?: string[];
  gate?: string;
  task_type?: string;
  text?: string;
  task_id?: string;
  [key: string]: unknown;
}

export function scoreLearningRecord(record: LearningRecord = Object(), query: LearningQuery = learningQueryFromTask()): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (record.status === "deprecated") return { score: -10, reasons: ["deprecated"] };

  const recordFiles = recordLearningFiles(record);
  const fileMatches = relatedPathMatches(asArray(query.files), recordFiles);
  if (fileMatches.length) {
    score += 5;
    reasons.push(`file:${fileMatches.slice(0, 3).join(",")}`);
  }

  const directoryMatches = intersects(asArray(query.directories), asArray(record.fingerprint?.directories));
  if (directoryMatches.length) {
    score += 2;
    reasons.push(`dir:${directoryMatches.slice(0, 3).join(",")}`);
  }

  const recordGate = String(record.gate || "").trim();
  if (query.gate && recordGate) {
    if (query.gate === recordGate) {
      score += 6;
      reasons.push(`gate:${query.gate}`);
    } else if (recordGate.includes(query.gate) || query.gate.includes(recordGate)) {
      score += 4;
      reasons.push(`gate~:${recordGate}`);
    }
  }

  const errorMatches = intersects(asArray(query.error_codes), asArray(record.fingerprint?.error_codes));
  if (errorMatches.length) {
    score += Math.min(8, errorMatches.length * 4);
    reasons.push(`error:${errorMatches.slice(0, 4).join(",")}`);
  }

  const riskMatches = intersects(asArray(query.risk_patterns), asArray(record.fingerprint?.risk_patterns));
  if (riskMatches.length) {
    score += Math.min(6, riskMatches.length * 3);
    reasons.push(`risk:${riskMatches.slice(0, 4).join(",")}`);
  }

  if (query.task_type && record.fingerprint?.task_type && query.task_type === record.fingerprint.task_type) {
    score += 2;
    reasons.push(`task_type:${query.task_type}`);
  }

  score += scoreStatus(record.status);
  score += Math.min(2, Number(record.confidence || 0) / 5);
  score += Math.min(2, Math.max(0, Number(record.occurrence_count || 1) - 1) / 3);

  return { score: Number(score.toFixed(2)), reasons };
}

export function selectRelevantLearningRecords(records: LearningRecord[] = [], input: JsonRecord = Object(), options: JsonRecord = Object()) {
  const query: LearningQuery = input.files || input.task || input.gate || input.lastGateError
    ? learningQueryFromTask(input)
    : input;
  const limit = Number(options.limit || input.limit || 5);
  const minScore = Number(options.minScore || options.min_score || input.minScore || input.min_score || 3);
  return records
    .map((record) => ({ record, ...scoreLearningRecord(record, query) }))
    .filter((entry) => entry.score >= minScore && entry.reasons.length > 0)
    .sort((a, b) => b.score - a.score || Number(b.record.confidence || 0) - Number(a.record.confidence || 0))
    .slice(0, Math.max(0, limit));
}

export function retrieveRelevantLearningRecords(options: JsonRecord = Object()) {
  const paths = resolveLearningPaths(options);
  const records = readLearningRecords(paths.learningFile);
  const eligibleRecords = filterVerifiedSuccessLearningRecords(records, {
    ...options,
    projectRoot: paths.projectRoot,
    stateRoot: paths.stateRoot,
  });
  const selected = selectRelevantLearningRecords(eligibleRecords, options, options);
  return {
    schema_version: LEARNING_CENTER_SCHEMA_VERSION,
    status: "ok",
    learning_file: paths.learningFile,
    record_count: records.length,
    selected_count: selected.length,
    selected,
  };
}

function compactText(value: unknown = "", max = 220): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function buildExperiencePackText(options: JsonRecord = Object()): string {
  const result = retrieveRelevantLearningRecords(options);
  const maxChars = Number(options.maxChars || options.max_chars || 1800);
  if (!result.selected.length) return "";
  const lines = [
    "## Relevant Experience Pack (advisory, non-blocking)",
    "",
    "Use these lessons to avoid repeated mistakes. Do not expand scope, bypass PRD constraints, or treat advisory lessons as gates.",
    "",
  ];
  for (const item of result.selected) {
    const record = item.record;
    lines.push(
      `- ${record.id} | score ${item.score} | ${record.type}/${record.status} | matches: ${item.reasons.join("; ")}`,
      `  - Lesson: ${compactText(record.lesson) || "n/a"}`,
      `  - Prevention: ${compactText(record.prevention) || "n/a"}`,
    );
  }
  return lines.join("\n").slice(0, maxChars).trim();
}

function countLines(title: string, items: [string, number][]): string[] {
  if (!items.length) return [`- ${title}: none`];
  return [`- ${title}:`, ...items.map(([name, count]) => `  - ${name}: ${count}`)];
}

function isLocalLegacySource(record: LearningRecord = Object()): boolean {
  const source = String(record.source || "");
  return source.startsWith("legacy_") || source === "learned_rules";
}

function summarizeRecords(records: LearningRecord[] = []) {
  const byType: Record<string, number> = Object();
  const byStatus: Record<string, number> = Object();
  const bySource: Record<string, number> = Object();
  const byGate: Record<string, number> = Object();
  const byRisk: Record<string, number> = Object();
  for (const record of records) {
    byType[record.type] = (byType[record.type] || 0) + 1;
    byStatus[record.status] = (byStatus[record.status] || 0) + 1;
    bySource[record.source] = (bySource[record.source] || 0) + 1;
    if (record.gate) byGate[record.gate] = (byGate[record.gate] || 0) + Number(record.occurrence_count || 1);
    for (const risk of record.fingerprint?.risk_patterns || []) {
      byRisk[risk] = (byRisk[risk] || 0) + Number(record.occurrence_count || 1);
    }
  }
  return {
    by_type: byType,
    by_status: byStatus,
    by_source: bySource,
    top_gates: Object.entries(byGate).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 10),
    top_risks: Object.entries(byRisk).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 10),
  };
}

/** Formats an optional `now` option for markdown headers: uses toISOString when the
 *  value is date-like, otherwise the current time. Mirrors the original optional-chain behavior. */
function optionNow(options: JsonRecord): string {
  const now = options.now;
  if (now && typeof now === "object" && typeof (now as { toISOString?: unknown }).toISOString === "function") {
    return (now as Date).toISOString();
  }
  return new Date().toISOString();
}

export function buildLearningIndexMarkdown(options: JsonRecord = Object()): string {
  const paths = resolveLearningPaths(options);
  const summary = summarizeLearningCenter(paths);
  const publicSafeMode = options.publicSafeMode ?? options.public_safe_mode ?? paths.packageMode;
  const displayRecords = publicSafeMode
    ? summary.records.filter((record) => !isLocalLegacySource(record))
    : summary.records;
  const displaySummary = summarizeRecords(displayRecords);
  const suppressed = summary.records.length - displayRecords.length;
  return [
    "# YOLO Learning Index",
    "",
    `> Generated: ${optionNow(options)}`,
    "",
    "This file summarizes the machine-readable learning ledger. The ledger is model-agnostic: providers receive only short, relevant experience packs derived from these records.",
    "",
    "## Ledger",
    "",
    `- Learning file: \`${rel(paths.projectRoot, paths.learningFile) || "state/learning.jsonl"}\``,
    `- Records: ${summary.record_count}`,
    publicSafeMode ? `- Package-local legacy details suppressed from public docs: ${suppressed}` : null,
    "",
    "## Counts",
    "",
    ...(Object.keys(displaySummary.by_type).length
      ? Object.entries(displaySummary.by_type).sort().map(([type, count]) => `- ${type}: ${count}`)
      : ["- none"]),
    "",
    "## Status",
    "",
    ...(Object.keys(displaySummary.by_status).length
      ? Object.entries(displaySummary.by_status).sort().map(([status, count]) => `- ${status}: ${count}`)
      : ["- none"]),
    "",
    "## Top Gates",
    "",
    ...countLines("gate fingerprints", displaySummary.top_gates),
    "",
    "## Top Risk Patterns",
    "",
    ...countLines("risk fingerprints", displaySummary.top_risks),
    "",
  ].filter((line) => line !== null).join("\n");
}

export function buildLessonsPlaybookMarkdown(options: JsonRecord = Object()): string {
  const paths = resolveLearningPaths(options);
  const summary = summarizeLearningCenter(paths);
  const publicSafeMode = options.publicSafeMode ?? options.public_safe_mode ?? paths.packageMode;
  const records = summary.records
    .filter((record) => !publicSafeMode || !isLocalLegacySource(record))
    .filter((record) => record.lesson)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, Number(options.maxLessons) || 40);
  const lines = [
    "# YOLO Lessons Playbook",
    "",
    `> Generated: ${optionNow(options)}`,
    "",
    "Use these lessons as advisory context first. Only promoted, machine-verifiable lessons should become blocking gates.",
    "",
  ];
  if (publicSafeMode) {
    lines.push(
      "Package-mode playbooks do not print detailed legacy project lessons. Local legacy lessons stay in `state/learning.jsonl` and can be migrated into project-specific playbooks after installation.",
      "",
    );
  }
  if (!records.length) {
    lines.push("_No learning records yet._", "");
    return lines.join("\n");
  }
  for (const record of records) {
    lines.push(
      `## ${record.id}`,
      "",
      `- Status: ${record.status}`,
      `- Type: ${record.type}`,
      `- Confidence: ${record.confidence}/10`,
      `- Gate: ${record.gate || "n/a"}`,
      `- Lesson: ${record.lesson}`,
      `- Prevention: ${record.prevention || "n/a"}`,
      `- Evidence: ${(record.evidence_refs || []).join(", ") || "n/a"}`,
      "",
    );
  }
  return lines.join("\n");
}
