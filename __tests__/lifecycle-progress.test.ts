import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildLifecycleStageReport, writeLifecycleStageReport } from "../src/lifecycle/progress.js";
import { createLifecycleStateSnapshot } from "../src/lifecycle/schema.js";
import { generateApprovalKeyPair, signApproval } from "../src/lib/security/approval-signing.js";
import { manualAcceptanceSignable } from "../src/lifecycle/manual-acceptance-keys.js";

// Install a freshly-generated project-rooted manual-acceptance public key into
// a test state root and return the matching private key (PEM). CR1 made
// manual-acceptance verification real, so the legit "resolved -> allowed" path
// must sign against an installed key rather than use a placeholder signature.
function installManualAcceptanceKey(stateRoot) {
  const { privateKeyPem, publicKeyPem } = generateApprovalKeyPair();
  mkdirSync(join(stateRoot, "keys"), { recursive: true });
  writeFileSync(join(stateRoot, "keys", "manual-acceptance.pub"), publicKeyPem, "utf8");
  return privateKeyPem;
}

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "yolo-lifecycle-progress-"));
  mkdirSync(join(root, ".yolo", "keys"), { recursive: true });
  writeFileSync(join(root, ".yolo", "keys", "ledger.hmac"), "lifecycle-progress-test-ledger-key", "utf8");
  return root;
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

  test("P8.M3: acceptance P0/P1 issues are promoted to stage blockers; P2 stays advisory", () => {
    for (const testCase of [
      { level: "P0", code: "UI_CRITICAL_PATH_FAILED", shouldBlock: true },
      { level: "P1", code: "RUN_REPORT_NOT_CLEAN", shouldBlock: true },
      { level: "P2", code: "ADVISORY_HINT", shouldBlock: false },
      { level: "human_review", code: "NEEDS_HUMAN_REVIEW", shouldBlock: false },
    ]) {
      const root = tempProject();
      const stateRoot = join(root, ".yolo");
      try {
        const result = writeLifecycleStageReport("acceptance", {
          status: "blocked",
          summary: `acceptance has a ${testCase.level} issue`,
          issues: [{
            level: testCase.level,
            code: testCase.code,
            message: `${testCase.level} issue surfaced by acceptance`,
          }],
        }, {
          projectRoot: root,
          stateRoot,
          source: "unit",
          writeSessionMemory: false,
          skipSequenceCheck: true,
        });

        // Read the stage report back to verify blockers field.
        const stageReport = JSON.parse(readFileSync(join(stateRoot, "lifecycle/acceptance-report.json"), "utf8"));
        const blockingCodes = stageReport.blockers.map((blocker) => blocker.code);

        if (testCase.shouldBlock) {
          assert.ok(
            blockingCodes.includes(testCase.code),
            `${testCase.level} issue ${testCase.code} should be a stage blocker, got: ${JSON.stringify(blockingCodes)}`,
          );
        } else {
          assert.ok(
            !blockingCodes.includes(testCase.code),
            `${testCase.level} issue ${testCase.code} should NOT be a stage blocker, got: ${JSON.stringify(blockingCodes)}`,
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("P8.M3: legacy issues with explicit status='blocked' still become stage blockers", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeLifecycleStageReport("acceptance", {
        status: "blocked",
        summary: "blocked via legacy status field",
        issues: [{ status: "blocked", code: "LEGACY_BLOCKER", message: "legacy status-shape blocker" }],
      }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      const stageReport = JSON.parse(readFileSync(join(stateRoot, "lifecycle/acceptance-report.json"), "utf8"));
      assert.ok(
        stageReport.blockers.some((blocker) => blocker.code === "LEGACY_BLOCKER"),
        `legacy status='blocked' issues must remain stage blockers: ${JSON.stringify(stageReport.blockers)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime invariant: delivery write fails closed when manual acceptance is unresolved", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeLifecycleStageReport("acceptance", {
        status: "pass",
        summary: "acceptance passed but still needs human evidence",
        evidence: [{ path: "state/acceptance/evidence.json" }],
        manual_criteria: [{
          task_id: "FEAT-1",
          condition_id: "POST-MANUAL",
          text: "Product owner signs off.",
        }],
      }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      assert.throws(
        () => writeLifecycleStageReport("delivery", {
          status: "success",
          summary: "delivery should not write",
        }, {
          projectRoot: root,
          stateRoot,
          source: "unit",
          writeSessionMemory: false,
          skipSequenceCheck: true,
        }),
        (error) => {
          const invariantError = error as any;
          assert.equal(invariantError.code, "RUNTIME_INVARIANT_VIOLATED:delivery_manual_acceptance_unresolved");
          assert.equal(invariantError.blockers[0].code, "RUNTIME_INVARIANT_VIOLATED:delivery_manual_acceptance_unresolved");
          assert.equal(invariantError.blockers[0].unresolved_manual_criteria[0].condition_id, "POST-MANUAL");
          return true;
        },
      );
      assert.equal(existsSync(join(stateRoot, "lifecycle/delivery-report.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime invariant: delivery write allows resolved manual acceptance", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      // CR1: install a real keypair and sign the canonical payload so the
      // "resolved -> allowed" path is real, not a placeholder-signature stub.
      const maPrivateKey = installManualAcceptanceKey(stateRoot);
      const resolvedEntry = {
        type: "manual_acceptance",
        task_id: "FEAT-1",
        condition_id: "POST-MANUAL",
        accepted_by: "operator",
        accepted_at: "2026-06-20T00:00:00.000Z",
        status: "accepted",
      };
      const signature = signApproval(manualAcceptanceSignable(resolvedEntry), maPrivateKey);
      writeLifecycleStageReport("acceptance", {
        status: "pass",
        summary: "manual acceptance resolved",
        evidence: [{ ...resolvedEntry, signature, digest: "sha256:test" }],
        manual_criteria: [{
          task_id: "FEAT-1",
          condition_id: "POST-MANUAL",
          text: "Product owner signs off.",
        }],
      }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      const result = writeLifecycleStageReport("delivery", {
        status: "success",
        summary: "delivery can write",
      }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      assert.equal(result.stage_status, "completed");
      assert.equal(existsSync(join(stateRoot, "lifecycle/delivery-report.json")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime invariant: delivery write rejects forged manual acceptance records", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeLifecycleStageReport("acceptance", {
        status: "pass",
        summary: "manual acceptance record is missing signature fields",
        evidence: [{
          type: "manual_acceptance",
          task_id: "FEAT-1",
          condition_id: "POST-MANUAL",
          accepted_by: "operator",
        }],
        manual_criteria: [{
          task_id: "FEAT-1",
          condition_id: "POST-MANUAL",
          text: "Product owner signs off.",
        }],
      }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      assert.throws(
        () => writeLifecycleStageReport("delivery", {
          status: "success",
          summary: "delivery should not write",
        }, {
          projectRoot: root,
          stateRoot,
          source: "unit",
          writeSessionMemory: false,
          skipSequenceCheck: true,
        }),
        (error) => {
          const invariantError = error as any;
          assert.equal(invariantError.code, "RUNTIME_INVARIANT_VIOLATED:delivery_manual_acceptance_unresolved");
          return true;
        },
      );
      assert.equal(existsSync(join(stateRoot, "lifecycle/delivery-report.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("buildLifecycleStageReport tolerates null/non-object entries inside blockers/blocked_reasons/checks arrays", () => {
    // A status='blocked' report whose `checks` array contains a null entry is
    // well-formed JSON; without a guard, `report.checks.filter((c) => c.status
    // === "blocked")` throws on `null.status`, taking down the whole stage
    // write. Mirror the asConditions pattern: filter non-object entries out.
    const stageReport = buildLifecycleStageReport("check", {
      status: "blocked",
      checks: [null, { status: "blocked" }],
      blockers: [null, 42, "plain string blocker", { code: "X", message: "object blocker" }],
      blocked_reasons: [null, { code: "R", message: "reason blocker" }],
    }, { projectName: "probe", now: "2026-06-21T00:00:00Z" });

    // No throw, blockers flattened to { code, message } objects.
    assert.ok(Array.isArray(stageReport.blockers));
    for (const blocker of stageReport.blockers) {
      assert.equal(typeof blocker, "object");
      assert.equal(typeof blocker.code, "string");
      assert.equal(typeof blocker.message, "string");
    }
    const codes = stageReport.blockers.map((b) => b.code);
    assert.ok(codes.includes("BLOCKER"), `plain string blocker preserved: ${JSON.stringify(codes)}`);
    assert.ok(codes.includes("X"), `object blocker preserved: ${JSON.stringify(codes)}`);
    assert.ok(codes.includes("R"), `blocked_reasons object preserved: ${JSON.stringify(codes)}`);

    // The { status: "blocked" } check has no code, so it falls back to BLOCKER.
    // After deduplication we should still see at least one BLOCKER entry from it.
    const fromChecks = stageReport.blockers.filter((b) => b.code === "BLOCKER").length;
    assert.ok(fromChecks >= 1, `blocking check surfaced: ${JSON.stringify(stageReport.blockers)}`);
  });

  test("writeLifecycleStageReport survives malformed-but-valid blockers/checks arrays end-to-end", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      // Regression: previously crashed with "Cannot read properties of null
      // (reading 'status')" inside reportBlockers before the stage report was
      // written, leaving the lifecycle stuck.
      writeLifecycleStageReport("check", {
        status: "blocked",
        summary: "checks array contained a null entry",
        checks: [null, { status: "blocked" }],
        blockers: [null, 7, { code: "B", message: "blocker" }],
      }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      const stageReport = JSON.parse(readFileSync(join(stateRoot, "lifecycle/check-report.json"), "utf8"));
      assert.ok(Array.isArray(stageReport.blockers));
      assert.ok(
        stageReport.blockers.some((b) => b.code === "B"),
        `real blocker preserved despite malformed siblings: ${JSON.stringify(stageReport.blockers)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tolerates null/non-object entries in status.json stages on stage write", () => {
    // Regression: a status.json that is valid JSON but carries a null entry
    // inside the `stages` array (botched external write, partial flush, git
    // merge) used to crash writeLifecycleStageReport with
    // "Cannot read properties of null (reading 'id')" inside
    // updateStatusForStage / sequence-check, taking down stage transitions.
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const base = createLifecycleStateSnapshot({ projectName: "demo", currentStage: "discovery" });
      base.stages = [null, 7, "bad", ...base.stages] as unknown as typeof base.stages;
      mkdirSync(join(stateRoot, "lifecycle"), { recursive: true });
      writeFileSync(join(stateRoot, "lifecycle/status.json"), JSON.stringify(base, null, 2));

      const result = writeLifecycleStageReport("discovery", { status: "success" }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        writeSessionMemory: false,
        skipSequenceCheck: true,
        now: "2026-06-21T00:00:00.000Z",
      });

      assert.equal(result.status, "ok");
      assert.equal(result.stage_status, "completed");
      const status = JSON.parse(readFileSync(join(stateRoot, "lifecycle/status.json"), "utf8"));
      const discovery = status.stages.find((s) => s.id === "discovery");
      assert.equal(discovery.status, "completed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
