import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-lifecycle-progress-"));
}

describe("lifecycle progress", () => {
  test("writes stage reports, status, ledger, and session memory under the project state root", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const result = writeLifecycleStageReport("check", {
        status: "pass",
        summary: "check passed",
        artifacts: ["prd.json"],
        next_actions: ["Run /yolo-run only after user approval."],
      }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        now: "2026-05-25T00:00:00.000Z",
        skipSequenceCheck: true,
      });

      assert.equal(result.status, "ok");
      assert.equal(existsSync(join(stateRoot, "lifecycle/check-report.json")), true);
      assert.equal(existsSync(join(stateRoot, "lifecycle/status.json")), true);
      assert.equal(existsSync(join(stateRoot, "state/events.jsonl")), true);
      assert.equal(existsSync(join(stateRoot, "state/session-memory.jsonl")), true);

      const status = JSON.parse(readFileSync(join(stateRoot, "lifecycle/status.json"), "utf8"));
      assert.equal(status.current_stage, "run");
      assert.equal(status.stages.find((stage) => stage.id === "idea").status, "pending");
      assert.equal(status.stages.find((stage) => stage.id === "discovery").status, "pending");
      assert.equal(status.stages.find((stage) => stage.id === "check").status, "completed");
      assert.equal(status.stages.find((stage) => stage.id === "run").status, "active");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("promotes blocked stage reports into bounded learning candidates when requested", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const result = writeLifecycleStageReport("check", {
        status: "blocked",
        summary: "UI evidence plan missing",
        blockers: [{ code: "UI_EVIDENCE_PLAN_MISSING", message: "Add screenshots." }],
        next_actions: ["Add UI evidence plan."],
      }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        learnFailures: true,
        skipSequenceCheck: true,
      });

      assert.equal(result.learning.status, "ok");
      const learning = readFileSync(join(stateRoot, "state/learning.jsonl"), "utf8");
      assert.match(learning, /UI evidence plan missing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("negative: non-success report statuses do not complete lifecycle stages", () => {
    for (const reportStatus of ["ready", "skipped", "not_run", "indeterminate"]) {
      const root = tempProject();
      const stateRoot = join(root, ".yolo");
      try {
        const result = writeLifecycleStageReport("check", {
          status: reportStatus,
          summary: `${reportStatus} is not executable success`,
        }, {
          projectRoot: root,
          stateRoot,
          source: "unit",
          writeSessionMemory: false,
          skipSequenceCheck: true,
        });

        const status = JSON.parse(readFileSync(join(stateRoot, "lifecycle/status.json"), "utf8"));
        const checkStage = status.stages.find((stage) => stage.id === "check");
        assert.notEqual(result.stage_status, "completed", `${reportStatus} must not normalize to completed`);
        assert.notEqual(checkStage.status, "completed", `${reportStatus} must not mark lifecycle stage completed`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
