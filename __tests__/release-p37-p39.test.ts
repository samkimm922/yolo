import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createYoloSdk } from "../sdk.js";
import {
  runRealProjectDogfoodPack,
} from "../src/release/real-project-dogfood-pack.js";
import {
  runExperiencePackEffectivenessAudit,
} from "../src/release/experience-pack-audit.js";
import {
  runNonTechnicalUxDoctor,
  YOLO_STAGE_COMMAND_CONTRACT,
  YOLO_ONE_SENTENCE_ENTRY,
} from "../src/release/nontechnical-ux-doctor.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const tmpRoots = [];

after(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  tmpRoots.push(root);
  return root;
}

describe("P37-P39 dogfood, experience, and non-technical UX gates", () => {
  test("real-project dogfood pack blocks dry-run-only lifecycle evidence", () => {
    const root = tempRoot("yolo-p37");
    const projectRoot = join(root, "external-project");
    const homeDir = join(root, "home");

    const result = runRealProjectDogfoodPack({
      yoloRoot: YOLO_DIR,
      projectRoot,
      homeDir,
      targets: ["codex", "claude"],
      scope: "project",
      now: "2026-05-25T00:00:00.000Z",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.components.init.status, "success");
    assert.equal(result.components.bridge_dry_run.dry_run, true);
    assert.equal(result.components.dry_run_doctor.status, "pass");
    assert.equal(result.components.dogfood_lifecycle.discovery.status, "pass");
    assert.equal(result.components.dogfood_lifecycle.compiled.status, "draft");
    assert.equal(result.evidence.prd.status, "pass");
    assert.equal(result.evidence.prd.payload.dogfood_prd_evidence.status, "pass");
    assert.equal(result.components.dogfood_lifecycle.check_report.status, "pass");
    assert.equal(result.components.dogfood_lifecycle.run_report.status, "dry_run");
    assert.equal(result.components.dogfood_lifecycle.acceptance_report.status, "blocked");
    assert.equal(result.components.dogfood_lifecycle.controlled_run.status, "blocked");
    assert.equal(result.components.dogfood_gate.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "REAL_PROJECT_DOGFOOD_PACK_CONTROLLED_RUN"));
    assert.equal(result.guarantees.agent_bridge_installed, false);
    assert.equal(result.guarantees.provider_execution, false);
    assert.ok(result.evidence.plan.artifact_path.includes(".yolo/state/reports/dogfood/plan.json"));
    assert.ok(result.evidence.discovery.artifact_path.includes(".yolo/state/reports/dogfood/discovery.json"));
    assert.ok(result.evidence.prd.artifact_path.includes(".yolo/state/reports/dogfood/prd.json"));
    assert.ok(result.evidence.accept.artifact_path.includes(".yolo/state/reports/dogfood/accept.json"));
    assert.ok(result.evidence.controlled_run.artifact_path.includes(".yolo/state/reports/dogfood/controlled_run.json"));
  });

  test("real-project dogfood pack blocks compiler results without executable PRD instead of throwing", () => {
    const root = tempRoot("yolo-p37-blocked");
    const result = runRealProjectDogfoodPack({
      yoloRoot: YOLO_DIR,
      projectRoot: join(root, "external-project"),
      homeDir: join(root, "home"),
      targets: ["codex", "claude"],
      scope: "project",
      now: "2026-05-25T00:00:00.000Z",
      compiledRaw: {
        status: "blocked",
        spec: {
          schema_version: "1.0",
          schema: "yolo.spec.lifecycle.package.v1",
          status: "blocked",
        },
        prd: null,
        blockers: [{ code: "SPEC_COMPILER_BLOCKED", message: "blocked fixture" }],
        validation: { status: "blocked", blockers: [{ code: "PRD_VALIDATION_BLOCKED" }] },
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.components.dogfood_lifecycle.check_report.status, "blocked");
    assert.equal(result.components.dogfood_lifecycle.controlled_run.status, "blocked");
    assert.equal(result.evidence.prd.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "REAL_PROJECT_DOGFOOD_PACK_LIFECYCLE"));
  });

  test("real-project dogfood pack passes when caller injects real controlled-run evidence", () => {
    const root = tempRoot("yolo-p37-evidence");
    const projectRoot = join(root, "external-project");
    const homeDir = join(root, "home");

    const result = runRealProjectDogfoodPack({
      yoloRoot: YOLO_DIR,
      projectRoot,
      homeDir,
      targets: ["codex", "claude"],
      scope: "project",
      now: "2026-05-25T00:00:00.000Z",
      controlledRunEvidence: {
        status: "pass",
        run_id: "DOGFOOD-CONTROLLED-RUN-001",
        summary: { planned: 1, completed: 1, failed: 0, blocked: 0 },
        task_results: [{ task_id: "DOGFOOD-TASK-001", status: "pass" }],
        provider_execution: false,
        code_edited: false,
        evidence_refs: [],
      },
    });

    // The dead-end gate is now reachable: controlled run status is driven by
    // the injected real-run evidence instead of being hardcoded to "blocked".
    assert.equal(result.components.dogfood_lifecycle.controlled_run.status, "pass");
    assert.equal(result.evidence.controlled_run.status, "pass");
    assert.notEqual(
      result.components.dogfood_lifecycle.controlled_run.code,
      "REAL_PROJECT_DOGFOOD_CONTROLLED_RUN_DRY_RUN_ONLY",
      "controlled run must not carry the dry-run-only code when real evidence is provided",
    );
    assert.equal(
      result.components.dogfood_lifecycle.controlled_run["real_run_evidence"].status,
      "pass",
      "controlled run must surface the injected real-run evidence",
    );

    // No REAL_PROJECT_DOGFOOD_PACK_CONTROLLED_RUN blocker remains.
    assert.equal(
      result.blockers.some((blocker) => blocker.code === "REAL_PROJECT_DOGFOOD_PACK_CONTROLLED_RUN"),
      false,
    );

    // Acceptance is no longer blocked by a dry-run run report.
    assert.equal(result.components.dogfood_lifecycle.acceptance_report.status, "pass");

    // The full pack now reaches a pass state end-to-end.
    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.components.dogfood_gate.status, "pass");

    // Dry-run safety is preserved: no provider execution, no code edits.
    assert.equal(result.guarantees.provider_execution, false);
    assert.equal(result.guarantees.agent_bridge_installed, false);
  });

  test("real-project dogfood pack stays blocked when controlled-run evidence is absent or not pass", () => {
    const root = tempRoot("yolo-p37-no-evidence");
    const projectRoot = join(root, "external-project");
    const homeDir = join(root, "home");

    const blockedResult = runRealProjectDogfoodPack({
      yoloRoot: YOLO_DIR,
      projectRoot,
      homeDir,
      targets: ["codex", "claude"],
      scope: "project",
      now: "2026-05-25T00:00:00.000Z",
    });

    assert.equal(blockedResult.components.dogfood_lifecycle.controlled_run.status, "blocked");
    assert.equal(
      blockedResult.components.dogfood_lifecycle.controlled_run.code,
      "REAL_PROJECT_DOGFOOD_CONTROLLED_RUN_DRY_RUN_ONLY",
    );
    assert.ok(blockedResult.blockers.some((blocker) => blocker.code === "REAL_PROJECT_DOGFOOD_PACK_CONTROLLED_RUN"));

    // Evidence that does not report pass must still be treated as dry-run only.
    const root2 = tempRoot("yolo-p37-non-pass-evidence");
    const nonPassResult = runRealProjectDogfoodPack({
      yoloRoot: YOLO_DIR,
      projectRoot: join(root2, "external-project"),
      homeDir: join(root2, "home"),
      targets: ["codex", "claude"],
      scope: "project",
      now: "2026-05-25T00:00:00.000Z",
      controlledRunEvidence: { status: "blocked" },
    });

    assert.equal(nonPassResult.components.dogfood_lifecycle.controlled_run.status, "blocked");
    assert.ok(nonPassResult.blockers.some((blocker) => blocker.code === "REAL_PROJECT_DOGFOOD_PACK_CONTROLLED_RUN"));
  });

  test("experience pack effectiveness audit injects only relevant bounded lessons and does not block prompt generation", () => {
    const root = tempRoot("yolo-p38");
    const result = runExperiencePackEffectivenessAudit({
      projectRoot: join(root, "fixture"),
      stateRoot: join(root, "fixture/.yolo"),
    });

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.prompt_summary.generated, true);
    assert.equal(result.prompt_summary.contains_relevant, true);
    assert.equal(result.prompt_summary.contains_unrelated, false);
    assert.ok(result.prompt_summary.experience_item_count <= 2);
    assert.equal(result.guarantees.provider_execution, false);
  });

  test("non-technical UX doctor verifies one sentence entry across docs and generated command artifacts", () => {
    const result = runNonTechnicalUxDoctor({ yoloRoot: YOLO_DIR });

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.report.one_sentence_entry, YOLO_ONE_SENTENCE_ENTRY);
    assert.match(result.report.user_visible_next_step, /\/yolo /);
    assert.equal(result.artifacts_sample.native_skill_contains_entry, true);
    assert.equal(result.artifacts_sample.native_skill_stage_command_contract, true);
    assert.equal(result.artifacts_sample.bridge_stage_commands_clear, true);
    assert.equal(result.checks.find((item) => item.code === "NONTECH_UX_STAGE_COMMANDS_CLEAR")?.passed, true);
    assert.equal(YOLO_STAGE_COMMAND_CONTRACT, "If the user asks to talk through a requirement, use `/yolo-demand` as the single demand-stage entry instead of asking them to choose brainstorm/interview/discover/discuss.");
    assert.equal(result.guarantees.provider_execution, false);
  });

  test("SDK release namespace exposes P37-P39 helpers", () => {
    const sdk = createYoloSdk({ yoloRoot: YOLO_DIR, projectRoot: tempRoot("yolo-p37-p39-sdk") });

    assert.equal(typeof sdk.release.runRealProjectDogfoodPack, "function");
    assert.equal(typeof sdk.release.runExperiencePackEffectivenessAudit, "function");
    assert.equal(typeof sdk.release.runNonTechnicalUxDoctor, "function");
    assert.equal(typeof sdk.release.inspectAgentBridgeDryRunDoctor, "function");
  });
});
