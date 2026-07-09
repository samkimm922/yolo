import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  allowsMetadataOnlyCompletion,
  buildPostCommitOutcome,
  shouldRunPostCommitPostconditions,
} from "../src/runtime/execution/post-commit-outcome.js";

describe("post commit outcome helpers", () => {
  test("postconditions run only after real committed code", () => {
    assert.equal(shouldRunPostCommitPostconditions({ committed: true, hasRealCode: true }), true);
    assert.equal(shouldRunPostCommitPostconditions({ committed: true, hasRealCode: false }), false);
    assert.equal(shouldRunPostCommitPostconditions({ committed: false, hasRealCode: true, nonBlocking: true }), false);
    assert.equal(shouldRunPostCommitPostconditions({ blocked: true, hasRealCode: true }), false);
  });

  test("blocked commit results fail closed with the block reason", () => {
    const outcome = buildPostCommitOutcome({
      task: { id: "FIX-1" },
      commitResult: { blocked: true, blockReason: "scope audit blocked" },
      baseRecord: { id: "FIX-1", files_changed_total: 2 },
    });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "scope audit blocked");
    assert.equal(outcome.doneStatus, "failed");
    assert.equal(outcome.doneReason, "scope audit blocked");
    assert.equal(outcome.transition.task_id, "FIX-1");
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.result.reason, "scope audit blocked");
    assert.equal(outcome.transition.result.files_changed_total, 2);
    assert.deepEqual(outcome.transition.prd_update, {
      status: "failed",
      failReason: "scope audit blocked",
    });
  });

  test("dry-run artifact tasks fail closed when scoped targets were missed", () => {
    const outcome = buildPostCommitOutcome({
      task: { id: "DRY-1", task_kind: "dry_run_artifact" },
      commitResult: { committed: true, hasRealCode: true },
      baseRecord: {
        id: "DRY-1",
        scope_targets_missed: ["state/dry-run/report.md"],
      },
      postResult: { passed: true, failed: [] },
    });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "scope targets missed: state/dry-run/report.md");
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.prd_update.status, "failed");
  });

  test("failed postconditions create a postcondition failure transition", () => {
    const outcome = buildPostCommitOutcome({
      task: { id: "FIX-2" },
      commitResult: { committed: true, hasRealCode: true },
      baseRecord: { id: "FIX-2" },
      postResult: { passed: false, failed: ["expected file missing"] },
    });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "post_conditions failed: expected file missing");
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.prd_update.status, "failed");
    assert.equal(outcome.transition.prd_update.phase, "postcondition");
    assert.equal(outcome.transition.prd_update.failReason, "post_conditions failed: expected file missing");
  });

  test("passed postconditions complete the task", () => {
    const outcome = buildPostCommitOutcome({
      task: { id: "FIX-3" },
      commitResult: { committed: true, hasRealCode: true },
      baseRecord: { id: "FIX-3", files_changed_total: 1 },
      postResult: { passed: true, failed: [] },
    });

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reason, undefined);
    assert.equal(outcome.doneStatus, "completed");
    assert.equal(outcome.doneReason, undefined);
    assert.equal(outcome.transition.result.status, "PASS");
    assert.equal(outcome.transition.result.files_changed_total, 1);
    assert.deepEqual(outcome.transition.prd_update, {
      status: "done",
      phase: "done",
    });
  });

  test("YB-005 legacy nonblocking git_add_failed fails closed instead of completing", () => {
    const outcome = buildPostCommitOutcome({
      task: { id: "FIX-3B" },
      commitResult: {
        committed: false,
        hasRealCode: true,
        nonBlocking: true,
        commitWarning: "git_add_failed",
      },
      baseRecord: { id: "FIX-3B", files_changed_total: 1 },
      postResult: { passed: true, failed: [] },
    });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "commit 失败: git_add_failed");
    assert.equal(outcome.doneStatus, "failed");
    assert.equal(outcome.doneReason, "commit 失败: git_add_failed");
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.result.commit_failure, "git_add_failed");
    assert.equal("commit_warning" in outcome.transition.result, false);
    assert.deepEqual(outcome.transition.prd_update, {
      status: "failed",
      failReason: "commit 失败: git_add_failed",
    });
  });

  test("metadata-only outcomes fail as no-code work", () => {
    const outcome = buildPostCommitOutcome({
      task: { id: "FIX-4" },
      commitResult: { committed: false, hasRealCode: false },
      baseRecord: { id: "FIX-4" },
    });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "0 业务代码");
    assert.equal(outcome.doneReason, "0 业务代码");
    assert.equal(outcome.transition.result.status, "FAILED_NO_CODE");
    assert.equal(outcome.transition.result.reason, "仅元数据改动,无真实业务代码");
    assert.deepEqual(outcome.transition.prd_update, {
      status: "failed_no_code",
      failReason: "0 业务代码改动",
    });
  });

  test("metadata-only completion is limited to scaffold/config targets", () => {
    const metadata = {
      scope_targets_touched: ["package.json"],
      metadataFiles: ["package.json"],
    };
    assert.equal(allowsMetadataOnlyCompletion({
      id: "CFG-1",
      scope: { targets: [{ file: "package.json" }], config_file_patterns: ["package.json"] },
    }, metadata), true);
    assert.equal(allowsMetadataOnlyCompletion({
      id: "BUSINESS-1",
      scope: { targets: [{ file: "src/app.ts" }] },
    }, { scope_targets_touched: ["src/app.ts"], metadataFiles: ["src/app.ts"] }), false);

    const outcome = buildPostCommitOutcome({
      task: {
        id: "SCAFFOLD-1",
        task_kind: "greenfield_scaffold",
        scope: { targets: [{ file: "package.json" }] },
      },
      commitResult: {
        committed: false,
        hasRealCode: false,
        metadataFiles: ["package.json"],
      },
      baseRecord: {
        ...metadata,
        id: "SCAFFOLD-1",
        files_changed_total: 1,
        files_changed_business: 0,
        files_changed_metadata: 1,
      },
    });

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.transition.result.status, "PASS");
    assert.equal(outcome.transition.result.metadata_only_completion, true);
  });

  test("blocking commit failures produce a generic failure transition", () => {
    const outcome = buildPostCommitOutcome({
      task: { id: "FIX-5" },
      commitResult: { committed: false, hasRealCode: true },
      baseRecord: { id: "FIX-5" },
    });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "commit 失败");
    assert.equal(outcome.doneReason, "commit 失败");
    assert.equal(outcome.transition.result.status, "FAIL");
    assert.equal(outcome.transition.result.reason, "commit 失败");
    assert.equal(outcome.transition.result.commit_failure, "commit_failed");
    assert.deepEqual(outcome.transition.prd_update, {
      status: "failed",
      failReason: "commit 失败",
    });
  });
});
