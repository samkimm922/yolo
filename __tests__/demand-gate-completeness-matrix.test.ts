import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectDemandReadiness } from "../src/demand/gate.js";

function sessionWithFullCoverage() {
  return {
    idea: "inventory management dashboard",
    vision: {
      statement: "Store managers need real-time visibility into inventory gaps.",
      target_users: ["store manager", "warehouse staff"],
    },
    scenario_matrix: {
      scenarios: [
        {
          id: "SC-001",
          actor: "store manager",
          proof: "Store manager opens dashboard and sees the daily shortage list with ETA for each item.",
          exceptions: ["What if the inventory system is down?", "What if two managers view the same shortage item?"],
          surfaces: [{ id: "SURF-001", kind: "ui", target_files: ["src/pages/dashboard.tsx"] }],
        },
        {
          id: "SC-002",
          actor: "warehouse staff",
          proof: "Warehouse staff receives a notification when a transfer request is created.",
          exceptions: ["What if the warehouse is closed on weekends?"],
          surfaces: [{ id: "SURF-002", kind: "service", target_files: ["src/services/transfer.ts"] }],
        },
      ],
    },
    requirements: {
      active: [
        {
          id: "REQ-001",
          text: "Store manager can view daily shortage list",
          acceptance_scenarios: [
            { id: "AS-001", proof: "Manager opens dashboard at 8am and sees items with stock=0 highlighted in red." },
          ],
        },
        {
          id: "REQ-002",
          text: "Transfer requests notify warehouse staff",
          acceptance_scenarios: [
            { id: "AS-002", proof: "Warehouse staff phone buzzes with push notification within 30 seconds of transfer request." },
          ],
        },
      ],
    },
    prd_intake: { exceptions: ["What if the inventory system is down?"] },
  };
}

describe("demand gate completeness matrix", () => {
  test("passes when all roles have scenarios, all scenarios have exceptions, all requirements have acceptance evidence", () => {
    const session: any = sessionWithFullCoverage();
    const result: any = inspectDemandReadiness(session, { phase: "prd" });

    const matrixCheck = result.checks.find((c) => c.code === "COMPLETENESS_MATRIX");
    assert.ok(matrixCheck, "COMPLETENESS_MATRIX check must exist");
    assert.equal(matrixCheck.passed, true, "COMPLETENESS_MATRIX must pass with full coverage");
    assert.equal(matrixCheck.severity, "error", "COMPLETENESS_MATRIX must be error severity at PRD phase");

    const matrix = matrixCheck.completeness_matrix;
    assert.equal(matrix.passed, true);
    assert.equal(matrix.status, "pass");
    assert.equal(matrix.error_count, 0);
    assert.equal(matrix.coverage.roles.roles_uncovered.length, 0);
    assert.equal(matrix.coverage.exceptions.scenarios_missing_exceptions.length, 0);
    assert.equal(matrix.coverage.evidence.requirements_missing_proof.length, 0);
  });

  test("blocks when a role has no matching scenario", () => {
    const session: any = sessionWithFullCoverage();
    session.vision.target_users.push("regional director"); // no scenario for this role

    const result: any = inspectDemandReadiness(session, { phase: "discuss" });
    const matrixCheck = result.checks.find((c) => c.code === "COMPLETENESS_MATRIX");
    assert.ok(matrixCheck);
    assert.equal(matrixCheck.passed, false, "must block when a role has no scenario");

    const matrix = matrixCheck.completeness_matrix;
    assert.equal(matrix.error_count, 1);
    assert.ok(matrix.errors.some((e) => e.code === "ROLE_WITHOUT_SCENARIO"));
    assert.equal(matrix.coverage.roles.roles_uncovered.length, 1);
    assert.equal(matrix.coverage.roles.roles_uncovered[0].role, "regional director");
  });

  test("ignores command-like feature lines when checking role scenario coverage", () => {
    const session: any = sessionWithFullCoverage();
    session.vision.target_users.push("taskcli add writes a task to src/tasks.ts");
    session.vision.target_users.push("list archived tasks with --done");

    const result: any = inspectDemandReadiness(session, { phase: "discuss" });
    const matrixCheck = result.checks.find((c) => c.code === "COMPLETENESS_MATRIX");
    assert.ok(matrixCheck);
    assert.equal(matrixCheck.passed, true, "command-like feature descriptions must not become uncovered roles");
    assert.equal(matrixCheck.completeness_matrix.coverage.roles.roles_uncovered.length, 0);
  });

  test("blocks when a scenario has no exception Q&A", () => {
    const session: any = sessionWithFullCoverage();
    // Session-level exceptions activate the per-scenario check
    session.prd_intake = { exceptions: ["What if system is down?"] };
    session.scenario_matrix.scenarios[0].exceptions = [];

    const result: any = inspectDemandReadiness(session, { phase: "prd" });
    const matrixCheck = result.checks.find((c) => c.code === "COMPLETENESS_MATRIX");
    assert.ok(matrixCheck);
    assert.equal(matrixCheck.passed, false, "must block when exception data was collected but a scenario misses it");

    const matrix = matrixCheck.completeness_matrix;
    assert.equal(matrix.error_count, 1);
    assert.ok(matrix.errors.some((e) => e.code === "SCENARIO_WITHOUT_EXCEPTIONS"));
    assert.equal(matrix.coverage.exceptions.scenarios_missing_exceptions.length, 1);
  });

  test("blocks when a requirement has no acceptance evidence", () => {
    const session: any = sessionWithFullCoverage();
    session.requirements.active[1].acceptance_scenarios = [];

    const result: any = inspectDemandReadiness(session, { phase: "discuss" });
    const matrixCheck = result.checks.find((c) => c.code === "COMPLETENESS_MATRIX");
    assert.ok(matrixCheck);
    assert.equal(matrixCheck.passed, false, "must block when a requirement has no acceptance proof");

    const matrix = matrixCheck.completeness_matrix;
    assert.equal(matrix.error_count, 1);
    assert.ok(matrix.errors.some((e) => e.code === "REQUIREMENT_WITHOUT_ACCEPTANCE_EVIDENCE"));
    assert.equal(matrix.coverage.evidence.requirements_missing_proof.length, 1);
  });

  test("blocks with multiple errors combined", () => {
    const session: any = sessionWithFullCoverage();
    session.vision.target_users.push("external auditor");
    session.scenario_matrix.scenarios[0].exceptions = [];
    session.requirements.active[0].acceptance_scenarios = [];

    const result: any = inspectDemandReadiness(session, { phase: "discuss" });
    const matrixCheck = result.checks.find((c) => c.code === "COMPLETENESS_MATRIX");
    assert.ok(matrixCheck);
    assert.equal(matrixCheck.passed, false);
    assert.equal(matrixCheck.completeness_matrix.error_count, 3);
  });

  test("passes when no roles are declared (empty coverage is not an error)", () => {
    const session = {
      idea: "simple refactor with no user-facing change",
      scenario_matrix: { scenarios: [] },
      requirements: { active: [] },
    };

    const result: any = inspectDemandReadiness(session, { phase: "discuss" });
    const matrixCheck = result.checks.find((c) => c.code === "COMPLETENESS_MATRIX");
    assert.ok(matrixCheck);
    assert.equal(matrixCheck.passed, true, "empty session has no completeness violations");
    assert.equal(matrixCheck.completeness_matrix.error_count, 0);
  });

  test("severity is warning at discuss phase, error at PRD phase", () => {
    const session: any = sessionWithFullCoverage();
    session.vision.target_users.push("external auditor"); // creates a completeness violation

    const discussResult: any = inspectDemandReadiness(session, { phase: "discuss" });
    const discussCheck = discussResult.checks.find((c) => c.code === "COMPLETENESS_MATRIX");
    assert.equal(discussCheck.severity, "warning", "must be warning at discuss phase");
    assert.equal(discussCheck.passed, false);

    const prdResult: any = inspectDemandReadiness(session, { phase: "prd" });
    const prdCheck = prdResult.checks.find((c) => c.code === "COMPLETENESS_MATRIX");
    assert.equal(prdCheck.severity, "error", "must be error at PRD phase");
    assert.equal(prdCheck.passed, false);
  });

  test("blocks when session has zero exceptions across all scenarios", () => {
    const session: any = sessionWithFullCoverage();
    // Remove all exceptions from every scenario (zero-exception session)
    for (const scenario of session.scenario_matrix.scenarios) {
      scenario.exceptions = [];
    }
    session.prd_intake = undefined;

    const result: any = inspectDemandReadiness(session, { phase: "prd" });
    const matrixCheck = result.checks.find((c) => c.code === "COMPLETENESS_MATRIX");
    assert.ok(matrixCheck);
    assert.equal(matrixCheck.passed, false, "must block when no scenario has exceptions");
    assert.equal(matrixCheck.severity, "error");

    const matrix = matrixCheck.completeness_matrix;
    assert.equal(matrix.status, "blocked");
    assert.equal(matrix.error_count, session.scenario_matrix.scenarios.length);
    assert.ok(matrix.errors.every((e) => e.code === "SCENARIO_WITHOUT_EXCEPTIONS"));
    assert.equal(matrix.coverage.exceptions.scenarios_missing_exceptions.length, session.scenario_matrix.scenarios.length);
  });
});
