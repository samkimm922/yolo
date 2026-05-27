import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { resolveProjectContext } from "../../packs/resolver.js";
import { asArray, selectedAcceptanceAdapter } from "../gates/readiness-policy.js";

export const ADAPTER_EVIDENCE_COLLECTOR_SCHEMA_VERSION = "1.0";
export const ADAPTER_EVIDENCE_COLLECTOR_SCHEMA = "yolo.adapter.evidence_collector.v1";

function nowIso() {
  return new Date().toISOString();
}

function clean(value) {
  return String(value ?? "").trim();
}

function safeId(value) {
  return clean(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "adapter";
}

function repoRelative(path, projectRoot) {
  return relative(projectRoot, path).replace(/\\/g, "/");
}

function truncate(value, max = 4000) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n[truncated ${text.length - max} chars]` : text;
}

function normalizeCommand(entry = {}, index = 0) {
  const command = typeof entry === "string" ? entry : entry.command;
  return {
    id: clean(entry.id || entry.name || `command-${index + 1}`),
    command: clean(command),
    timeout_ms: Number(entry.timeout_ms || entry.timeoutMs || 30000),
    evidence_path: clean(entry.evidence_path || entry.evidencePath || entry.output_path || entry.outputPath),
  };
}

function readJsonEvidence(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return {
      parse_error: error.message,
      raw: truncate(readFileSync(path, "utf8")),
    };
  }
}

function mergeEvidence(records = []) {
  const objects = records.filter((record) => record && typeof record === "object" && !Array.isArray(record));
  if (objects.length === 0) return null;
  return Object.assign({}, ...objects.map((record) => record.ui_evidence || record));
}

function collectorArtifactPath({ projectRoot, stateRoot, adapter, artifactName }) {
  const fileName = artifactName || `${safeId(adapter?.id)}-latest.json`;
  return resolve(projectRoot, stateRoot, "state/evidence/adapters", fileName);
}

export function buildAdapterEvidencePlan(input = {}, options = {}) {
  const projectRoot = resolve(input.projectRoot || input.project_root || options.projectRoot || options.project_root || process.cwd());
  const stateRoot = resolve(input.stateRoot || input.state_root || options.stateRoot || options.state_root || join(projectRoot, ".yolo"));
  const resolver = input.resolver || options.resolver || resolveProjectContext({
    projectRoot,
    stateRoot,
    requiresAcceptanceAdapter: input.requiresAcceptanceAdapter === true || input.requires_acceptance_adapter === true || options.requiresAcceptanceAdapter === true || options.requires_acceptance_adapter === true,
  });
  const adapter = input.adapterManifest || input.adapter_manifest || selectedAcceptanceAdapter(resolver) || resolver?.selected?.acceptance_adapter || null;
  const commands = asArray(adapter?.commands).map(normalizeCommand).filter((command) => command.command);
  const artifactPath = collectorArtifactPath({
    projectRoot,
    stateRoot,
    adapter,
    artifactName: input.artifactName || input.artifact_name || options.artifactName || options.artifact_name,
  });

  return {
    schema_version: ADAPTER_EVIDENCE_COLLECTOR_SCHEMA_VERSION,
    schema: ADAPTER_EVIDENCE_COLLECTOR_SCHEMA,
    status: adapter?.id && adapter.id !== "unknown/custom" && commands.length > 0 ? "ready" : "blocked",
    code: adapter?.id && adapter.id !== "unknown/custom" ? commands.length > 0 ? "ADAPTER_EVIDENCE_PLAN_READY" : "ADAPTER_COMMANDS_MISSING" : "ACCEPTANCE_ADAPTER_MISSING",
    summary: adapter?.id && adapter.id !== "unknown/custom" && commands.length > 0
      ? "Adapter evidence commands are ready for controlled execution."
      : "Adapter evidence collection is missing a valid adapter or commands.",
    generated_at: nowIso(),
    project_root: projectRoot,
    state_root: stateRoot,
    adapter: adapter ? {
      id: adapter.id,
      kind: adapter.kind,
      source_path: adapter.source_path || "",
      capabilities: asArray(adapter.capabilities),
      evidence: asArray(adapter.evidence),
    } : null,
    commands,
    execution_policy: {
      default_mode: "dry_run",
      execute_requires: ["execute=true", "allowAdapterCommands=true"],
      cwd: projectRoot,
      timeout_ms_default: 30000,
      artifact_overwrite: "latest-per-adapter",
    },
    artifact_path: artifactPath,
    artifact_file: repoRelative(artifactPath, projectRoot),
    resolver,
  };
}

export function runAdapterEvidenceCollector(input = {}, options = {}) {
  const plan = buildAdapterEvidencePlan(input, options);
  const execute = input.execute === true || input.executeAdapter === true || input.execute_adapter === true || options.execute === true || options.executeAdapter === true || options.execute_adapter === true;
  const allow = input.allowAdapterCommands === true || input.allow_adapter_commands === true || options.allowAdapterCommands === true || options.allow_adapter_commands === true;
  const writeArtifact = input.writeArtifact !== false && input.write_artifact !== false && options.writeArtifact !== false && options.write_artifact !== false;
  const result = {
    ...plan,
    mode: execute ? "execute" : "dry_run",
    status: plan.status === "blocked" ? "blocked" : execute ? "blocked" : "dry_run",
    code: plan.status === "blocked" ? plan.code : execute ? "ADAPTER_COMMAND_EXECUTION_NOT_ALLOWED" : "ADAPTER_EVIDENCE_DRY_RUN",
    summary: plan.status === "blocked"
      ? plan.summary
      : execute
        ? "Adapter command execution requires explicit authorization."
        : "Adapter evidence collector planned commands without executing them.",
    command_results: [],
    collected_evidence: [],
    ui_evidence: null,
    artifacts: [],
  };

  if (plan.status === "blocked") {
    return result;
  }
  if (!execute) {
    return result;
  }
  if (!allow) {
    return result;
  }

  const commandResults = [];
  const evidenceRecords = [];
  for (const command of plan.commands) {
    const startedAt = nowIso();
    const executed = spawnSync(command.command, {
      cwd: plan.project_root,
      shell: true,
      encoding: "utf8",
      timeout: command.timeout_ms,
      env: { ...process.env },
    });
    const evidencePath = command.evidence_path ? resolve(plan.project_root, command.evidence_path) : "";
    const evidence = readJsonEvidence(evidencePath);
    if (evidence) evidenceRecords.push(evidence);
    commandResults.push({
      id: command.id,
      command: command.command,
      started_at: startedAt,
      finished_at: nowIso(),
      status: executed.status === 0 && !executed.error ? "pass" : "failed",
      exit_code: executed.status,
      signal: executed.signal || null,
      error: executed.error?.message || null,
      stdout: truncate(executed.stdout),
      stderr: truncate(executed.stderr),
      evidence_path: evidencePath || null,
      evidence_file: evidencePath ? repoRelative(evidencePath, plan.project_root) : null,
      evidence_found: evidencePath ? existsSync(evidencePath) : null,
    });
  }

  const failed = commandResults.filter((entry) => entry.status !== "pass");
  const missingEvidence = commandResults.filter((entry) => entry.evidence_path && entry.evidence_found === false);
  result.status = failed.length > 0 || missingEvidence.length > 0 ? "blocked" : "pass";
  result.code = result.status === "pass" ? "ADAPTER_EVIDENCE_COLLECTED" : "ADAPTER_EVIDENCE_COLLECTION_FAILED";
  result.summary = result.status === "pass"
    ? "Adapter evidence commands executed and evidence was collected."
    : "Adapter evidence collection failed or required evidence was missing.";
  result.command_results = commandResults;
  result.collected_evidence = evidenceRecords;
  result.ui_evidence = mergeEvidence(evidenceRecords);

  if (writeArtifact) {
    mkdirSync(dirname(plan.artifact_path), { recursive: true });
    writeFileSync(plan.artifact_path, JSON.stringify(result, null, 2), "utf8");
    result.artifacts.push(plan.artifact_path);
  }

  return result;
}
