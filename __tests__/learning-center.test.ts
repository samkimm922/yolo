import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  appendLearningRecord,
  buildExperiencePackText,
  buildLearningIndexMarkdown,
  buildLessonsPlaybookMarkdown,
  createLearningRecord,
  migrateLegacyLearning,
  retrieveRelevantLearningRecords,
  summarizeLearningCenter,
} from "../src/runtime/learning/center.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-learning-center-"));
}

function write(file, content) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content, "utf8");
}

describe("learning center", () => {
  test("createLearningRecord builds deterministic fingerprints from task evidence", () => {
    const record = createLearningRecord({
      type: "failure",
      gate: "tsc",
      lesson: "TS2352 caused by as unknown as in src/services/category.ts",
      prevention: "Do not use as unknown as; narrow the type.",
      files: ["src/services/category.ts"],
    }, { now: new Date("2026-05-25T00:00:00.000Z") });

    assert.equal(record.schema_version, "1.0");
    assert.equal(record.type, "failure");
    assert.equal(record.gate, "tsc");
    assert.deepEqual(record.fingerprint.error_codes, ["TS2352"]);
    assert.deepEqual(record.fingerprint.risk_patterns, ["double_type_assertion"]);
    assert.deepEqual(record.fingerprint.directories, ["src/services"]);
    assert.match(record.id, /^learn_/);
  });

  test("migrateLegacyLearning imports old lessons, knowledge, red-team, and learned rules without deleting sources", () => {
    const root = tempProject();
    try {
      write(join(root, "package.json"), JSON.stringify({ name: "yolo", type: "module" }));
      write(join(root, "src/runtime/.keep"), "");
      write(join(root, "closed-loop/knowledge-base.jsonl"), [
        JSON.stringify({
          id: "KN-1",
          type: "trap",
          content: "Avoid as unknown as in service layer",
          confidence: 8,
          status: "active",
          related_files: ["src/services/category.ts"],
        }),
        "",
      ].join("\n"));
      write(join(root, "closed-loop/lessons.jsonl"), [
        JSON.stringify({
          task_id: "TASK-1",
          timestamp: "2026-05-25T00:00:00.000Z",
          result: "FAIL",
          knowledge_type: "gate_knowledge",
          knowledge: "File Scope Guard: changed too many files",
        }),
        "",
      ].join("\n"));
      write(join(root, "closed-loop/red-team-report.jsonl"), [
        JSON.stringify({
          timestamp: "2026-05-25T00:00:01.000Z",
          attack_type: "console.log",
          filename: "bad-console-log.ts",
          blocked: true,
        }),
        "",
      ].join("\n"));
      write(join(root, "learned-rules.json"), JSON.stringify({
        tsc: {
          rule: "Avoid TS2352",
          strategy: "Run type narrowing before casting",
          gate: "gate-exit-1",
          learned_at: "2026-05-25",
        },
      }));

      const first = migrateLegacyLearning({ projectRoot: root, stateRoot: root });
      const second = migrateLegacyLearning({ projectRoot: root, stateRoot: root });
      const records = readFileSync(join(root, "state/learning.jsonl"), "utf8").trim().split("\n").map(JSON.parse);

      assert.equal(first.status, "ok");
      assert.equal(second.total_count, first.total_count);
      assert.equal(records.length, first.total_count);
      assert.ok(records.some((record) => record.source === "legacy_knowledge"));
      assert.ok(records.some((record) => record.source === "legacy_lessons"));
      assert.ok(records.some((record) => record.source === "legacy_red_team"));
      assert.ok(records.some((record) => record.source === "learned_rules"));
      assert.equal(existsSync(join(root, "closed-loop/knowledge-base.jsonl")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appendLearningRecord and docs summarize the unified ledger", () => {
    const root = tempProject();
    try {
      appendLearningRecord({
        type: "failure",
        source: "test",
        gate: "file_lines_max",
        lesson: "File exceeded limit",
        prevention: "Split before editing",
        files: ["src/runtime/runner-core.ts"],
        confidence: 6,
      }, { projectRoot: root, stateRoot: root, now: new Date("2026-05-25T00:00:00.000Z") });

      const summary = summarizeLearningCenter({ projectRoot: root, stateRoot: root });
      const index = buildLearningIndexMarkdown({ projectRoot: root, stateRoot: root, now: new Date("2026-05-25T00:00:00.000Z") });
      const playbook = buildLessonsPlaybookMarkdown({ projectRoot: root, stateRoot: root, now: new Date("2026-05-25T00:00:00.000Z") });

      assert.equal(summary.record_count, 1);
      assert.match(index, /Records: 1/);
      assert.match(index, /file_lines_max/);
      assert.match(playbook, /File exceeded limit/);
      assert.match(playbook, /Split before editing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retrieves a small relevant experience pack for the current task", () => {
    const root = tempProject();
    try {
      appendLearningRecord({
        type: "failure",
        source: "test",
        gate: "tsc",
        lesson: "TS2352 happened when a service used as unknown as",
        prevention: "Narrow the value before casting.",
        files: ["src/services/category.ts"],
        confidence: 8,
      }, { projectRoot: root, stateRoot: root, now: new Date("2026-05-25T00:00:00.000Z") });
      appendLearningRecord({
        type: "failure",
        source: "test",
        gate: "eslint",
        lesson: "Unrelated eslint note",
        prevention: "Remove unused imports.",
        files: ["src/other.ts"],
        confidence: 8,
      }, { projectRoot: root, stateRoot: root, now: new Date("2026-05-25T00:00:01.000Z") });

      const task = {
        id: "FIX-LEARN-1",
        type: "bugfix",
        title: "Fix category service TS2352",
        description: "Avoid as unknown as",
        scope: { targets: [{ file: "src/services/category.ts" }] },
      };
      const result = retrieveRelevantLearningRecords({
        projectRoot: root,
        stateRoot: root,
        task,
        gate: "tsc",
        lastGateError: "src/services/category.ts error TS2352",
      });
      const pack = buildExperiencePackText({
        projectRoot: root,
        stateRoot: root,
        task,
        gate: "tsc",
        lastGateError: "src/services/category.ts error TS2352",
      });

      assert.equal(result.selected_count, 1);
      assert.equal(result.selected[0].record.gate, "tsc");
      assert.match(pack, /Relevant Experience Pack/);
      assert.match(pack, /TS2352 happened/);
      assert.doesNotMatch(pack, /Unrelated eslint note/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("learn CLI records failures under the supplied project state root", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      execFileSync(process.execPath, [
        resolve(import.meta.dirname, "../dist/src/runtime/learning/learn.js"),
        "--record",
        "--task=FIX-LEARN-CLI",
        "--result=fail",
        "--gate=gate-exit-1",
        "--message=src/a.ts error TS2352",
        `--project-root=${root}`,
        `--state-root=${stateRoot}`,
      ], { encoding: "utf8" });

      const learning = readFileSync(join(stateRoot, "state/learning.jsonl"), "utf8");
      const progress = readFileSync(join(stateRoot, "state/runtime/progress.txt"), "utf8");
      assert.match(learning, /FIX-LEARN-CLI/);
      assert.match(learning, /TS2352/);
      assert.match(progress, /FIX-LEARN-CLI/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
