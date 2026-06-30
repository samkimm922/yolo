import assert from "node:assert/strict";
import { closeSync, mkdtempSync, mkdirSync, openSync, rmSync, statSync, writeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readJsonlTail, readJsonlSince, readTextTail } from "../src/lib/bounded-read.js";
import { readLifecycleDashboard } from "../src/runtime/progress/lifecycle-dashboard.js";

// L8: bounded-read now types entries as unknown[] (honest for JSON.parse).
// Narrow to the record shape the assertions use.
type TailEntry = Record<string, unknown>;
const entriesOf = (r: { entries: unknown[] }): TailEntry[] => r.entries as TailEntry[];

// Regression coverage for bounded tail reads on the progress dashboard.
//
// Previously the dashboard read entire JSONL/text log files into memory via
// readFileSync on every poll and every SSE tick. These tests pin the new
// behavior: small files are read in full (identical to before), large files
// return only a bounded tail with correct truncation metadata, and incremental
// reads survive log rotation without losing or duplicating entries.

function tempDir() {
  return mkdtempSync(join(tmpdir(), "yolo-progress-tail-read-"));
}

function jsonlLine(obj) {
  return JSON.stringify(obj);
}

test("readJsonlTail: small files behave like readFileSync (no truncation)", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "small.jsonl");
    writeFileSync(file, [
      jsonlLine({ type: "TASK_START", title: "t1" }),
      jsonlLine({ type: "EDIT", file: "a.ts" }),
      jsonlLine({ type: "DONE", result: "completed" }),
      "", // trailing newline like real writers
    ].join("\n"), "utf8");

    const result = readJsonlTail(file);
    assert.ok(result);
    assert.equal(entriesOf(result).length, 3);
    assert.equal(entriesOf(result)[0].type, "TASK_START");
    assert.equal(entriesOf(result)[2].result, "completed");
    assert.equal(result.meta.truncated, false);
    assert.equal(result.meta.totalBytes, statSync(file).size);
    assert.equal(result.meta.bytesRead, statSync(file).size);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonlTail: large file returns only the bounded tail and flags truncation", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "large.jsonl");
    const marker = jsonlLine({ type: "DONE", result: "completed", marker: "tail-anchor" });
    // 10 KiB of filler lines (5000 lines * ~2 bytes each is small; to force a
    // truncation we cap maxBytes far below the file). Write 10000 lines.
    const filler = jsonlLine({ type: "BASH", i: 0 });
    const fillerLine = filler + "\n";
    const fillerCount = 10000;
    const buf = Buffer.alloc(fillerLine.length * fillerCount + marker.length + 1);
    let off = 0;
    for (let i = 0; i < fillerCount; i++) {
      off += buf.write(fillerLine, off, "utf8");
    }
    off += buf.write(marker + "\n", off, "utf8");
    writeFileSync(file, buf.subarray(0, off));

    const totalSize = statSync(file).size;
    const maxBytes = 1024; // far smaller than the file → must truncate
    const result = readJsonlTail(file, { maxBytes, maxEntries: 100000 });
    assert.ok(result);
    assert.equal(result.meta.truncated, true);
    assert.equal(result.meta.totalBytes, totalSize);
    assert.ok(result.meta.bytesRead <= maxBytes, `bytesRead ${result.meta.bytesRead} must be <= ${maxBytes}`);
    // The most-recent marker entry must be present in the tail.
    const last = entriesOf(result)[entriesOf(result).length - 1];
    assert.equal(last.type, "DONE");
    assert.equal(last.marker, "tail-anchor");
    // We must NOT have materialized the whole file into a single buffer.
    assert.ok(result.meta.bytesRead < totalSize);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonlTail: maxEntries caps the parsed entries (keeps newest)", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "capped.jsonl");
    const lines = [];
    for (let i = 0; i < 50; i++) lines.push(jsonlLine({ type: "X", i }));
    writeFileSync(file, lines.join("\n") + "\n", "utf8");

    const result = readJsonlTail(file, { maxEntries: 5 });
    assert.ok(result);
    assert.equal(entriesOf(result).length, 5);
    // Newest 5 are indices 45..49
    assert.deepEqual(entriesOf(result).map((e) => e.i), [45, 46, 47, 48, 49]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonlSince: incremental reads return only appended entries", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "inc.jsonl");
    writeFileSync(file, [
      jsonlLine({ type: "A", n: 1 }),
      jsonlLine({ type: "A", n: 2 }),
    ].join("\n") + "\n", "utf8");

    // First read from offset 0 → both entries.
    const first = readJsonlSince(file, 0);
    assert.ok(first);
    assert.equal(entriesOf(first).length, 2);
    assert.equal(first.rotated, false);
    assert.ok(first.nextOffset > 0);

    // Append a third entry.
    const before = statSync(file).size;
    writeFileSync(file, jsonlLine({ type: "A", n: 3 }) + "\n", { flag: "a" });
    void before;

    // Incremental read from the previous offset returns only the new entry.
    const second = readJsonlSince(file, first.nextOffset);
    assert.ok(second);
    assert.equal(entriesOf(second).length, 1);
    assert.equal(entriesOf(second)[0].n, 3);
    assert.equal(second.rotated, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readJsonlSince: log rotation (shrink below offset) is flagged and resets", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "rot.jsonl");
    writeFileSync(file, [
      jsonlLine({ type: "OLD", n: 1 }),
      jsonlLine({ type: "OLD", n: 2 }),
    ].join("\n") + "\n", "utf8");
    const first = readJsonlSince(file, 0);
    assert.ok(first);
    assert.ok(first.nextOffset > 0);

    // Simulate rotation: truncate and write a fresh smaller file.
    writeFileSync(file, [
      jsonlLine({ type: "NEW", n: 1 }),
    ].join("\n") + "\n", "utf8");

    const after = readJsonlSince(file, first.nextOffset);
    assert.ok(after);
    assert.equal(after.rotated, true, "rotation must be flagged when file shrank below offset");
    // On rotation we re-read from 0: the new entry must appear.
    assert.ok(entriesOf(after).some((e) => e.type === "NEW"));
    // nextOffset must now reflect the fresh (smaller) file size.
    assert.equal(after.nextOffset, statSync(file).size);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTextTail: large text log returns only the bounded tail, line-aligned", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "output.log");
    // 200 lines of 100 bytes each = ~20 KiB.
    const line = "x".repeat(99) + "\n";
    const lines = [];
    for (let i = 0; i < 200; i++) lines.push(line);
    lines.push("[00:00:00] (1s) 1/1 P1 TASK-TAIL >> current running task\n");
    writeFileSync(file, lines.join(""), "utf8");

    const maxBytes = 1024;
    const result = readTextTail(file, maxBytes);
    assert.ok(result);
    assert.equal(result.meta.truncated, true);
    assert.ok(result.meta.bytesRead <= maxBytes);
    // The tail window must contain the final marker line and must be
    // line-aligned: the first line is a COMPLETE 99-char filler line (or the
    // marker), never a fragment of one.
    assert.match(result.text, /TASK-TAIL/);
    const firstLine = result.text.split("\n")[0];
    assert.ok(
      firstLine.length === 99 || firstLine.includes("TASK-TAIL"),
      `first tail line must be line-aligned (complete), got length ${firstLine.length}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readTextTail: small text file is read in full (no truncation)", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "small.log");
    writeFileSync(file, "line one\nline two\nline three\n", "utf8");
    const result = readTextTail(file, 8192);
    assert.ok(result);
    assert.equal(result.meta.truncated, false);
    assert.equal(result.text, "line one\nline two\nline three\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory bound: parsing a 60MB JSONL does not allocate a 60MB string", () => {
  const dir = tempDir();
  try {
    const file = join(dir, "huge.jsonl");
    // ~60 MiB of tiny lines. We do not assert RSS directly (flaky under test
    // runners); instead we assert the bounded contract: bytesRead <= maxBytes
    // and the newest entry is present despite the file being far larger than
    // the window.
    const line = jsonlLine({ type: "BASH", i: 0 }) + "\n";
    const targetBytes = 60 * 1024 * 1024;
    const count = Math.ceil(targetBytes / line.length);
    const chunk = Buffer.alloc(line.length);
    chunk.write(line, "utf8");
    const fh = awaitOpenSyncAppend(file);
    for (let i = 0; i < count; i++) fh.append(chunk);
    fh.appendStr(jsonlLine({ type: "DONE", result: "completed", marker: "end" }) + "\n");
    fh.close();

    const totalSize = statSync(file).size;
    assert.ok(totalSize >= 60 * 1024 * 1024, "fixture should be ~60 MiB");

    const maxBytes = 256 * 1024;
    const result = readJsonlTail(file, { maxBytes, maxEntries: 100000 });
    assert.ok(result);
    assert.equal(result.meta.totalBytes, totalSize);
    assert.ok(result.meta.bytesRead <= maxBytes, "bounded read window respected for 60MB file");
    assert.equal(result.meta.truncated, true);
    const last = entriesOf(result)[entriesOf(result).length - 1];
    assert.equal(last.marker, "end");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lifecycle-dashboard readEvents returns newest events via bounded tail read", () => {
  const projectRoot = tempDir();
  const stateRoot = join(projectRoot, ".yolo");
  const lifecycleDir = join(stateRoot, "lifecycle");
  const stateDir = join(stateRoot, "state");
  mkdirSync(join(stateDir, "reports"), { recursive: true });
  mkdirSync(lifecycleDir, { recursive: true });
  try {
    writeFileSync(join(lifecycleDir, "status.json"), `${JSON.stringify({
      current_stage: "check",
      stages: [{ id: "check", status: "active" }],
    }, null, 2)}\n`, "utf8");

    // Write a large events.jsonl: many old events + 2 recent ones. The recent
    // ones must surface in recent_events regardless of file size.
    const old = [];
    for (let i = 0; i < 20000; i++) {
      old.push(jsonlLine({ type: "stage_started", stage_id: "check", created_at: `2025-01-0${(i % 9) + 1}T00:00:00.000Z` }));
    }
    writeFileSync(join(stateDir, "events.jsonl"), [
      ...old,
      jsonlLine({ type: "stage_blocked", stage_id: "check", created_at: "2026-01-03T00:00:00.000Z" }),
      jsonlLine({ type: "stage_resumed", stage_id: "check", created_at: "2026-01-04T00:00:00.000Z" }),
      "",
    ].join("\n"), "utf8");

    const dashboard = readLifecycleDashboard({ projectRoot, eventLimit: 8 });
    assert.equal(dashboard.exists, true);
    assert.ok(dashboard.recent_events.length > 0);
    // Newest event must be stage_resumed (2026-01-04).
    assert.equal(dashboard.recent_events[0].type, "stage_resumed");
    // All returned events must be within eventLimit.
    assert.ok(dashboard.recent_events.length <= 8);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("lifecycle-dashboard small events file matches prior behavior", () => {
  const projectRoot = tempDir();
  const stateRoot = join(projectRoot, ".yolo");
  const lifecycleDir = join(stateRoot, "lifecycle");
  const stateDir = join(stateRoot, "state");
  mkdirSync(lifecycleDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  try {
    writeFileSync(join(lifecycleDir, "status.json"), `${JSON.stringify({
      current_stage: "check",
      stages: [{ id: "check", status: "active" }],
    }, null, 2)}\n`, "utf8");
    writeFileSync(join(stateDir, "events.jsonl"), [
      jsonlLine({ type: "stage_started", stage_id: "check", created_at: "2026-01-01T00:00:00.000Z" }),
      jsonlLine({ type: "stage_blocked", stage_id: "check", created_at: "2026-01-03T00:00:00.000Z" }),
      "",
    ].join("\n"), "utf8");

    const dashboard = readLifecycleDashboard({ projectRoot });
    assert.equal(dashboard.recent_events.length, 2);
    assert.equal(dashboard.recent_events[0].type, "stage_blocked");
    assert.equal(dashboard.recent_events[1].type, "stage_started");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

// Minimal helper to stream a large fixture without building one giant string.
function awaitOpenSyncAppend(file) {
  const fd = openSync(file, "w");
  return {
    append(buf) { writeSync(fd, buf); },
    appendStr(s) { writeSync(fd, Buffer.from(s, "utf8")); },
    close() { closeSync(fd); },
  };
}
