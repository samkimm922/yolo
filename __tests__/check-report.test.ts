import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { inspectYoloCheck, runYoloCheckCli } from "../src/runtime/gates/check-report.js";
import { runYoloCli } from "../src/cli/yolo.js";
import { initLifecycleState } from "../src/lifecycle/state.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-check-report-"));
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
    applies_to: ["ui", "browser"],
  };
}

function strictPrd(taskOverrides = {}, prdOverrides = {}) {
  return {
    version: "2.0",
    id: "PRD-20260525-CHECK-001",
    title: "Check report fixture",
    project: { name: "test", language: "javascript" },
    generated_by: "yolo-demand",
    generated_at: "2026-05-25T00:00:00.000Z",
    base_commit: "abcdef0",
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-CHECK",
      approval: { approved: true, effective_for_prd: true },
      project_facts: {
        target_files: [{ file: "src/a.js", status: "verified" }],
        assumptions: [],
      },
      quality_report: {
        schema_version: "1.0",
        schema: "yolo.demand.quality.v1",
        status: "pass",
        total_score: 100,
        dimensions: [],
      },
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: {
        schema_version: "1.0",
        schema: "yolo.demand.quality.v1",
        status: "pass",
        total_score: 100,
        dimensions: [],
      },
    },
    requirements: [{
      id: "REQ-1",
      text: "For operators, keep a small module update tracked.",
      demand_trace: { evidence: ["EVID-1"] },
    }],
    designs: [{ id: "DES-1", text: "Use target-file evidence." }],
    tasks: [{
      id: "FIX-CHECK-001",
      title: "Fix small module",
      priority: "P1",
      type: "bugfix",
      task_kind: "atomic_fix",
      status: "pending",
      requirement_ids: ["REQ-1"],
      design_ids: ["DES-1"],
      scope: { targets: [{ file: "src/a.js" }] },
      acceptance_criteria: ["Small module target is modified."],
      post_conditions: [
        {
          id: "POST-TARGET",
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: "src/a.js" },
        },
        {
          id: "POST-TYPECHECK",
          type: "no_new_type_errors",
          severity: "FAIL",
          params: { command: "npm run typecheck" },
        },
      ],
      ...taskOverrides,
    }],
    ...prdOverrides,
  };
}

describe("yolo check report", () => {
  test("passes a strict non-UI PRD while keeping missing adapter advisory", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd());

      const report = inspectYoloCheck({ prdPath, projectRoot: root });

      assert.equal(report.status, "pass");
      assert.equal(report.checks.find((check) => check.name === "prd_preflight").status, "pass");
      assert.equal(report.checks.find((check) => check.name === "adapter_readiness").status, "pass");
      assert.equal(report.checks.find((check) => check.name === "resolver_readiness").status, "pass");
      assert.ok(report.checks.find((check) => check.name === "resolver_readiness").advisories.length > 0);
      assert.ok(report.advisory_warnings.some((warning) => warning.code === "ADAPTER_MANIFEST_MISSING"));
      assert.equal(report.resolver.selected.acceptance_adapter.id, "unknown/custom");
      assert.equal(report.blockers.length, 0);
      assert.equal(report.execution_policy.gate_strength, "strict");
      assert.equal(report.remediation_plan.action, "PASS");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("strict runner policy blocks unknown execution warnings and returns nonzero", () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        post_conditions: [
          {
            id: "POST-TARGET",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/a.js" },
          },
          {
            id: "POST-MANUAL",
            type: "acceptance_criteria",
            severity: "FAIL",
            params: { text: "Human verifies the copy still feels right." },
          },
        ],
      }));

      const exitCode = runYoloCheckCli([prdPath, "--strict", "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 1);
      assert.equal(stderr, "");
      assert.equal(report.status, "blocked");
      assert.equal(report.warning_policy.fail_closed, true);
      assert.ok(report.blockers.some((blocker) => blocker.code === "MANUAL_FAIL_CONDITION" && blocker.source === "contract"));
      assert.equal(report.warnings.some((warning) => warning.code === "MANUAL_FAIL_CONDITION"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo check returns structured JSON for malformed PRDs", () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "bad-prd.json");
      writeFileSync(prdPath, "{not-json", "utf8");

      const exitCode = runYoloCheckCli([prdPath, "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 1);
      assert.equal(stderr, "");
      assert.equal(report.status, "error");
      assert.equal(report.code, "PRD_JSON_INVALID");
      assert.ok(report.blockers.some((blocker) => blocker.code === "PRD_JSON_INVALID"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo check returns structured JSON when PRD tasks is not an array", () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "bad-prd-shape.json");
      writeJson(prdPath, { version: "2.0", id: "PRD-INVALID", tasks: "not-an-array" });

      const exitCode = runYoloCheckCli([prdPath, "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 1);
      assert.equal(stderr, "");
      assert.equal(report.status, "blocked");
      assert.equal(report.code, "YOLO_CHECK_BLOCKED");
      assert.ok(report.blockers.some((blocker) => blocker.code === "PRD_SCHEMA_FAILED"));
      assert.doesNotMatch(stdout, /TypeError|traceability\\.js|\\.map is not a function/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo check returns structured JSON when the PRD JSON value is null", () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "null-prd.json");
      // `null` is valid JSON, so the file parses — the gate must still reject it
      // structurally instead of crashing inside contract evaluation.
      writeFileSync(prdPath, "null\n", "utf8");

      const exitCode = runYoloCheckCli([prdPath, "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 1);
      assert.equal(stderr, "");
      assert.equal(report.status, "blocked");
      // A null PRD is rejected up front with a dedicated shape code (a clearer
      // fail-closed signal than the generic aggregate code); both are valid
      // structured rejections — what matters is no crash / no silent pass.
      assert.ok(report.code === "PRD_NOT_OBJECT" || report.code === "YOLO_CHECK_BLOCKED");
      assert.doesNotMatch(stdout, /TypeError|Cannot read properties of null|\.map is not a function/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo check returns structured JSON when a task post_conditions is not an array", () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "post-conditions-not-array.json");
      writeJson(prdPath, strictPrd({ post_conditions: "not-an-array" }));

      const exitCode = runYoloCheckCli([prdPath, "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 1);
      assert.equal(stderr, "");
      assert.equal(report.status, "blocked");
      assert.equal(report.code, "YOLO_CHECK_BLOCKED");
      assert.doesNotMatch(stdout, /TypeError|conditions\.map is not a function/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo check returns structured JSON when a task scope.targets is not an array", () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "scope-targets-not-array.json");
      writeJson(prdPath, strictPrd({ scope: { targets: "src/a.js" } }));

      const exitCode = runYoloCheckCli([prdPath, "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 1);
      assert.equal(stderr, "");
      assert.equal(report.status, "blocked");
      assert.equal(report.code, "YOLO_CHECK_BLOCKED");
      assert.doesNotMatch(stdout, /TypeError|targets\.map is not a function/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo check blocks PRD strings with unsafe control characters", () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "control-char-prd.json");
      writeJson(prdPath, strictPrd({}, {
        title: "Check report\u0000fixture",
        tasks: [{
          ...strictPrd().tasks[0],
          title: "Fix small module\u001b[31m",
        }],
      }));

      const exitCode = runYoloCheckCli([prdPath, "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 1);
      assert.equal(stderr, "");
      assert.equal(report.status, "blocked");
      assert.equal(report.code, "YOLO_CHECK_BLOCKED");
      assert.ok(report.blockers.some((blocker) => blocker.code === "PRD_SCHEMA_FAILED"));
      const preflight = report.checks.find((check) => check.name === "prd_preflight");
      assert.ok(preflight.preflight.schema.details.some((detail) => detail.keyword === "unsafeControlCharacter"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("advisory warning reports return CLI exit 2 instead of success", () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "legacy-prd.json");
      initLifecycleState({ projectRoot: root });
      writeJson(prdPath, strictPrd({}, {
        source: undefined,
        demand_contract_required: undefined,
        demand: undefined,
        execution_readiness: undefined,
      }));

      const exitCode = runYoloCheckCli([prdPath, "--mode=advisory", "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 2);
      assert.equal(stderr, "");
      assert.equal(report.status, "warning");
      assert.equal(report.summary, "YOLO check blocked by warnings.");
      assert.equal(report.execution_policy.automation_can_continue, false);
      assert.equal(report.remediation_plan.automation_can_continue, false);
      assert.equal(report.remediation_plan.requires_human, true);
      assert.match(report.remediation_plan.summary, /automation is blocked/);
      assert.ok(report.warnings.some((warning) => warning.code === "DEMAND_CONTRACT_MISSING"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("root yolo check exits 2 for warning reports", async () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "legacy-prd.json");
      initLifecycleState({ projectRoot: root });
      writeJson(prdPath, strictPrd({}, {
        source: undefined,
        demand_contract_required: undefined,
        demand: undefined,
        execution_readiness: undefined,
      }));

      const exitCode = await runYoloCli(["check", prdPath, "--mode=advisory", "--cwd", root, "--json", "--no-write"], {
        cwd: root,
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const report = JSON.parse(stdout);

      assert.equal(exitCode, 2);
      assert.equal(stderr, "");
      assert.equal(report.status, "warning");
      assert.equal(report.execution_policy.automation_can_continue, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("YB-001 blocks runner check when the demand contract is missing", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({}, {
        source: undefined,
        demand_contract_required: undefined,
        demand: undefined,
        execution_readiness: undefined,
        requirements: [{
          id: "REQ-1",
          text: "For operators, keep inventory counts clear.",
        }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });
      const demandContract = report.checks.find((check) => check.name === "demand_contract");

      assert.equal(report.status, "blocked");
      assert.equal(report.code, "YOLO_CHECK_BLOCKED");
      assert.equal(demandContract.status, "blocked");
      assert.equal(report.execution_policy.automation_can_continue, false);
      assert.ok(report.blockers.some((blocker) => blocker.code === "DEMAND_CONTRACT_MISSING" && blocker.human_needed === true));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("YB-002 blocks investigate-first atomicity in runner check instead of warning", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        scope: { targets: [{ file: "src/a.js" }, { file: "src/b.js" }] },
        post_conditions: [
          { id: "POST-A", type: "target_file_modified", severity: "FAIL", params: { file: "src/a.js" } },
          { id: "POST-B", type: "target_file_modified", severity: "FAIL", params: { file: "src/b.js" } },
        ],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });
      const atomicity = report.checks.find((check) => check.name === "atomicity");

      assert.equal(report.status, "blocked");
      assert.equal(atomicity.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "ATOMICITY_INVESTIGATE_FIRST" && blocker.human_needed === true));
      assert.equal(report.warnings.some((warning) => warning.code === "ATOMICITY_INVESTIGATE_FIRST"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("YB-003 blocks runner check when task files and acceptance are missing", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        scope: { targets: [] },
        acceptance_criteria: [],
        post_conditions: [],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });

      assert.equal(report.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "TASK_MISSING_FILES"));
      assert.ok(report.blockers.some((blocker) => blocker.code === "TASK_MISSING_ACCEPTANCE"));
      assert.equal(report.execution_policy.automation_can_continue, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("YB-008 blocks circular task dependencies during check preflight", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({}, {
        tasks: [
          strictPrd({
            id: "A",
            depends_on: ["B"],
            scope: { targets: [{ file: "src/a.js" }] },
            post_conditions: [
              { id: "POST-A", type: "target_file_modified", severity: "FAIL", params: { file: "src/a.js" } },
              { id: "POST-TYPECHECK-A", type: "no_new_type_errors", severity: "FAIL", params: { command: "npm run typecheck" } },
            ],
          }).tasks[0],
          strictPrd({
            id: "B",
            depends_on: ["A"],
            scope: { targets: [{ file: "src/b.js" }] },
            post_conditions: [
              { id: "POST-B", type: "target_file_modified", severity: "FAIL", params: { file: "src/b.js" } },
              { id: "POST-TYPECHECK-B", type: "no_new_type_errors", severity: "FAIL", params: { command: "npm run typecheck" } },
            ],
          }).tasks[0],
        ],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });
      const dependencyPreflight = report.checks.find((check) => check.name === "task_dependency_preflight");

      assert.equal(report.status, "blocked");
      assert.equal(dependencyPreflight.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.gate === "task_dependency_preflight" && blocker.code === "TASK_DEPENDENCY_CYCLE"));
      assert.equal(report.blockers.some((blocker) => blocker.gate === "atomicity" && blocker.code === "TASK_DEPENDENCY_CYCLE"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("YB-008 blocks fully connected dependency graphs with no executable root", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      const task = (id, depends_on, file) => strictPrd({
        id,
        depends_on,
        scope: { targets: [{ file }] },
        post_conditions: [
          { id: `POST-${id}`, type: "target_file_modified", severity: "FAIL", params: { file } },
          { id: `POST-TYPECHECK-${id}`, type: "no_new_type_errors", severity: "FAIL", params: { command: "npm run typecheck" } },
        ],
      }).tasks[0];
      writeJson(prdPath, strictPrd({}, {
        tasks: [
          task("A", ["B", "C"], "src/a.js"),
          task("B", ["A", "C"], "src/b.js"),
          task("C", ["A", "B"], "src/c.js"),
        ],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });
      const dependencyPreflight = report.checks.find((check) => check.name === "task_dependency_preflight");

      assert.equal(report.status, "blocked");
      assert.equal(dependencyPreflight.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.gate === "task_dependency_preflight" && blocker.code === "TASK_DEPENDENCY_NO_ROOT"));
      assert.ok(report.blockers.some((blocker) => blocker.gate === "task_dependency_preflight" && blocker.invariant_code === "RUNTIME_INVARIANT_VIOLATED:task_graph_no_root"));
      assert.ok(report.blockers.some((blocker) => blocker.gate === "task_dependency_preflight" && blocker.code === "TASK_DEPENDENCY_CYCLE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks approved-demand PRDs with blocked quality reports", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({}, {
        generated_by: "yolo-demand",
        source: "approved_demand",
        demand_contract_required: true,
        demand: {
          id: "DEMAND-CHECK",
          approval: { approved: true, effective_for_prd: true },
          quality_report: {
            schema_version: "1.0",
            schema: "yolo.demand.quality.v1",
            status: "blocked",
            total_score: 40,
            dimensions: [],
          },
        },
        execution_readiness: {
          level: "L3",
          afk_ready: true,
          quality_status: "pass",
          quality_report: {
            schema_version: "1.0",
            schema: "yolo.demand.quality.v1",
            status: "pass",
            total_score: 100,
            dimensions: [],
          },
        },
        requirements: [{
          id: "REQ-1",
          text: "For operators, keep inventory counts clear.",
          demand_trace: { evidence: ["EVID-1"] },
        }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root });
      const demandContract = report.checks.find((check) => check.name === "demand_contract");

      assert.equal(report.status, "blocked");
      assert.equal(demandContract.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "DEMAND_QUALITY_BLOCKED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks approved-demand PRDs when approval is not effective for PRD execution", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({}, {
        generated_by: "yolo-demand",
        source: "approved_demand",
        demand_contract_required: true,
        demand: {
          id: "DEMAND-CHECK",
          approval: { approved: true, effective_for_prd: false },
          project_facts: {
            target_files: [{ file: "src/a.js", status: "verified" }],
            assumptions: [],
          },
          quality_report: {
            schema_version: "1.0",
            schema: "yolo.demand.quality.v1",
            status: "pass",
            total_score: 100,
            dimensions: [],
          },
        },
        execution_readiness: {
          level: "L3",
          afk_ready: true,
          quality_status: "pass",
          quality_report: {
            schema_version: "1.0",
            schema: "yolo.demand.quality.v1",
            status: "pass",
            total_score: 100,
            dimensions: [],
          },
        },
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root });
      const demandContract = report.checks.find((check) => check.name === "demand_contract");

      assert.equal(report.status, "blocked");
      assert.equal(demandContract.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "DEMAND_APPROVAL_NOT_EFFECTIVE_FOR_PRD" && blocker.human_needed === true));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks approved-demand PRDs with project facts outside the project root", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({}, {
        generated_by: "yolo-demand",
        source: "approved_demand",
        demand_contract_required: true,
        demand: {
          id: "DEMAND-CHECK",
          approval: { approved: true, effective_for_prd: true },
          project_facts: {
            target_files: [{ file: "/tmp/outside-project.js", status: "verified" }],
            assumptions: [],
          },
          quality_report: {
            schema_version: "1.0",
            schema: "yolo.demand.quality.v1",
            status: "pass",
            total_score: 100,
            dimensions: [],
          },
        },
        execution_readiness: {
          level: "L3",
          afk_ready: true,
          quality_status: "pass",
          quality_report: {
            schema_version: "1.0",
            schema: "yolo.demand.quality.v1",
            status: "pass",
            total_score: 100,
            dimensions: [],
          },
        },
        requirements: [{
          id: "REQ-1",
          text: "For operators, keep inventory counts clear.",
          demand_trace: { evidence: ["EVID-1"] },
        }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root });
      const demandContract = report.checks.find((check) => check.name === "demand_contract");

      assert.equal(report.status, "blocked");
      assert.equal(demandContract.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "DEMAND_PROJECT_TARGET_FACTS_UNRESOLVED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks task targets and post condition file params outside the project root", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        scope: { targets: [{ file: "../outside.ts" }] },
        post_conditions: [
          {
            id: "POST-TARGET",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "../outside.ts" },
          },
          {
            id: "POST-TYPECHECK",
            type: "no_new_type_errors",
            severity: "FAIL",
            params: { command: "npm run typecheck" },
          },
        ],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });
      const pmReadiness = report.checks.find((check) => check.name === "pm_readiness");

      assert.equal(report.status, "blocked");
      assert.equal(pmReadiness.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "TASK_TARGET_OUTSIDE_ROOT" && blocker.gate === "pm_readiness"));
      assert.ok(report.blockers.some((blocker) => blocker.code === "TASK_TARGET_OUTSIDE_ROOT" && blocker.gate === "prd_preflight"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks task targets that symlink outside the project root", () => {
    const root = tempProject();
    const outside = tempProject();
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const outsideTarget = join(outside, "outside.js");
      writeFileSync(outsideTarget, "export const outside = true;\n", "utf8");
      symlinkSync(outsideTarget, join(root, "src/link-out.js"));

      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        scope: { targets: [{ file: "src/link-out.js" }] },
        post_conditions: [
          {
            id: "POST-TARGET",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/link-out.js" },
          },
          {
            id: "POST-TYPECHECK",
            type: "no_new_type_errors",
            severity: "FAIL",
            params: { command: "npm run typecheck" },
          },
        ],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });

      assert.equal(report.status, "blocked");
      assert.ok(report.blockers.some((blocker) =>
        blocker.code === "TASK_TARGET_OUTSIDE_ROOT" &&
        blocker.gate === "prd_preflight" &&
        /src\/link-out\.js/.test(blocker.message || "")
      ));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("allows task targets resolved inside the project root", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      const insideTarget = join(root, "src/a.js");
      writeJson(prdPath, strictPrd({
        scope: { targets: [{ file: insideTarget }] },
        post_conditions: [
          {
            id: "POST-TARGET",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: insideTarget },
          },
          {
            id: "POST-TYPECHECK",
            type: "no_new_type_errors",
            severity: "FAIL",
            params: { command: "npm run typecheck" },
          },
        ],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });

      assert.equal(report.status, "pass");
      assert.equal(report.blockers.some((blocker) => blocker.code === "TASK_TARGET_OUTSIDE_ROOT"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks UI tasks without state matrix and evidence plan", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        title: "Build inventory page",
        type: "feature",
        scope: { targets: [{ file: "src/pages/inventory.tsx" }] },
        post_conditions: [{
          id: "POST-PAGE",
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: "src/pages/inventory.tsx" },
        }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root });

      assert.equal(report.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "UI_STATE_MATRIX_MISSING"));
      assert.ok(report.blockers.some((blocker) => blocker.code === "UI_EVIDENCE_PLAN_MISSING"));
      assert.ok(report.blockers.some((blocker) => blocker.code === "ADAPTER_UI_ACCEPTANCE_MISSING"));
      assert.ok(report.blockers.some((blocker) => blocker.code === "ACCEPTANCE_ADAPTER_MISSING"));
      assert.equal(report.remediation_plan.gate_strength, "strict");
      assert.equal(report.remediation_plan.blocks_ship, true);
      assert.equal(report.remediation_plan.action, "ASK_HUMAN");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("treats ui false tasks with TSX surfaces as UI and requires an adapter", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        ui: false,
        surface: "src/pages/inventory.tsx",
        title: "Build inventory page",
        type: "feature",
        scope: { targets: [{ file: "src/pages/inventory.tsx" }] },
        state_matrix: [{ state: "loaded" }],
        evidence_plan: [{ type: "screenshot" }],
        post_conditions: [
          {
            id: "POST-TARGET",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/pages/inventory.tsx" },
          },
          {
            id: "POST-TYPECHECK",
            type: "no_new_type_errors",
            severity: "FAIL",
            params: { command: "npm run typecheck" },
          },
        ],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });
      const adapter = report.checks.find((check) => check.name === "adapter_readiness");

      assert.equal(report.status, "blocked");
      assert.equal(report.task_surface_summary.ui_task_count, 1);
      assert.equal(adapter.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "ADAPTER_UI_ACCEPTANCE_MISSING"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps ui false backend tasks non-UI without hard UI signals", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        ui: false,
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });
      const adapter = report.checks.find((check) => check.name === "adapter_readiness");

      assert.equal(report.status, "pass");
      assert.equal(report.task_surface_summary.ui_task_count, 0);
      assert.equal(adapter.status, "pass");
      assert.equal(adapter.ui_task_count, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps script and library surfaces non-UI without requiring acceptance adapter", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        title: "Build CSV pipeline library",
        type: "feature",
        surface: "csv pipeline module",
        scope: { targets: [{ file: "src/csv-pipeline.ts" }] },
        acceptance_criteria: ["CSV pipeline unit tests pass for deterministic sample rows."],
        post_conditions: [
          {
            id: "POST-TARGET",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/csv-pipeline.ts" },
          },
          {
            id: "POST-TEST",
            type: "no_new_type_errors",
            severity: "FAIL",
            params: { command: "npm run typecheck" },
          },
        ],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });
      const adapter = report.checks.find((check) => check.name === "adapter_readiness");

      assert.equal(report.status, "pass", JSON.stringify(report.blockers, null, 2));
      assert.equal(report.task_surface_summary.ui_task_count, 0);
      assert.equal(adapter.status, "pass");
      assert.equal(report.blockers.some((blocker) => blocker.code === "ACCEPTANCE_ADAPTER_MISSING"), false);
      assert.equal(report.blockers.some((blocker) => blocker.code === "ADAPTER_UI_ACCEPTANCE_MISSING"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("still requires acceptance adapter for explicit UI surface without frontend target file", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        title: "Build inventory workflow",
        type: "feature",
        surface: "inventory page",
        scope: { targets: [{ file: "src/inventory-workflow.ts" }] },
        state_matrix: [{ state: "loaded" }],
        evidence_plan: [{ type: "screenshot" }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, mode: "runner" });

      assert.equal(report.status, "blocked");
      assert.equal(report.task_surface_summary.ui_task_count, 1);
      assert.ok(report.blockers.some((blocker) => blocker.code === "ACCEPTANCE_ADAPTER_MISSING"));
      assert.ok(report.blockers.some((blocker) => blocker.code === "ADAPTER_UI_ACCEPTANCE_MISSING"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses task handoff state matrix and evidence plan for UI readiness", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      writeJson(join(stateRoot, "adapters/local-browser.manifest.json"), acceptanceAdapter());
      writeJson(prdPath, strictPrd({
        title: "Build inventory page",
        type: "feature",
        scope: { targets: [{ file: "src/pages/inventory.tsx" }] },
        handoff: {
          state_matrix: [{ state: "loaded" }],
          evidence_plan: [{ type: "screenshot" }],
        },
        post_conditions: [
          {
            id: "POST-TARGET",
            type: "target_file_modified",
            severity: "FAIL",
            params: { file: "src/pages/inventory.tsx" },
          },
          {
            id: "POST-TYPECHECK",
            type: "no_new_type_errors",
            severity: "FAIL",
            params: { command: "npm run typecheck" },
          },
        ],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, stateRoot, mode: "runner" });
      const uiReadiness = report.checks.find((check) => check.name === "ui_readiness");

      assert.equal(report.status, "pass");
      assert.equal(uiReadiness.status, "pass");
      assert.equal(report.blockers.some((blocker) => blocker.code === "UI_STATE_MATRIX_MISSING"), false);
      assert.equal(report.blockers.some((blocker) => blocker.code === "UI_EVIDENCE_PLAN_MISSING"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks PRD slices that mix independent user stories", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd({
        title: "Edit and notify items",
        description: "编辑条目标题，并发送确认通知。",
        acceptance_criteria: ["编辑后的条目标题可见；确认通知已发送。"],
      }, {
        requirements: [{
          id: "REQ-1",
          text: "用户可以编辑条目标题，并发送确认通知。",
        }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root });
      const storyAtomicity = report.checks.find((check) => check.name === "story_atomicity");

      assert.equal(report.status, "blocked");
      assert.equal(storyAtomicity.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.gate === "story_atomicity" && blocker.code === "STORY_ATOMICITY_MULTI_STORY"));
      assert.ok(report.blockers.some((blocker) => blocker.gate === "story_atomicity" && blocker.task_id === "FIX-CHECK-001"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes check report into lifecycle when requested", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, strictPrd());

      const report = inspectYoloCheck({
        prdPath,
        projectRoot: root,
        stateRoot,
        writeLifecycle: true,
      });

      assert.equal(report.lifecycle_write.stage, "check");
      assert.equal(existsSync(join(stateRoot, "lifecycle/check-report.json")), true);
      const artifact = JSON.parse(readFileSync(join(stateRoot, "lifecycle/check-report.json"), "utf8"));
      assert.equal(artifact.report.schema, "yolo.check.report.v1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses resolver-selected acceptance adapter for UI readiness", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      writeJson(join(stateRoot, "adapters/local-browser.manifest.json"), acceptanceAdapter());
      writeJson(prdPath, strictPrd({
        title: "Build inventory page",
        type: "feature",
        scope: { targets: [{ file: "src/pages/inventory.tsx" }] },
        state_matrix: [{ state: "loaded" }],
        evidence_plan: [{ type: "screenshot" }],
        post_conditions: [{
          id: "POST-PAGE",
          type: "screenshot_exists",
          severity: "FAIL",
          params: { file: ".yolo/state/evidence/ui/inventory.png" },
        }],
      }));

      const report = inspectYoloCheck({ prdPath, projectRoot: root, stateRoot });
      const adapter = report.checks.find((check) => check.name === "adapter_readiness");

      assert.equal(adapter.status, "pass");
      assert.equal(adapter.adapter_id, "local-browser");
      assert.equal(report.resolver.selected.acceptance_adapter.id, "local-browser");
      assert.equal(report.task_surface_summary.ui_task_count, 1);
      assert.equal(report.blockers.some((blocker) => blocker.code === "ADAPTER_UI_ACCEPTANCE_MISSING"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
