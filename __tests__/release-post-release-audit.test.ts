import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPostReleaseAuditPlan,
  POST_RELEASE_AUDIT_SCHEMA_VERSION,
  runPostReleaseAuditGate,
} from "../src/release/post-release-audit.js";

const packageJson = {
  name: "yolo",
  version: "0.1.0",
  private: false,
  type: "module",
};

function readyRunbook(overrides = {}) {
  return {
    status: "ready",
    blockers: [],
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

function passingHardeningDrill(overrides = {}) {
  return {
    status: "pass",
    blockers: [],
    components: {
      package_install: { status: "pass" },
    },
    guarantees: {
      published: false,
      credential_access: false,
      provider_execution_allowed: false,
      billable_provider_execution: false,
    },
    ...overrides,
  };
}

function manualReleaseRecord(overrides = {}) {
  return {
    package_name: "yolo",
    package_version: "0.1.0",
    operator: "release-owner",
    published_at: "2026-05-25T00:00:00.000Z",
    registry_url: "https://www.npmjs.com/package/yolo/v/0.1.0",
    executed_by_sdk: false,
    published_by_sdk: false,
    token_read_by_sdk: false,
    billable_provider_executed_by_sdk: false,
    dogfood_report_published_by_sdk: false,
    ...overrides,
  };
}

function dogfoodAudit(overrides = {}) {
  return {
    status: "pass",
    public_url: "https://example.com/yolo-dogfood-0.1.0",
    evidence_files: ["state/reports/run-1/run-report.json"],
    privacy_reviewed: true,
    publication_approved: true,
    approver: "release-owner",
    ...overrides,
  };
}

function audit(options = {}) {
  return runPostReleaseAuditGate({
    yoloRoot: "/tmp/yolo",
    packageJson,
    operatorRunbook: readyRunbook(),
    hardeningDrill: passingHardeningDrill(),
    manualReleaseRecord: manualReleaseRecord(),
    dogfoodAudit: dogfoodAudit(),
    ...options,
  });
}

describe("post-release audit gate", () => {
  test("buildPostReleaseAuditPlan is manual-evidence only and has no release side effects", () => {
    const plan = buildPostReleaseAuditPlan({ yoloRoot: "/tmp/yolo" });

    assert.equal(plan.schema_version, POST_RELEASE_AUDIT_SCHEMA_VERSION);
    assert.equal(plan.writes_workspace, false);
    assert.equal(plan.publishes, false);
    assert.equal(plan.reads_credentials, false);
    assert.equal(plan.executes_billable_provider, false);
    assert.equal(plan.publishes_dogfood_report, false);
    assert.equal(plan.requires_manual_external_release_record, true);
    assert.ok(plan.required_evidence.some((item) => item.includes("manual release record")));
  });

  test("blocks when the manual external release record is missing or package is still private", () => {
    const result = audit({
      packageJson: { ...packageJson, private: true },
      manualReleaseRecord: null,
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "POST_RELEASE_AUDIT_MANUAL_RECORD_PRESENT"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "POST_RELEASE_AUDIT_PACKAGE_PUBLIC"));
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.publish_command_executed, false);
  });

  test("blocks when operator runbook was not ready or manual record claims SDK execution", () => {
    const result = audit({
      operatorRunbook: readyRunbook({
        status: "blocked",
        blockers: [{ code: "RUNBOOK_PUBLISH_AUTHORIZED" }],
      }),
      manualReleaseRecord: manualReleaseRecord({ published_by_sdk: true }),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "POST_RELEASE_AUDIT_RUNBOOK_READY"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "POST_RELEASE_AUDIT_EXTERNAL_ONLY"));
  });

  test("requires post-release hardening, package install smoke, and public dogfood evidence", () => {
    const result = audit({
      hardeningDrill: passingHardeningDrill({
        status: "blocked",
        blockers: [{ code: "PACKAGE_INSTALL_SMOKE_PASS" }],
        components: { package_install: { status: "blocked" } },
      }),
      dogfoodAudit: dogfoodAudit({ status: "blocked", privacy_reviewed: false }),
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "POST_RELEASE_AUDIT_HARDENING_PASS"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "POST_RELEASE_AUDIT_PACKAGE_INSTALL_PASS"));
    assert.ok(result.blockers.some((blocker) => blocker.code === "POST_RELEASE_AUDIT_DOGFOOD_AUDIT_PASS"));
  });

  test("missing dogfood audit blocks instead of throwing", () => {
    const result = audit({ dogfoodAudit: null });

    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.code === "POST_RELEASE_AUDIT_DOGFOOD_AUDIT_PASS"));
    assert.equal(result.guarantees.dogfood_report_published, false);
  });

  test("passes with complete external release and dogfood audit evidence", () => {
    const result = audit();

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.manual_release_record.package_name, "yolo");
    assert.equal(result.components.dogfood_audit.status, "pass");
    assert.equal(result.guarantees.published, false);
    assert.equal(result.guarantees.credential_access, false);
    assert.equal(result.guarantees.billable_provider_execution, false);
    assert.equal(result.guarantees.audited_manual_external_release_only, true);
  });
});
