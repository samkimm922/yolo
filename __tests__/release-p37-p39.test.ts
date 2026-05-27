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
  test("real-project dogfood pack initializes an isolated project and validates full lifecycle dogfood evidence", () => {
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

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.components.init.status, "success");
    assert.equal(result.components.bridge_dry_run.dry_run, true);
    assert.equal(result.components.dry_run_doctor.status, "pass");
    assert.equal(result.components.dogfood_lifecycle.discovery.status, "pass");
    assert.equal(result.components.dogfood_lifecycle.compiled.status, "pass");
    assert.equal(result.components.dogfood_lifecycle.check_report.status, "pass");
    assert.equal(result.components.dogfood_lifecycle.acceptance_report.status, "pass");
    assert.equal(result.components.dogfood_lifecycle.controlled_run.status, "pass");
    assert.equal(result.components.dogfood_gate.status, "pass");
    assert.equal(result.guarantees.agent_bridge_installed, false);
    assert.equal(result.guarantees.provider_execution, false);
    assert.ok(result.evidence.plan.artifact_path.includes(".yolo/state/reports/dogfood/plan.json"));
    assert.ok(result.evidence.discovery.artifact_path.includes(".yolo/state/reports/dogfood/discovery.json"));
    assert.ok(result.evidence.prd.artifact_path.includes(".yolo/state/reports/dogfood/prd.json"));
    assert.ok(result.evidence.accept.artifact_path.includes(".yolo/state/reports/dogfood/accept.json"));
    assert.ok(result.evidence.controlled_run.artifact_path.includes(".yolo/state/reports/dogfood/controlled_run.json"));
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
