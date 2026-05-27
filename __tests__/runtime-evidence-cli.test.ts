import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendSessionMemory } from "../src/runtime/evidence/session-memory.js";
import { writeStateSnapshot } from "../src/runtime/evidence/state-snapshot.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const FIXED_NOW = new Date("2026-05-25T00:00:00.000Z");

describe("runtime evidence CLI modules", () => {
  test("state snapshot implementation writes under caller supplied state root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-state-snapshot-"));
    try {
      mkdirSync(join(root, "state/runtime"), { recursive: true });
      writeFileSync(join(root, "state/current-run.json"), JSON.stringify({ run_id: "RUN-1" }), "utf8");
      writeFileSync(join(root, "state/runtime/progress-snapshot.json"), JSON.stringify({ completed: ["A"] }), "utf8");

      const result = writeStateSnapshot({
        argv: [`--state-root=${root}`, "--prd=data/prd.json"],
        now: FIXED_NOW,
      });

      assert.equal(result.status, "ok");
      assert.equal(result.snapshot.generated_at, FIXED_NOW.toISOString());
      assert.deepEqual(result.snapshot.current_run, { run_id: "RUN-1" });
      assert.equal(existsSync(join(root, "state/progress-snapshots/latest.json")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("session memory implementation appends under caller supplied state root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-session-memory-"));
    try {
      const result = appendSessionMemory({
        argv: [
          `--state-root=${root}`,
          "--type=runner_checkpoint",
          "--source=test",
          "--summary=hello",
          "--refs=a,b",
        ],
        now: FIXED_NOW,
      });

      const lines = readFileSync(join(root, "state/session-memory.jsonl"), "utf8").trim().split("\n");
      assert.equal(result.status, "ok");
      assert.deepEqual(JSON.parse(lines[0]), {
        ts: FIXED_NOW.toISOString(),
        type: "runner_checkpoint",
        source: "test",
        summary: "hello",
        refs: ["a", "b"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("root evidence shims preserve CLI JSON output", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-root-evidence-shims-"));
    try {
      const snapshot = JSON.parse(execFileSync(process.execPath, [
        join(YOLO_DIR, "dist/state-snapshot.js"),
        `--state-root=${root}`,
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" }));
      assert.equal(snapshot.status, "ok");
      assert.equal(existsSync(snapshot.file), true);

      const memory = JSON.parse(execFileSync(process.execPath, [
        join(YOLO_DIR, "dist/session-memory.js"),
        `--state-root=${root}`,
        "--type=note",
        "--source=test",
        "--summary=root shim",
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" }));
      assert.equal(memory.status, "ok");
      assert.equal(JSON.parse(readFileSync(memory.file, "utf8").trim()).summary, "root shim");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
