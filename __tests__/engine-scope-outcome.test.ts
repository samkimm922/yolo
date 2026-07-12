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
    // logMessage must now name the specific triggering file + engine path + a recovery path,
    // not just a generic "engine_self_modify_blocked" string.
    assert.match(outcome.logMessage, /scripts\/yolo\/runner\.js/);
    assert.match(outcome.logMessage, /scripts\/yolo\//);
    assert.match(outcome.logMessage, /engine_self_modify_blocked/);
    assert.equal(outcome.doneStatus, "blocked");
    assert.equal(outcome.doneReason, "engine_self_modify_blocked");
    assert.deepEqual(outcome.result, {
      status: "blocked",
      skip_kind: "blocked_skip_missing_evidence",
      reason: "engine_self_modify_blocked",
      matched_paths: ["scripts/yolo/runner.js"],
      matched_engine_paths: ["scripts/yolo/"],
      remediation: outcome.result.remediation,
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

  test("buildEngineSelfModificationBlockOutcome names the specific files that triggered the block", () => {
    const outcome = buildEngineSelfModificationBlockOutcome({
      task: {
        id: "FIX-MULTI",
        scope: { targets: [
          { file: "scripts/yolo/runner.js" },
          { file: ".yolo-backup/state.json" },
          { file: "src/app.ts" }, // not engine — must be excluded
        ] },
      },
    });

    assert.equal(outcome.shouldBlock, true);
    assert.deepEqual(outcome.result.matched_paths, ["scripts/yolo/runner.js", ".yolo-backup/state.json"]);
    assert.deepEqual(outcome.result.matched_engine_paths, ["scripts/yolo/", ".yolo-backup/"]);
  });

  test("buildEngineSelfModificationBlockOutcome distinguishes which enginePath matched for .claude/ targets", () => {
    const outcome = buildEngineSelfModificationBlockOutcome({
      task: {
        id: "FIX-CLAUDE",
        scope: { targets: [{ file: ".claude/settings.json" }] },
      },
    });

    assert.deepEqual(outcome.result.matched_paths, [".claude/settings.json"]);
    assert.deepEqual(outcome.result.matched_engine_paths, [".claude/"]);
  });

  test("buildEngineSelfModificationBlockOutcome provides concrete per-path remediation next actions", () => {
    const outcome = buildEngineSelfModificationBlockOutcome({
      task: {
        id: "FIX-REM",
        scope: { targets: [{ file: ".claude/settings.json" }] },
      },
    });

    const remediation = outcome.result.remediation;
    assert.ok(remediation, "block outcome must carry remediation guidance");
    assert.ok(Array.isArray(remediation.next_actions) && remediation.next_actions.length > 0,
      "remediation must enumerate concrete next actions");

    const message = JSON.stringify(remediation.next_actions);
    // The recovery hint must reference a concrete alternative, not just "blocked".
    assert.match(message, /\.claude\/settings\.json/);
    assert.match(message, /\.claude\//);
    // Generic "blocked" alone is not acceptable — there must be an action verb.
    assert.match(message, /(modify|review|init|maintain|open|use|edit|route|update)/i);

    // logMessage must also surface the recovery path so the operator sees it inline.
    assert.match(outcome.logMessage, /(modify|review|init|maintain|open|use|edit|route|update)/i);
    assert.match(outcome.logMessage, /\.claude\//);
  });

  test("buildEngineSelfModificationBlockOutcome gives scripts/yolo/ the engine-PR recovery path", () => {
    const outcome = buildEngineSelfModificationBlockOutcome({
      task: {
        id: "FIX-YOLO",
        scope: { targets: [{ file: "scripts/yolo/runner.js" }] },
      },
    });

    const message = JSON.stringify(outcome.result.remediation.next_actions);
    assert.match(message, /scripts\/yolo\/runner\.js/);
    assert.match(message, /scripts\/yolo\//);
    // scripts/yolo/ is engine source — recovery must route via a reviewed engine PR.
    assert.match(message, /(engine\s*PR|reviewed\s*engine|separate\s*review)/i);
  });
});
