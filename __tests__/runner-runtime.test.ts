import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/lib/config.js";
import { inspectYoloCheck } from "../src/runtime/gates/check-report.js";
import { runRunnerRuntime } from "../src/runtime/runner-runtime.js";

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "yolo-runner-runtime-"));
  mkdirSync(join(root, ".yolo", "keys"), { recursive: true });
  writeFileSync(join(root, ".yolo", "keys", "ledger.hmac"), "runner-runtime-test-ledger-key", "utf8");
  return root;
}

function writeJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function approvedDemandFields(targetFiles = []) {
  const quality = {
    schema_version: "1.0",
    schema: "yolo.demand.quality.v1",
    status: "pass",
    total_score: 100,
    dimensions: [],
  };
  return {
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-RUNNER-RUNTIME-TEST",
      approval: { approved: true, effective_for_prd: true },
      project_facts: {
        target_files: targetFiles.map((file) => ({ file, status: "verified" })),
        assumptions: [],
      },
      quality_report: quality,
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: quality,
    },
  };
}

function tracedRequirement(id, text) {
  return {
    id,
    text,
    demand_trace: { evidence: [`EVID-${id}`] },
  };
}

function prepareLifecycle(projectRoot, stateRoot, prdPath) {
  writeLifecycleStageReport("discovery", { status: "success" }, {
    projectRoot,
    stateRoot,
    writeSessionMemory: false,
    skipSequenceCheck: true,
  });
  writeLifecycleStageReport("roadmap", { status: "success" }, {
    projectRoot,
    stateRoot,
    writeSessionMemory: false,
    skipSequenceCheck: true,
  });
  writeLifecycleStageReport("prd", { status: "success", prd_path: prdPath, artifacts: [prdPath] }, {
    projectRoot,
    stateRoot,
    writeSessionMemory: false,
    skipSequenceCheck: true,
  });
  return inspectYoloCheck({ prdPath, projectRoot, stateRoot, writeLifecycle: true });
}

function writeRunnablePrd(prdPath) {
  writeJson(prdPath, {
    version: "2.0",
    id: "PRD-20260606-RUNNER-RUNTIME",
    title: "Runner runtime final verdict",
    project: { name: "runner-runtime-test", language: "javascript" },
    generated_by: "yolo-review-agent",
    generated_at: "2026-06-06T00:00:00.000Z",
    base_commit: "abcdef0",
    review_policy: { mode: "disabled" },
    ...approvedDemandFields(["README.md"]),
    requirements: [tracedRequirement("REQ-RUNTIME-001", "Runner runtime must fail closed on blocked results.")],
    designs: [{ id: "DES-RUNTIME-001", text: "Normalize the final runner verdict before returning runtime status." }],
    tasks: [{
      id: "FIX-RUNTIME-001",
      title: "Touch README for runtime verdict",
      priority: "P3",
      type: "cleanup",
      task_kind: "atomic_fix",
      status: "pending",
      requirement_ids: ["REQ-RUNTIME-001"],
      design_ids: ["DES-RUNTIME-001"],
      scope: { targets: [{ file: "README.md" }] },
      acceptance_criteria: ["README change records the runtime verdict behavior."],
      post_conditions: [{
        id: "POST-README",
        type: "target_file_modified",
        severity: "FAIL",
        params: { file: "README.md" },
      }, {
        id: "POST-TYPECHECK",
        type: "no_new_type_errors",
        severity: "FAIL",
        params: { command: "npm run typecheck" },
      }],
    }],
  });
}

describe("runner runtime final verdict", () => {
  test("loads target project .yolo/config.json before invoking runner-core", async () => {
    const projectRoot = tempProject();
    const stateRoot = join(projectRoot, ".yolo");
    const prdPath = join(stateRoot, "data/prd/current/runtime.json");
    let seenOptions = null;
    try {
      writeFileSync(join(projectRoot, "README.md"), "# runner runtime\n", "utf8");
      writeJson(join(stateRoot, "config.json"), {
        version: "2.0",
        project: { name: "TargetProject", root: "." },
        build: {
          type_check: "echo target-typecheck",
          lint: "echo target-lint",
        },
      });
      writeRunnablePrd(prdPath);
      const check = prepareLifecycle(projectRoot, stateRoot, prdPath);
      assert.notEqual(check.status, "blocked", JSON.stringify(check.blockers, null, 2));

      await runRunnerRuntime({
        prdPath,
        projectRoot,
        stateRoot,
        startProgressServer: false,
        initializeBaselines: false,
        writeLifecycle: false,
      }, {
        runner: {
          run: async (_prd, options) => {
            seenOptions = options;
            return {
              status: "success",
              summary: "runner completed",
              exit_code: 0,
              run_id: "run-mock",
              prd: prdPath,
              completed: ["FIX-RUNTIME-001"],
              failed: [],
              skipped: [],
              blocked: [],
              contractReview: [],
              report: {
                status: "success",
                summary: { failed: 0, blocked: 0, evidence_failures: 0 },
              },
            };
          },
        },
      });

      assert.equal(seenOptions.config.project.name, "TargetProject");
      assert.equal(seenOptions.config.build.type_check, "echo target-typecheck");
      assert.equal(seenOptions.config.build.lint, "echo target-lint");
    } finally {
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("returns error when mocked runner exits 0 with blocked tasks", async () => {
    const projectRoot = tempProject();
    const stateRoot = join(projectRoot, ".yolo");
    const prdPath = join(stateRoot, "data/prd/current/runtime.json");
    try {
      writeFileSync(join(projectRoot, "README.md"), "# runner runtime\n", "utf8");
      writeRunnablePrd(prdPath);
      const check = prepareLifecycle(projectRoot, stateRoot, prdPath);
      assert.notEqual(check.status, "blocked", JSON.stringify(check.blockers, null, 2));

      const result = await runRunnerRuntime({
        prdPath,
        projectRoot,
        stateRoot,
        startProgressServer: false,
        initializeBaselines: false,
      }, {
        runner: {
          run: async () => ({
            status: "success",
            summary: "runner completed",
            exit_code: 0,
            run_id: "run-mock",
            prd: prdPath,
            completed: ["FIX-RUNTIME-001"],
            failed: [],
            skipped: [],
            blocked: ["FIX-RUNTIME-BLOCKED"],
            contractReview: [],
            report: {
              status: "success",
              summary: { failed: 0, blocked: 0, evidence_failures: 0 },
            },
          }),
        },
      });

      assert.equal(result.status, "error");
      assert.equal(result.exit_code, 1);
      assert.deepEqual(result.blocked, ["FIX-RUNTIME-BLOCKED"]);
      assert.ok(result.final_verdict.issues.some((issue) => issue.code === "BLOCKED_TASKS"));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("returns error when mocked runner reports top-level error with exit code 0", async () => {
    const projectRoot = tempProject();
    const stateRoot = join(projectRoot, ".yolo");
    const prdPath = join(stateRoot, "data/prd/current/runtime.json");
    try {
      writeFileSync(join(projectRoot, "README.md"), "# runner runtime\n", "utf8");
      writeRunnablePrd(prdPath);
      const check = prepareLifecycle(projectRoot, stateRoot, prdPath);
      assert.notEqual(check.status, "blocked", JSON.stringify(check.blockers, null, 2));

      const result = await runRunnerRuntime({
        prdPath,
        projectRoot,
        stateRoot,
        startProgressServer: false,
        initializeBaselines: false,
      }, {
        runner: {
          run: async () => ({
            status: "error",
            summary: "runner failed internally",
            exit_code: 0,
            run_id: "run-mock",
            prd: prdPath,
            completed: ["FIX-RUNTIME-001"],
            failed: [],
            skipped: [],
            blocked: [],
            contractReview: [],
            report: {
              status: "success",
              summary: { failed: 0, blocked: 0, evidence_failures: 0 },
            },
          }),
        },
      });

      assert.equal(result.status, "error");
      assert.equal(result.exit_code, 1);
      assert.equal(result.summary, "runner failed closed: RUNNER_RESULT_STATUS_ERROR=1");
      assert.ok(result.final_verdict.issues.some((issue) => issue.code === "RUNNER_RESULT_STATUS_ERROR"));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("returns error when mocked runner reports non-clean status with exit code 0", async () => {
    for (const status of ["warning", "dry_run", "not_run", "ready"]) {
      const projectRoot = tempProject();
      const stateRoot = join(projectRoot, ".yolo");
      const prdPath = join(stateRoot, "data/prd/current/runtime.json");
      try {
        writeFileSync(join(projectRoot, "README.md"), "# runner runtime\n", "utf8");
        writeRunnablePrd(prdPath);
        const check = prepareLifecycle(projectRoot, stateRoot, prdPath);
        assert.notEqual(check.status, "blocked", JSON.stringify(check.blockers, null, 2));

        const result = await runRunnerRuntime({
          prdPath,
          projectRoot,
          stateRoot,
          startProgressServer: false,
          initializeBaselines: false,
        }, {
          runner: {
            run: async () => ({
              status,
              summary: "runner did not produce clean execution status",
              exit_code: 0,
              run_id: "run-mock",
              prd: prdPath,
              completed: ["FIX-RUNTIME-001"],
              failed: [],
              skipped: [],
              blocked: [],
              contractReview: [],
              report: {
                status: "success",
                summary: { failed: 0, blocked: 0, evidence_failures: 0 },
              },
            }),
          },
        });

        assert.equal(result.status, "error", status);
        assert.equal(result.exit_code, 1, status);
        assert.ok(result.final_verdict.issues.some((issue) => issue.code === "RUNNER_RESULT_STATUS_ERROR"), status);
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    }
  });

  test("returns error when mocked runner claims success without run report artifacts", async () => {
    const projectRoot = tempProject();
    const stateRoot = join(projectRoot, ".yolo");
    const prdPath = join(stateRoot, "data/prd/current/runtime.json");
    try {
      writeFileSync(join(projectRoot, "README.md"), "# runner runtime\n", "utf8");
      writeRunnablePrd(prdPath);
      const check = prepareLifecycle(projectRoot, stateRoot, prdPath);
      assert.notEqual(check.status, "blocked", JSON.stringify(check.blockers, null, 2));

      const result = await runRunnerRuntime({
        prdPath,
        projectRoot,
        stateRoot,
        startProgressServer: false,
        initializeBaselines: false,
      }, {
        runner: {
          run: async () => ({
            status: "success",
            summary: "runner completed without evidence artifacts",
            exit_code: 0,
            run_id: "run-mock",
            prd: prdPath,
            completed: ["FIX-RUNTIME-001"],
            failed: [],
            skipped: [],
            blocked: [],
            contractReview: [],
            report: {
              status: "success",
              summary: { failed: 0, blocked: 0, evidence_failures: 0 },
            },
            final_answer: {
              status: "success",
              outcome: "success",
              checks: [{ name: "tasks", status: "pass" }],
              blockers: [],
            },
          }),
        },
      });

      assert.equal(result.status, "error");
      assert.equal(result.exit_code, 1);
      assert.ok(result.final_verdict.issues.some((issue) => issue.code === "RUN_REPORT_ARTIFACT_MISSING"));
      assert.ok(result.final_verdict.issues.some((issue) => issue.code === "FINAL_ANSWER_ARTIFACT_MISSING"));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("returns error when mocked runner claims success with dryRun flag", async () => {
    const projectRoot = tempProject();
    const stateRoot = join(projectRoot, ".yolo");
    const prdPath = join(stateRoot, "data/prd/current/runtime.json");
    try {
      writeFileSync(join(projectRoot, "README.md"), "# runner runtime\n", "utf8");
      writeRunnablePrd(prdPath);
      const check = prepareLifecycle(projectRoot, stateRoot, prdPath);
      assert.notEqual(check.status, "blocked", JSON.stringify(check.blockers, null, 2));

      const result = await runRunnerRuntime({
        prdPath,
        projectRoot,
        stateRoot,
        startProgressServer: false,
        initializeBaselines: false,
      }, {
        runner: {
          run: async () => ({
            status: "success",
            summary: "runner dry-run result",
            exit_code: 0,
            dryRun: true,
            run_id: "run-mock",
            prd: prdPath,
            completed: ["FIX-RUNTIME-001"],
            failed: [],
            skipped: [],
            blocked: [],
            contractReview: [],
            report: {
              status: "success",
              summary: { failed: 0, blocked: 0, evidence_failures: 0 },
            },
            final_answer: {
              status: "success",
              outcome: "success",
              checks: [{ name: "tasks", status: "pass" }],
              blockers: [],
            },
          }),
        },
      });

      assert.equal(result.status, "error");
      assert.equal(result.exit_code, 1);
      assert.ok(result.final_verdict.issues.some((issue) => issue.code === "RUNNER_RESULT_DRY_RUN"));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
