import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildReviewFixPrd, inspectReviewFixLoop } from "../src/review/fix-loop.js";

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "yolo-review-fix-loop-"));
  mkdirSync(join(root, ".yolo", "keys"), { recursive: true });
  writeFileSync(join(root, ".yolo", "keys", "ledger.hmac"), "review-fix-loop-test-ledger-key", "utf8");
  return root;
}

const highFinding = {
  finding_id: "REV-HIGH-001",
  scanner_id: "unsafe-innerHTML",
  severity: "HIGH",
  fix_type: "CLAUDE_FIX",
  dimension: "security",
  file: "src/pages/profile.tsx:12",
  description: "Remove unsafe innerHTML usage",
  match: "innerHTML",
};

describe("review fix loop", () => {
  test("builds a traceable fix PRD from review findings", () => {
    const prd = buildReviewFixPrd([highFinding], {
      now: "2026-05-25T00:00:00.000Z",
      project: { name: "test", language: "typescript" },
    });

    assert.equal(prd.tasks.length, 1);
    assert.deepEqual(prd.tasks[0].requirement_ids, [`REQ-${prd.tasks[0].id}`]);
    assert.deepEqual(prd.tasks[0].design_ids, [`DES-${prd.tasks[0].id}`]);
    assert.equal(prd.requirements.length, 1);
    assert.equal(prd.designs.length, 1);
    assert.equal(prd.tasks[0].must_fix_before_ship, true);
  });

  test("blocks ship on HIGH or CRITICAL findings and writes lifecycle evidence", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const output = join(root, "fix-prd.json");
      const report = inspectReviewFixLoop({
        findings: [highFinding],
        output,
        projectRoot: root,
        stateRoot,
        writeLifecycle: true,
      }, {
        project: { name: "test", language: "typescript" },
      });

      assert.equal(report.status, "blocked");
      assert.equal(report.contract.blocks_execution, false);
      assert.equal(report.spec_governance.blocks_execution, false);
      assert.ok(report.blockers.some((blocker) => blocker.code === "REVIEW_FINDING_BLOCKS_SHIP"));
      assert.equal(existsSync(output), true);
      assert.equal(existsSync(join(stateRoot, "lifecycle/review-report.json")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
