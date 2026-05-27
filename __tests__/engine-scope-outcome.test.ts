import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEngineSelfModificationBlockOutcome,
  isAllowedDryRunArtifactTarget,
  taskTargetsEngineFiles,
} from "../src/runtime/execution/engine-scope-outcome.js";

describe("engine scope outcome helpers", () => {
  test("isAllowedDryRunArtifactTarget allows only dry-run artifacts under state/dry-run", () => {
    assert.equal(isAllowedDryRunArtifactTarget(
      { task_kind: "dry_run_artifact" },
      "scripts/yolo/state/dry-run/report.md",
    ), true);
    assert.equal(isAllowedDryRunArtifactTarget(
      { task_kind: "feature" },
      "scripts/yolo/state/dry-run/report.md",
    ), false);
    assert.equal(isAllowedDryRunArtifactTarget(
      { task_kind: "dry_run_artifact" },
      "scripts/yolo/runner.js",
    ), false);
  });

  test("taskTargetsEngineFiles blocks runner, backup, and claude paths", () => {
    assert.equal(taskTargetsEngineFiles({
      scope: { targets: [{ file: "scripts/yolo/runner.js" }] },
    }), true);
    assert.equal(taskTargetsEngineFiles({
      scope: { targets: [{ file: ".yolo-backup/state.json" }] },
    }), true);
    assert.equal(taskTargetsEngineFiles({
      scope: { targets: [{ file: ".claude/settings.json" }] },
    }), true);
    assert.equal(taskTargetsEngineFiles({
      task_kind: "dry_run_artifact",
      scope: { targets: [{ file: "scripts/yolo/state/dry-run/report.md" }] },
    }), false);
  });

  test("buildEngineSelfModificationBlockOutcome creates the existing blocked transition shape", () => {
    const outcome = buildEngineSelfModificationBlockOutcome({
      task: {
        id: "FIX-1",
        scope: { targets: [{ file: "scripts/yolo/runner.js" }] },
      },
    });

    assert.equal(outcome.shouldBlock, true);
    assert.equal(outcome.logMessage, "targets engine files, blocked (engine_self_modify_blocked)");
    assert.equal(outcome.doneStatus, "blocked");
    assert.equal(outcome.doneReason, "engine_self_modify_blocked");
    assert.deepEqual(outcome.result, {
      status: "blocked",
      skip_kind: "blocked_skip_missing_evidence",
      reason: "engine_self_modify_blocked",
    });
    assert.equal(outcome.transition.result.status, "BLOCKED");
    assert.equal(outcome.transition.result.reason, "engine_self_modify_blocked");
    assert.equal(outcome.transition.result.skip_kind, "blocked_skip_missing_evidence");
    assert.equal(outcome.transition.prd_update.status, "blocked");
    assert.equal(outcome.transition.prd_update.phaseDetail, "engine_self_modify_blocked");
    assert.equal(outcome.transition.prd_update.counts_as_completed, false);
  });

  test("buildEngineSelfModificationBlockOutcome skips normal project targets", () => {
    assert.deepEqual(buildEngineSelfModificationBlockOutcome({
      task: {
        id: "FIX-2",
        scope: { targets: [{ file: "src/app.ts" }] },
      },
    }), { shouldBlock: false });
  });
});
