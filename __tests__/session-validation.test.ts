import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runAtomicTaskDoctorGate,
  shouldRunAtomicTaskDoctor,
  validateContextPackBeforeSession,
  validateTestGenerationAfterSession,
} from "../src/runtime/execution/session-validation.js";

describe("session validation helpers", () => {
  test("validateContextPackBeforeSession writes artifact and passes strict task packs", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "yolo-session-validation-"));
    const runtimeDir = join(rootDir, "state/runtime");
    try {
      mkdirSync(runtimeDir, { recursive: true });
      const task = {
        id: "FIX-SESSION-001",
        title: "Validate context pack",
        type: "bugfix",
        status: "pending",
        priority: "P1",
        scope: { targets: [{ file: "src/value.ts" }], max_files: 1 },
        post_conditions: [{
          id: "POST-FILE",
          type: "file_exists",
          severity: "FAIL",
          params: { file: "src/value.ts" },
        }],
      };

      const result = await validateContextPackBeforeSession({ task, attempt: 2, rootDir, runtimeDir });

      assert.equal(result.ok, true);
      assert.equal(result.result.status, "pass");
      assert.equal(result.artifact, join(runtimeDir, "context-pack-FIX-SESSION-001-2.json"));
      assert.equal(existsSync(result.artifact), true);
      const artifact = JSON.parse(readFileSync(result.artifact, "utf8"));
      assert.equal(artifact.pack.task.id, "FIX-SESSION-001");
      assert.equal(artifact.pack.attempt, 2);
      assert.equal(artifact.result.blocks_execution, false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("validateContextPackBeforeSession fails closed when validator import fails", async () => {
    const result = await validateContextPackBeforeSession({
      task: { id: "FIX-SESSION-002" },
      attempt: 1,
      rootDir: "/tmp/noop",
      runtimeDir: "/tmp/noop",
      loadContextPackModule: async () => {
        throw new Error("validator missing");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.result.blocks_execution, true);
    assert.equal(result.result.failures[0].code, "CONTEXT_PACK_VALIDATOR_ERROR");
  });

  test("validateContextPackBeforeSession fails closed when a task target escapes the project root", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "yolo-session-validation-target-"));
    const runtimeDir = join(rootDir, "state/runtime");
    try {
      mkdirSync(runtimeDir, { recursive: true });
      const result = await validateContextPackBeforeSession({
        task: {
          id: "FIX-SESSION-PATH-001",
          title: "Unsafe target",
          type: "bugfix",
          status: "pending",
          priority: "P1",
          scope: { targets: [{ file: "../outside.ts" }] },
          post_conditions: [{
            id: "POST-FILE",
            type: "file_exists",
            severity: "FAIL",
            params: { file: "src/value.ts" },
          }],
        },
        attempt: 1,
        rootDir,
        runtimeDir,
      });

      assert.equal(result.ok, false);
      assert.equal(result.result.blocks_execution, true);
      assert.equal(result.result.failures[0].code, "RUNTIME_INVARIANT_VIOLATED:task_path_outside_project_root");
      assert.equal(result.result.failures[0].violations[0].role, "scope.targets[0].file");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("validateContextPackBeforeSession fails closed when a post-condition path escapes the project root", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "yolo-session-validation-post-"));
    const runtimeDir = join(rootDir, "state/runtime");
    try {
      mkdirSync(runtimeDir, { recursive: true });
      const result = await validateContextPackBeforeSession({
        task: {
          id: "FIX-SESSION-PATH-002",
          title: "Unsafe post-condition",
          type: "bugfix",
          status: "pending",
          priority: "P1",
          scope: { targets: [{ file: "src/value.ts" }] },
          post_conditions: [{
            id: "POST-FILE",
            type: "file_exists",
            severity: "FAIL",
            params: { file: "../../outside.ts" },
          }],
        },
        attempt: 1,
        rootDir,
        runtimeDir,
      });

      assert.equal(result.ok, false);
      assert.equal(result.result.blocks_execution, true);
      assert.equal(result.result.failures[0].code, "RUNTIME_INVARIANT_VIOLATED:task_path_outside_project_root");
      assert.equal(result.result.failures[0].violations[0].role, "post_conditions[0].params.file");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test("validateContextPackBeforeSession fails closed when symlink target resolves outside the project root", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "yolo-session-validation-symlink-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "yolo-session-validation-outside-"));
    const runtimeDir = join(rootDir, "state/runtime");
    try {
      mkdirSync(join(rootDir, "src"), { recursive: true });
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(join(outsideDir, "secret.ts"), "export const secret = true;\n", "utf8");
      symlinkSync(join(outsideDir, "secret.ts"), join(rootDir, "src", "linked-secret.ts"));

      const result = await validateContextPackBeforeSession({
        task: {
          id: "FIX-SESSION-PATH-003",
          title: "Unsafe symlink target",
          type: "bugfix",
          status: "pending",
          priority: "P1",
          scope: { targets: [{ file: "src/linked-secret.ts" }] },
          post_conditions: [{
            id: "POST-FILE",
            type: "file_exists",
            severity: "FAIL",
            params: { file: "src/linked-secret.ts" },
          }],
        },
        attempt: 1,
        rootDir,
        runtimeDir,
      });

      assert.equal(result.ok, false);
      assert.equal(result.result.blocks_execution, true);
      assert.equal(result.result.failures[0].code, "RUNTIME_INVARIANT_VIOLATED:task_path_outside_project_root");
      assert.equal(result.result.failures[0].violations[0].role, "scope.targets[0].file");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("validateTestGenerationAfterSession delegates validator and fails closed on errors", async () => {
    const pass = await validateTestGenerationAfterSession({
      task: { id: "FIX-SESSION-003" },
      cwd: "/tmp/noop",
      loadTestGenerationModule: async () => ({
        validateTestGeneration: (task, options) => ({
          status: "pass",
          blocks_execution: false,
          task_id: task.id,
          cwd: options.cwd,
        }),
      }),
    });
    assert.deepEqual(pass, {
      status: "pass",
      blocks_execution: false,
      task_id: "FIX-SESSION-003",
      cwd: "/tmp/noop",
    });

    const blocked = await validateTestGenerationAfterSession({
      task: { id: "FIX-SESSION-004" },
      cwd: "/tmp/noop",
      loadTestGenerationModule: async () => {
        throw new Error("test validator missing");
      },
    });
    assert.equal(blocked.blocks_execution, true);
    assert.equal(blocked.failures[0].code, "TEST_GENERATION_VALIDATOR_ERROR");
  });

  test("runAtomicTaskDoctorGate preserves skip, pass, must-split, and error semantics", () => {
    assert.equal(shouldRunAtomicTaskDoctor({ status: "completed", type: "bugfix" }), false);
    assert.equal(shouldRunAtomicTaskDoctor({ status: "pending", task_kind: "dry_run_artifact", type: "bugfix" }), false);
    assert.equal(shouldRunAtomicTaskDoctor({ status: "pending", type: "bugfix" }), true);

    const skipped = runAtomicTaskDoctorGate({ task: { id: "FIX-SESSION-005", task_kind: "dry_run_artifact" } });
    assert.deepEqual(skipped, { ok: true, skipped: true });

    const logs = [];
    const passed = runAtomicTaskDoctorGate({
      task: { id: "FIX-SESSION-006", status: "pending", type: "bugfix" },
      prdPath: "prd.json",
      yoloRoot: "/tmp/yolo",
      inspectAtomicTask: () => ({ status: "pass", mode: "direct_patch", score: 10, next_action: "execute" }),
      logTaskBash: (...args) => logs.push(args),
    });
    assert.equal(passed.ok, true);
    assert.equal(logs[0][1], "atomic-task-doctor");
    assert.equal(logs[0][2], "pass");

    const split = runAtomicTaskDoctorGate({
      task: { id: "FIX-SESSION-007", status: "pending", type: "feature" },
      inspectAtomicTask: () => ({ status: "fail", mode: "must_split", score: 90, evidence_file: "evidence.json" }),
    });
    assert.equal(split.ok, false);
    assert.equal(split.result.mode, "must_split");

    const failed = runAtomicTaskDoctorGate({
      task: { id: "FIX-SESSION-008", status: "pending", type: "security" },
      inspectAtomicTask: () => {
        throw new Error("doctor exploded");
      },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.result.mode, "research_only");
    assert.equal(failed.result.error, "doctor exploded");
  });
});
