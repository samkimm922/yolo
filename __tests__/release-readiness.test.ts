import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  inspectPackageReadiness,
  inspectPublicBetaReadiness,
  inspectYoloReliabilityReadiness,
  REQUIRED_RELIABILITY_INCIDENT_IDS,
} from "../src/release/readiness.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");

describe("release readiness", () => {
  test("inspectYoloReliabilityReadiness blocks missing incident evidence", () => {
    const result = inspectYoloReliabilityReadiness();

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((item) => item.code === "YOLO_RELIABILITY_INCIDENT_EVIDENCE_PRESENT"));
    assert.ok(result.blockers.some((item) => item.code === "YOLO_RELIABILITY_INCIDENT_COVERAGE"));
  });

  test("inspectYoloReliabilityReadiness blocks fake success reports and contaminated external remediation", () => {
    const result = inspectYoloReliabilityReadiness({
      incidentEvidence: {
        incidents: REQUIRED_RELIABILITY_INCIDENT_IDS.map((id) => ({ id, status: "pass", evidence: `fixtures/${id}.json` })),
      },
      runReports: [{
        run_id: "run-bad",
        status: "error",
        summary: { task_success_rate: 100, run_success_rate: 100 },
      }],
      externalRemediation: [{ id: "manual-claude-p", counts_as_yolo_success: true }],
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((item) => item.code === "YOLO_RELIABILITY_NO_FAKE_SUCCESS_REPORTS"));
    assert.ok(result.blockers.some((item) => item.code === "YOLO_RELIABILITY_EXTERNAL_REMEDIATION_ISOLATED"));
  });

  test("inspectYoloReliabilityReadiness passes complete project-independent incident evidence", () => {
    const result = inspectYoloReliabilityReadiness({
      incidentEvidence: {
        incidents: REQUIRED_RELIABILITY_INCIDENT_IDS.map((id) => ({ id, status: "fixed", evidence: `fixtures/${id}.json` })),
      },
      runReports: [{
        run_id: "run-good",
        status: "success",
        summary: { task_success_rate: 100, run_success_rate: 100 },
      }],
      externalRemediation: [{ id: "manual-claude-p", counts_as_yolo_success: false }],
    });

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.blocks_release, false);
  });

  test("inspectPackageReadiness blocks public release while package is private", () => {
    const result = inspectPackageReadiness({
      name: "yolo",
      version: "0.1.0",
      license: "MIT",
      private: true,
      files: ["dist/bin/", "dist/src/", "dist/lib/", "dist/schemas/"],
      exports: { ".": "./dist/sdk.js" },
      bin: { yolo: "./dist/bin/yolo.js" },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blocks_release, true);
    assert.deepEqual(result.blockers.map((blocker) => blocker.code), ["PACKAGE_PRIVATE_RELEASE_BLOCK"]);
  });

  test("inspectPackageReadiness passes package metadata when public release blockers are clear", () => {
    const result = inspectPackageReadiness({
      name: "yolo",
      version: "0.1.0-beta.1",
      license: "MIT",
      private: false,
      files: ["dist/bin/", "dist/src/", "dist/lib/", "dist/schemas/"],
      exports: { ".": "./dist/sdk.js" },
      bin: { yolo: "./dist/bin/yolo.js" },
    });

    assert.equal(result.status, "pass");
    assert.equal(result.blocks_release, false);
  });

  test("inspectPublicBetaReadiness checks docs, fixtures, package metadata, and fails closed", () => {
    const result = inspectPublicBetaReadiness({ yoloRoot: YOLO_DIR });

    assert.equal(result.status, "blocked");
    assert.equal(result.blocks_release, true);
    assert.equal(result.package.private, true);
    assert.ok(result.checks.some((item) => item.code === "DOC_API_BOUNDARIES" && item.passed === true));
    assert.ok(result.checks.some((item) => item.code === "DOC_README_PUBLIC_BETA_SURFACES" && item.passed === true));
    assert.ok(result.checks.some((item) => item.code === "DOC_API_REFERENCE_SURFACES" && item.passed === true));
    assert.ok(result.checks.some((item) => item.code === "DOC_FIXTURE_MATRIX_COVERAGE" && item.passed === true));
    assert.ok(result.checks.some((item) => item.code === "DOC_CHANGELOG_PUBLIC_BETA" && item.passed === true));
    assert.ok(result.checks.some((item) => item.code === "PACKAGE_FILES_ALLOWLIST" && item.passed === true));
    assert.ok(result.checks.some((item) => item.code === "PACKAGE_FILES_NO_WORKSPACE_STATE" && item.passed === true));
    assert.ok(result.checks.some((item) => item.code === "API_BOUNDARY_PACKAGE_EXPORTS" && item.passed === true));
    assert.ok(result.checks.some((item) => item.code === "API_BOUNDARY_VERSION_POLICY" && item.passed === true));
    assert.ok(result.checks.some((item) => item.code === "API_BOUNDARY_SDK_SURFACE" && item.passed === true));
    assert.ok(result.checks.some((item) => item.code === "FIXTURE_REGISTRY_PASS" && item.passed === true));
    assert.ok(result.checks.some((item) => item.code === "YOLO_RELIABILITY_INCIDENT_EVIDENCE_PRESENT" && item.passed === false));
    assert.ok(result.blockers.some((item) => item.code === "YOLO_RELIABILITY_INCIDENT_COVERAGE"));
    assert.ok(result.blockers.some((item) => item.code === "PACKAGE_PRIVATE_RELEASE_BLOCK"));
  });

  test("release docs keep manual external, billable, public dogfood, and private blockers explicit", () => {
    const docs = [
      "docs/api-reference.md",
      "docs/public-sdk-contract.md",
      "docs/memory/CURRENT_STATUS.md",
    ].map((relativePath) => readFileSync(resolve(YOLO_DIR, relativePath), "utf8")).join("\n");

    assert.match(docs, /private: true/);
    assert.match(docs, /manual external|external publish/i);
    assert.match(docs, /billable provider|billable execution/i);
    assert.match(docs, /public dogfood/i);
    assert.doesNotMatch(docs, /release-ready now|ready for public release|stable release is ready/i);
  });
});
