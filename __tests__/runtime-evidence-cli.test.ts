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

  // P10.S3 chokepoint: session-memory.jsonl is broadcast verbatim by the progress
  // dashboard via /lifecycle.json (readEvents walks state/*.jsonl). summary/refs
  // originate from runner checkpoints (task failReason, command-output fragments)
  // and can carry secrets. The writer must redact before persisting.
  describe("session-memory redacts secrets before persisting", () => {
    function runWithSummary(summary, refs = "") {
      const root = mkdtempSync(join(tmpdir(), "yolo-session-memory-redact-"));
      try {
        const argv = [
          `--state-root=${root}`,
          "--type=runner_checkpoint",
          "--source=test",
          `--summary=${summary}`,
        ];
        if (refs) argv.push(`--refs=${refs}`);
        const result = appendSessionMemory({ argv, now: FIXED_NOW });
        const persisted = JSON.parse(readFileSync(result.file, "utf8").trim());
        return { result, persisted };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    test("redacts OpenAI-style API key in summary", () => {
      const { result, persisted } = runWithSummary(
        "task TASK-001 failed: invalid api key sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234 in gate output",
      );
      assert.equal(
        persisted.summary,
        "task TASK-001 failed: invalid api key [REDACTED:sk-key] in gate output",
      );
      assert.equal(result.record.summary, persisted.summary);
      assert.equal(persisted.summary.includes("sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX1234"), false);
    });

    test("redacts GitHub token in summary", () => {
      const { persisted } = runWithSummary(
        "push failed: gh auth token ghp_1234567890abcdefghijklmnopqrstuvwxYZ01 not authorized",
      );
      assert.equal(persisted.summary.includes("ghp_1234567890abcdefghijklmnopqrstuvwxYZ01"), false);
      assert.equal(persisted.summary.includes("[REDACTED:gh-token]"), true);
    });

    test("redacts secrets in refs array", () => {
      const { persisted } = runWithSummary(
        "checkpoint",
        "state/foo.json,bearer token sk-proj-REFSSECRET1234567890ABCDEFGH",
      );
      assert.equal(persisted.refs.some((r) => r.includes("sk-proj-REFSSECRET")), false);
      assert.equal(persisted.refs.some((r) => r.includes("[REDACTED:sk-key]")), true);
    });

    test("preserves non-secret content unchanged", () => {
      const { persisted } = runWithSummary(
        "task TASK-002 done: gate passed, commit ok",
        "state/foo.json,state/bar.json",
      );
      assert.equal(persisted.summary, "task TASK-002 done: gate passed, commit ok");
      assert.deepEqual(persisted.refs, ["state/foo.json", "state/bar.json"]);
    });
  });
});
