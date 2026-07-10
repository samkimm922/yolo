import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readDiscoveryArtifact,
  runDiscoveryPlanRuntime,
  runDiscoveryPrdRuntime,
  runDiscoveryRuntime,
} from "../src/discovery/runtime.js";
import { validatePrdPath } from "../src/prd/validate.js";
import { readRegisteredArtifactDigests } from "../src/runtime/evidence/artifact-integrity.js";

describe("discovery runtime artifact chain", () => {
  test("writes discovery, plan, and non-executable draft PRD artifacts from one main line", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-discovery-runtime-"));
    try {
      mkdirSync(join(root, ".yolo/keys"), { recursive: true });
      writeFileSync(join(root, ".yolo/keys/ledger.hmac"), "discovery-runtime-test-ledger-key", "utf8");
      const discoveryResult = runDiscoveryRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "For store managers, add inventory alerts before stockouts.",
        problem: "Operators learn about stockouts too late.",
        target_users: ["store manager"],
        success_criteria: ["Alert appears when projected stock drops below threshold."],
        constraints: ["Do not change order import behavior."],
        target_files: ["src/inventory/alerts.js"],
        writeLifecycle: false,
      });

      assert.equal(discoveryResult.status, "success");
      assert.equal(discoveryResult.discovery.schema, "yolo.discovery.artifact.v1");
      assert.equal(discoveryResult.discovery.ready_for_plan, true);
      assert.equal(existsSync(discoveryResult.artifacts[0]), true);

      const read = readDiscoveryArtifact(discoveryResult.artifacts[0]);
      assert.equal(read.ok, true);
      assert.equal(read.discovery.requirements.active[0].id, "R001");

      const planResult = runDiscoveryPlanRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        discoveryPath: discoveryResult.artifacts[0],
        writeLifecycle: false,
      });

      assert.equal(planResult.status, "success");
      if (!("plan" in planResult)) throw new Error("expected plan");
      assert.equal(planResult.plan.steps[0].requirement_id, "R001");
      assert.equal(existsSync(planResult.artifacts[0]), true);

      const prdResult = runDiscoveryPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        discoveryPath: discoveryResult.artifacts[0],
        writeLifecycle: false,
      });

      assert.equal(prdResult.status, "draft");
      if (!("executable" in prdResult)) throw new Error("expected executable");
      assert.equal(prdResult.executable, false);
      assert.equal(prdResult.prd, null);
      if (!("draft_prd" in prdResult) || !prdResult.draft_prd) throw new Error("expected draft_prd");
      assert.equal(prdResult.draft_prd.tasks[0].source_finding_ids[0], "R001");
      assert.equal(prdResult.draft_prd.tasks[0].status, "needs_contract_review");
      assert.equal(prdResult.draft_prd.demand.approval.approved, false);
      assert.equal(existsSync(prdResult.artifacts[0]), true);
      assert.equal(validatePrdPath(prdResult.artifacts[0]).ok, true);
      const registered = readRegisteredArtifactDigests(prdResult.artifacts, {
        rootDir: root,
        stateRoot: join(root, ".yolo"),
      });
      assert.equal(registered.status, "pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks plan and PRD when discovery is incomplete", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-discovery-blocked-"));
    try {
      const discoveryResult = runDiscoveryRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Build alerts",
        writeLifecycle: false,
      });

      assert.equal(discoveryResult.status, "blocked");
      assert.equal(existsSync(discoveryResult.artifacts[0]), true);

      const planResult = runDiscoveryPlanRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        discoveryPath: discoveryResult.artifacts[0],
        writeLifecycle: false,
      });
      assert.equal(planResult.status, "blocked");

      const prdResult = runDiscoveryPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        discoveryPath: discoveryResult.artifacts[0],
        writeLifecycle: false,
      });
      assert.equal(prdResult.status, "blocked");
      assert.deepEqual(prdResult.artifacts, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
