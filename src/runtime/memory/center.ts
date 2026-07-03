import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLearningIndexMarkdown,
  buildLessonsPlaybookMarkdown,
  migrateLegacyLearning,
  summarizeLearningCenter,
} from "../learning/center.js";
import { applyMemoryRetention } from "./retention.js";

export const MEMORY_CENTER_SCHEMA_VERSION = "1.0";

type MemoryRecord = Record<string, unknown>;

type MemoryPaths = {
  projectRoot: string;
  stateRoot: string;
  stateDir: string;
  memoryDir: string;
  packageMode: boolean;
};

type MemoryDocClassification = {
  category: string;
  action: string;
  reason: string;
  stale?: boolean;
};

type DiscoveredMemoryDocument = MemoryDocClassification & {
  path: string;
  bytes: number;
  mtime_ms: number;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_YOLO_ROOT = resolve(__dirname, "../../..");
const EXCLUDED_DIRS = new Set([".git", "node_modules"]);
const TREE_EXCLUDED_DIRS = new Set([".git", "node_modules"]);
const MEMORY_DOCS = [
  "MEMORY_INDEX.md",
  "CURRENT_STATUS.md",
  "CURRENT_HANDOFF.md",
  "PROJECT_BRIEF.md",
  "PROGRESS.md",
  "OPEN_QUESTIONS.md",
  "DECISION_LOG.md",
  "DOCUMENT_GOVERNANCE.md",
  "LEARNING_INDEX.md",
  "LESSONS_PLAYBOOK.md",
  "PROJECT_TREE.md",
  "MEMORY_AUDIT.md",
];

const STAGE_COMMANDS = {
  idea: "/yolo-brainstorm, /yolo-interview, or /yolo-discuss",
  discovery: "/yolo-interview, /yolo-discuss, or /yolo-discover",
  setup: "/yolo-init or /yolo-doctor",
  roadmap: "/yolo-plan",
  prd: "/yolo-prd",
  check: "/yolo-check",
  run: "/yolo-run",
  "review-fix": "/yolo-review",
  acceptance: "/yolo-accept",
  delivery: "/yolo-ship",
  learn: "/yolo-learn",
};

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function rel(root: string, file: string): string {
  return toPosix(relative(root, file));
}

function displayPath(root: string, file: string): string {
  const relativePath = rel(root, file);
  if (relativePath === "") return ".";
  return relativePath && !relativePath.startsWith("..") ? relativePath : file;
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stateRelativePath(relativePath: string): string {
  const path = toPosix(relativePath);
  return path.startsWith(".yolo/") ? path.slice(".yolo/".length) : path;
}

function readText(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readJson<T = unknown>(filePath: string, fallback: T = null as T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function readJsonlTail(filePath: string, limit = 3): MemoryRecord[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line): MemoryRecord => {
      try {
        return JSON.parse(line) as MemoryRecord;
      } catch {
        return { raw: line };
      }
    });
}

function isYoloPackageRoot(projectRoot: string): boolean {
  const pkg = readJson<MemoryRecord>(join(projectRoot, "package.json"), {});
  return pkg?.name === "yolo" && existsSync(join(projectRoot, "src/runtime"));
}

type WalkFilesOptions = {
  includeHidden?: boolean;
  includeArchive?: boolean;
  maxFiles?: number;
};

export function resolveMemoryPaths(options: MemoryRecord = Object()): MemoryPaths {
  const projectRoot = resolve(String(options.projectRoot || options.yoloRoot || options.cwd || process.cwd()));
  const rawPackageMode = options.packageMode;
  const packageMode = rawPackageMode == null ? isYoloPackageRoot(projectRoot) : Boolean(rawPackageMode);
  const stateRoot = resolve(String(options.stateRoot || options.state_root || (packageMode ? projectRoot : join(projectRoot, ".yolo"))));
  const stateDir = resolve(String(options.stateDir || options.state_dir || join(stateRoot, "state")));
  const memoryDir = resolve(String(options.memoryDir || options.memory_dir || (packageMode ? join(projectRoot, "docs/memory") : join(stateRoot, "memory"))));
  return {
    projectRoot,
    stateRoot,
    stateDir,
    memoryDir,
    packageMode,
  };
}

function walkFiles(root: string, options: WalkFilesOptions = Object()): string[] {
  const files: string[] = [];
  const includeHidden = options.includeHidden !== false;
  const includeArchive = options.includeArchive === true;
  const maxFiles = options.maxFiles || 5000;

  function visit(dir: string): void {
    if (files.length >= maxFiles || !existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => includeHidden || !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = join(dir, entry.name);
      const relativePath = rel(root, full);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (!includeArchive && relativePath === "state/archive") continue;
        visit(full);
      } else {
        files.push(full);
      }
    }
  }

  visit(root);
  return files;
}

type JsonlSummary = {
  exists: boolean;
  line_count: number;
  parsed_count: number;
  invalid_count: number;
  latest_ts: string | null;
};

function readJsonlSummary(filePath: string): JsonlSummary {
  if (!existsSync(filePath)) {
    return { exists: false, line_count: 0, parsed_count: 0, invalid_count: 0, latest_ts: null };
  }
  const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  let parsedCount = 0;
  let invalidCount = 0;
  let latestTs: string | null = null;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as MemoryRecord;
      parsedCount += 1;
      const ts = parsed.ts || parsed.logged_at || parsed.finished_at || parsed.started_at;
      if (ts && (!latestTs || String(ts) > latestTs)) latestTs = String(ts);
    } catch {
      invalidCount += 1;
    }
  }
  return {
    exists: true,
    line_count: lines.length,
    parsed_count: parsedCount,
    invalid_count: invalidCount,
    latest_ts: latestTs,
  };
}

function classifyMemoryDocument(relativePath: string, content = ""): MemoryDocClassification {
  const path = toPosix(relativePath);
  const statePath = stateRelativePath(path);
  const name = path.split("/").at(-1) || path;
  const isMd = path.endsWith(".md");
  const isJsonl = path.endsWith(".jsonl");

  if (path.startsWith("docs/memory/") || path.startsWith(".yolo/memory/")) {
    return {
      category: "canonical_memory_doc",
      action: "keep_refresh",
      reason: "Canonical human-readable memory center document.",
    };
  }
  if (statePath.startsWith("state/archive/jsonl/") && isJsonl) {
    return {
      category: "archived_memory_ledger",
      action: "keep_archive_only",
      reason: "Archived overflow from active memory ledgers; keep for audit and recovery, not active context.",
    };
  }
  if (statePath.startsWith("state/archive/")) {
    return {
      category: "archive_snapshot",
      action: "keep_archive_only",
      reason: "Historical generated-doc snapshot; useful for forensics, not active truth.",
    };
  }
  if (path.startsWith("closed-loop/") && isJsonl) {
    return {
      category: "legacy_learning_source",
      action: "keep_legacy_readonly",
      reason: "v1 learning source; memory refresh migrates it into state/learning.jsonl, preserve read-only until deletion policy is approved.",
    };
  }
  if (path.startsWith("tmp/")) {
    return {
      category: "scratch_doc",
      action: "deletion_candidate",
      reason: "Scratch analysis output; keep only if a human still needs this local note.",
    };
  }
  if (statePath === "state/learning.jsonl") {
    return {
      category: "active_learning_ledger",
      action: "keep_active",
      reason: "Unified learning compound-interest ledger for lessons, rules, pitfalls, and recoveries.",
    };
  }
  if (["state/changes.jsonl", "state/events.jsonl", "state/runs.jsonl", "state/review-log.jsonl"].includes(statePath)) {
    return {
      category: "active_append_only_ledger",
      action: "keep_active",
      reason: "Active append-only runtime memory ledger.",
    };
  }
  if (statePath === "state/session-memory.jsonl") {
    return {
      category: "active_session_memory",
      action: "keep_active",
      reason: "Runner checkpoint/session memory ledger.",
    };
  }
  if (statePath.startsWith("state/runtime/") && isJsonl) {
    return {
      category: "active_runtime_ledger",
      action: "keep_active",
      reason: "Runtime task audit/result ledger used for recovery and review.",
    };
  }
  if (["PROJECT_TREE.md", "SYSTEM_STATE.md", "ROADMAP.md", "docs/PROJECT_TREE.md", "docs/SYSTEM_STATE.md", "docs/ROADMAP.md"].includes(path)) {
    const stale = path.includes("PROJECT_TREE")
      ? !/Canonical memory dir/.test(content)
      : path.includes("SYSTEM_STATE")
        ? !/^# YOLO Memory Current Status/m.test(content)
        : !/docs\/yolo-public-sdk-progress\.md/.test(content);
    return {
      category: "compatibility_memory_mirror",
      action: "keep_as_pointer",
      reason: stale
        ? "Legacy generated doc is stale; refresh it as a pointer or mirror to docs/memory."
        : "Compatibility location; canonical truth lives in docs/memory.",
      stale,
    };
  }
  if (["CHANGELOG.md", "docs/CHANGELOG.md"].includes(path)) {
    return {
      category: "active_changelog",
      action: "keep_active",
      reason: "Human release/change summary; append memory-system milestones here.",
    };
  }
  if (["docs/yolo-public-sdk-progress.md", "docs/sdk-gap-matrix.md"].includes(path)) {
    return {
      category: "active_roadmap",
      action: "keep_active",
      reason: "Current public SDK roadmap/progress truth.",
    };
  }
  if (path.startsWith(".agents/") || path.startsWith(".claude/") || path.startsWith(".codex/")) {
    return {
      category: "local_agent_artifact",
      action: "keep_local_only",
      reason: "Local generated agent integration artifact; not canonical repo memory.",
    };
  }
  if (isMd) {
    return {
      category: "reference_doc",
      action: "keep_reference",
      reason: "Project reference document; not an append-only memory ledger.",
    };
  }
  return {
    category: "other_jsonl",
    action: isJsonl ? "review_before_delete" : "ignore",
    reason: isJsonl ? "JSONL file outside known ledgers; keep until a migration policy classifies it." : "Not a memory document.",
  };
}

export function discoverMemoryDocuments(options: MemoryRecord = Object()) {
  const paths = resolveMemoryPaths(options);
  const files: DiscoveredMemoryDocument[] = walkFiles(paths.projectRoot, { includeArchive: true, includeHidden: true })
    .filter((file) => file.endsWith(".md") || file.endsWith(".jsonl"))
    .map((file): DiscoveredMemoryDocument => {
      const relativePath = rel(paths.projectRoot, file);
      const content = file.endsWith(".md") ? readText(file) : "";
      const stat = statSync(file);
      return {
        path: relativePath,
        bytes: stat.size,
        mtime_ms: stat.mtimeMs,
        ...classifyMemoryDocument(relativePath, content),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    schema_version: MEMORY_CENTER_SCHEMA_VERSION,
    project_root: paths.projectRoot,
    state_root: paths.stateRoot,
    memory_dir: paths.memoryDir,
    documents: files,
  };
}

export function buildMemoryAudit(options: MemoryRecord = Object()) {
  const discovered = discoverMemoryDocuments(options);
  const byAction: Record<string, number> = Object();
  for (const doc of discovered.documents) {
    byAction[doc.action] = (byAction[doc.action] || 0) + 1;
  }
  const deletionCandidates = discovered.documents.filter((doc) => doc.action === "deletion_candidate");
  const staleMirrors = discovered.documents.filter((doc) => doc.stale === true);
  return {
    ...discovered,
    summary: {
      document_count: discovered.documents.length,
      by_action: byAction,
      deletion_candidate_count: deletionCandidates.length,
      stale_mirror_count: staleMirrors.length,
    },
    deletion_candidates: deletionCandidates,
    stale_mirrors: staleMirrors,
  };
}

type ListTreeFilesOptions = { maxFiles?: number };

function listTreeFiles(root: string, options: ListTreeFilesOptions = Object()): string[] {
  const maxFiles = options.maxFiles || 800;
  const files: string[] = [];

  function visit(dir: string): void {
    if (files.length >= maxFiles || !existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") || entry.name === ".yolo")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = join(dir, entry.name);
      const relativePath = rel(root, full);
      if (entry.isDirectory()) {
        if (TREE_EXCLUDED_DIRS.has(entry.name)) continue;
        if (relativePath === "state/archive" || relativePath === ".yolo/state/archive") {
          files.push(`${relativePath}/`);
          continue;
        }
        if (relativePath === ".yolo/state" || relativePath === "state/runtime/task-logs") {
          files.push(`${relativePath}/`);
          continue;
        }
        visit(full);
      } else {
        files.push(relativePath);
      }
    }
  }

  visit(root);
  return files;
}

function treeLines(paths: string[]): string[] {
  const lines: string[] = [];
  for (const path of paths) {
    const depth = path.split("/").length - 1;
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- ${path}`);
  }
  return lines;
}

function countFiles(projectRoot: string, predicate: (relativePath: string) => boolean): number {
  return walkFiles(projectRoot, { includeArchive: false, includeHidden: false })
    .filter((file) => predicate(rel(projectRoot, file)))
    .length;
}

function sourceCounts(projectRoot: string) {
  const packageJson = readJson<MemoryRecord>(join(projectRoot, "package.json"), {});
  const rootFiles = existsSync(projectRoot)
    ? readdirSync(projectRoot).filter((file) => statSync(join(projectRoot, file)).isFile()).sort()
    : [];
  return {
    package_name: packageJson.name || null,
    package_version: packageJson.version || null,
    package_private: packageJson.private === true,
    package_exports: Object.keys(packageJson.exports || {}).length,
    package_bins: Object.keys(packageJson.bin || {}).length,
    root_js: rootFiles.filter((file) => file.endsWith(".js")).length,
    root_ts: rootFiles.filter((file) => file.endsWith(".ts")).length,
    root_mjs: rootFiles.filter((file) => file.endsWith(".js")).length,
    root_mjs_files: rootFiles.filter((file) => file.endsWith(".js")),
    src_ts: countFiles(projectRoot, (path) => path.startsWith("src/") && path.endsWith(".ts")),
    src_mjs: countFiles(projectRoot, (path) => path.startsWith("src/") && path.endsWith(".js")),
    test_files: countFiles(projectRoot, (path) => path.startsWith("__tests__/") && path.endsWith(".test.ts")),
    docs_md: countFiles(projectRoot, (path) => path.startsWith("docs/") && !path.startsWith("docs/memory/") && path.endsWith(".md")),
  };
}

function ledgerSummaries(stateDir: string): Record<string, JsonlSummary> {
  const ledgers = [
    "changes.jsonl",
    "events.jsonl",
    "runs.jsonl",
    "review-log.jsonl",
    "learning.jsonl",
    "session-memory.jsonl",
    "runtime/task-audit.jsonl",
    "runtime/task-results.jsonl",
  ];
  return Object.fromEntries(ledgers.map((name) => [name, readJsonlSummary(join(stateDir, name))]));
}

type LifecycleStage = MemoryRecord & { id?: string; status?: string; label?: string };

function lifecycleSummary(paths: MemoryPaths) {
  const statusPath = join(paths.stateRoot, "lifecycle", "status.json");
  const status = readJson<MemoryRecord | null>(statusPath, null);
  if (!status) {
    return {
      exists: false,
      status_path: statusPath,
      current_stage: null,
      active_stage: null,
      blocked_stages: [] as LifecycleStage[],
      completed_count: 0,
      next_action: "Run /yolo-init to create project memory, lifecycle, and specs.",
    };
  }

  const stages: LifecycleStage[] = Array.isArray(status.stages)
    ? status.stages.filter((entry): entry is LifecycleStage => entry && typeof entry === "object" && !Array.isArray(entry))
    : [];
  const current = stages.find((stage) => stage.id === status.current_stage) || null;
  const blocked = stages.filter((stage) => stage.status === "blocked");
  return {
    exists: true,
    status_path: statusPath,
    current_stage: status.current_stage || null,
    active_stage: current,
    blocked_stages: blocked,
    completed_count: stages.filter((stage) => stage.status === "completed").length,
    next_action: blocked.length
      ? `Resolve blocked lifecycle stage(s): ${blocked.map((stage) => stage.id).join(", ")}.`
      : `Continue with ${STAGE_COMMANDS[status.current_stage as keyof typeof STAGE_COMMANDS] || "/yolo-doctor"}.`,
  };
}

function latestLifecycleReports(paths: MemoryPaths, limit = 3) {
  const dir = join(paths.stateRoot, "lifecycle");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "status.json")
    .map((name): MemoryRecord | null => {
      const file = join(dir, name);
      const report = readJson<MemoryRecord | null>(file, null);
      if (!report) return null;
      const nestedReport = report.report as MemoryRecord | undefined;
      const stage = report.stage as MemoryRecord | undefined;
      return {
        path: rel(paths.projectRoot, file),
        stage: stage?.id || name.replace(/\.json$/, ""),
        status: report.status || "unknown",
        summary: nestedReport?.summary || report.summary || "",
        updated_at: report.updated_at || report.created_at || "",
        mtime: statSync(file).mtimeMs,
      };
    })
    .filter((report): report is MemoryRecord => report !== null)
    .sort((a, b) => (b.mtime as number) - (a.mtime as number))
    .slice(0, limit);
}

function latestDemandSession(paths: MemoryPaths) {
  const demandDir = join(paths.stateRoot, "demand");
  if (!existsSync(demandDir)) return null;
  const candidates: MemoryRecord[] = [];
  for (const entry of readdirSync(demandDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(demandDir, entry.name, "session.json");
    const session = readJson<MemoryRecord | null>(file, null);
    if (!session) continue;
    const readiness = session.readiness as MemoryRecord | undefined;
    candidates.push({
      path: rel(paths.projectRoot, file),
      id: session.id || entry.name,
      phase: session.phase || "unknown",
      readiness_level: readiness?.readiness_level || "unknown",
      readiness_status: readiness?.status || "unknown",
      quality_score: readiness?.quality_score ?? null,
      blocker_count: Array.isArray(readiness?.blockers) ? readiness.blockers.length : 0,
      next_actions: Array.isArray(readiness?.next_actions) ? readiness.next_actions : [],
      mtime: statSync(file).mtimeMs,
    });
  }
  candidates.sort((a, b) => (b.mtime as number) - (a.mtime as number));
  return candidates[0] || null;
}

function projectBrainSummary(paths: MemoryPaths) {
  const lifecycle = lifecycleSummary(paths);
  const latestDemand = latestDemandSession(paths);
  const latestReports = latestLifecycleReports(paths);
  const sessionTail = readJsonlTail(join(paths.stateDir, "session-memory.jsonl"), 3);
  return {
    lifecycle,
    latest_demand: latestDemand,
    latest_reports: latestReports,
    session_tail: sessionTail,
    next_action: nextActionOr(latestDemand?.next_actions, lifecycle.next_action),
  };
}

function nextActionOr(nextActions: unknown, fallback: string): string {
  if (!Array.isArray(nextActions) || nextActions.length === 0) return fallback;
  const first = nextActions[0];
  return first != null && String(first) !== "" ? String(first) : fallback;
}

function compactSessionMemoryLine(entry: MemoryRecord = Object()): string {
  const summary = entry.summary || entry.message || entry.event || entry.raw || "";
  const source = entry.source || entry.type || "session";
  const ts = entry.ts || entry.logged_at || entry.created_at || "";
  return `- ${ts ? `${ts} ` : ""}${source}: ${String(summary).slice(0, 160) || "recorded checkpoint"}`;
}

function archiveSummary(stateDir: string) {
  const archiveDir = join(stateDir, "archive");
  const jsonlDir = join(archiveDir, "jsonl");
  const generatedSnapshots = existsSync(archiveDir)
    ? readdirSync(archiveDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^(CHANGELOG|PROJECT_TREE|SYSTEM_STATE)_/.test(entry.name) && entry.name.endsWith(".md"))
      .length
    : 0;
  const archivedJsonl = walkFiles(jsonlDir, { includeArchive: true, includeHidden: false, maxFiles: 5000 })
    .filter((file) => file.endsWith(".jsonl"))
    .length;
  return { archive_dir: archiveDir, jsonl_archive_dir: jsonlDir, generated_snapshots: generatedSnapshots, archived_jsonl_files: archivedJsonl };
}

function latestValidationText(projectRoot: string): string {
  const progress = readText(join(projectRoot, "docs/yolo-public-sdk-progress.md"));
  const matches = [...progress.matchAll(/(\d+\s+tests\s+\/\s+\d+\s+suites\s+\/\s+0\s+fail)/g)];
  return matches.length ? (matches.at(-1)?.[1] ?? "not recorded").replace(/\s+/g, " ") : "not recorded";
}

export function buildProjectTreeMarkdown(options = Object()) {
  const paths = resolveMemoryPaths(options);
  const counts = sourceCounts(paths.projectRoot);
  const ledgers = ledgerSummaries(paths.stateDir);
  const entries = listTreeFiles(paths.projectRoot, { maxFiles: options.maxTreeFiles || 800 });
  const omitted = walkFiles(paths.projectRoot, { includeArchive: false, includeHidden: false }).length > entries.length;
  return [
    "# YOLO Memory Project Tree",
    "",
    `> Generated: ${options.now?.toISOString?.() || new Date().toISOString()}`,
    `> Canonical memory dir: \`${rel(paths.projectRoot, paths.memoryDir) || "."}\``,
    "",
    "## Snapshot",
    "",
    `- package: ${counts.package_name || "unknown"} ${counts.package_version || ""}`.trim(),
    `- package private: ${counts.package_private}`,
    `- package exports: ${counts.package_exports}`,
    `- package bins: ${counts.package_bins}`,
    `- root .js files: ${counts.root_js} (${counts.root_mjs_files.join(", ") || "none"})`,
    `- root .ts files: ${counts.root_ts}`,
    `- src .ts files: ${counts.src_ts}`,
    `- test files: ${counts.test_files}`,
    `- docs markdown files: ${counts.docs_md}`,
    "",
    "## Active Ledgers",
    "",
    ...Object.entries(ledgers).map(([name, summary]) =>
      `- \`${name}\`: ${summary.exists ? `${summary.line_count} lines, latest ${summary.latest_ts || "n/a"}` : "missing"}`
    ),
    "",
    "## Tree",
    "",
    "```text",
    rel(paths.projectRoot, paths.projectRoot) || ".",
    ...treeLines(entries),
    omitted ? "... output capped; rerun with a higher maxTreeFiles for a full tree." : "",
    "```",
    "",
  ].filter((line) => line !== null).join("\n");
}

export function buildCurrentStatusMarkdown(options = Object()) {
  const paths = resolveMemoryPaths(options);
  const counts = sourceCounts(paths.projectRoot);
  const ledgers = ledgerSummaries(paths.stateDir);
  const audit = buildMemoryAudit(paths);
  const archives = archiveSummary(paths.stateDir);
  const learning = summarizeLearningCenter(paths);
  const brain = projectBrainSummary(paths);
  const currentTruth = paths.packageMode ? [
    "## Current Truth",
    "",
    `- Public package state: ${counts.package_private ? "`private: true` blocks release" : "public package metadata is not private"}.`,
    `- Version: ${counts.package_version || "unknown"}.`,
    `- Latest recorded full validation: ${latestValidationText(paths.projectRoot)}.`,
    `- Root .js budget: ${counts.root_js} files.`,
    `- SDK surface: ${counts.package_exports} package exports and ${counts.package_bins} bins.`,
    `- Source/test/docs surface: ${counts.src_ts} src modules, ${counts.test_files} test files, ${counts.docs_md} docs markdown files, ${counts.root_ts} root .ts files.`,
    "",
  ] : [
    "## Project Brain",
    "",
    `- Current lifecycle stage: ${brain.lifecycle.exists ? `\`${brain.lifecycle.current_stage}\` (${brain.lifecycle.active_stage?.label || "unknown"})` : "not initialized"}.`,
    `- Completed lifecycle stages: ${brain.lifecycle.completed_count}.`,
    `- Blocked lifecycle stages: ${brain.lifecycle.blocked_stages.length ? brain.lifecycle.blocked_stages.map((stage) => stage.id).join(", ") : "none"}.`,
    `- Latest demand session: ${brain.latest_demand ? `\`${brain.latest_demand.id}\` phase=${brain.latest_demand.phase}, readiness=${brain.latest_demand.readiness_level}/${brain.latest_demand.readiness_status}, blockers=${brain.latest_demand.blocker_count}` : "none yet"}.`,
    `- Next recommended entry: ${brain.next_action}`,
    "",
  ];
  const releaseOrOperating = paths.packageMode ? [
    "## Release Reality",
    "",
    "- Release-side automation remains evidence-only: no publish, no credential reads, and no billable provider execution inside SDK gates.",
    "- Stable/public release still needs human operator evidence for external publish, billable execution, and public dogfood.",
    "- Runtime implementation is freeze-ready, but `./runtime` remains experimental until explicit stable-boundary approval.",
    "",
  ] : [
    "## Operating Rule",
    "",
    "- Treat `.yolo/lifecycle/status.json` and `.yolo/state/*.jsonl` as machine truth.",
    "- Treat this file and `CURRENT_HANDOFF.md` as refreshed summaries, not competing source documents.",
    "- Return to `/yolo-doctor` when the next entry is unclear.",
    "",
  ];
  return [
    "# YOLO Memory Current Status",
    "",
    `> Generated: ${options.now?.toISOString?.() || new Date().toISOString()}`,
    "",
    ...currentTruth,
    "## Recent Lifecycle Reports",
    "",
    ...(brain.latest_reports.length
      ? brain.latest_reports.map((report) => `- \`${report.stage}\` ${report.status}: ${report.summary || report.path}`)
      : ["- No lifecycle reports have been written yet."]),
    "",
    "## Memory Health",
    "",
    `- Audited memory docs/jsonl: ${audit.summary.document_count}.`,
    `- Canonical memory docs: ${audit.documents.filter((doc) => doc.category === "canonical_memory_doc").length}.`,
    `- Stale compatibility mirrors found: ${audit.summary.stale_mirror_count}.`,
    `- Deletion candidates found: ${audit.summary.deletion_candidate_count}.`,
    `- Learning ledger: ${learning.record_count} records.`,
    `- Session memory ledger: ${ledgers["session-memory.jsonl"].exists ? `${ledgers["session-memory.jsonl"].line_count} records` : "not present yet"}.`,
    `- Archived ledger files: ${archives.archived_jsonl_files}.`,
    `- Legacy generated archive snapshots: ${archives.generated_snapshots}.`,
    "",
    ...releaseOrOperating,
  ].join("\n");
}

export function buildCurrentHandoffMarkdown(options = Object()) {
  const paths = resolveMemoryPaths(options);
  const brain = projectBrainSummary(paths);
  if (!paths.packageMode) {
    return [
      "# YOLO Memory Handoff",
      "",
      `> Generated: ${options.now?.toISOString?.() || new Date().toISOString()}`,
      "",
      "## Current Context",
      "",
      `- Lifecycle stage: ${brain.lifecycle.exists ? `\`${brain.lifecycle.current_stage}\` (${brain.lifecycle.active_stage?.label || "unknown"})` : "not initialized"}.`,
      `- Latest demand: ${brain.latest_demand ? `\`${brain.latest_demand.id}\` (${brain.latest_demand.phase}, ${brain.latest_demand.readiness_level}/${brain.latest_demand.readiness_status})` : "none yet"}.`,
      `- Blockers: ${brain.lifecycle.blocked_stages.length ? brain.lifecycle.blocked_stages.map((stage) => stage.id).join(", ") : brain.latest_demand?.blocker_count ? `${brain.latest_demand.blocker_count} demand blocker(s)` : "none recorded"}.`,
      "",
      "## Recent Reports",
      "",
      ...(brain.latest_reports.length
        ? brain.latest_reports.map((report) => `- \`${report.stage}\` ${report.status}: ${report.summary || report.path}`)
        : ["- No lifecycle report has been written yet."]),
      "",
      "## Recent Session Memory",
      "",
      ...(brain.session_tail.length ? brain.session_tail.map(compactSessionMemoryLine) : ["- No session-memory checkpoint yet."]),
      "",
      "## Next Operator Action",
      "",
      `- ${brain.next_action}`,
      "",
      "## Key Paths",
      "",
      `- State root: \`${displayPath(paths.projectRoot, paths.stateRoot) || "."}\``,
      `- Lifecycle status: \`${displayPath(paths.projectRoot, join(paths.stateRoot, "lifecycle", "status.json"))}\``,
      `- Memory dir: \`${displayPath(paths.projectRoot, paths.memoryDir)}\``,
      `- Session memory: \`${displayPath(paths.projectRoot, join(paths.stateDir, "session-memory.jsonl"))}\``,
      "",
    ].join("\n");
  }
  return [
    "# YOLO Memory Handoff",
    "",
    `> Generated: ${options.now?.toISOString?.() || new Date().toISOString()}`,
    "",
    "## What Changed In This Memory System",
    "",
    "- Canonical memory documents live under `docs/memory/` for the YOLO package, and under `.yolo/memory/` for initialized user projects.",
    "- Append-only ledgers stay machine-readable under `state/*.jsonl` or `.yolo/state/*.jsonl`.",
    "- Overflow from active ledgers is archived under `state/archive/jsonl/YYYY-MM/` or `.yolo/state/archive/jsonl/YYYY-MM/` before the active files are trimmed.",
    "- Learning records are unified under `state/learning.jsonl` or `.yolo/state/learning.jsonl`; legacy closed-loop knowledge files are read-only migration sources.",
    "- Compatibility docs such as `PROJECT_TREE.md`, `SYSTEM_STATE.md`, and `ROADMAP.md` are mirrors or pointers, not the source of truth.",
    "- Hook-triggered refresh now targets `src/devtools/memory-center.js` instead of removed root scripts.",
    "",
    "## Next Operator Actions",
    "",
    "- Review `docs/memory/MEMORY_AUDIT.md` before deleting any legacy/scratch document.",
    "- Keep `docs/yolo-public-sdk-progress.md` as the roadmap/progress source; mirror only summaries into memory docs.",
    "- Run the configured project test command after memory center changes, because hooks, package smoke, bootstrap, and legacy-boundary tests all guard this area.",
    "",
    "## Key Paths",
    "",
    `- Project root: \`${displayPath(paths.projectRoot, paths.projectRoot) || "."}\``,
    `- State root: \`${displayPath(paths.projectRoot, paths.stateRoot) || "."}\``,
    `- State dir: \`${displayPath(paths.projectRoot, paths.stateDir)}\``,
    `- Memory dir: \`${displayPath(paths.projectRoot, paths.memoryDir)}\``,
    "",
  ].join("\n");
}

export function buildDocumentGovernanceMarkdown(options = Object()) {
  const paths = resolveMemoryPaths(options);
  const memoryHome = paths.packageMode ? "docs/memory/" : ".yolo/memory/";
  const stateHome = paths.packageMode ? "state/" : ".yolo/state/";
  return [
    "# YOLO Document Governance",
    "",
    `> Generated: ${options.now?.toISOString?.() || new Date().toISOString()}`,
    "",
    "## Decision",
    "",
    `- Human-readable YOLO memory and operational documents have one canonical home: \`${memoryHome}\`.`,
    `- Machine-readable ledgers have one canonical home: \`${stateHome}*.jsonl\`.`,
    "- Root-level `PROJECT_TREE.md`, `SYSTEM_STATE.md`, and `ROADMAP.md` are compatibility mirrors only; do not edit them as source documents.",
    "- `docs/PROJECT_TREE.md`, `docs/SYSTEM_STATE.md`, and `docs/ROADMAP.md` are also mirrors/pointers only.",
    "- New durable project-memory documents must be added to this memory center and to the refresh/bootstrap rules, not hand-written in random folders.",
    "",
    "## Canonical Document Homes",
    "",
    "| Document Type | Canonical Location | Naming Rule | Notes |",
    "|---|---|---|---|",
    `| Current status / handoff / tree / audit / learning / governance | \`${memoryHome}\` | \`UPPER_SNAKE_CASE.md\` | Generated or refreshed by \`yolo memory refresh\`. |`,
    `| Machine ledgers | \`${stateHome}\` | \`lower-kebab-or-domain.jsonl\` | Append-only; retention archives old records before trimming. |`,
    "| Public user docs | `docs/` | `lower-kebab-case.md` | README-linked docs for users and integrators. |",
    "| Roadmap/progress truth | `docs/yolo-public-sdk-progress.md` | fixed name | Ordered execution table and current SDK progress. |",
    "| Gap/architecture truth | `docs/sdk-gap-matrix.md` and `docs/sdk-agent-architecture.md` | fixed names | Strategic comparison and agent architecture. |",
    "| API/release reference | `docs/api-reference.md`, `docs/public-sdk-contract.md`, `docs/public-sdk-api-boundary.json` | fixed names | Public SDK contract and machine-readable API tiers. |",
    "| Spec artifacts in user projects | `specs/` | `requirements.md`, `design.md`, `tasks.md` | Project-owned requirements/design/tasks, not YOLO memory docs. |",
    "| Temporary analysis | `tmp/` | `lower-kebab-case.md` | Scratch only; must become deletion candidate unless promoted. |",
    "| Legacy learning sources | `closed-loop/*.jsonl` | existing names | Read-only migration sources; do not add new v1 docs here. |",
    "",
    "## Naming Rules",
    "",
    "- Generated memory docs use `UPPER_SNAKE_CASE.md` so agents can recognize canonical operational memory quickly.",
    "- Public docs under `docs/` use lowercase kebab-case, for example `agent-native-integration.md`.",
    "- JSON ledgers use `.jsonl`; JSON manifests use `.json`.",
    "- Do not create duplicate documents with date suffixes in active folders. If a snapshot is needed, store it under an archive path with a retention policy.",
    "- Do not encode local usernames, absolute machine paths, or one-off project names in public docs.",
    "",
    "## Add / Move / Delete Policy",
    "",
    "- Before adding a new doc, check `MEMORY_AUDIT.md` in the memory center for existing homes.",
    "- If the doc affects active execution state, update the canonical memory doc or roadmap first, then refresh mirrors.",
    "- If the doc is public-facing reference, put it in `docs/` and link it from README or an existing index.",
    "- If the doc is temporary, put it in `tmp/` and promote or delete it after review.",
    "- Do not delete legacy or scratch docs unless the audit marks them as deletion candidates and a human explicitly approves cleanup.",
    "",
    "## Enforcement",
    "",
    "- `yolo memory refresh` regenerates canonical memory docs and compatibility mirrors.",
    "- `MEMORY_AUDIT.md` classifies `.md` and `.jsonl` files as keep, archive, reference, legacy-readonly, or deletion-candidate.",
    "- Package smoke requires canonical memory docs to be present in the public tarball and blocks local `state/`, `data/`, `tmp/`, and `closed-loop/` content.",
    "- Project bootstrap creates the same memory governance document for initialized external projects.",
    "",
    "## Practical Answer",
    "",
    "Yes: from this point forward, YOLO should treat `docs/memory/` in the YOLO package, and `.yolo/memory/` in installed projects, as the unique home for operational memory documents. Other locations may exist as public reference docs, project specs, ledgers, compatibility mirrors, archives, or scratch space, but they must not become competing sources of truth.",
    "",
  ].join("\n");
}

export function buildMemoryAuditMarkdown(options = Object()) {
  const audit = buildMemoryAudit(options);
  const rows = audit.documents.map((doc) =>
    `| \`${doc.path}\` | ${doc.category} | ${doc.action} | ${doc.stale ? "yes" : "no"} | ${doc.reason.replaceAll("|", "\\|")} |`
  );
  return [
    "# YOLO Memory Audit",
    "",
    `> Generated: ${options.now?.toISOString?.() || new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    `- Total memory-related `.concat("`.md` / `.jsonl` files: ", String(audit.summary.document_count), "."),
    `- Delete candidates: ${audit.summary.deletion_candidate_count}.`,
    `- Stale compatibility mirrors: ${audit.summary.stale_mirror_count}.`,
    "- No file is deleted by this audit. Delete candidates require an explicit human cleanup step.",
    "",
    "## Action Counts",
    "",
    ...Object.entries(audit.summary.by_action).sort().map(([action, count]) => `- ${action}: ${count}`),
    "",
    "## Documents",
    "",
    "| Path | Category | Action | Stale | Reason |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

export function buildMemoryIndexMarkdown(options = Object()) {
  const paths = resolveMemoryPaths(options);
  return [
    "# YOLO Memory Index",
    "",
    `> Generated: ${options.now?.toISOString?.() || new Date().toISOString()}`,
    "",
    "This folder is the canonical human-readable memory center. Machine-readable ledgers remain in `state/*.jsonl` for this package, or `.yolo/state/*.jsonl` for initialized projects.",
    "",
    "## Canonical Files",
    "",
    "- `CURRENT_STATUS.md`: current release/runtime/project state.",
    "- `CURRENT_HANDOFF.md`: handoff notes for the next agent/session.",
    "- `PROJECT_BRIEF.md`: plain-language project purpose, users, and surfaces.",
    "- `PROGRESS.md`: human-readable progress summary and next work.",
    "- `OPEN_QUESTIONS.md`: product and execution questions that block PRD or implementation.",
    "- `DECISION_LOG.md`: durable decisions and ADR promotion candidates.",
    "- `DOCUMENT_GOVERNANCE.md`: canonical document homes, naming rules, and anti-sprawl policy.",
    "- `PROJECT_TREE.md`: generated project structure tree and active ledger summary.",
    "- `MEMORY_AUDIT.md`: audit of `.md` and `.jsonl` files with keep/archive/delete-candidate classification.",
    "- `LEARNING_INDEX.md`: summary of the model-agnostic learning ledger.",
    "- `LESSONS_PLAYBOOK.md`: human-readable pitfalls and prevention playbook.",
    "",
    "## Machine Ledgers",
    "",
    `- State dir: \`${rel(paths.projectRoot, paths.stateDir) || paths.stateDir}\``,
    "- `changes.jsonl`: task starts/completions and auto file-change records.",
    "- `events.jsonl`: runtime/manual events.",
    "- `runs.jsonl`: run lifecycle events.",
    "- `learning.jsonl`: unified lessons, pitfalls, rules, and recovery records.",
    "- `session-memory.jsonl`: runner checkpoints and handoff memory.",
    "- `questions.jsonl`: demand interview questions and answers.",
    "- `decisions.jsonl`: structured product/technical decisions.",
    "- `artifacts.jsonl`: generated artifacts and trace links.",
    "- `runtime/task-*.jsonl`: task audit/results/log records.",
    "- `archive/jsonl/YYYY-MM/*.jsonl`: old ledger records archived by retention before active files are trimmed.",
    "",
    "## Compatibility Mirrors",
    "",
    "- Root `PROJECT_TREE.md`, `SYSTEM_STATE.md`, and `ROADMAP.md` are compatibility mirrors.",
    "- `docs/PROJECT_TREE.md`, `docs/SYSTEM_STATE.md`, and `docs/ROADMAP.md` point back to this canonical memory center.",
    "",
  ].join("\n");
}

function writeDoc(filePath: string, content: string, dryRun: boolean): { path: string; bytes: number } {
  if (!dryRun) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }
  return { path: filePath, bytes: Buffer.byteLength(content, "utf8") };
}

function buildDocs(options: MemoryRecord = Object()) {
  return {
    "MEMORY_INDEX.md": buildMemoryIndexMarkdown(options),
    "CURRENT_STATUS.md": buildCurrentStatusMarkdown(options),
    "CURRENT_HANDOFF.md": buildCurrentHandoffMarkdown(options),
    "DOCUMENT_GOVERNANCE.md": buildDocumentGovernanceMarkdown(options),
    "LEARNING_INDEX.md": buildLearningIndexMarkdown(options),
    "LESSONS_PLAYBOOK.md": buildLessonsPlaybookMarkdown(options),
    "PROJECT_TREE.md": buildProjectTreeMarkdown(options),
    "MEMORY_AUDIT.md": buildMemoryAuditMarkdown(options),
  };
}

export function refreshMemoryCenter(options: MemoryRecord = Object()) {
  const paths = resolveMemoryPaths(options);
  const dryRun = options.dryRun === true || options.dry_run === true;
  const learningMigration = options.migrateLearning === false || options.migrate_learning === false
    ? null
    : migrateLegacyLearning({ ...options, ...paths, dryRun });
  const retention = options.applyRetention === false || options.apply_retention === false
    ? null
    : applyMemoryRetention({
      stateDir: paths.stateDir,
      dryRun,
      now: options.now,
      maxChanges: options.maxChanges ?? options.max_changes,
      maxEvents: options.maxEvents ?? options.max_events,
      maxRuns: options.maxRuns ?? options.max_runs,
      maxReviewLog: options.maxReviewLog ?? options.max_review_log,
      maxSessionMemory: options.maxSessionMemory ?? options.max_session_memory,
      maxLearning: options.maxLearning ?? options.max_learning,
      pruneGeneratedArchives: options.pruneGeneratedArchives ?? options.prune_generated_archives,
    });
  const docs = buildDocs({ ...options, ...paths });
  const written: { path: string; bytes: number }[] = [];
  for (const [name, content] of Object.entries(docs)) {
    written.push(writeDoc(join(paths.memoryDir, name), content, dryRun));
  }

  const audit = buildMemoryAudit({ ...options, ...paths });
  return {
    schema_version: MEMORY_CENTER_SCHEMA_VERSION,
    status: "ok",
    dry_run: dryRun,
    project_root: paths.projectRoot,
    state_root: paths.stateRoot,
    state_dir: paths.stateDir,
    memory_dir: paths.memoryDir,
    package_mode: paths.packageMode,
    written,
    retention,
    learning_migration: learningMigration,
    audit_summary: audit.summary,
  };
}

function argValue(argv: string[], name: string): { value: string | null; consumed: number } {
  const flag = `--${name}=`;
  const exact = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith(flag)) return { value: arg.slice(flag.length), consumed: 0 };
    if (arg === exact) return { value: argv[i + 1], consumed: 1 };
  }
  return { value: null, consumed: 0 };
}

function parseMemoryCenterArgs(argv: string[] = []): MemoryRecord {
  const options: MemoryRecord = Object.assign(Object(), {
    dryRun: argv.includes("--dry-run"),
    json: argv.includes("--json"),
    writeLegacyPointers: argv.includes("--legacy-pointers") || argv.includes("--write-legacy-pointers"),
    applyRetention: !argv.includes("--no-retention"),
    migrateLearning: !argv.includes("--no-learning-migration"),
    pruneGeneratedArchives: !argv.includes("--no-prune-generated-archives"),
  });
  for (const key of ["project-root", "state-root", "state-dir", "memory-dir", "cwd"]) {
    const parsed = argValue(argv, key);
    if (parsed.value) options[key.replaceAll("-", "_")] = parsed.value;
  }
  for (const key of ["max-changes", "max-events", "max-runs", "max-review-log", "max-session-memory", "max-learning"]) {
    const parsed = argValue(argv, key);
    if (parsed.value) options[key.replaceAll("-", "_")] = Number(parsed.value);
  }
  return options;
}

type StreamLike = { write(chunk: string): void };

export function runMemoryCenterCli(argv: string[] = process.argv.slice(2), io: { stdout?: StreamLike; stderr?: StreamLike } = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  try {
    const options = parseMemoryCenterArgs(argv);
    const result = refreshMemoryCenter({
      projectRoot: options.project_root || options.cwd,
      stateRoot: options.state_root,
      stateDir: options.state_dir,
      memoryDir: options.memory_dir,
      dryRun: options.dryRun,
      writeLegacyPointers: options.writeLegacyPointers,
      applyRetention: options.applyRetention,
      migrateLearning: options.migrateLearning,
      pruneGeneratedArchives: options.pruneGeneratedArchives,
      maxChanges: options.max_changes,
      maxEvents: options.max_events,
      maxRuns: options.max_runs,
      maxReviewLog: options.max_review_log,
      maxSessionMemory: options.max_session_memory,
      maxLearning: options.max_learning,
    });
    if (options.json) {
      stdout.write(stableJson(result));
    } else {
      stdout.write(`[memory-center] ${result.status}: wrote ${result.written.length} docs under ${result.memory_dir}\n`);
    }
    return result;
  } catch (error) {
    const result = {
      schema_version: MEMORY_CENTER_SCHEMA_VERSION,
      status: "error",
      error: (error as Error).message,
    };
    if (argv.includes("--json")) stdout.write(stableJson(result));
    else stderr.write(`[memory-center] error: ${(error as Error).message}\n`);
    return result;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const result = runMemoryCenterCli();
  if (result.status !== "ok") process.exit(1);
}

export { DEFAULT_YOLO_ROOT };
