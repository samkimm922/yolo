import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildManualExternalReleasePlan,
  MANUAL_EXTERNAL_RELEASE_SCHEMA_VERSION,
  runManualExternalReleaseGate,
} from "../src/release/manual-external-release.js";

const packageJson = {
  name: "yolo",
  version: "1.0.0",
  private: false,
  type: "module",
};

const requestedOperations = [
  "publish_public_beta",
  "access_credentials",
  "billable_provider_execution",
  "public_dogfood_report",
];

function runbook(overrides = {}) {
  return {
    status: "ready",
    blockers: [],
    manual_commands: requestedOperations.map((id) => ({
      id,
      execute: false,
      requires_human: true,
    })),
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      publish_command_executed: false,
      dogfood_report_published: false,
    },
    ...overrides,
  };
}

function manualReleaseRecord(overrides = {}) {
  return {
    package_name: "yolo",
    package_version: "1.0.0",
    operator: "release-owner",
    published_at: "2026-05-25T00:00:00.000Z",
    registry_url: "https://www.npmjs.com/package/yolo/v/1.0.0",
    executed_by_sdk: false,
    published_by_sdk: false,
    token_read_by_sdk: false,
    billable_provider_executed_by_sdk: false,
    dogfood_report_published_by_sdk: false,
    ...overrides,
  };
}

function credentialEvidence(overrides = {}) {
  return {
    status: "pass",
    operator: "release-owner",
    executed_at: "2026-05-25T00:01:00.000Z",
    command: "npm whoami",
    token_value_redacted: true,
    secret_material_recorded: false,
    executed_by_sdk: false,
    token_read_by_sdk: false,
    ...overrides,
  };
}

function billableEvidence(overrides = {}) {
  return {
    status: "pass",
    operator: "release-owner",
    executed_at: "2026-05-25T00:02:00.000Z",
    provider: "codex",
    command: "codex exec --model gpt-5 -- yolo dogfood",
    evidence_files: ["state/reports/run-dogfood/run-report.json"],
    cost_acknowledged: true,
    executed_by_sdk: false,
    billable_provider_executed_by_sdk: false,
    ...overrides,
  };
}

function dogfoodEvidence(overrides = {}) {
  return {
    status: "pass",
    public_url: "https://example.com/yolo-dogfood-1.0.0",
    evidence_files: ["state/reports/run-dogfood/run-report.json"],
    privacy_reviewed: true,
    publication_approved: true,
    approver: "release-owner",
    executed_by_sdk: false,
    dogfood_report_published_by_sdk: false,
    ...overrides,
  };
}

function postReleaseAudit(overrides = {}) {
  return {
    status: "pass",
    blockers: [],
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      publish_command_executed: false,
      dogfood_report_published: false,
    },
    components: {
      dogfood_audit: dogfoodEvidence(),
    },
    ...overrides,
  };
}

function stableGraduation(overrides = {}) {
  return {
    status: "pass",
    blockers: [],
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      publish_command_executed: false,
      dogfood_report_published: false,
      stable_graduation_declared: true,
    },
    ...overrides,
  };
}

function gate(options = {}) {
  return runManualExternalReleaseGate({
    yoloRoot: "/tmp/yolo",
    packageJson,
    requestedOperations,
    operatorRunbook: runbook(),
    manualReleaseRecord: manualReleaseRecord(),
    credentialEvidence: credentialEvidence(),
    billableProviderEvidence: billableEvidence(),
    dogfoodPublicationEvidence: dogfoodEvidence(),
    postReleaseAudit: postReleaseAudit(),
    stableGraduation: stableGraduation(),
    ...options,
  });
}

describe("manual external release evidence gate", () => {
  test("buildManualExternalReleasePlan is evidence-only and has no release side effects", () => {
    const plan = buildManualExternalReleasePlan({ yoloRoot: "/tmp/yolo" });

    assert.equal(plan.schema_version, MANUAL_EXTERNAL_RELEASE_SCHEMA_VERSION);
    assert.deepEqual(plan.requested_operations, requestedOperations);
    assert.equal(plan.writes_workspace, false);
    assert.equal(plan.publishes, false);
    assert.equal(plan.reads_credentials, false);
    assert.equal(plan.executes_billable_provider, false);
    assert.equal(plan.publishes_dogfood_report, false);
    assert.equal(plan.requires_human_operator, true);
    assert.ok(plan.required_evidence.some((item) => item.includes("post-release audit")));
    assert.ok(plan.required_evidence.some((item) => item.includes("stable graduation")));
  });

  test("blocks missing manual evidence and blocked downstream release gates", () => {
    const result = gate({
      manualReleaseRecord: null,
      credentialEvidence: null,
      billableProviderEvidence: null,
      dogfoodPublicationEvidence: null,
      operatorRunbook: runbook({ status: "blocked", blockers: [{ code: "RUNBOOK_DOGFOOD_REPORT_PASS" }] }),
      postReleaseAudit: postReleaseAudit({ status: "blocked", blockers: [{ code: "POST_RELEASE_AUDIT_DOGFOOD_AUDIT_PASS" }] }),
      stableGraduation: stableGraduation({ status: "blocked", blockers: [{ code: "STABLE_GRADUATION_PUBLIC_DOGFOOD_EVIDENCE" }] }),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "MANUAL_EXTERNAL_RELEASE_RUNBOOK_READY"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "MANUAL_EXTERNAL_RELEASE_RECORD_PRESENT"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "MANUAL_EXTERNAL_RELEASE_CREDENTIAL_EVIDENCE_PRESENT"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "MANUAL_EXTERNAL_RELEASE_BILLABLE_EVIDENCE_PRESENT"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "MANUAL_EXTERNAL_RELEASE_DOGFOOD_EVIDENCE_PRESENT"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "MANUAL_EXTERNAL_RELEASE_POST_RELEASE_AUDIT_PASS"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "MANUAL_EXTERNAL_RELEASE_STABLE_GRADUATION_PASS"));
    assert.equal(result.guarantees.published, false);
  });

  test("blocks raw credential material and SDK-executed external claims", () => {
    const result = gate({
      credentialEvidence: credentialEvidence({
        token_value_redacted: false,
        token_value: "npm_secret_token",
        token_read_by_sdk: true,
      }),
      manualReleaseRecord: manualReleaseRecord({ published_by_sdk: true }),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "MANUAL_EXTERNAL_RELEASE_RECORD_APPROVED"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "MANUAL_EXTERNAL_RELEASE_CREDENTIAL_REDACTED"));
    assert.equal(result.guarantees.credential_access, false);
  });

  test("blocks billable provider and dogfood evidence without external approval", () => {
    const result = gate({
      billableProviderEvidence: billableEvidence({
        cost_acknowledged: false,
        billable_provider_executed_by_sdk: true,
      }),
      dogfoodPublicationEvidence: dogfoodEvidence({
        privacy_reviewed: false,
        publication_approved: false,
        dogfood_report_published_by_sdk: true,
      }),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "MANUAL_EXTERNAL_RELEASE_BILLABLE_APPROVED"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "MANUAL_EXTERNAL_RELEASE_DOGFOOD_APPROVED"));
    assert.equal(result.guarantees.billable_provider_execution, false);
    assert.equal(result.guarantees.dogfood_report_published, false);
  });

  test("passes only with full manual evidence, post-release audit, and stable graduation", () => {
    const result = gate();

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.package.version, "1.0.0");
    assert.equal(result.evidence.manual_release_record.package_name, "yolo");
    assert.equal(result.components.post_release_audit.status, "pass");
    assert.equal(result.components.stable_graduation.status, "pass");
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.credential_access, false);
    assert.equal(result.guarantees.billable_provider_execution, false);
    assert.equal(result.guarantees.audited_manual_external_release_only, true);
    assert.equal(result.guarantees.stable_release_verified, true);
  });
});
