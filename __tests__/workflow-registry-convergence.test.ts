import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  getWorkflow,
  listWorkflowCommandSurfaces,
  listWorkflows,
  STABLE_WORKFLOW_COMMAND_SURFACES,
} from "../src/workflows/registry.js";

describe("workflow registry convergence", () => {
  test("stable command surfaces are exactly 4", () => {
    const surfaces = listWorkflowCommandSurfaces();
    assert.equal(
      surfaces.length,
      4,
      `Expected exactly 4 stable command surfaces, got ${surfaces.length}: ${surfaces.map((s) => s.command).join(", ")}`
    );
  });

  test("non-alias workflows map to 4 stable surfaces — no surface expansion", () => {
    const stableIds = new Set(
      Object.values(STABLE_WORKFLOW_COMMAND_SURFACES).flat()
    );
    const workflows = listWorkflows();
    const stableWorkflows = workflows.filter((w) => w.stability === "stable");
    for (const w of stableWorkflows) {
      assert.ok(
        stableIds.has(w.id),
        `Stable workflow "${w.id}" is not registered in STABLE_WORKFLOW_COMMAND_SURFACES`
      );
    }
    const surfaceNames = new Set(stableWorkflows.map((w) => w.surface));
    assert.ok(
      surfaceNames.size <= 4,
      `Non-alias workflows span ${surfaceNames.size} surfaces (max 4): ${[...surfaceNames].join(", ")}`
    );
  });

  test("demand workflow is the sole stable entry for the demand surface", () => {
    const workflows = listWorkflows();
    const demandSurface = workflows.filter((w) => w.surface === "demand" && w.stability === "stable");
    assert.equal(demandSurface.length, 1, "Exactly one stable workflow should own the demand surface");
    assert.equal(demandSurface[0].id, "demand");
  });

  test("demand sub_modes are declared and non-empty", () => {
    const demand = getWorkflow("demand");
    assert.ok(Array.isArray(demand.sub_modes), "demand.sub_modes must be an array");
    assert.ok(demand.sub_modes.length >= 1, "demand.sub_modes must declare at least one sub-mode");
    assert.ok(demand.sub_modes.includes("discover"), "demand sub_modes must include 'discover'");
  });

  test("compat alias workflows are hidden and alias_for is set", () => {
    const workflows = listWorkflows();
    const aliases = workflows.filter((w) => w.alias_for !== null);
    for (const alias of aliases) {
      assert.equal(alias.visibility, "hidden", `Alias workflow "${alias.id}" must be hidden`);
      assert.equal(alias.stability, "compat", `Alias workflow "${alias.id}" must have compat stability`);
      assert.notEqual(alias.alias_for, null, `Alias workflow "${alias.id}" must have alias_for set`);
    }
  });

  test("total workflow count stays within convergence ceiling", () => {
    const workflows = listWorkflows();
    assert.ok(
      workflows.length <= 16,
      `Total workflow count ${workflows.length} exceeds convergence ceiling of 16`
    );
    const stableWorkflows = workflows.filter((w) => w.stability === "stable");
    const surfaceNames = new Set(stableWorkflows.map((w) => w.surface));
    assert.ok(
      surfaceNames.size <= 4,
      `Stable workflows span ${surfaceNames.size} surfaces (max 4): ${[...surfaceNames].join(", ")}`
    );
  });
});
