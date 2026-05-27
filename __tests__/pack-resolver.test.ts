import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverPackManifests,
  validatePackManifest,
} from "../src/packs/manifest.js";
import { resolveProjectContext } from "../src/packs/resolver.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-pack-resolver-"));
}

function writeJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
}

function acceptanceAdapter(id = "local-browser") {
  return {
    schema: "yolo.manifest.v1",
    id,
    kind: "acceptance_adapter",
    description: "Local browser acceptance adapter",
    inputs: ["url", "prd"],
    outputs: ["acceptance_report"],
    commands: [{ command: "npm run accept" }],
    evidence: ["screenshot", "runtime_log"],
    capabilities: ["page_reachable", "screenshot", "runtime_errors"],
  };
}

describe("pack and adapter resolver", () => {
  test("validates adapter manifests with required explicit capabilities", () => {
    const invalid = validatePackManifest({
      schema: "yolo.manifest.v1",
      id: "bad",
      kind: "acceptance_adapter",
    });
    const valid = validatePackManifest(acceptanceAdapter());

    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.some((error) => error.code === "MANIFEST_INPUTS_MISSING"));
    assert.equal(valid.status, "pass");
    assert.equal(valid.manifest.kind, "acceptance_adapter");
  });

  test("discovers manifests and resolves unknown/custom without guessing", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeJson(join(stateRoot, "adapters/local-browser.manifest.json"), acceptanceAdapter());

      const discovered = discoverPackManifests({ projectRoot: root, stateRoot });
      const resolved = resolveProjectContext({ projectRoot: root, stateRoot, requiresAcceptanceAdapter: true });

      assert.equal(discovered.manifests.length, 1);
      assert.equal(resolved.status, "warning");
      assert.equal(resolved.selected.acceptance_adapter.id, "local-browser");
      assert.equal(resolved.selected.platform_adapter.id, "unknown/custom");
      assert.ok(resolved.warnings.some((warning) => warning.kind === "platform_adapter"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks when acceptance requires an adapter and none is available", () => {
    const root = tempProject();
    try {
      const resolved = resolveProjectContext({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        requiresAcceptanceAdapter: true,
      });

      assert.equal(resolved.status, "blocked");
      assert.ok(resolved.blockers.some((blocker) => blocker.code === "ACCEPTANCE_ADAPTER_MISSING"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
