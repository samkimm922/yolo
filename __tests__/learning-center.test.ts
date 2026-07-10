import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { registerGeneratedArtifactIntegrity } from "../src/runtime/evidence/artifact-integrity.js";
import { appendStateEvent, provisionLedgerHmacKey } from "../src/runtime/evidence/ledger.js";
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
import { runLearnCli } from "../src/runtime/learning/learn.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-learning-center-"));
}

function write(file, content) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function writeVerifiedShipEvidence(root: string) {
  const stateRoot = join(root, ".yolo");
  const stateDir = join(stateRoot, "state");
  const acceptancePath = join(stateRoot, "lifecycle", "acceptance-report.json");
  const deliveryPath = join(stateRoot, "lifecycle", "delivery-report.json");
  provisionLedgerHmacKey(stateRoot);
  write(acceptancePath, JSON.stringify({ status: "completed", report: { status: "pass" } }));
  registerGeneratedArtifactIntegrity([acceptancePath], { rootDir: root, stateRoot, source: "test-acceptance" });
  appendStateEvent(stateDir, "lifecycle.acceptance.report", {
    stage: "acceptance",
    status: "pass",
    artifact: acceptancePath,
  }, { stateRoot, source: "test-acceptance" });
  write(deliveryPath, JSON.stringify({
    status: "completed",
    report: { status: "success", acceptance_report_path: acceptancePath },
  }));
  registerGeneratedArtifactIntegrity([deliveryPath], { rootDir: root, stateRoot, source: "test-delivery" });
  appendStateEvent(stateDir, "lifecycle.delivery.report", {
    stage: "delivery",
    status: "success",
    artifact: deliveryPath,
  }, { stateRoot, source: "test-delivery" });
  return { stateRoot, acceptancePath, deliveryPath };
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
      const records = readFileSync(join(root, "state/learning.jsonl"), "utf8").trim().split("\n").map((text: string) => JSON.parse(text));

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

  test("migrateLegacyLearning ignores null / non-object JSONL lines instead of crashing", () => {
    const root = tempProject();
    try {
      write(join(root, "package.json"), JSON.stringify({ name: "yolo", type: "module" }));
      write(join(root, "src/runtime/.keep"), "");
      // Each legacy file has a valid entry plus a `null` line plus a non-JSON line.
      // Without the guard, the null line throws "Cannot read properties of null".
      write(join(root, "closed-loop/knowledge-base.jsonl"), [
        JSON.stringify({ id: "KN-1", type: "trap", content: "real entry", status: "active" }),
        "null",
        "not-json{",
        "",
      ].join("\n"));
      write(join(root, "closed-loop/lessons.jsonl"), [
        JSON.stringify({ task_id: "TASK-1", timestamp: "2026-05-25T00:00:00.000Z", result: "FAIL", knowledge: "real lesson" }),
        "null",
        "",
      ].join("\n"));
      write(join(root, "closed-loop/red-team-report.jsonl"), [
        JSON.stringify({ timestamp: "2026-05-25T00:00:01.000Z", attack_type: "console.log", blocked: true }),
        "null",
        "",
      ].join("\n"));

      const result = migrateLegacyLearning({ projectRoot: root, stateRoot: root });

      assert.equal(result.status, "ok");
      assert.equal(result.sources.legacy_knowledge, 1);
      assert.equal(result.sources.legacy_lessons, 1);
      assert.equal(result.sources.legacy_red_team, 1);
      const records = readFileSync(join(root, "state/learning.jsonl"), "utf8").trim().split("\n").map((text: string) => JSON.parse(text));
      assert.ok(records.some((record) => record.source === "legacy_knowledge" && record.lesson === "real entry"));
      assert.ok(records.some((record) => record.source === "legacy_lessons" && record.lesson === "real lesson"));
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
      const { stateRoot, deliveryPath } = writeVerifiedShipEvidence(root);
      appendLearningRecord({
        type: "retrospective",
        source: "test",
        source_outcome: "success",
        gate: "tsc",
        lesson: "TS2352 happened when a service used as unknown as",
        prevention: "Narrow the value before casting.",
        files: ["src/services/category.ts"],
        confidence: 8,
        evidence_refs: [deliveryPath],
      }, { projectRoot: root, stateRoot, now: new Date("2026-05-25T00:00:00.000Z") });
      appendLearningRecord({
        type: "failure",
        source: "test",
        gate: "eslint",
        lesson: "Unrelated eslint note",
        prevention: "Remove unused imports.",
        files: ["src/other.ts"],
        confidence: 8,
      }, { projectRoot: root, stateRoot, now: new Date("2026-05-25T00:00:01.000Z") });

      const task = {
        id: "FIX-LEARN-1",
        type: "bugfix",
        title: "Fix category service TS2352",
        description: "Avoid as unknown as",
        scope: { targets: [{ file: "src/services/category.ts" }] },
      };
      const result = retrieveRelevantLearningRecords({
        projectRoot: root,
        stateRoot,
        task,
        gate: "tsc",
        lastGateError: "src/services/category.ts error TS2352",
      });
      const pack = buildExperiencePackText({
        projectRoot: root,
        stateRoot,
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

  test("does not recommend a pattern recorded from a gate failure", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      runLearnCli([
        "--record",
        "--task=FIX-FAILED-RUN",
        "--result=fail",
        "--gate=gate-exit-1",
        "--message=src/services/category.ts error TS2352 from as unknown as",
        `--project-root=${root}`,
        `--state-root=${stateRoot}`,
      ]);

      const stored = JSON.parse(readFileSync(join(stateRoot, "state/learning.jsonl"), "utf8").trim());
      const result = retrieveRelevantLearningRecords({
        projectRoot: root,
        stateRoot,
        gate: "gate-exit-1",
        files: ["src/services/category.ts"],
        error_codes: ["TS2352"],
      });

      assert.equal(result.selected_count, 0);
      assert.equal(stored.source_outcome, "failure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when a claimed success has no signed ship evidence", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      appendLearningRecord({
        type: "retrospective",
        source: "test",
        source_outcome: "success",
        gate: "tsc",
        lesson: "TS2352 narrowing pattern",
        prevention: "Narrow before casting.",
        files: ["src/services/category.ts"],
        evidence_refs: [join(stateRoot, "lifecycle", "delivery-report.json")],
      }, { projectRoot: root, stateRoot });

      const result = retrieveRelevantLearningRecords({
        projectRoot: root,
        stateRoot,
        gate: "tsc",
        files: ["src/services/category.ts"],
      });

      assert.equal(result.selected_count, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when signed ship evidence is modified after digest registration", () => {
    const root = tempProject();
    try {
      const { stateRoot, deliveryPath } = writeVerifiedShipEvidence(root);
      appendLearningRecord({
        type: "retrospective",
        source: "test",
        source_outcome: "success",
        gate: "tsc",
        lesson: "TS2352 narrowing pattern",
        prevention: "Narrow before casting.",
        files: ["src/services/category.ts"],
        evidence_refs: [deliveryPath],
      }, { projectRoot: root, stateRoot });
      write(deliveryPath, JSON.stringify({
        status: "completed",
        report: { status: "success", acceptance_report_path: "tampered" },
      }));

      const result = retrieveRelevantLearningRecords({
        projectRoot: root,
        stateRoot,
        gate: "tsc",
        files: ["src/services/category.ts"],
      });

      assert.equal(result.selected_count, 0);
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
