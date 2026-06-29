import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildProviderCapabilityBits,
  buildProviderParityMatrix,
  inspectProviderParityMatrix,
  PROVIDER_CAPABILITY_FIELDS,
} from "../src/runtime/adapters/provider-capability-bits.js";
import { inspectProviderCapabilityGate } from "../src/runtime/gates/provider-capability-gate.js";
import { inspectPreExecutionGates } from "../src/runtime/gates/pre-execution-gates.js";

function makePreExecutionPaths() {
  const projectRoot = mkdtempSync(join(tmpdir(), "yolo-provider-capability-"));
  return {
    projectRoot,
    stateDir: join(projectRoot, "state"),
    prdPath: join(projectRoot, "prd.json"),
  };
}

describe("provider capability bits and parity matrix", () => {
  test("buildProviderCapabilityBits returns known capabilities for claude, codex, custom", () => {
    const claude = buildProviderCapabilityBits("claude");
    assert.equal(claude.supports_tools, true);
    assert.equal(claude.supports_vision, true);
    assert.equal(claude.supports_streaming, true);
    assert.equal(claude.supports_parallel, false);

    const codex = buildProviderCapabilityBits("codex");
    assert.equal(codex.supports_tools, true);
    assert.equal(codex.supports_vision, false);
    assert.equal(codex.supports_streaming, true);
    assert.equal(codex.supports_parallel, true);

    const custom = buildProviderCapabilityBits("custom");
    assert.equal(custom.supports_tools, false);
    assert.equal(custom.supports_vision, false);
    assert.equal(custom.supports_parallel, false);
  });

  test("buildProviderCapabilityBits accepts overrides", () => {
    const bits = buildProviderCapabilityBits("custom", { supports_tools: true, supports_vision: true });
    assert.equal(bits.supports_tools, true);
    assert.equal(bits.supports_vision, true);
    assert.equal(bits.supports_streaming, false);
  });

  test("buildProviderParityMatrix includes all providers and fields", () => {
    const matrix = buildProviderParityMatrix();
    assert.equal(matrix.providers.length, 3);
    assert.deepEqual(matrix.providers.map((p) => p.provider), ["claude", "codex", "custom"]);
    assert.deepEqual(matrix.fields, PROVIDER_CAPABILITY_FIELDS);
  });

  test("inspectProviderParityMatrix warns for custom provider", () => {
    const result = inspectProviderParityMatrix();
    assert.equal(result.status, "warning");
    assert.ok(result.warnings.some((w) => w.code === "PARITY_CUSTOM_ADAPTER_UNVERIFIED"));
  });

  test("inspectProviderParityMatrix passes when custom is excluded", () => {
    const result = inspectProviderParityMatrix({ providers: ["claude", "codex"] });
    assert.equal(result.status, "pass");
    assert.equal(result.warnings.length, 0);
  });
});

describe("provider capability gate", () => {
  test("blocks when PRD declares no required capabilities (fail-closed)", () => {
    const result = inspectProviderCapabilityGate({
      prd: { tasks: [{ id: "T1" }] },
      config: { ai: { executor: "claude" } },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.blocks_execution, true);
    assert.equal(result.required.length, 0);
    assert.ok(result.blockers.some((b) => b.code === "PROVIDER_CAPABILITY_NOT_DECLARED"));
  });

  test("passes when PRD opts out of capability declaration explicitly", () => {
    const result = inspectProviderCapabilityGate({
      prd: { tasks: [{ id: "T1" }], provider_capability: { opt_out: true } },
      config: { ai: { executor: "claude" } },
    });
    assert.equal(result.status, "pass");
    assert.equal(result.blocks_execution, false);
    assert.equal(result.required.length, 0);
  });

  test("blocks when provider lacks required capability", () => {
    const result = inspectProviderCapabilityGate({
      prd: { required_capabilities: ["supports_vision"] },
      config: { ai: { executor: "codex" } },
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.blocks_execution, true);
    assert.ok(result.blockers.some((b) => b.code === "PROVIDER_CAPABILITY_MISSING" && b.capability === "supports_vision"));
  });

  test("passes when provider supports all required capabilities", () => {
    const result = inspectProviderCapabilityGate({
      prd: { required_capabilities: ["supports_tools", "supports_streaming"] },
      config: { ai: { executor: "claude" } },
    });
    assert.equal(result.status, "pass");
    assert.equal(result.blocks_execution, false);
    assert.deepEqual(result.required, ["supports_tools", "supports_streaming"]);
  });

  test("reads required capabilities from tasks when not at PRD level", () => {
    const result = inspectProviderCapabilityGate({
      prd: {
        tasks: [
          { id: "T1", required_capabilities: ["supports_parallel"] },
          { id: "T2", required_capabilities: ["supports_streaming"] },
        ],
      },
      config: { ai: { executor: "claude" } },
    });
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((b) => b.capability === "supports_parallel"));
    assert.ok(!result.blockers.some((b) => b.capability === "supports_streaming"));
  });

  test("allows override via config.ai.capability_overrides", () => {
    const result = inspectProviderCapabilityGate({
      prd: { required_capabilities: ["supports_vision"] },
      config: { ai: { executor: "codex", capability_overrides: { supports_vision: true } } },
    });
    assert.equal(result.status, "pass");
    assert.equal(result.blocks_execution, false);
  });
});

function strictPrd(overrides = {}) {
  return {
    version: "2.0",
    id: "PRD-CAP-GATE",
    title: "Capability gate fixture",
    project: { name: "test", language: "javascript" },
    generated_by: "yolo-demand",
    generated_at: "2026-05-24T00:00:00.000Z",
    base_commit: "abcdef0",
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-CAP-GATE",
      approval: { approved: true, effective_for_prd: true },
      project_facts: { target_files: [{ file: "src/a.js", status: "verified" }], assumptions: [] },
      quality_report: { schema_version: "1.0", schema: "yolo.demand.quality.v1", status: "pass", total_score: 100, dimensions: [] },
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: { schema_version: "1.0", schema: "yolo.demand.quality.v1", status: "pass", total_score: 100, dimensions: [] },
    },
    requirements: [{ id: "REQ-1", text: "Keep gates strict", demand_trace: { evidence: ["EVID-1"] } }],
    designs: [{ id: "DES-1", text: "Use file-exists smoke target" }],
    tasks: [{
      id: "FIX-CAP-001",
      title: "Strict task",
      priority: "P1",
      type: "bugfix",
      task_kind: "atomic_fix",
      status: "pending",
      requirement_ids: ["REQ-1"],
      design_ids: ["DES-1"],
      scope: { targets: [{ file: "src/a.js" }] },
      post_conditions: [
        { id: "POST-FILE", type: "file_exists", severity: "FAIL", params: { file: "src/a.js" } },
        { id: "POST-TYPECHECK", type: "no_new_type_errors", severity: "FAIL", params: { command: "npm run typecheck" } },
      ],
    }],
    ...overrides,
  };
}

describe("pre-execution gates with provider capability", () => {
  test("blocks at capability stage when required capabilities are missing", () => {
    const paths = makePreExecutionPaths();
    try {
      const result = inspectPreExecutionGates({
        prd: strictPrd({ required_capabilities: ["supports_vision"] }),
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
        config: { ai: { executor: "codex" } },
      });
      assert.equal(result.status, "blocked");
      assert.equal(result.stage, "capability");
      assert.equal(result.code, "PROVIDER_CAPABILITY_BLOCKED");
      assert.ok(result.capability.blockers.some((b) => b.code === "PROVIDER_CAPABILITY_MISSING"));
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });

  test("passes all gates when capabilities are satisfied", () => {
    const paths = makePreExecutionPaths();
    try {
      const result = inspectPreExecutionGates({
        prd: strictPrd({ required_capabilities: ["supports_tools"] }),
        prdPath: paths.prdPath,
        stateDir: paths.stateDir,
        projectRoot: paths.projectRoot,
        config: { ai: { executor: "claude" } },
      });
      assert.equal(result.status, "pass");
      assert.equal(result.stage, "ready");
      assert.equal(result.code, "PRE_EXECUTION_GATES_PASS");
      assert.equal(result.capability.status, "pass");
    } finally {
      rmSync(paths.projectRoot, { recursive: true, force: true });
    }
  });
});
