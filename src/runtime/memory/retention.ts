import {
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  readdirSync as defaultReaddirSync,
  rmSync as defaultRmSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const MEMORY_RETENTION_SCHEMA_VERSION = "1.0";

export const DEFAULT_MEMORY_RETENTION = {
  changes: 500,
  events: 500,
  runs: 100,
  reviewLog: 200,
  learning: 500,
  sessionMemory: 200,
};

const GENERATED_ARCHIVE_RE = /^(CHANGELOG|PROJECT_TREE|SYSTEM_STATE)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.md$/;

function timestampId(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function monthId(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  return date.toISOString().slice(0, 7);
}

function jsonlLines(text) {
  return text.split("\n").filter(Boolean);
}

function defaultArchiveDirFor(filePath, now = new Date()) {
  return join(dirname(filePath), "archive", "jsonl", monthId(now));
}

export function trimJsonlWithArchive({
  filePath,
  maxLines,
  archiveDir,
  dryRun = false,
  now = new Date(),
  existsSync = defaultExistsSync,
  readFileSync = defaultReadFileSync,
  writeFileSync = defaultWriteFileSync,
  mkdirSync = defaultMkdirSync,
} = Object()) {
  if (!filePath) throw new Error("filePath is required");
  if (!Number.isFinite(maxLines) || maxLines < 0) throw new Error("maxLines must be a non-negative number");
  if (!existsSync(filePath)) {
    return { file_path: filePath, status: "missing", trimmed: false, line_count: 0, max_lines: maxLines };
  }

  const lines = jsonlLines(readFileSync(filePath, "utf8"));
  if (lines.length <= maxLines) {
    return {
      file_path: filePath,
      status: "kept",
      trimmed: false,
      line_count: lines.length,
      max_lines: maxLines,
    };
  }

  const keep = maxLines === 0 ? [] : lines.slice(-maxLines);
  const archive = maxLines === 0 ? lines : lines.slice(0, lines.length - maxLines);
  const shouldArchive = archiveDir !== null;
  const resolvedArchiveDir = shouldArchive
    ? (archiveDir ? resolve(archiveDir) : defaultArchiveDirFor(filePath, now))
    : null;
  const archiveFile = shouldArchive
    ? join(resolvedArchiveDir, `${basename(filePath, ".jsonl")}.${timestampId(now)}.jsonl`)
    : null;

  if (!dryRun) {
    if (shouldArchive) {
      mkdirSync(resolvedArchiveDir, { recursive: true });
      writeFileSync(archiveFile, archive.length > 0 ? `${archive.join("\n")}\n` : "", "utf8");
    }
    writeFileSync(filePath, keep.length > 0 ? `${keep.join("\n")}\n` : "", "utf8");
  }

  return {
    file_path: filePath,
    status: "archived",
    trimmed: true,
    before: lines.length,
    after: keep.length,
    archived: archive.length,
    max_lines: maxLines,
    archive_file: archiveFile,
    dry_run: dryRun,
  };
}

function retentionValue(options, camelKey, snakeKey, fallback) {
  const value = options[camelKey] ?? options[snakeKey];
  return Number.isFinite(value) ? value : fallback;
}

export function pruneGeneratedArchiveSnapshots({
  stateDir,
  dryRun = false,
  existsSync = defaultExistsSync,
  readdirSync = defaultReaddirSync,
  rmSync = defaultRmSync,
} = Object()) {
  const archiveDir = join(resolve(stateDir || "state"), "archive");
  if (!existsSync(archiveDir)) {
    return { status: "missing", archive_dir: archiveDir, deleted: [], deleted_count: 0, dry_run: dryRun };
  }

  const deleted = [];
  for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
    if (!entry.isFile() || !GENERATED_ARCHIVE_RE.test(entry.name)) continue;
    const filePath = join(archiveDir, entry.name);
    deleted.push(filePath);
    if (!dryRun) rmSync(filePath, { force: true });
  }

  return {
    status: "ok",
    archive_dir: archiveDir,
    deleted,
    deleted_count: deleted.length,
    dry_run: dryRun,
  };
}

export function applyMemoryRetention(options = Object()) {
  const stateDir = resolve(options.stateDir || options.state_dir || "state");
  const dryRun = options.dryRun === true || options.dry_run === true;
  const now = options.now || new Date();
  const archiveDir = options.archiveDir || options.archive_dir || join(stateDir, "archive", "jsonl", monthId(now));
  const ledgers = [
    ["changes.jsonl", retentionValue(options, "maxChanges", "max_changes", DEFAULT_MEMORY_RETENTION.changes)],
    ["events.jsonl", retentionValue(options, "maxEvents", "max_events", DEFAULT_MEMORY_RETENTION.events)],
    ["runs.jsonl", retentionValue(options, "maxRuns", "max_runs", DEFAULT_MEMORY_RETENTION.runs)],
    ["review-log.jsonl", retentionValue(options, "maxReviewLog", "max_review_log", DEFAULT_MEMORY_RETENTION.reviewLog)],
    ["learning.jsonl", retentionValue(options, "maxLearning", "max_learning", DEFAULT_MEMORY_RETENTION.learning)],
    ["session-memory.jsonl", retentionValue(options, "maxSessionMemory", "max_session_memory", DEFAULT_MEMORY_RETENTION.sessionMemory)],
  ];

  const results = ledgers.map(([name, maxLines]) =>
    trimJsonlWithArchive({
      filePath: join(stateDir, name),
      maxLines,
      archiveDir,
      dryRun,
      now,
    })
  );
  const pruneGeneratedArchives = options.pruneGeneratedArchives ?? options.prune_generated_archives ?? true;
  const prunedGeneratedArchives = pruneGeneratedArchives
    ? pruneGeneratedArchiveSnapshots({ stateDir, dryRun })
    : { status: "skipped", archive_dir: join(stateDir, "archive"), deleted: [], deleted_count: 0, dry_run: dryRun };

  return {
    schema_version: MEMORY_RETENTION_SCHEMA_VERSION,
    status: "ok",
    dry_run: dryRun,
    state_dir: stateDir,
    archive_dir: archiveDir,
    ledgers: results,
    archived_record_count: results.reduce((sum, result) => sum + (result.archived || 0), 0),
    trimmed_ledger_count: results.filter((result) => result.trimmed).length,
    pruned_generated_archives: prunedGeneratedArchives,
  };
}
