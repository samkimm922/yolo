import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildEvidenceArtifact, createEvidenceLedger } from "../evidence/ledger.js";
import {
  fixtureEvidenceRecord,
  getFixtureDefinition,
  inspectFixtureDefinition,
} from "./registry.js";

function fixtureWorkspace(id, options = {}) {
  return mkdtempSync(join(resolve(options.tmpRoot || tmpdir()), `yolo-fixture-${id}-`));
}

function runCommand(command, cwd, timeout_ms) {
  const startedAt = new Date().toISOString();
  const result = spawnSync("sh", ["-c", command], {
    cwd,
    encoding: "utf8",
    timeout: timeout_ms,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    command,
    exit_code: result.status,
    signal: result.signal,
    status: result.status === 0 ? "pass" : "fail",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    stdout_tail: String(result.stdout || "").slice(-4000),
    stderr_tail: String(result.stderr || "").slice(-4000),
  };
}

export function copyFixtureToWorkspace(fixture, options = {}) {
  const workspace = resolve(options.workspace || fixtureWorkspace(fixture.id, options));
  cpSync(fixture.fixture_dir, workspace, { recursive: true });
  return workspace;
}

export function runFixtureHarness(id, options = {}) {
  const fixture = typeof id === "string" ? getFixtureDefinition(id, options) : id;
  const inspection = inspectFixtureDefinition(fixture);
  if (inspection.blocks_execution) {
    return {
      status: "blocked",
      fixture_id: fixture.id || null,
      inspection,
      commands: [],
      evidence_file: null,
      workspace: null,
    };
  }

  const workspace = copyFixtureToWorkspace(fixture, options);
  const commands = fixture.run?.commands || [];
  const commandResults = commands.map((command) =>
    runCommand(command, workspace, options.timeout_ms || fixture.run?.timeout_ms || 120000)
  );
  const passed = commandResults.every((result) => result.status === "pass");
  const expectedEvidence = fixture.evidence?.expected?.[0] || `state/evidence/${fixture.task?.id || fixture.id}/fixture-run.json`;
  const evidencePath = resolve(workspace, expectedEvidence);
  const ledger = createEvidenceLedger({ stateDir: resolve(workspace, "state") });
  const evidence = buildEvidenceArtifact("fixture.run", {
    fixture: fixtureEvidenceRecord(fixture, inspection),
    status: passed ? "pass" : "fail",
    workspace,
    commands: commandResults,
  }, { source: "fixture-harness" });
  ledger.writeJsonArtifact(evidencePath, evidence);
  ledger.appendStateEvent("fixture.run", {
    fixture_id: fixture.id,
    status: evidence.status,
    artifact_type: evidence.artifact_type,
    evidence_file: relative(workspace, evidencePath),
  }, { source: "fixture-harness" });

  if (options.keepWorkspace !== true) {
    rmSync(workspace, { recursive: true, force: true });
  }

  return {
    status: evidence.status,
    fixture_id: fixture.id,
    inspection,
    commands: commandResults,
    evidence,
    evidence_file: relative(workspace, evidencePath),
    workspace: options.keepWorkspace === true ? workspace : null,
  };
}
