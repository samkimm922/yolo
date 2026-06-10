import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createYoloSdk } from "../sdk.js";
import {
  buildInitToFirstPrdSmokePlan,
  runInitToFirstPrdSmoke,
} from "../src/core/init-smoke.js";
import { runRunnerRuntime } from "../src/runtime/runner-runtime.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-init-first-prd-"));
}

describe("init-to-first-PRD smoke", () => {
  test("buildInitToFirstPrdSmokePlan links bootstrap, spec lifecycle, and a strict first PRD", () => {
    const root = tempProject();
    try {
      const plan = buildInitToFirstPrdSmokePlan({
        projectRoot: root,
        projectName: "stranger-app",
      });

      assert.equal(plan.schema, "yolo.project.init_to_first_prd_smoke_plan.v1");
      assert.equal(plan.project_root, root);
      assert.equal(plan.bootstrap_plan.files.some((file) => file.path === "specs/tasks.md"), true);
      assert.equal(plan.spec_inspection.status, "pass");
      assert.equal(plan.prd.id, "PRD-20260524-FIRST-SMOKE");
      assert.equal(plan.prd.project.name, "stranger-app");
      assert.equal(plan.prd.execution_mode, "dry_run");
      assert.deepEqual(plan.prd.tasks[0].requirement_ids, ["REQ-SMOKE-001"]);
      assert.deepEqual(plan.prd.tasks[0].design_ids, ["DES-SMOKE-001"]);
      assert.deepEqual(plan.prd.tasks[0].scope.targets, [{ file: "specs/tasks.md" }]);
      assert.equal(plan.prd.tasks[0].post_conditions[0].type, "target_file_modified");
      assert.equal(existsSync(join(root, ".yolo")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runInitToFirstPrdSmoke initializes a stranger project and passes preflight plus runner dry-run readiness", async () => {
    const root = tempProject();
    try {
      const result = await runInitToFirstPrdSmoke({
        projectRoot: root,
        projectName: "stranger-app",
      });

      assert.equal(result.status, "success");
      assert.equal(result.exit_code, 0);
      assert.equal(result.preflight.status, "pass");
      assert.equal(result.preflight.runner_readiness.can_execute, true);
      assert.equal(result.runner.code, "RUNNER_DRY_RUN_READY");
      assert.equal(result.runner.status, "dry_run");
      assert.equal(result.runner.dry_run, true);
      assert.equal(existsSync(join(root, ".yolo/config.json")), true);
      assert.equal(existsSync(join(root, "specs/requirements.md")), true);
      assert.equal(existsSync(join(root, ".yolo/smoke/first-prd.json")), true);

      const prd = JSON.parse(readFileSync(join(root, ".yolo/smoke/first-prd.json"), "utf8"));
      assert.equal(prd.tasks[0].status, "pending");
      assert.equal(prd.tasks[0].post_conditions[0].severity, "FAIL");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runInitToFirstPrdSmoke dry-run plans artifacts without writing files", async () => {
    const root = tempProject();
    try {
      const result = await runInitToFirstPrdSmoke({
        projectRoot: root,
        dryRun: true,
      });

      assert.equal(result.status, "success");
      assert.equal(result.dry_run, true);
      assert.equal(result.artifacts.includes(".yolo/smoke/first-prd.json"), true);
      assert.equal(existsSync(join(root, ".yolo/config.json")), false);
      assert.equal(existsSync(join(root, ".yolo/smoke/first-prd.json")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runner runtime dryRun stops after preflight instead of importing the runner", async () => {
    const root = tempProject();
    try {
      const smoke = await runInitToFirstPrdSmoke({ projectRoot: root });
      const result = await runRunnerRuntime({
        prdPath: smoke.prd_path,
        dryRun: true,
        stateRoot: join(root, ".yolo", "smoke"),
      });

      assert.equal(result.status, "dry_run");
      assert.equal(result.exit_code, 2);
      assert.equal(result.code, "RUNNER_DRY_RUN_READY");
      assert.equal(result.preflight.status, "pass");
      assert.deepEqual(result.next_actions, ["Run without dryRun to start implementation."]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createYoloSdk exposes init-to-first-PRD smoke helpers", async () => {
    const root = tempProject();
    try {
      const sdk = createYoloSdk({ projectRoot: root });

      assert.equal(typeof sdk.project.buildInitToFirstPrdSmokePlan, "function");
      assert.equal(typeof sdk.project.runInitToFirstPrdSmoke, "function");

      const plan = sdk.project.buildInitToFirstPrdSmokePlan({ projectName: "sdk-smoke" });
      assert.equal(plan.project_name, "sdk-smoke");

      const result = await sdk.project.runInitToFirstPrdSmoke({ projectName: "sdk-smoke" });
      assert.equal(result.status, "success");
      assert.equal(result.runner.code, "RUNNER_DRY_RUN_READY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
