import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as rawMkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  computeWorktreeSignature,
  writeSourceSnapshot,
  readSourceSnapshot,
  inspectWorktreeDrift,
} from "../src/lifecycle/source-snapshot.js";
import { inspectLifecycleDrift, inspectLifecycleGuard } from "../src/lifecycle/guard.js";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";
import { initLifecycleState } from "../src/lifecycle/state.js";

function mkdtempSync(prefix: string): string {
  const root = rawMkdtempSync(prefix);
  mkdirSync(join(root, ".yolo", "keys"), { recursive: true });
  writeFileSync(join(root, ".yolo", "keys", "ledger.hmac"), "source-snapshot-test-ledger-key", "utf8");
  return root;
}

function gitInit(root) {
  const result = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
  return result.status === 0;
}

describe("source-snapshot worktree drift detection", () => {
  test("git project: snapshot then edit source → drift detected", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-snap-drift-"));
    try {
      if (!gitInit(root)) return; // skip if git unavailable
      writeFileSync(join(root, "app.ts"), "export const x = 1;\n", "utf8");
      spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: root, encoding: "utf8" });

      writeSourceSnapshot({ projectRoot: root, stateRoot: join(root, ".yolo") });
      const before = inspectWorktreeDrift({ projectRoot: root, stateRoot: join(root, ".yolo") });
      assert.equal(before.has_drift, false);

      // Out-of-band edit to source.
      writeFileSync(join(root, "app.ts"), "export const x = 2;\n", "utf8");

      const after = inspectWorktreeDrift({ projectRoot: root, stateRoot: join(root, ".yolo") });
      assert.equal(after.has_drift, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("git project: editing only .yolo state does not trigger drift", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-snap-clean-"));
    try {
      if (!gitInit(root)) return;
      writeFileSync(join(root, "app.ts"), "export const x = 1;\n", "utf8");
      spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: root, encoding: "utf8" });

      writeSourceSnapshot({ projectRoot: root, stateRoot: join(root, ".yolo") });
      // Edit something under .yolo/ (excluded from signature).
      mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
      writeFileSync(join(root, ".yolo/lifecycle/notes.txt"), "changed\n", "utf8");

      const result = inspectWorktreeDrift({ projectRoot: root, stateRoot: join(root, ".yolo") });
      assert.equal(result.has_drift, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no snapshot present is explicitly unverifiable", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-snap-none-"));
    try {
      const result = inspectWorktreeDrift({ projectRoot: root, stateRoot: join(root, ".yolo") });
      assert.equal(result.status, "unverifiable");
      assert.equal(result.has_drift, null);
      assert.equal(result.reason, "no_snapshot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lifecycle guard blocks downstream work when the drift snapshot is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-snap-guard-none-"));
    try {
      initLifecycleState({ projectRoot: root });

      const result = inspectLifecycleGuard({ command: "yolo-run", projectRoot: root });

      assert.equal(result.status, "blocked");
      assert.ok(result.blockers.some((blocker) => blocker.code === "LIFECYCLE_DRIFT_WORKTREE_UNVERIFIABLE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-git project: walk-based signature detects source edits", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-snap-nongit-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/app.ts"), "export const x = 1;\n", "utf8");

      writeSourceSnapshot({ projectRoot: root, stateRoot: join(root, ".yolo") });
      assert.equal(inspectWorktreeDrift({ projectRoot: root, stateRoot: join(root, ".yolo") }).has_drift, false);

      writeFileSync(join(root, "src/app.ts"), "export const x = 2;\n", "utf8");
      assert.equal(inspectWorktreeDrift({ projectRoot: root, stateRoot: join(root, ".yolo") }).has_drift, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inspectLifecycleDrift surfaces WORKTREE_DIVERGED after out-of-band edit", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-snap-guard-"));
    try {
      if (!gitInit(root)) return;
      writeFileSync(join(root, "app.ts"), "export const x = 1;\n", "utf8");
      spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: root, encoding: "utf8" });

      // Seed a status.json declaring check completed, then snapshot.
      const lifecycleDir = join(root, ".yolo/lifecycle");
      mkdirSync(lifecycleDir, { recursive: true });
      writeFileSync(join(lifecycleDir, "status.json"), JSON.stringify({
        schema_version: "1.0",
        schema: "yolo.lifecycle.state.v1",
        project: { name: "test" },
        current_stage: "check",
        stages: [{ id: "check", status: "completed", artifact: "check-report.json" }],
      }), "utf8");
      writeSourceSnapshot({ projectRoot: root, stateRoot: join(root, ".yolo") });

      const before = inspectLifecycleDrift(root);
      const worktreeBefore = before.drift_records.filter((r) => r.code === "WORKTREE_DIVERGED");
      assert.equal(worktreeBefore.length, 0);

      writeFileSync(join(root, "app.ts"), "export const x = 2;\n", "utf8");
      const after = inspectLifecycleDrift(root);
      assert.ok(after.drift_records.some((r) => r.code === "WORKTREE_DIVERGED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("successful write-capable lifecycle stage refreshes post-run source snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-snap-run-"));
    try {
      if (!gitInit(root)) return;
      writeFileSync(join(root, "app.ts"), "export const x = 1;\n", "utf8");
      spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: root, encoding: "utf8" });

      const stateRoot = join(root, ".yolo");
      writeSourceSnapshot({ projectRoot: root, stateRoot });
      writeFileSync(join(root, "app.ts"), "export const x = 2;\n", "utf8");
      assert.equal(inspectWorktreeDrift({ projectRoot: root, stateRoot }).has_drift, true);

      const write = writeLifecycleStageReport("run", {
        status: "success",
        summary: "run changed source in-band",
      }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      assert.equal(write.stage_status, "completed");
      assert.ok(write.source_snapshot);
      assert.equal(inspectWorktreeDrift({ projectRoot: root, stateRoot }).has_drift, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocked write-capable lifecycle stage does not bless source drift", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-snap-run-blocked-"));
    try {
      if (!gitInit(root)) return;
      writeFileSync(join(root, "app.ts"), "export const x = 1;\n", "utf8");
      spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], { cwd: root, encoding: "utf8" });

      const stateRoot = join(root, ".yolo");
      writeSourceSnapshot({ projectRoot: root, stateRoot });
      writeFileSync(join(root, "app.ts"), "export const x = 2;\n", "utf8");

      const write = writeLifecycleStageReport("run", {
        status: "blocked",
        summary: "run did not complete cleanly",
      }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      assert.equal(write.stage_status, "blocked");
      assert.equal(write.source_snapshot, null);
      assert.equal(inspectWorktreeDrift({ projectRoot: root, stateRoot }).has_drift, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("snapshot write/read round-trip", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-snap-rw-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/app.ts"), "x\n", "utf8");
      const { payload } = writeSourceSnapshot({ projectRoot: root, stateRoot: join(root, ".yolo") });
      const read = readSourceSnapshot({ projectRoot: root, stateRoot: join(root, ".yolo") });
      assert.ok(read);
      assert.equal(read.signature, payload.signature);
      assert.equal(read.schema, "yolo.lifecycle.source_snapshot.v1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
