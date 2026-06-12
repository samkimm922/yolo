import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as sdkModule from "../sdk.js";
import { createYoloSdk } from "../sdk.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(YOLO_DIR, "package.json"), "utf8"));
const boundary: {
  package_exports: { export: string; target: string; tier: string; reason: string }[];
  sdk_module_exports: Record<string, string[]>;
  version_policy: Record<string, { compatibility: string; breaking_change: string; deprecation: string }>;
  create_yolo_sdk: {
    namespaces: {
      namespace: string;
      shape: string;
      tier: string;
      entries: Record<string, string>;
    }[];
  };
} = JSON.parse(readFileSync(resolve(YOLO_DIR, "docs/public-sdk-api-boundary.json"), "utf8"));
const RELEASE_CANDIDATE_EXPORTS = [
  "./release/change-provenance",
  "./release/clean-environment-verify",
  "./release/dogfood-matrix",
];
const RELEASE_CANDIDATE_SDK_SURFACES = [
  "buildReleaseCandidateChangeManifest",
  "readReleaseCandidateChangeManifest",
  "buildCleanEnvironmentVerifyPlan",
  "runCleanEnvironmentVerify",
  "buildDogfoodMatrixPlan",
  "buildDogfoodMatrixReport",
  "buildDogfoodMatrixEvidence",
  "runReleaseCandidateGate",
];

function sorted(values: Iterable<string>) {
  return [...values].sort();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function flattenTierGroups(groups: Record<string, string[]> | undefined) {
  const entries: { name: string; tier: string }[] = [];
  for (const [tier, names] of Object.entries(groups || {})) {
    for (const name of names) {
      entries.push({ name, tier });
    }
  }
  return entries;
}

describe("public SDK API boundary", () => {
  test("package exports are classified exactly once with matching targets", () => {
    const entries = boundary.package_exports || [];
    const byExport = new Map(entries.map((entry) => [entry.export, entry]));

    assert.deepEqual(sorted(byExport.keys()), sorted(Object.keys(packageJson.exports)));

    for (const [exportName, target] of Object.entries(packageJson.exports)) {
      const entry = byExport.get(exportName);
      assert.equal(entry.target, target, `${exportName} target must match package.json`);
      assert.ok(boundary.version_policy[entry.tier], `${exportName} has unknown tier ${entry.tier}`);
      assert.match(entry.reason, /\S/, `${exportName} must explain why it is public`);
    }
  });

  test("used API tiers have explicit version policy rules", () => {
    const usedTiers = new Set([
      ...boundary.package_exports.map((entry) => entry.tier),
      ...flattenTierGroups(boundary.sdk_module_exports).map((entry) => entry.tier),
    ]);
    for (const namespace of boundary.create_yolo_sdk.namespaces) {
      for (const tier of Object.values(namespace.entries || {})) {
        usedTiers.add(tier);
      }
    }

    for (const tier of usedTiers) {
      const policy = boundary.version_policy[tier];
      assert.ok(policy, `${tier} must have a version policy`);
      assert.match(policy.compatibility, /\S/);
      assert.match(policy.breaking_change, /\S/);
      assert.match(policy.deprecation, /\S/);
    }
  });

  test("sdk.js named exports are classified exactly once", () => {
    const classified = flattenTierGroups(boundary.sdk_module_exports);
    const names = classified.map((entry) => entry.name);
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);

    assert.equal(duplicate, undefined, `${duplicate} is classified more than once`);
    assert.deepEqual(sorted(names), sorted(Object.keys(sdkModule)));

    for (const entry of classified) {
      assert.ok(boundary.version_policy[entry.tier], `${entry.name} has unknown tier ${entry.tier}`);
    }
  });

  test("createYoloSdk namespaces and callable entries are classified exactly once", () => {
    const sdk = createYoloSdk({ projectRoot: YOLO_DIR });
    const namespaces = boundary.create_yolo_sdk.namespaces || [];
    const byNamespace = new Map(namespaces.map((entry) => [entry.namespace, entry]));

    assert.deepEqual(sorted(byNamespace.keys()), sorted(Object.keys(sdk)));

    for (const [namespaceName, namespaceValue] of Object.entries(sdk)) {
      const entry = byNamespace.get(namespaceName);
      assert.ok(["object", "opaque"].includes(entry.shape), `${namespaceName} has unsupported shape`);
      assert.ok(["stable", "experimental", "mixed"].includes(entry.tier), `${namespaceName} has unsupported tier`);
      if (entry.shape === "opaque") {
        continue;
      }

      const documentedEntries = Object.keys(entry.entries || {});
      assert.deepEqual(sorted(documentedEntries), sorted(Object.keys(namespaceValue)), `${namespaceName} entries must match SDK object`);
      for (const [entryName, tier] of Object.entries(entry.entries)) {
        assert.ok(boundary.version_policy[tier], `${namespaceName}.${entryName} has unknown tier ${tier}`);
      }
    }
  });

  test("human SDK contract points to the machine-readable boundary and version policy", () => {
    const contract = readFileSync(resolve(YOLO_DIR, "docs/public-sdk-contract.md"), "utf8");

    assert.match(contract, /public-sdk-api-boundary\.json/);
    assert.match(contract, /## Version Policy/);
    assert.match(contract, /sdk\.stable/);
    assert.match(contract, /sdk\.experimental/);
    assert.match(contract, /exit 2[\s\S]*fail-closed/);
    assert.match(contract, /废弃命令桩[\s\S]*退出 `2`/);
  });

  test("release candidate exports are classified and documented", () => {
    const apiReference = readFileSync(resolve(YOLO_DIR, "docs/api-reference.md"), "utf8");
    const contract = readFileSync(resolve(YOLO_DIR, "docs/public-sdk-contract.md"), "utf8");
    const byExport = new Map(boundary.package_exports.map((entry) => [entry.export, entry]));

    for (const exportName of RELEASE_CANDIDATE_EXPORTS) {
      assert.ok(Object.hasOwn(packageJson.exports, exportName), `${exportName} must stay exported`);
      assert.equal(byExport.get(exportName)?.target, packageJson.exports[exportName], `${exportName} boundary target must match package.json`);
      assert.equal(byExport.get(exportName)?.tier, "experimental", `${exportName} must stay experimental until release evidence is complete`);

      const publicImport = `yolo/${exportName.slice(2)}`;
      assert.match(apiReference, new RegExp(escapeRegExp(publicImport)), `${publicImport} must be in docs/api-reference.md`);
      assert.match(contract, new RegExp(escapeRegExp(publicImport)), `${publicImport} must be in docs/public-sdk-contract.md`);
    }

    for (const surfaceName of RELEASE_CANDIDATE_SDK_SURFACES) {
      assert.match(apiReference, new RegExp(escapeRegExp(`${surfaceName}()`)), `${surfaceName} must be in docs/api-reference.md`);
    }
  });
});
