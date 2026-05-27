import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  inspectPackageReadiness,
  inspectPublicBetaReadiness,
} from "../src/release/readiness.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");

describe("release readiness", () => {
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
    assert.ok(result.blockers.some((item) => item.code === "PACKAGE_PRIVATE_RELEASE_BLOCK"));
  });
});
