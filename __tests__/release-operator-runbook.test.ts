import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOperatorReleaseRunbookPlan,
  OPERATOR_RELEASE_OPERATIONS,
  OPERATOR_RELEASE_RUNBOOK_SCHEMA_VERSION,
  runOperatorReleaseRunbookGate,
} from "../src/release/operator-runbook.js";

const packageJson = {
  name: "yolo",
  version: "0.1.0",
  private: false,
  type: "module",
};

function decisionGate(approvedActions = ["remove_private", "publish_public_beta"]) {
  return {
    status: "ready",
    approved_actions: approvedActions,
    action_authorization: {
      remove_private: approvedActions.includes("remove_private"),
      publish_public_beta: approvedActions.includes("publish_public_beta"),
      access_credentials: approvedActions.includes("access_credentials"),
      billable_provider_execution: approvedActions.includes("billable_provider_execution"),
    },
    blockers: [],
  };
}

function operatorState(overrides = {}) {
  const gate = overrides.decision_gate || decisionGate();
  return {
    status: "applied",
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      publish_command_executed: false,
      package_private_mutated: true,
    },
    post_mutation_readiness: {
      status: "pass",
      blockers: [],
    },
    components: {
      decision_gate: gate,
    },
    ...overrides,
  };
}

function dogfoodReport(overrides = {}) {
  return {
    status: "pass",
    report_path: "reports/dogfood-public-beta.md",
    evidence_files: ["state/reports/run-1/run-report.json"],
    privacy_reviewed: true,
    publication_approved: true,
    approver: "release-owner",
    ...overrides,
  };
}

function runbook(options = {}) {
  return runOperatorReleaseRunbookGate({
    yoloRoot: "/tmp/yolo",
    packageJson,
    ...options,
  });
}

describe("operator release runbook gate", () => {
  test("buildOperatorReleaseRunbookPlan creates manual-only instructions with no side effects", () => {
    const plan = buildOperatorReleaseRunbookPlan({
      yoloRoot: "/tmp/yolo",
      packageJson,
      dogfoodReport: dogfoodReport(),
    });

    assert.equal(plan.schema_version, OPERATOR_RELEASE_RUNBOOK_SCHEMA_VERSION);
    assert.deepEqual(plan.requested_operations, ["publish_public_beta", "public_dogfood_report"]);
    assert.equal(plan.writes_workspace, false);
    assert.equal(plan.publishes, false);
    assert.equal(plan.reads_credentials, false);
    assert.equal(plan.executes_billable_provider, false);
    assert.deepEqual(plan.manual_commands.map((command) => command.id), [
      "publish_public_beta",
      "public_dogfood_report",
    ]);
    assert.ok(plan.manual_commands.every((command) => command.execute === false));
    assert.ok(plan.manual_commands.every((command) => command.requires_human === true));
    assert.ok(OPERATOR_RELEASE_OPERATIONS.includes("billable_provider_execution"));
  });

  test("publish stays blocked until operator release-state mutation is applied", () => {
    const result = runbook({
      operatorState: operatorState({ status: "planned" }),
      dogfoodReport: dogfoodReport(),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "RUNBOOK_OPERATOR_STATE_APPLIED_FOR_PUBLISH"));
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.publish_command_executed, false);
  });

  test("public dogfood report requires pass status, evidence, privacy review, and approval", () => {
    const result = runbook({
      operatorState: operatorState(),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "RUNBOOK_DOGFOOD_REPORT_PRESENT"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "RUNBOOK_DOGFOOD_REPORT_PASS"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "RUNBOOK_DOGFOOD_REPORT_EVIDENCE"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "RUNBOOK_DOGFOOD_REPORT_PRIVACY_REVIEWED"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "RUNBOOK_DOGFOOD_REPORT_PUBLICATION_APPROVED"));
    assert.equal(result.guarantees.dogfood_report_published, false);
  });

  test("runbook is ready when publish authorization, applied state, and dogfood evidence all pass", () => {
    const result = runbook({
      operatorState: operatorState(),
      dogfoodReport: dogfoodReport(),
    });

    assert.equal(result.status, "ready", JSON.stringify(result.blockers, null, 2));
    assert.deepEqual(result.manual_commands.map((command) => command.id), [
      "publish_public_beta",
      "public_dogfood_report",
    ]);
    assert.ok(result.manual_commands.every((command) => command.execute === false));
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.credential_access, false);
    assert.equal(result.guarantees.provider_execution, false);
  });

  test("credential and billable operations require controlled decision authorization", () => {
    const result = runbook({
      requestedOperations: [
        "publish_public_beta",
        "access_credentials",
        "billable_provider_execution",
        "public_dogfood_report",
      ],
      operatorState: operatorState(),
      dogfoodReport: dogfoodReport(),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "RUNBOOK_CREDENTIAL_ACCESS_AUTHORIZED"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "RUNBOOK_BILLABLE_PROVIDER_AUTHORIZED"));
    assert.equal(result.guarantees.credential_access, false);
    assert.equal(result.guarantees.billable_provider_execution, false);
  });

  test("authorized billable provider operation remains a manual instruction and does not execute", () => {
    const releaseDecision = decisionGate([
      "remove_private",
      "publish_public_beta",
      "access_credentials",
      "billable_provider_execution",
    ]);
    const result = runbook({
      requestedOperations: [
        "publish_public_beta",
        "access_credentials",
        "billable_provider_execution",
        "public_dogfood_report",
      ],
      operatorState: operatorState({ decision_gate: releaseDecision }),
      dogfoodReport: dogfoodReport(),
      providerCommand: "npm run dogfood:provider",
    });

    assert.equal(result.status, "ready", JSON.stringify(result.blockers, null, 2));
    const billableCommand = result.manual_commands.find((command) => command.id === "billable_provider_execution");
    assert.equal(billableCommand.command, "npm run dogfood:provider");
    assert.equal(billableCommand.execute, false);
    assert.equal(billableCommand.requires_billable_provider, true);
    assert.equal(result.guarantees.billable_provider_execution, false);
  });
});
