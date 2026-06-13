import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { decidePreExecutionOutcome } from "../src/runtime/run-lifecycle/pre-execution-outcome.js";
import { runPreExecutionGates } from "../src/runtime/runner-core.js";

// B1: behavior tests for the pure decision seam extracted from runPreExecutionGates,
// plus the deps-injection seam that lets callers drive gate inspection from tests.
// Mutation sanity (recorded in B1 commit): flipping `gate.status === "pass"` to
// `!== "pass"` in decidePreExecutionOutcome turns pass/warning/blocked tests RED.

describe("decidePreExecutionOutcome", () => {
  test("pass gate does not halt", () => {
    const decision = decidePreExecutionOutcome(
      { status: "pass", stage: "ready", code: "PRE_EXECUTION_GATES_PASS", exit_code: 0, message: "ok", messages: [] },
      {},
    );
    assert.equal(decision.halt, false);
    assert.equal(decision.outcome, "pass");
    assert.equal(decision.shouldExit, false);
    assert.equal(decision.shouldThrow, false);
    assert.equal(decision.logLevel, null);
  });

  test("warning gate halts with warn level and throws when exitOnFailure is false", () => {
    const gate = {
      status: "warning",
      stage: "contract",
      code: "PRD_CONTRACT_WARNING_BLOCKED",
      exit_code: 2,
      message: "warn-msg",
      contract: { doctor: "doc", migration: "mig", evidence_path: "ev.json" },
      messages: ["w1", "w2"],
    };
    const decision = decidePreExecutionOutcome(gate, { exitOnFailure: false });
    assert.equal(decision.halt, true);
    assert.equal(decision.outcome, "warning");
    assert.equal(decision.logLevel, "warn");
    assert.equal(decision.exitCode, 2);
    assert.equal(decision.shouldExit, false);
    assert.equal(decision.shouldThrow, true);
    assert.equal(decision.output, "w1\nw2");
    assert.equal(decision.errorMessage, "warn-msg");
    assert.equal(decision.details.doctor, "doc");
    assert.equal(decision.details.migration, "mig");
    assert.equal(decision.details.evidence_file, "ev.json");
    assert.equal(decision.throwExitCode, 2);
  });

  test("blocked gate halts with error level and exits when exitOnFailure is true", () => {
    const gate = {
      status: "blocked",
      stage: "spec",
      code: "PRD_SPEC_GOVERNANCE_BLOCKED",
      exit_code: 1,
      message: "blocked-msg",
      spec: { result: { ok: false } },
      messages: ["b"],
    };
    const decision = decidePreExecutionOutcome(gate, { exitOnFailure: true });
    assert.equal(decision.halt, true);
    assert.equal(decision.outcome, "blocked");
    assert.equal(decision.logLevel, "error");
    assert.equal(decision.exitCode, 1);
    assert.equal(decision.shouldExit, true);
    assert.equal(decision.shouldThrow, false);
    assert.equal(decision.details.code, "PRD_SPEC_GOVERNANCE_BLOCKED");
    assert.deepEqual(decision.details.spec_governance, { ok: false });
  });

  test("blocked gate falls back to exitCode 1 when gate.exit_code is missing", () => {
    const decision = decidePreExecutionOutcome(
      { status: "blocked", stage: "spec", code: "X", message: "m", spec: { result: {} }, messages: [] },
      { exitOnFailure: false },
    );
    assert.equal(decision.exitCode, 1);
    assert.equal(decision.throwExitCode, undefined);
  });
});

describe("runPreExecutionGates deps injection", () => {
  test("injected blocked gate throws and invokes onHalt with the decision", () => {
    const blockedGate = {
      status: "blocked",
      stage: "spec",
      code: "PRD_SPEC_GOVERNANCE_BLOCKED",
      exit_code: 1,
      message: "blocked-msg",
      spec: { result: {} },
      messages: ["m"],
    };
    let halted = null;
    assert.throws(
      () => runPreExecutionGates("prd.json", {
        exitOnFailure: false,
        deps: {
          loadPRD: () => ({}),
          inspectGates: () => blockedGate,
          onHalt: (decision, gate) => { halted = { decision, gate }; },
        },
      }),
      /blocked-msg/,
    );
    assert.equal(halted !== null, true);
    assert.equal(halted.gate, blockedGate);
    assert.equal(halted.decision.outcome, "blocked");
    assert.equal(halted.decision.shouldThrow, true);
  });

  test("injected pass gate does not throw and does not call onHalt", () => {
    let halted = false;
    assert.doesNotThrow(() => runPreExecutionGates("prd.json", {
      exitOnFailure: true,
      deps: {
        loadPRD: () => ({}),
        inspectGates: () => ({ status: "pass", stage: "ready", code: "P", exit_code: 0, message: "ok", messages: [] }),
        onHalt: () => { halted = true; },
      },
    }));
    assert.equal(halted, false);
  });
});
