// Quality-score release gate battery: release evidence must fail closed when
// status strings and process exit codes disagree.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  RELEASE_CANDIDATE_REQUIRED_REPORTS,
  runReleaseCandidateGate,
} from "../../src/release/decision-gate.js";
import { listDogfoodMatrixScenarios } from "../../src/release/dogfood-matrix.js";

const NOW = "2026-06-07T12:00:00.000Z";
const STARTED_AT = "2026-06-07T10:00:00.000Z";
const FINISHED_AT = "2026-06-07T10:01:00.000Z";

type ReleaseBatteryCase = {
  id: string;
  category: "release_gate_robustness";
  description: string;
  expect: "blocked";
  mutate: (reports: Record<string, Record<string, unknown>>) => void;
};

type ReleaseBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

function commandEvidence(command: string, overrides: Record<string, unknown> = {}) {
  return { command, exit_code: 0, status: "pass", started_at: STARTED_AT, finished_at: FINISHED_AT, ...overrides };
}

function writeArtifact(dir: string, name: string) {
  const path = join(dir, `${name}.json`);
  const content = JSON.stringify({ name, generated_at: FINISHED_AT }, null, 2);
  writeFileSync(path, content, "utf8");
  return {
    artifact_path: path,
    artifact_sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function report(dir: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    status: "pass",
    provenance: { source: "ci", id: `${name}-run-1` },
    blockers: [],
    warnings: [],
    approvals: [],
    executed_at: FINISHED_AT,
    ...writeArtifact(dir, name),
    ...overrides,
  };
}

function scenarioReports() {
  return listDogfoodMatrixScenarios().map((scenario) => ({
    id: scenario.id,
    scenario: scenario.id,
    status: scenario.expected.outcome === "fail_closed" ? "fail_closed" : "pass",
    expected: scenario.expected,
    expected_outcome: scenario.expected.outcome,
    acceptance_evidence_paths: scenario.acceptance_evidence_paths,
  }));
}

function passingReports(dir: string) {
  const reports: Record<string, Record<string, unknown>> = Object.fromEntries(
    RELEASE_CANDIDATE_REQUIRED_REPORTS.map((name) => [name, report(dir, name, {
      commands: [commandEvidence(`run ${name}`)],
    })]),
  );
  reports.verify = report(dir, "verify", {
    provenance: { source: "verify", id: "verify-run-1" },
    commands: [commandEvidence("npm run verify")],
  });
  reports.prdPreflight = report(dir, "prdPreflight", {
    provenance: { source: "prd-preflight", id: "prd-preflight-run-1" },
    commands: [commandEvidence("npm run preflight")],
  });
  reports.cleanEnvironment = report(dir, "cleanEnvironment", {
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
  reports.dogfoodMatrix = report(dir, "dogfoodMatrix", {
    provenance: { source: "dogfood-matrix", id: "dogfood-run-1" },
    scenario_count: 7,
    scenarios: scenarioReports(),
  });
  reports.changeManifest = report(dir, "changeManifest", {
    provenance: { source: "change-manifest", id: "change-manifest-run-1" },
    manifest: {
      schema: "yolo.release_change_provenance.v1",
      status: "pass",
      clean: true,
      generated_from: { status_command: "git status --porcelain=v1 -z" },
      blockers: [],
    },
  });
  return reports;
}

export const RELEASE_BATTERY: ReleaseBatteryCase[] = [
  {
    id: "rc_failed_status_exit0_blocks",
    category: "release_gate_robustness",
    description: "command status=failed with exit_code=0 must block instead of passing by OR logic.",
    expect: "blocked",
    mutate: (reports) => {
      reports.verify.commands = [commandEvidence("npm run verify", { status: "failed", exit_code: 0 })];
    },
  },
  {
    id: "rc_clean_step_pass_failed_command_blocks",
    category: "release_gate_robustness",
    description: "clean-env step status=pass must not override a failed command result.",
    expect: "blocked",
    mutate: (reports) => {
      const steps = reports.cleanEnvironment.steps as Array<Record<string, unknown>>;
      steps[2] = {
        ...steps[2],
        status: "pass",
        command: commandEvidence("npm run verify", { status: "failed", exit_code: 1 }),
      };
    },
  },
];

export function runReleaseBattery(): ReleaseBatteryResult[] {
  return RELEASE_BATTERY.map((testCase) => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-release-battery-"));
    try {
      const reports = passingReports(dir);
      testCase.mutate(reports);
      const result = runReleaseCandidateGate({ mode: "rc", now: NOW, reports }) as { status?: string };
      const status = result.status === "pass" ? "pass" : "blocked";
      const correct = status === testCase.expect;
      return {
        id: testCase.id,
        category: testCase.category,
        expect: testCase.expect,
        actualExit: status === "pass" ? 0 : 1,
        actualStatus: status,
        correct,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
