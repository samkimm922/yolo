import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, join, normalize } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import { buildEvidenceArtifact, createEvidenceLedger, evidenceArtifactDigest, validateEvidenceArtifact } from "../runtime/evidence/ledger.js";
import {
  fixtureEvidenceRecord,
  getFixtureDefinition,
  inspectFixtureDefinition,
} from "./registry.js";

// Resolve yolo's bundled tsx loader once at module load. Fixture commands
// stay as bare `node src/index.ts` (no caller churn), but the child node
// process is launched with `--import <tsx loader>`, so the TypeScript source
// is compiled by tsx/esbuild instead of relying on whatever native
// `--experimental-strip-types` (or lack thereof) the host node provides.
// This makes fixture execution deterministic across node 20/22/25 and
// across any future node version bump.
//
// tsx 4.x maps the package main entry (`"exports"."."`) to
// `dist/loader.mjs`, so `require.resolve("tsx")` is the supported path.
// The subpath `tsx/dist/loader.mjs` is not in the exports map and would
// throw ERR_PACKAGE_PATH_NOT_EXPORTED.
const _require = createRequire(import.meta.url);
let TSX_LOADER_FLAG = "";
try {
  const loaderUrl = pathToFileURL(_require.resolve("tsx")).href;
  TSX_LOADER_FLAG = `--import ${loaderUrl}`;
} catch {
  // tsx is not resolvable in this environment (e.g. user runs the SDK
  // without dev deps). The harness still works — fixture commands fall
  // back to whatever `node xxx.ts` does on the host. We deliberately
  // do not throw here: this module is part of the public SDK surface
  // and must not hard-depend on tsx.
  TSX_LOADER_FLAG = "";
}

function buildChildEnv() {
  const existing = process.env.NODE_OPTIONS;
  const merged = [existing, TSX_LOADER_FLAG].filter(Boolean).join(" ");
  return { ...process.env, NODE_OPTIONS: merged };
}

function fixtureWorkspace(id, options = Object()) {
  return mkdtempSync(join(resolve(options.tmpRoot || tmpdir()), `yolo-fixture-${id}-`));
}

const RELEASE_LIKE_MODES = new Set(["release", "ship", "dogfood", "executable"]);

function commandName(command = "") {
  const match = String(command).trim().match(/^([A-Za-z0-9_./-]+)/);
  return match ? match[1] : "";
}

function classifyCommandFailure(result = Object()) {
  const stderr = String(result.stderr_tail || "");
  const stdout = String(result.stdout_tail || "");
  const text = `${stdout}\n${stderr}`;
  if (result.timed_out) {
    return {
      failure_type: "timeout",
      code: "FIXTURE_COMMAND_TIMEOUT",
      message: "Fixture command timed out.",
    };
  }
  if (result.exit_code === 127 || /\bnot found\b|is not recognized|command not found/i.test(text)) {
    return {
      failure_type: "command_not_found",
      code: "FIXTURE_COMMAND_NOT_FOUND",
      message: "Fixture command was not found.",
    };
  }
  if (result.exit_code !== 0) {
    return {
      failure_type: "nonzero_exit",
      code: "FIXTURE_COMMAND_NONZERO_EXIT",
      message: "Fixture command exited nonzero.",
    };
  }
  return null;
}

function commandAvailable(command, cwd, spawnSync = defaultSpawnSync) {
  const name = commandName(command);
  if (!name) return false;
  const result = spawnSync("sh", ["-c", `command -v ${JSON.stringify(name)} >/dev/null 2>&1`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function dependencyFailures(fixture, workspace, spawnSync = defaultSpawnSync) {
  return asArray(fixture.run?.external_dependencies).filter((command) => !commandAvailable(command, workspace, spawnSync)).map((command) => ({
    failure_type: "external_dependency_unavailable",
    code: "FIXTURE_EXTERNAL_DEPENDENCY_UNAVAILABLE",
    command,
    message: `Required external dependency is unavailable: ${command}`,
  }));
}

function runCommand(command, cwd, timeout_ms, spawnSync = defaultSpawnSync) {
  const startedAt = new Date().toISOString();
  const result = spawnSync("sh", ["-c", command], {
    cwd,
    encoding: "utf8",
    timeout: timeout_ms,
    stdio: ["ignore", "pipe", "pipe"],
    env: buildChildEnv(),
  });
  const spawnError = result.error ? Object.assign(Object(), result.error) : null;
  const commandResult = Object.assign(Object(), {
    command,
    exit_code: result.status,
    signal: result.signal,
    timed_out: spawnError?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
    status: result.status === 0 ? "pass" : "blocked",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    stdout_tail: String(result.stdout || "").slice(-4000),
    stderr_tail: String(result.stderr || "").slice(-4000),
  });
  const failure = classifyCommandFailure(commandResult);
  if (failure) commandResult.failure = failure;
  return commandResult;
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === "") return [];
  return [value];
}

function safeRelativeEvidencePath(value) {
  const path = String(value || "").trim();
  if (!path || isAbsolute(path)) return null;
  const normalized = normalize(path).replace(/\\/g, "/");
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

export function copyFixtureToWorkspace(fixture, options = Object()) {
  const workspace = resolve(options.workspace || fixtureWorkspace(fixture.id, options));
  cpSync(fixture.fixture_dir, workspace, { recursive: true });
  return workspace;
}

export function runFixtureHarness(id, options = Object()) {
  const fixture = typeof id === "string" ? getFixtureDefinition(id, options) : id;
  const inspection = inspectFixtureDefinition(fixture);
  if (inspection.blocks_execution) {
    return {
      status: "blocked",
      fixture_id: fixture.id || null,
      inspection,
      blocking_failures: [{
        failure_type: "fixture_definition_blocked",
        code: "FIXTURE_DEFINITION_BLOCKED",
        message: "Fixture definition failed registry inspection.",
        blockers: inspection.blockers,
      }],
      commands: [],
      evidence_file: null,
      workspace: null,
    };
  }

  const workspace = copyFixtureToWorkspace(fixture, options);
  const commands = fixture.run?.commands || [];
  const dependencyBlockingFailures = dependencyFailures(fixture, workspace, options.spawnSync || defaultSpawnSync);
  const commandResults = commands.map((command) =>
    runCommand(command, workspace, options.timeout_ms || fixture.run?.timeout_ms || 120000, options.spawnSync || defaultSpawnSync)
  );
  const commandBlockingFailures = commandResults.map((result) => result.failure).filter(Boolean);
  const blockingFailures = [...dependencyBlockingFailures, ...commandBlockingFailures];
  const commandsPassed = commandResults.every((result) => result.status === "pass");
  const degradedReason = fixture.run?.degraded_reason || null;
  const mode = String(options.mode || options.gateMode || options.gate_mode || fixture.run?.gate_mode || fixture.run?.mode || "").toLowerCase();
  if (degradedReason && RELEASE_LIKE_MODES.has(mode)) {
    blockingFailures.push({
      failure_type: "degraded_fixture_not_release_eligible",
      code: "FIXTURE_DEGRADED_RELEASE_BLOCKED",
      message: "Degraded fixtures cannot satisfy release, dogfood, or executable gates.",
      degraded_reason: degradedReason,
      mode,
    });
  }
  const expectedArtifacts = asArray(fixture.evidence?.expected?.length ? fixture.evidence.expected : [`state/evidence/${fixture.task?.id || fixture.id}/fixture-run.json`])
    .map(safeRelativeEvidencePath);
  const invalidExpectedArtifacts = expectedArtifacts.some((item) => !item);
  const validExpectedArtifacts = expectedArtifacts.filter(Boolean);
  const primaryEvidence = validExpectedArtifacts[0] || `state/evidence/${fixture.task?.id || fixture.id}/fixture-run.json`;
  const evidencePath = resolve(workspace, primaryEvidence);
  const ledger = createEvidenceLedger({ stateDir: resolve(workspace, "state") });
  const evidence = buildEvidenceArtifact("fixture.run", {
    fixture: fixtureEvidenceRecord(fixture, inspection),
    status: blockingFailures.length > 0 ? "blocked" : degradedReason ? "degraded" : commandsPassed ? "pass" : "fail",
    workspace,
    commands: commandResults,
    blocking_failures: blockingFailures,
    degraded_reason: degradedReason,
    mode,
    expected_artifacts: validExpectedArtifacts,
    invalid_expected_artifacts: invalidExpectedArtifacts,
  }, { source: "fixture-harness" });
  const initialSchemaCheck = validateEvidenceArtifact(evidence);
  ledger.writeJsonArtifact(evidencePath, evidence);
  const missingExpectedArtifacts = validExpectedArtifacts.filter((item) => {
    const resolved = resolve(workspace, item);
    const insideWorkspace = resolved === workspace || resolved.startsWith(`${workspace}/`);
    return !insideWorkspace || !existsSync(resolved);
  });
  const finalStatus = blockingFailures.length > 0
    ? "blocked"
    : degradedReason
      ? "degraded"
      : commandsPassed && !invalidExpectedArtifacts && missingExpectedArtifacts.length === 0 && initialSchemaCheck.ok
        ? "pass"
        : "fail";
  evidence.status = finalStatus;
  evidence.missing_expected_artifacts = missingExpectedArtifacts;
  evidence.artifact_digest = evidenceArtifactDigest(evidence);
  evidence.schema_check = validateEvidenceArtifact(evidence);
  evidence.artifact_digest = evidenceArtifactDigest(evidence);
  ledger.writeJsonArtifact(evidencePath, evidence);
  ledger.appendStateEvent("fixture.run", {
    fixture_id: fixture.id,
    status: evidence.status,
    artifact_type: evidence.artifact_type,
    evidence_file: relative(workspace, evidencePath),
    missing_expected_artifacts: missingExpectedArtifacts,
    blocking_failures: blockingFailures,
    degraded_reason: degradedReason,
    schema_ok: evidence.schema_check.ok,
  }, { source: "fixture-harness" });

  if (options.keepWorkspace !== true) {
    rmSync(workspace, { recursive: true, force: true });
  }

  return {
    status: evidence.status,
    fixture_id: fixture.id,
    inspection,
    blocking_failures: blockingFailures,
    commands: commandResults,
    evidence,
    evidence_file: relative(workspace, evidencePath),
    workspace: options.keepWorkspace === true ? workspace : null,
  };
}
