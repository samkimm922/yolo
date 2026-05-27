import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildAdapterEvidencePlan,
  runAdapterEvidenceCollector,
} from "../src/runtime/adapters/evidence-collector.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-adapter-evidence-"));
}

function writeJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
}

function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, "utf8");
}

function adapterManifest() {
  return {
    schema: "yolo.manifest.v1",
    id: "local-browser",
    kind: "acceptance_adapter",
    description: "Local browser acceptance adapter",
    inputs: ["url"],
    outputs: ["ui_evidence"],
    commands: [{
      command: "node tools/write-evidence.cjs",
      evidence_path: ".yolo/state/evidence/ui/latest.json",
    }],
    evidence: ["screenshot", "runtime_log"],
    capabilities: ["page_reachable", "critical_path_passed", "screenshot"],
    applies_to: ["ui", "browser"],
  };
}

describe("adapter evidence collector", () => {
  test("builds a dry-run plan without executing adapter commands", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeJson(join(stateRoot, "adapters/local-browser.manifest.json"), adapterManifest());
      const plan = buildAdapterEvidencePlan({ projectRoot: root, stateRoot, requiresAcceptanceAdapter: true });

      assert.equal(plan.status, "ready");
      assert.equal(plan.adapter.id, "local-browser");
      assert.equal(plan.commands.length, 1);
      assert.equal(plan.execution_policy.default_mode, "dry_run");
      assert.match(plan.artifact_file, /^\.yolo\/state\/evidence\/adapters\/local-browser-latest\.json$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires explicit command authorization before executing", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeJson(join(stateRoot, "adapters/local-browser.manifest.json"), adapterManifest());
      writeText(join(root, "tools/write-evidence.cjs"), "throw new Error('should not run');\n");

      const result = runAdapterEvidenceCollector({
        projectRoot: root,
        stateRoot,
        requiresAcceptanceAdapter: true,
        execute: true,
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.code, "ADAPTER_COMMAND_EXECUTION_NOT_ALLOWED");
      assert.equal(existsSync(join(stateRoot, "state/evidence/ui/latest.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("executes authorized adapter command and records collected UI evidence", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      writeJson(join(stateRoot, "adapters/local-browser.manifest.json"), adapterManifest());
      writeText(join(root, "tools/write-evidence.cjs"), [
        "const fs = require('fs');",
        "fs.mkdirSync('.yolo/state/evidence/ui', { recursive: true });",
        "fs.writeFileSync('.yolo/state/evidence/ui/latest.json', JSON.stringify({",
        "  page_reachable: true,",
        "  critical_path_passed: true,",
        "  required_state_present: true,",
        "  screenshots: ['.yolo/state/evidence/ui/inventory.png']",
        "}));",
        "",
      ].join("\n"));

      const result = runAdapterEvidenceCollector({
        projectRoot: root,
        stateRoot,
        requiresAcceptanceAdapter: true,
        execute: true,
        allowAdapterCommands: true,
      });

      assert.equal(result.status, "pass");
      assert.equal(result.code, "ADAPTER_EVIDENCE_COLLECTED");
      assert.equal(result.command_results[0].status, "pass");
      assert.equal(result.ui_evidence.page_reachable, true);
      assert.equal(result.ui_evidence.screenshots.length, 1);
      assert.equal(existsSync(join(stateRoot, "state/evidence/adapters/local-browser-latest.json")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
