import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RELEASE_CANDIDATE_REQUIRED_REPORTS,
  runReleaseCandidateGate,
} from "../src/release/decision-gate.js";
import { listDogfoodMatrixScenarios } from "../src/release/dogfood-matrix.js";

const NOW = "2026-06-07T12:00:00.000Z";
const STARTED_AT = "2026-06-07T10:00:00.000Z";
const FINISHED_AT = "2026-06-07T10:01:00.000Z";
const TEMP_DIRS = [];

after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

function writeArtifact(name, body = "") {
  const dir = mkdtempSync(join(tmpdir(), "yolo-rc-artifact-"));
  TEMP_DIRS.push(dir);
  const path = join(dir, `${name}.json`);
  const content = body || JSON.stringify({ name, generated_at: FINISHED_AT }, null, 2);
  writeFileSync(path, content, "utf8");
  return {
    artifact_path: path,
    artifact_sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function report(name, overrides = {}) {
  const artifact = writeArtifact(name);
  return {
    status: "pass",
    provenance: { source: "ci", id: `${name}-run-1` },
    blockers: [],
    warnings: [],
    approvals: [],
    executed_at: FINISHED_AT,
    ...artifact,
    ...overrides,
  };
}

function commandEvidence(command) {
  return { command, exit_code: 0, status: "pass", started_at: STARTED_AT, finished_at: FINISHED_AT };
}

function scenarioReports() {
  return listDogfoodMatrixScenarios().map((scenario) => ({
    id: scenario.id,
    scenario: scenario.id,
    status: scenario.expected.outcome === "fail_closed" ? "fail_closed" : "pass",
    expected: scenario.expected,
    expected_outcome: scenario.expected.outcome,
    acceptance_evidence_paths: scenario.acceptance_evidence_paths,
    evidence: {
      status: scenario.expected.outcome === "fail_closed" ? "fail_closed" : "pass",
      evidence_files: scenario.acceptance_evidence_paths,
      provider_execution: false,
      billable_provider_execution: false,
      writes_workspace: false,
    },
  }));
}

function passingReports(overrides: Record<string, Record<string, unknown>> = {}) {
  const reports: Record<string, Record<string, unknown>> = Object.fromEntries(RELEASE_CANDIDATE_REQUIRED_REPORTS.map((name) => [name, report(name, {
    commands: [commandEvidence(`run ${name}`)],
  })]));
  reports.verify = report("verify", {
    provenance: { source: "verify", id: "verify-run-1" },
    commands: [commandEvidence("npm run verify")],
  });
  reports.prdPreflight = report("prdPreflight", {
    provenance: { source: "prd-preflight", id: "prd-preflight-run-1" },
    commands: [commandEvidence("npm run preflight")],
  });
  reports.cleanEnvironment = report("cleanEnvironment", {
    provenance: { source: "clean-environment", id: "clean-env-run-1" },
    dry_run: false,
    tarball: "yolo-0.0.0.tgz",
    steps: [
      { id: "prepare_clean_source", status: "pass", command: commandEvidence("copy /repo /tmp/clean-worktree") },
      { id: "install_dependencies", status: "pass", command: commandEvidence("npm ci") },
      { id: "verify", status: "pass", command: commandEvidence("npm run verify") },
      { id: "pack", status: "pass", command: commandEvidence("npm pack --json --ignore-scripts") },
      { id: "install_tarball", status: "pass", command: commandEvidence("npm install yolo-0.0.0.tgz") },
      { id: "public_entrypoint_bin_smoke", status: "pass", command: commandEvidence("node public-entrypoint-bin-smoke.mjs") },
    ],
  });
  reports.dogfoodMatrix = report("dogfoodMatrix", {
    provenance: { source: "dogfood-matrix", id: "dogfood-run-1" },
    scenario_count: 7,
    scenarios: scenarioReports(),
  });
  reports.changeManifest = report("changeManifest", {
    provenance: { source: "change-manifest", id: "change-manifest-run-1" },
    manifest: {
      schema: "yolo.release_change_provenance.v1",
      status: "pass",
      clean: true,
      risk_level: "none",
      generated_from: {
        status_command: "git status --porcelain=v1 -z",
        diff_command: "git diff --name-status -z --find-renames HEAD --",
      },
      tracked_modified: [],
      untracked: [],
      deleted_or_renamed: [],
      blockers: [],
    },
  });
  for (const [name, override] of Object.entries(overrides)) {
    reports[name] = { ...(reports[name]), ...override };
  }
  return reports;
}

function approval(issueCode, overrides = {}) {
  return {
    id: `approval-${issueCode}`,
    approved_by: "release-owner",
    approved_at: "2026-06-07T11:00:00.000Z",
    expires_at: "2026-06-08T11:00:00.000Z",
    issue_codes: [issueCode],
    ...overrides,
  };
}

describe("release candidate gate aggregator", () => {
  test("passes when every required report passes with known provenance", () => {
    const result = runReleaseCandidateGate({
      mode: "rc",
      now: NOW,
      reports: passingReports(),
    });

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.deepEqual(result.issue_codes, []);
    assert.deepEqual(Object.keys(result.reports), RELEASE_CANDIDATE_REQUIRED_REPORTS);
  });

  test("blocks when a required report is missing", () => {
    const reports = passingReports();
    delete reports.cleanEnvironment;

    const result = runReleaseCandidateGate({ now: NOW, reports });

    assert.equal(result.status, "block");
    assert.ok(result.blockers.some((blocker) =>
      blocker.code === "RC_GATE_REPORT_MISSING" && blocker.report === "cleanEnvironment"
    ));
    assert.ok(result.issue_codes.includes("RC_GATE_REPORT_MISSING"));
  });

  test("blocks malformed reports instead of treating warnings as success", () => {
    const result = runReleaseCandidateGate({
      now: NOW,
      reports: passingReports({
        verify: report("verify", { status: "ready", blockers: "none" }),
      }),
    });

    assert.equal(result.status, "block");
    assert.ok(result.blockers.some((blocker) =>
      blocker.code === "RC_GATE_REPORT_MALFORMED" && blocker.report === "verify"
    ));
  });

  test("blocks unapproved warnings in rc mode instead of treating them as RC success", () => {
    const result = runReleaseCandidateGate({
      mode: "rc",
      now: NOW,
      reports: passingReports({
        cleanEnvironment: report("cleanEnvironment", {
          warnings: [{ code: "CLEAN_ENV_WARNING", message: "environment check found minor deviation" }],
        }),
      }),
    });

    assert.equal(result.status, "block");
    assert.ok(result.blockers.some((blocker) =>
      blocker.code === "RC_GATE_WARNING_APPROVAL_REQUIRED"
      && blocker.issue_code === "CLEAN_ENV_WARNING"
    ));
  });

  test("blocks unapproved warnings in publish mode", () => {
    const result = runReleaseCandidateGate({
      mode: "publish",
      now: NOW,
      reports: passingReports({
        cleanEnvironment: report("cleanEnvironment", {
          warnings: [{ code: "CLEAN_ENV_WARNING", message: "environment check found minor deviation" }],
        }),
      }),
    });

    assert.equal(result.status, "block");
    assert.ok(result.blockers.some((blocker) =>
      blocker.code === "RC_GATE_WARNING_APPROVAL_REQUIRED"
      && blocker.issue_code === "CLEAN_ENV_WARNING"
    ));
  });

  test("passes publish mode when every warning has a bound current approval", () => {
    const result = runReleaseCandidateGate({
      mode: "publish",
      now: NOW,
      reports: passingReports({
        cleanEnvironment: report("cleanEnvironment", {
          warnings: [{ code: "CLEAN_ENV_WARNING", approval_id: "approval-CLEAN_ENV_WARNING" }],
          approvals: [approval("CLEAN_ENV_WARNING")],
        }),
      }),
    });

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
    assert.equal(result.warnings[0].approved, true);
  });

  test("blocks dogfood matrix failures even when the report status is pass", () => {
    const result = runReleaseCandidateGate({
      now: NOW,
      reports: passingReports({
        dogfoodMatrix: report("dogfoodMatrix", {
          provenance: { source: "dogfood-matrix", id: "dogfood-run-2" },
          scenario_count: 7,
          scenarios: [
            ...scenarioReports().filter((scenario) => scenario.id !== "node-basic"),
            { id: "node-basic", status: "fail" },
          ],
        }),
      }),
    });

    assert.equal(result.status, "block");
    assert.ok(result.blockers.some((blocker) =>
      blocker.code === "RC_GATE_DOGFOOD_FAILURE" && blocker.scenario_id === "node-basic"
    ));
  });

  test("allows dogfood scenarios that are expected to fail closed by object outcome", () => {
    const result = runReleaseCandidateGate({
      now: NOW,
      reports: passingReports({
        dogfoodMatrix: report("dogfoodMatrix", {
          provenance: { source: "dogfood-matrix", id: "dogfood-run-3" },
          scenario_count: 7,
          scenarios: scenarioReports(),
        }),
      }),
    });

    assert.equal(result.status, "pass", JSON.stringify(result.blockers, null, 2));
  });

  test("blocks empty shell pass reports and dry-run release evidence", () => {
    const shell = Object.fromEntries(RELEASE_CANDIDATE_REQUIRED_REPORTS.map((name) => [name, {
      status: "pass",
      provenance: { source: "ci" },
      blockers: [],
      warnings: [],
    }]));

    const result = runReleaseCandidateGate({
      mode: "publish",
      now: NOW,
      reports: {
        ...shell,
        cleanEnvironment: { ...shell.cleanEnvironment, dry_run: true },
        dogfoodMatrix: { ...shell.dogfoodMatrix, provenance: { source: "dogfood-matrix" }, scenarios: [] },
      },
    });

    assert.equal(result.status, "block");
    assert.ok(result.issue_codes.includes("RC_GATE_REPORT_EXECUTION_EVIDENCE_MISSING"));
    assert.ok(result.issue_codes.includes("RC_GATE_REPORT_DRY_RUN"));
    assert.ok(result.issue_codes.includes("RC_GATE_DOGFOOD_MATRIX_INCOMPLETE"));
  });

  test("negative: fake pass reports are blocked when artifacts are missing or digest-mismatched", () => {
    const missingDir = mkdtempSync(join(tmpdir(), "yolo-rc-missing-"));
    TEMP_DIRS.push(missingDir);
    const missingArtifact = join(missingDir, "missing.json");
    const result = runReleaseCandidateGate({
      mode: "rc",
      now: NOW,
      reports: passingReports({
        verify: report("verify", {
          provenance: { source: "verify", id: "verify-run-missing-artifact" },
          artifact_path: missingArtifact,
        }),
        prdPreflight: report("prdPreflight", {
          provenance: { source: "prd-preflight", id: "prd-preflight-run-bad-digest" },
          artifact_sha256: "0".repeat(64),
        }),
      }),
    });

    assert.equal(result.status, "block");
    assert.ok(result.issue_codes.includes("RC_GATE_ARTIFACT_MISSING"));
    assert.ok(result.issue_codes.includes("RC_GATE_ARTIFACT_DIGEST_MISMATCH"));
    assert.equal(result.reports.verify.artifact_integrity.status, "fail");
    assert.equal(result.reports.prdPreflight.artifact_integrity.status, "fail");
  });

  test("blocks unknown provenance", () => {
    const result = runReleaseCandidateGate({
      now: NOW,
      reports: passingReports({
        changeManifest: report("changeManifest", {
          provenance: { source: "unknown", id: "manifest-run-1" },
        }),
      }),
    });

    assert.equal(result.status, "block");
    assert.ok(result.blockers.some((blocker) =>
      blocker.code === "RC_GATE_UNKNOWN_PROVENANCE" && blocker.report === "changeManifest"
    ));
  });

  test("blocks unbound and expired approvals", () => {
    const result = runReleaseCandidateGate({
      now: NOW,
      reports: passingReports({
        verify: report("verify", {
          approvals: [
            { id: "approval-without-codes", approved_by: "release-owner", approved_at: "2026-06-07T11:00:00.000Z" },
            approval("VERIFY_WARNING", { expires_at: "2026-06-07T10:00:00.000Z" }),
          ],
        }),
      }),
    });

    assert.equal(result.status, "block");
    assert.ok(result.issue_codes.includes("RC_GATE_APPROVAL_UNBOUND"));
    assert.ok(result.issue_codes.includes("RC_GATE_APPROVAL_EXPIRED"));
  });
});
