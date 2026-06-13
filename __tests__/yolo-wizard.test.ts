import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  friendlyPreflightSummary,
  inspectWizardCheck,
  inspectWizardRunGuard,
  normalizeMenuChoice,
  planToMarkdown,
} from "../tools/yolo-wizard.js";
import { initLifecycleState } from "../src/lifecycle/state.js";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";

function approvedDemandFields(targetFiles = []) {
  const quality = {
    schema_version: "1.0",
    schema: "yolo.demand.quality.v1",
    status: "pass",
    total_score: 100,
    dimensions: [],
  };
  return {
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-WIZARD-CHECK-TEST",
      approval: { approved: true, effective_for_prd: true },
      project_facts: {
        target_files: targetFiles.map((file) => ({ file, status: "verified" })),
        assumptions: [],
      },
      quality_report: quality,
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: quality,
    },
  };
}

function tracedRequirement(id, text) {
  return {
    id,
    text,
    demand_trace: { evidence: [`EVID-${id}`] },
  };
}

describe("non-technical YOLO wizard helpers", () => {
  test("normalizes numeric and plain-language menu choices", () => {
    assert.equal(normalizeMenuChoice("1"), "init");
    assert.equal(normalizeMenuChoice("计划"), "plan");
    assert.equal(normalizeMenuChoice("3"), "check");
    assert.equal(normalizeMenuChoice("执行"), "run");
    assert.equal(normalizeMenuChoice("退出"), "quit");
    assert.equal(normalizeMenuChoice("wat"), "unknown");
  });

  test("planToMarkdown renders a readable plan without executing actions", () => {
    const markdown = planToMarkdown({
      status: "success",
      summary: "PI plan created; execution was not started.",
      artifacts: { prdPath: "/tmp/project/.yolo/plans/prd.json" },
      plan: {
        actions: [
          { id: "pi.intake", summary: "Turn requirement into atomic findings." },
          { id: "pi.prd.preflight", summary: "Validate PRD before implementation." },
        ],
      },
      next_actions: ["Review the generated action list."],
    });

    assert.match(markdown, /# YOLO Plan/);
    assert.match(markdown, /prdPath: \/tmp\/project\/\.yolo\/plans\/prd\.json/);
    assert.match(markdown, /pi\.prd\.preflight/);
    assert.match(markdown, /Review the generated action list/);
  });

  test("friendlyPreflightSummary explains pass and blocked states in plain language", () => {
    assert.equal(friendlyPreflightSummary({
      runner_readiness: { can_execute: true, next_actions: ["run"] },
    }).ok, true);

    const blocked = friendlyPreflightSummary({
      blocked_count: 2,
      runner_readiness: { can_execute: false, next_actions: ["fix PRD"] },
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.title, /2 个阻断项/);
  });

  test("wizard run path fails closed behind lifecycle guard", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-wizard-guard-"));
    try {
      const prdPath = join(root, "specs", "prd.json");
      mkdirSync(dirname(prdPath), { recursive: true });
      writeFileSync(prdPath, "{}\n", "utf8");
      initLifecycleState({ projectRoot: root });

      const guard = inspectWizardRunGuard(root, prdPath);

      assert.equal(guard.status, "blocked");
      assert.deepEqual(guard.missing_required_stages, ["discovery", "roadmap", "check"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("wizard check writes lifecycle evidence required by run guard", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-wizard-check-"));
    try {
      const stateRoot = join(root, ".yolo");
      const prdPath = join(root, "specs", "prd.json");
      mkdirSync(dirname(prdPath), { recursive: true });
      writeFileSync(join(root, "README.md"), "# wizard\n", "utf8");
      writeFileSync(prdPath, `${JSON.stringify({
        version: "2.0",
        id: "PRD-20260530-WIZARD-CHECK",
        title: "Wizard check",
        project: { name: "wizard", language: "javascript" },
        generated_by: "yolo-review-agent",
        generated_at: "2026-05-30T00:00:00.000Z",
        base_commit: "abcdef0",
        review_policy: { mode: "disabled" },
        ...approvedDemandFields(["artifacts/wizard-check.md"]),
        requirements: [tracedRequirement("REQ-1", "Wizard check writes lifecycle evidence.")],
        designs: [{ id: "DES-1", text: "Use yolo check before run." }],
        tasks: [{
          id: "TASK-WIZARD-001",
          title: "Touch wizard artifact",
          type: "cleanup",
          task_kind: "dry_run_artifact",
          priority: "P3",
          status: "pending",
          requirement_ids: ["REQ-1"],
          design_ids: ["DES-1"],
          scope: {
            targets: [{ file: "artifacts/wizard-check.md" }],
            allow_new_files: true,
            expected_zero_business_code: true,
          },
          post_conditions: [
            { id: "POST-1", type: "file_exists", severity: "FAIL", params: { file: "artifacts/wizard-check.md" } },
            { id: "POST-TYPECHECK", type: "no_new_type_errors", severity: "FAIL", params: { command: "npm run typecheck" } },
          ],
        }],
      }, null, 2)}\n`, "utf8");
      initLifecycleState({ projectRoot: root });
      writeLifecycleStageReport("discovery", { status: "success" }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      writeLifecycleStageReport("roadmap", { status: "success" }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      writeLifecycleStageReport("prd", { status: "success", prd_path: prdPath, artifacts: [prdPath] }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      const check = inspectWizardCheck(root, prdPath);
      const guard = inspectWizardRunGuard(root, prdPath);

      assert.notEqual(check.status, "blocked");
      assert.equal(guard.status, "pass", JSON.stringify(guard.blockers, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
