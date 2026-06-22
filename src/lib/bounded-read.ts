// lib/bounded-read.ts — bounded tail / incremental reads for dashboard logs.
//
// The progress dashboard reads several JSONL / text log files that grow over
// the course of a run (task-logs/*.jsonl, _review.jsonl, yolo-output.log,
// lifecycle state/*.jsonl). Previously every read went through
// `readFileSync(path, "utf8")`, which reads the ENTIRE file into memory and
// blocks the event loop for as long as the disk read takes. With long runs and
// multiple SSE clients polling simultaneously, that pins the event loop and
// drives RSS up roughly linearly with the largest log file.
//
// This module replaces those reads with bounded tail reads:
//
//   * `readJsonlTail`       — parse the last <= maxEntries lines of a JSONL
//                             file (used for review/task-log summary reads).
//   * `readJsonlSince`      — incremental read keyed on a byte offset that
//                             gracefully handles rotation/truncation
//                             (used for SSE push paths).
//   * `readTextTail`        — read the last <= maxBytes of a UTF-8 text file,
//                             re-aligned to a line boundary (used for
//                             yolo-output.log).
//
// All reads open the file, seek to near the tail, and read only a bounded
// window; they never materialize the full file into a single Buffer/string.
// Small files (under the bound) behave identically to readFileSync, so existing
// API contracts are preserved. Each call returns `truncated` / `bytesRead` /
// `totalBytes` metadata so callers can surface truncation without changing the
// response shape.

import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";

/** Common metadata returned by every bounded read. */
export interface BoundedReadMeta {
  /** Total size of the file in bytes at the time of read. */
  totalBytes: number;
  /** Number of bytes actually read into memory (<= maxBytes). */
  bytesRead: number;
  /** True when the read returned only a tail window of a larger file. */
  truncated: boolean;
}

/** Result of a JSONL tail read. */
export interface JsonlTailResult {
  /** Parsed JSON entries from the last lines (oldest → newest). Typed `any`
   *  to match the prior `JSON.parse` ergonomics so callers can access fields
   *  without per-site casts. */
  entries: any[];
  meta: BoundedReadMeta;
}

/** Result of an incremental JSONL read keyed on a byte offset. */
export interface JsonlSinceResult {
  /** New entries appended after `sinceByte` (oldest → newest). Typed `any` to
   *  match prior `JSON.parse` ergonomics. */
  entries: any[];
  /** New byte offset to pass on the next call (end-of-file). */
  nextOffset: number;
  /** True when the file shrank below `sinceByte` (rotation/truncation); the
   * caller's stored offset should be reset to `nextOffset`. */
  rotated: boolean;
  meta: BoundedReadMeta;
}

/** Result of a UTF-8 text tail read. */
export interface TextTailResult {
  /** Decoded text (last <= maxBytes, line-aligned). */
  text: string;
  meta: BoundedReadMeta;
}

const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KiB tail window.
const DEFAULT_MAX_ENTRIES = 2000; // cap parsed entries per call.

function safeClose(fd: number) {
  try { closeSync(fd); } catch { /* already closed */ }
}

/**
 * Read up to `maxBytes` from the end of a file into a Buffer, returning the
 * Buffer plus metadata. Reads at most `maxBytes` bytes; for files smaller than
 * the window it reads the whole file (matching readFileSync behavior).
 */
function readTailBuffer(filePath: string, maxBytes: number): { buffer: Buffer; meta: BoundedReadMeta } | null {
  if (!existsSync(filePath)) return null;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const stat = fstatSync(fd);
    const totalBytes = stat.size;
    if (totalBytes === 0) {
      return { buffer: Buffer.alloc(0), meta: { totalBytes: 0, bytesRead: 0, truncated: false } };
    }
    const readSize = Math.min(maxBytes, totalBytes);
    const offset = totalBytes - readSize;
    const buf = Buffer.alloc(readSize);
    // readSync may return fewer bytes than requested; loop until satisfied.
    let read = 0;
    while (read < readSize) {
      const n = readSync(fd, buf, read, readSize - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    const truncated = read < totalBytes;
    return { buffer: buf.subarray(0, read), meta: { totalBytes, bytesRead: read, truncated } };
  } catch {
    return null;
  } finally {
    if (fd !== null) safeClose(fd);
  }
}

/**
 * Drop a partial first line so callers don't see a truncated JSON record.
 * Returns the buffer sliced to the first full line. `isTail` indicates the
 * buffer represents a tail window (not a whole-file read); only then is a
 * leading partial line dropped.
 */
function alignToLineStart(buf: Buffer, isTail: boolean): Buffer {
  if (!isTail || buf.length === 0) return buf;
  const newline = buf.indexOf(0x0a); // "\n"
  if (newline === -1) return Buffer.alloc(0); // no complete line yet
  return buf.subarray(newline + 1);
}

/**
 * Parse JSONL text into entries, tolerating non-JSON / blank lines exactly like
 * the previous `lines.map(JSON.parse).filter(Boolean)` pattern. Caps the number
 * of returned entries at `maxEntries` (keeping the newest).
 */
function parseJsonlLines(text: string, maxEntries: number): any[] {
  const lines = text.split("\n");
  const entries: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (value === null || value === undefined) continue;
    entries.push(value);
  }
  if (entries.length > maxEntries) return entries.slice(entries.length - maxEntries);
  return entries;
}

/**
 * Read the last <= maxEntries JSONL records from `filePath` (bounded to a tail
 * window of `maxBytes`). Replaces
 *   readFileSync(filePath, "utf8").split("\n").map(JSON.parse).filter(Boolean)
 * for dashboard summary reads. The returned `entries` are oldest → newest, and
 * `meta.truncated` is true when the file exceeded the byte window.
 */
export function readJsonlTail(
  filePath: string,
  options: { maxBytes?: number; maxEntries?: number } = {},
): JsonlTailResult | null {
  const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  if (maxBytes === 0 || maxEntries === 0) {
    const totalBytes = existsSync(filePath) ? fileSize(filePath) : 0;
    return { entries: [], meta: { totalBytes, bytesRead: 0, truncated: totalBytes > 0 } };
  }
  const tail = readTailBuffer(filePath, maxBytes);
  if (tail === null) return null;
  const aligned = alignToLineStart(tail.buffer, tail.meta.truncated);
  const text = aligned.toString("utf8");
  const entries = parseJsonlLines(text, maxEntries);
  return { entries, meta: tail.meta };
}

/**
 * Incrementally read JSONL entries appended after `sinceByte`. On rotation
 * (file shrank below `sinceByte`) returns the full tail and flags `rotated`.
 * The caller should store `nextOffset` and pass it on the next call. Replaces
 *   readFileSync(filePath, "utf8").split("\n").slice(lastPosition)
 * which read the whole file on every watcher fire.
 */
export function readJsonlSince(
  filePath: string,
  sinceByte: number,
  options: { maxBytes?: number; maxEntries?: number } = {},
): JsonlSinceResult | null {
  const maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxEntries = Math.max(0, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  let totalBytes = 0;
  try { totalBytes = statSync(filePath).size; } catch { return null; }

  const start = Math.max(0, sinceByte);
  const rotated = start > totalBytes; // file shrank below last offset
  const effectiveStart = rotated ? 0 : start;

  // If there is nothing new, return empty without opening the file.
  if (!rotated && effectiveStart >= totalBytes) {
    return {
      entries: [],
      nextOffset: totalBytes,
      rotated: false,
      meta: { totalBytes, bytesRead: 0, truncated: false },
    };
  }

  // Bound the read window to maxBytes from the effective start. If the new
  // suffix is larger than the window we only parse the newest maxBytes and
  // surface `truncated`.
  const available = totalBytes - effectiveStart;
  const readSize = Math.min(available, maxBytes);
  const truncated = available > maxBytes;
  const readFrom = truncated ? totalBytes - maxBytes : effectiveStart;

  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(readSize);
    let read = 0;
    while (read < readSize) {
      const n = readSync(fd, buf, read, readSize - read, readFrom + read);
      if (n <= 0) break;
      read += n;
    }
    // Drop a partial leading line ONLY when truncation pushed our read start
    // forward into the middle of a record (readFrom > effectiveStart). When we
    // read from a real boundary (effectiveStart === readFrom) — e.g. an
    // incremental read resuming at the exact byte we last stopped — the first
    // byte already begins a full record and must NOT be dropped.
    const needsAlign = readFrom > effectiveStart;
    const aligned = needsAlign ? alignToLineStart(buf.subarray(0, read), true) : buf.subarray(0, read);
    const text = aligned.toString("utf8");
    const entries = parseJsonlLines(text, maxEntries);
    return {
      entries,
      nextOffset: totalBytes,
      rotated,
      meta: { totalBytes, bytesRead: read, truncated },
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) safeClose(fd);
  }
}

/**
 * Read the last <= maxBytes of a UTF-8 text file, aligned to the first line
 * boundary inside the window. Replaces readFileSync for log-tail scans where
 * only the most recent lines matter (e.g. finding the current running task).
 */
export function readTextTail(
  filePath: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): TextTailResult | null {
  if (maxBytes <= 0) {
    const totalBytes = existsSync(filePath) ? fileSize(filePath) : 0;
    return { text: "", meta: { totalBytes, bytesRead: 0, truncated: totalBytes > 0 } };
  }
  const tail = readTailBuffer(filePath, maxBytes);
  if (tail === null) return null;
  const aligned = alignToLineStart(tail.buffer, tail.meta.truncated);
  return { text: aligned.toString("utf8"), meta: tail.meta };
}

function fileSize(filePath: string): number {
  try { return statSync(filePath).size; } catch { return 0; }
}
