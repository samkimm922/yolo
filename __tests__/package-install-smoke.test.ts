import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createYoloSdk } from "../sdk.js";
import {
  buildPackageInstallSmokePlan,
  inspectPackedPackage,
  runPackageInstallSmoke,
} from "../src/release/pack-smoke.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(YOLO_DIR, "package.json"), "utf8"));

describe("package install smoke", () => {
  test("plan covers every public package export and bin", () => {
    const plan = buildPackageInstallSmokePlan({ yoloRoot: YOLO_DIR });

    assert.deepEqual(
      plan.import_specifiers,
      Object.keys(packageJson.exports).sort().map((name) =>
        name === "." ? packageJson.name : `${packageJson.name}/${name.replace(/^\.\//, "")}`
      ),
    );
    assert.deepEqual(plan.bin_names, Object.keys(packageJson.bin).sort());
    assert.ok(plan.package_files.some((entry) => entry === "dist/" || entry.startsWith("dist/")));
    assert.ok(plan.commands.some((command) => command.includes("npm pack") && command.includes("--ignore-scripts")));
  });

  test("packed package inspection blocks local state, tests, and legacy workspace data", () => {
    const plan = buildPackageInstallSmokePlan({ yoloRoot: YOLO_DIR });
    const inspection = inspectPackedPackage({
      filename: "yolo-0.1.0.tgz",
      files: [
        ...plan.required_entries.map((path) => ({ path })),
        { path: "__tests__/sdk.test.js" },
        { path: "state/runs.jsonl" },
        { path: "dist/closed-loop/gate-chain-v2.js" },
      ],
    });

    assert.equal(inspection.status, "blocked");
    assert.deepEqual(inspection.blockers.map((blocker) => blocker.code), ["PACKAGE_PACK_FORBIDDEN_ENTRY"]);
    assert.deepEqual(inspection.missing_entries, []);
    assert.ok(inspection.forbidden_entries.includes("__tests__/sdk.test.js"));
    assert.ok(inspection.forbidden_entries.includes("state/runs.jsonl"));
    assert.ok(inspection.forbidden_entries.includes("dist/closed-loop/gate-chain-v2.js"));
  });

  test("npm pack tarball installs and imports from an external temp project", { timeout: 300000 }, () => {
    const result = runPackageInstallSmoke({ yoloRoot: YOLO_DIR, timeout_ms: 300000 });

    assert.equal(result.status, "pass", JSON.stringify(result, null, 2));
    assert.equal(result.exit_code, 0);
    assert.equal(result.pack.inspection.status, "pass");
    assert.equal(result.pack.inspection.forbidden_entries.length, 0);
    assert.ok(result.pack.info.files.some((file) => file.path === "dist/hooks/pre-tool-block-yolo-write.js"), "tarball must ship dist/hooks/pre-tool-block-yolo-write.js");
    assert.equal(result.install.status, "pass");
    assert.equal(result.import_check.status, "pass");
    assert.equal(result.bin_checks[0].status, "pass");
  });

  test("SDK release namespace exposes package install smoke helpers", () => {
    const sdk = createYoloSdk();

    assert.equal(typeof sdk.release.buildPackageInstallSmokePlan, "function");
    assert.equal(typeof sdk.release.buildReleaseCandidateChangeManifest, "function");
    assert.equal(typeof sdk.release.buildCleanEnvironmentVerifyPlan, "function");
    assert.equal(typeof sdk.release.buildDogfoodMatrixReport, "function");
    assert.equal(typeof sdk.release.buildControlledBetaReleaseDecisionPlan, "function");
    assert.equal(typeof sdk.release.buildOperatorReleaseRunbookPlan, "function");
    assert.equal(typeof sdk.release.buildOperatorReleaseStatePlan, "function");
    assert.equal(typeof sdk.release.buildPostReleaseAuditPlan, "function");
    assert.equal(typeof sdk.release.buildPublicBetaHardeningDrillPlan, "function");
    assert.equal(typeof sdk.release.buildStableGraduationPlan, "function");
    assert.equal(typeof sdk.release.buildManualExternalReleasePlan, "function");
    assert.equal(typeof sdk.release.buildAgentIntegrationDoctorPlan, "function");
    assert.equal(typeof sdk.release.buildRealProjectDogfoodPlan, "function");
    assert.equal(typeof sdk.release.buildPiExecutionDrillPlan, "function");
    assert.equal(typeof sdk.release.buildRuntimeBoundaryDecisionPlan, "function");
    assert.equal(typeof sdk.release.buildPublicBetaEvidencePlan, "function");
    assert.equal(typeof sdk.release.inspectPackedPackage, "function");
    assert.equal(typeof sdk.release.classifyReleaseChangeDomain, "function");
    assert.equal(typeof sdk.release.listDogfoodMatrixScenarios, "function");
    assert.equal(typeof sdk.release.runPackageInstallSmoke, "function");
    assert.equal(typeof sdk.release.runControlledBetaReleaseDecisionGate, "function");
    assert.equal(typeof sdk.release.runReleaseCandidateGate, "function");
    assert.equal(typeof sdk.release.readReleaseCandidateChangeManifest, "function");
    assert.equal(typeof sdk.release.runCleanEnvironmentVerify, "function");
    assert.equal(typeof sdk.release.runOperatorReleaseRunbookGate, "function");
    assert.equal(typeof sdk.release.runOperatorReleaseStateMutation, "function");
    assert.equal(typeof sdk.release.runPostReleaseAuditGate, "function");
    assert.equal(typeof sdk.release.runPublicBetaHardeningDrill, "function");
    assert.equal(typeof sdk.release.runStableGraduationGate, "function");
    assert.equal(typeof sdk.release.runManualExternalReleaseGate, "function");
    assert.equal(typeof sdk.release.runAgentIntegrationDoctor, "function");
    assert.equal(typeof sdk.release.runRealProjectDogfoodGate, "function");
    assert.equal(typeof sdk.release.runPiExecutionDrillGate, "function");
    assert.equal(typeof sdk.release.runRuntimeBoundaryDecisionGate, "function");
    assert.equal(typeof sdk.release.runPublicBetaEvidenceGate, "function");
    assert.equal(typeof runPackageInstallSmoke, "function");
  });
});
