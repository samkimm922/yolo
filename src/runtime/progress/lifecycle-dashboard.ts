import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const EMPTY_STAGE_COUNTS = { total: 0, pending: 0, active: 0, completed: 0, blocked: 0, warning: 0 };

function clean(value) {
  return String(value ?? "").trim();
}

function normalizePath(root, path) {
  const rel = relative(root, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll("\\", "/") : path;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function stateRootCandidates(options = Object()) {
  if (options.stateRoot || options.state_root) return [resolve(options.stateRoot || options.state_root)];
  const roots = unique([
    ...asArray(options.stateRoots || options.state_roots),
    ...asArray(options.stateRootCandidates || options.state_root_candidates),
  ].map((root) => resolve(String(root)))).map(String);
  const projectRoots = unique([
    ...asArray(options.projectRoots || options.project_roots),
    options.projectRoot || options.project_root || options.cwd || process.cwd(),
  ].map((root) => resolve(String(root)))).map(String);
  const yoloRoots = unique([
    ...asArray(options.yoloRoots || options.yolo_roots),
    options.yoloRoot || options.yolo_root || options.packageRoot || options.package_root,
  ].filter(Boolean).map((root) => resolve(String(root)))).map(String);
  return unique([
    ...roots,
    ...projectRoots.map((root) => join(root, ".yolo")),
    ...yoloRoots.map((root) => join(root, ".yolo")),
    ...yoloRoots,
  ]);
}

function stateRoot(options = Object()) {
  const candidates = stateRootCandidates(options).map(String);
  return candidates.find((root) => existsSync(join(root, "lifecycle", "status.json"))) || candidates[0];
}

function readJson(path) {
  try {
    return parseJson(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function countStages(stages = []) {
  const counts = { ...EMPTY_STAGE_COUNTS };
  for (const stage of stages) {
    // Tolerate null/non-object entries from corrupted status.json (same guard
    // pattern as lifecycle/guard.ts:730-731 and lifecycle/progress.ts:197).
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) continue;
    const status = clean(stage.status).toLowerCase() || "pending";
    counts.total += 1;
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function reportStatus(report = Object()) { return clean(report.status || report.verdict || report.outcome).toLowerCase() || "unknown"; }

function reportStageId(report = Object()) {
  return typeof report.stage === "object" && report.stage ? clean(report.stage.id) : clean(report.stage_id || report.stageId || report.stage);
}

function reportBlockers(report = Object()) {
  // Tolerate null/non-object entries from corrupted/hand-edited stage reports
  // (same guard pattern as countStages above and lifecycle/guard.ts:730-731).
  // Without this, a single null in report.issues / report.checks / report.blockers
  // crashes the dashboard read path with TypeError on .status / .code access.
  const isBlockerEntry = (item) => typeof item === "string" || (item && typeof item === "object" && !Array.isArray(item));
  const blocked = (items) => (Array.isArray(items) ? items.filter((item) => isBlockerEntry(item) && item.status === "blocked") : []);
  const raw = [
    ...(Array.isArray(report.blockers) ? report.blockers : []),
    ...(Array.isArray(report.blocked_reasons) ? report.blocked_reasons : []),
    ...blocked(report.issues),
    ...blocked(report.checks),
  ].filter(isBlockerEntry);
  return raw.map((item) =>
    typeof item === "string"
      ? { code: "BLOCKER", message: item }
      : {
      code: item.code || item.id || item.name || "BLOCKER",
      message: item.message || item.detail || item.summary || item.reason || "",
      source: item.source || item.gate || item.stage || null,
      task_id: item.task_id || item.taskId || null,
    },
  );
}

function reportEvidence(report = Object()) {
  return [
    ...(Array.isArray(report.evidence) ? report.evidence : []),
    ...(Array.isArray(report.artifacts) ? report.artifacts.map((path) => ({ path })) : []),
    report.report_json ? { path: report.report_json, type: "report_json" } : null,
    report.report_markdown ? { path: report.report_markdown, type: "report_markdown" } : null,
  ].filter(Boolean);
}

function reportTimestamp(report = Object(), filePath = "") {
  return clean(report.updated_at || report.completed_at || report.created_at || report.timestamp) || statSync(filePath).mtime.toISOString();
}

function isStageReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return false;
  const schema = clean(report.schema || report.type || report.kind).toLowerCase();
  if (schema.includes("lifecycle.artifact")) return false;
  if (schema.includes("stage_report")) return true;
  return Boolean(reportStageId(report) && (report.status || report.verdict || report.outcome));
}

function readReports(root) {
  return [join(root, "state"), join(root, "lifecycle")]
    .flatMap(walk)
    .filter((path) => path.endsWith(".json") && !path.endsWith("/status.json"))
    .map((path) => ({ path, report: readJson(path) }))
    .filter(({ report }) => isStageReport(report))
    .map(({ path, report }) => ({
      path: normalizePath(root, path),
      stage_id: reportStageId(report),
      status: reportStatus(report),
      updated_at: reportTimestamp(report, path),
      blockers: reportBlockers(report),
      evidence: reportEvidence(report),
    }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

function readEvents(root, limit) {
  return walk(join(root, "state"))
    .filter((path) => path.endsWith(".jsonl"))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ path, event: parseJson(line) }))
        .filter(({ event }) => event && typeof event === "object" && !Array.isArray(event)),
    )
    .map(({ path, event }) => Object.assign(Object(), event, { path: normalizePath(root, path) }))
    .sort((a, b) => clean(b.created_at || b.timestamp || b.ts).localeCompare(clean(a.created_at || a.timestamp || a.ts)))
    .slice(0, limit);
}

export function readLifecycleDashboard(options = Object()) {
  const root = stateRoot(options);
  const statusPath = join(root, "lifecycle", "status.json");
  const reportLimit = Number(options.reportLimit || options.report_limit || 5);
  const eventLimit = Number(options.eventLimit || options.event_limit || 10);
  if (!existsSync(statusPath)) {
    return { exists: false, state_root: root, current_stage: null, stage_counts: { ...EMPTY_STAGE_COUNTS }, blocker_count: 0, evidence_count: 0, latest_reports: [], recent_events: [], next_action: "Run yolo-init to initialize lifecycle state." };
  }

  const status = readJson(statusPath) || {};
  const stageCounts = countStages(Array.isArray(status.stages) ? status.stages : []);
  const reports = readReports(root);
  const latestReports = reports.slice(0, reportLimit);
  const blockerCount = reports.reduce((sum, report) => sum + report.blockers.length, 0);
  const evidenceCount = reports.reduce((sum, report) => sum + report.evidence.length, 0);
  return { exists: true, state_root: root, status_path: normalizePath(root, statusPath), current_stage: clean(status.current_stage) || null, stage_counts: stageCounts, blocker_count: Math.max(blockerCount, stageCounts.blocked || 0), evidence_count: evidenceCount, latest_reports: latestReports, recent_events: readEvents(root, eventLimit), next_action: blockerCount || stageCounts.blocked ? "Resolve blocked lifecycle items." : "Continue lifecycle work." };
}
