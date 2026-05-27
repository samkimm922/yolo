import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildDryRunArtifactBaseRecord,
  completeDryRunArtifactTask,
  dryRunArtifactTarget,
  renderDryRunArtifact,
  runDryRunCommand,
} from "../src/runtime/execution/dry-run-artifact.js";

describe("dry-run artifact execution helpers", () => {
  test("dryRunArtifactTarget reads the first declared scope target", () => {
    assert.equal(dryRunArtifactTarget({ scope: { targets: [{ file: "state/dry-run/out.md" }] } }), "state/dry-run/out.md");
    assert.equal(dryRunArtifactTarget({}), "");
  });

  test("runDryRunCommand normalizes successful and failed command results", () => {
    const ok = runDryRunCommand("echo ok", {
      cwd: "/tmp",
      execFileSync: () => " ok\n",
    });
    assert.deepEqual(ok, { command: "echo ok", exit_code: 0, stdout: "ok", stderr: "" });

    const fail = runDryRunCommand("bad", {
      cwd: "/tmp",
      execFileSync: () => {
        const error = new Error("boom");
        error.status = 7;
        error.stdout = " partial ";
        error.stderr = " failed ";
        throw error;
      },
    });
    assert.deepEqual(fail, { command: "bad", exit_code: 7, stdout: "partial", stderr: "failed" });
  });

  test("renderDryRunArtifact writes deterministic JSON artifacts with command evidence", () => {
    const artifact = renderDryRunArtifact({
      id: "DRY-JSON",
      title: "JSON dry run",
      scope: { targets: [{ file: "state/dry-run/result.json" }] },
      test_generation: { required_commands: ["npm test"] },
    }, "/repo/scripts/yolo/prd.json", {
      yoloRoot: "/repo/scripts/yolo",
      projectRoot: "/repo",
      now: "2026-05-24T00:00:00.000Z",
      runCommand: (command) => ({ command, exit_code: 0, stdout: "ok", stderr: "" }),
    });
    const parsed = JSON.parse(artifact);
    assert.equal(parsed.generated_by, "yolo deterministic dry_run_artifact producer");
    assert.equal(parsed.current_prd, "prd.json");
    assert.equal(parsed.conclusion, "PASS");
    assert.deepEqual(parsed.command_results, [{ command: "npm test", exit_code: 0, stdout: "ok", stderr: "" }]);
  });

  test("buildDryRunArtifactBaseRecord preserves runner metadata shape", () => {
    assert.deepEqual(buildDryRunArtifactBaseRecord({
      taskId: "DRY-1",
      target: "state/dry-run/out.md",
      startedAtMs: 1000,
      nowMs: 2500,
      timestamp: "2026-05-24T00:00:00.000Z",
    }), {
      id: "DRY-1",
      timestamp: "2026-05-24T00:00:00.000Z",
      duration_sec: "1.5",
      diff_lines_added: 0,
      diff_lines_removed: 0,
      files_changed_total: 1,
      files_changed_business: 0,
      files_changed_metadata: 1,
      scope_targets_touched: ["state/dry-run/out.md"],
      scope_targets_missed: [],
      out_of_scope_files: [],
      deterministic_artifact: true,
    });
  });

  test("completeDryRunArtifactTask writes the artifact and records a pass transition", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-dryrun-pass-"));
    try {
      const task = {
        id: "DRY-PASS",
        title: "Dry run pass",
        description: "Write an artifact",
        scope: { targets: [{ file: "state/dry-run/out.md" }] },
      };
      const transitions = [];
      const done = [];
      const progress = [];
      const result = completeDryRunArtifactTask({
        task,
        prdPath: join(root, "scripts/yolo/prd.json"),
        startedAtMs: Date.now(),
        yoloRoot: join(root, "scripts/yolo"),
        projectRoot: root,
        loadPRD: () => ({ tasks: [task] }),
        taskPostconditionsPass: () => ({ passed: true, failed: [] }),
        recordTaskTransition: (prdPath, transition) => transitions.push({ prdPath, transition }),
        logTaskDone: (...args) => done.push(args),
        logProgress: (...args) => progress.push(args),
      });

      assert.deepEqual(result, { status: "completed" });
      assert.equal(existsSync(join(root, "state/dry-run/out.md")), true);
      assert.match(readFileSync(join(root, "state/dry-run/out.md"), "utf8"), /Model call: skipped/);
      assert.equal(transitions[0].transition.result.status, "PASS");
      assert.equal(transitions[0].transition.result.deterministic_artifact, true);
      assert.deepEqual(transitions[0].transition.result.scope_targets_touched, ["state/dry-run/out.md"]);
      assert.equal(done[0][1], "completed");
      assert.deepEqual(progress[0], ["DRY-PASS", "artifact", "deterministic PASS: state/dry-run/out.md"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("completeDryRunArtifactTask fails closed when postconditions fail", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-dryrun-fail-"));
    try {
      const task = {
        id: "DRY-FAIL",
        scope: { targets: [{ file: "state/dry-run/out.md" }] },
      };
      const transitions = [];
      const result = completeDryRunArtifactTask({
        task,
        prdPath: join(root, "scripts/yolo/prd.json"),
        startedAtMs: Date.now(),
        yoloRoot: join(root, "scripts/yolo"),
        projectRoot: root,
        loadPRD: () => ({ tasks: [task] }),
        taskPostconditionsPass: () => ({ passed: false, failed: ["file_exists: missing"] }),
        recordTaskTransition: (prdPath, transition) => transitions.push({ prdPath, transition }),
      });

      assert.deepEqual(result, { status: "failed", reason: "post_conditions failed: file_exists: missing" });
      assert.equal(transitions[0].transition.result.status, "FAIL");
      assert.equal(transitions[0].transition.prd_update.status, "failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
