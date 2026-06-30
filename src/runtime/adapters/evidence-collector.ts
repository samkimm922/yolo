import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { resolveProjectContext } from "../../packs/resolver.js";
import { asArray, selectedAcceptanceAdapter } from "../gates/readiness-policy.js";
import { isWithin, resolveWithinRoot } from "../../lib/security/path-guard.js";
import { redactDeep } from "../../lib/security/redact.js";
import { execCommand } from "../../lib/security/safe-exec.js";

export const ADAPTER_EVIDENCE_COLLECTOR_SCHEMA_VERSION = "1.0";
export const ADAPTER_EVIDENCE_COLLECTOR_SCHEMA = "yolo.adapter.evidence_collector.v1";

function nowIso(): string {
  return new Date().toISOString();
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function safeId(value: unknown): string {
  return clean(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "adapter";
}

function repoRelative(path: string, projectRoot: string): string {
  return relative(projectRoot, path).replace(/\\/g, "/");
}

function truncate(value: unknown, max = 4000): string {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n[truncated ${text.length - max} chars]` : text;
}

function unique<T>(values: T[] = []): T[] {
  return [...new Set(values.filter(Boolean))];
}

function platformValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(platformValues);
  if (value && typeof value === "object") {
    return [
      (value as Record<string, unknown>).id,
      (value as Record<string, unknown>).key,
      (value as Record<string, unknown>).name,
      (value as Record<string, unknown>).type,
      (value as Record<string, unknown>).platform,
      (value as Record<string, unknown>).platforms,
      (value as Record<string, unknown>).target_platform,
      (value as Record<string, unknown>).targetPlatform,
    ].flatMap(platformValues);
  }
  return clean(value) ? [value] : [];
}

function normalizePlatform(value: unknown): string {
  const normalized = clean(value).toLowerCase().replace(/[\s_]+/g, "-");
  if (!normalized) return "";
  const aliases: Record<string, string> = {
    browser: "h5",
    html5: "h5",
    web: "h5",
    "web-app": "h5",
    webapp: "h5",
    "mobile-web": "h5",
    miniapp: "weapp",
    miniprogram: "weapp",
    "mini-program": "weapp",
    wechat: "weapp",
    "wechat-miniapp": "weapp",
    "wechat-miniprogram": "weapp",
    "wechat-mini-program": "weapp",
    wxapp: "weapp",
  };
  return aliases[normalized] || normalized;
}

function normalizePlatforms(values: unknown[] = []): string[] {
  return unique(platformValues(values).map(normalizePlatform).filter((v): v is string => Boolean(v)));
}

function inferRequiredPlatforms(input: Record<string, unknown> = Object(), options: Record<string, unknown> = Object()): string[] {
  const prd = ((input.prd || input.prd_contract || input.prdContract || options.prd || options.prd_contract || options.prdContract) as Record<string, unknown>) || {};
  return normalizePlatforms([
    input.requiredPlatform,
    input.required_platform,
    input.requiredPlatforms,
    input.required_platforms,
    options.requiredPlatform,
    options.required_platform,
    options.requiredPlatforms,
    options.required_platforms,
    input.platform,
    input.platforms,
    options.platform,
    options.platforms,
    prd.requiredPlatform,
    prd.required_platform,
    prd.requiredPlatforms,
    prd.required_platforms,
    prd.platform,
    prd.platforms,
    prd.targetPlatform,
    prd.target_platform,
    (prd.project as Record<string, unknown> | undefined)?.platform,
    (prd.project as Record<string, unknown> | undefined)?.platforms,
    (prd.runtime as Record<string, unknown> | undefined)?.platform,
    (prd.runtime as Record<string, unknown> | undefined)?.platforms,
  ]);
}

function adapterAppliesTo(adapter: Record<string, unknown> = Object()): string[] {
  return asArray(adapter?.applies_to).map(String);
}

function missingRequiredPlatforms(requiredPlatforms: string[] = [], coveredPlatforms: string[] = []): string[] {
  const covered = new Set(coveredPlatforms);
  return requiredPlatforms.filter((platform) => !covered.has(platform));
}

function evidenceCoveredPlatforms(record: Record<string, unknown> = Object()): string[] {
  if (!record || typeof record !== "object") return [];
  const coverageFields = (source: Record<string, unknown> = Object()): unknown[] => [
    source.covered_platform,
    source.covered_platforms,
    source.platform,
    source.platforms,
    source.target_platform,
    source.targetPlatform,
    source.applies_to,
    source.appliesTo,
  ];
  return normalizePlatforms([
    ...coverageFields(record),
    ...coverageFields((record.ui_evidence as Record<string, unknown>) || {}),
    ...coverageFields((record.evidence as Record<string, unknown>) || {}),
    ...coverageFields((record.result as Record<string, unknown>) || {}),
  ]);
}

function annotateEvidenceRecord(record: Record<string, unknown> = Object(), plan: Record<string, unknown> = Object()): Record<string, unknown> {
  if (!record || typeof record !== "object" || Array.isArray(record)) return record;
  return {
    ...record,
    adapter_applies_to: plan.adapter_applies_to || adapterAppliesTo((plan.adapter as Record<string, unknown>) || Object()),
    required_platform: plan.required_platform || null,
    required_platforms: plan.required_platforms || [],
  };
}

function normalizeCommand(entry: Record<string, unknown> | string = Object(), index = 0) {
  const command = typeof entry === "string" ? entry : entry.command;
  return {
    id: clean((entry as Record<string, unknown>).id || (entry as Record<string, unknown>).name || `command-${index + 1}`),
    command: clean(command),
    timeout_ms: Number((entry as Record<string, unknown>).timeout_ms || (entry as Record<string, unknown>).timeoutMs || 30000),
    evidence_path: clean((entry as Record<string, unknown>).evidence_path || (entry as Record<string, unknown>).evidencePath || (entry as Record<string, unknown>).output_path || (entry as Record<string, unknown>).outputPath),
    platforms: normalizePlatforms([(entry as Record<string, unknown>).platforms, (entry as Record<string, unknown>).platform, (entry as Record<string, unknown>).target_platform, (entry as Record<string, unknown>).targetPlatform]),
  };
}

// H10: bound evidence reads to DEFAULT_JSON_FILE_MAX_BYTES (8MiB). An unbounded
// readFileSync (and the catch path's SECOND unbounded read) let a huge or
// hostile evidence file OOM the collector. A size violation is a structured
// error record, not a crash or a silent empty result.
const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;

export function readJsonEvidence(path: string): Record<string, unknown> | null {
  if (!path || !existsSync(path)) return null;
  // H11: open by path ONCE and read from the fd, closing the existsSync→
  // readFileSync TOCTOU window (a symlink swapped between exists and read would
  // be followed by the path-based read). fstat on the fd gives the size for the
  // H10 bound without a separate path stat.
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
  } catch (error) {
    return {
      parse_error: `cannot open evidence file: ${(error as { message?: string })?.message ?? String(error)}`,
    };
  }
  try {
    // H10: size-cap before reading (fail-closed on oversized evidence).
    const size = fstatSync(fd).size;
    if (size > EVIDENCE_MAX_BYTES) {
      return {
        parse_error: `evidence file exceeds ${EVIDENCE_MAX_BYTES} byte limit (${size} bytes)`,
        size_limit_exceeded: true,
        size_bytes: size,
      };
    }
    const content = readFileSync(fd, "utf8");
    try {
      return JSON.parse(content);
    } catch (error) {
      return {
        parse_error: (error as { message?: string })?.message ?? String(error),
        raw: truncate(content),
      };
    }
  } catch (error) {
    return {
      parse_error: `cannot read evidence file: ${(error as { message?: string })?.message ?? String(error)}`,
    };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* close is advisory; fd leaks are bounded by process exit */ }
    }
  }
}

function mergeEvidence(records: Array<Record<string, unknown>> = []): Record<string, unknown> | null {
  const objects = records.filter((record) => record && typeof record === "object" && !Array.isArray(record));
  if (objects.length === 0) return null;
  return Object.assign({}, ...objects.map((record) => record.ui_evidence || record));
}

function collectorArtifactPath({ projectRoot, stateRoot, adapter, artifactName }: { projectRoot: string; stateRoot: string; adapter: Record<string, unknown> | null; artifactName?: string }): string {
  const fileName = artifactName || `${safeId(adapter?.id)}-latest.json`;
  return resolve(projectRoot, stateRoot, "state/evidence/adapters", fileName);
}

interface AdapterCommand {
  id: string;
  command: string;
  timeout_ms: number;
  evidence_path: string;
  platforms: string[];
}

export interface AdapterCommandResult {
  id: string;
  command: string;
  started_at: string;
  finished_at: string;
  status: string;
  exit_code: number | null;
  signal: string | null;
  error: string | null;
  stdout: string;
  stderr: string;
  evidence_path: string | null;
  evidence_file: string | null;
  evidence_found: boolean | null;
  adapter_applies_to: string[];
  required_platform: string | null;
  required_platforms: string[];
}

type UiEvidence = (Record<string, unknown> & { screenshots?: unknown[] }) | null;

function commandPlatformBlockers(commands: AdapterCommand[] = [], requiredPlatforms: string[] = []): Array<Record<string, unknown>> {
  if (requiredPlatforms.length === 0) return [];
  const blockers: Array<Record<string, unknown>> = [];
  for (const command of commands) {
    if (!command.platforms.length) {
      blockers.push({
        code: "ADAPTER_COMMAND_PLATFORM_MISSING",
        command_id: command.id,
        required_platforms: requiredPlatforms,
        message: `Adapter command ${command.id} must declare platform coverage.`,
      });
      continue;
    }
    const missing = missingRequiredPlatforms(requiredPlatforms, command.platforms);
    if (missing.length > 0) {
      blockers.push({
        code: "ADAPTER_COMMAND_PLATFORM_MISMATCH",
        command_id: command.id,
        required_platforms: requiredPlatforms,
        command_platforms: command.platforms,
        missing_platforms: missing,
        message: `Adapter command ${command.id} does not cover required platform: ${missing.join(", ")}.`,
      });
    }
  }
  return blockers;
}

export function buildAdapterEvidencePlan(input: Record<string, unknown> = Object(), options: Record<string, unknown> = Object()) {
  const projectRoot = resolve(String(input.projectRoot || input.project_root || options.projectRoot || options.project_root || process.cwd()));
  const stateRoot = resolve(String(input.stateRoot || input.state_root || options.stateRoot || options.state_root || join(projectRoot, ".yolo")));
  const resolver = input.resolver || options.resolver || resolveProjectContext({
    projectRoot,
    stateRoot,
    requiresAcceptanceAdapter: input.requiresAcceptanceAdapter === true || input.requires_acceptance_adapter === true || options.requiresAcceptanceAdapter === true || options.requires_acceptance_adapter === true,
  });
  const resolverRec = (resolver as Record<string, unknown>) || {};
  const adapter = ((input.adapterManifest || input.adapter_manifest || selectedAcceptanceAdapter(resolverRec) || ((resolverRec.selected as Record<string, unknown>)?.acceptance_adapter)) as Record<string, unknown> | null) || null;
  const adapterApplies = adapterAppliesTo((adapter as Record<string, unknown>) || Object());
  const requiredPlatforms = inferRequiredPlatforms(input, options);
  const adapterCoveredPlatforms = normalizePlatforms(adapterApplies);
  const missingAdapterPlatforms = adapter?.id && adapter.id !== "unknown/custom"
    ? missingRequiredPlatforms(requiredPlatforms, adapterCoveredPlatforms)
    : [];
  const commands = asArray(adapter?.commands).map(normalizeCommand).filter((command) => command.command).map((command) => ({
    ...command,
    adapter_applies_to: adapterApplies,
    required_platform: requiredPlatforms[0] || null,
    required_platforms: requiredPlatforms,
  }));
  const commandPlatformBlockersList = commandPlatformBlockers(commands, requiredPlatforms);
  const artifactPath = collectorArtifactPath({
    projectRoot,
    stateRoot,
    adapter,
    artifactName: (input.artifactName || input.artifact_name || options.artifactName || options.artifact_name) as string | undefined,
  });
  const hasValidAdapter = Boolean(adapter?.id && adapter.id !== "unknown/custom");
  const status = !hasValidAdapter || commands.length === 0 || missingAdapterPlatforms.length > 0 || commandPlatformBlockersList.length > 0 ? "blocked" : "ready";
  const code = !hasValidAdapter
    ? "ACCEPTANCE_ADAPTER_MISSING"
    : commands.length === 0
      ? "ADAPTER_COMMANDS_MISSING"
      : missingAdapterPlatforms.length > 0
        ? "ADAPTER_PLATFORM_NOT_COVERED"
        : commandPlatformBlockersList.length > 0
          ? (commandPlatformBlockersList[0].code as string)
          : "ADAPTER_EVIDENCE_PLAN_READY";
  const summary = status === "ready"
    ? "Adapter evidence commands are ready for controlled execution."
    : missingAdapterPlatforms.length > 0
      ? "Adapter manifest does not cover the required platform."
      : commandPlatformBlockersList.length > 0
        ? "Adapter commands do not explicitly cover the required platform."
      : "Adapter evidence collection is missing a valid adapter or commands.";

  return {
    schema_version: ADAPTER_EVIDENCE_COLLECTOR_SCHEMA_VERSION,
    schema: ADAPTER_EVIDENCE_COLLECTOR_SCHEMA,
    status,
    code,
    summary,
    generated_at: nowIso(),
    project_root: projectRoot,
    state_root: stateRoot,
    required_platform: requiredPlatforms[0] || null,
    required_platforms: requiredPlatforms,
    adapter_applies_to: adapterApplies,
    platform_coverage: {
      required_platform: requiredPlatforms[0] || null,
      required_platforms: requiredPlatforms,
      adapter_applies_to: adapterApplies,
      adapter_covered_platforms: adapterCoveredPlatforms,
      missing_adapter_platforms: missingAdapterPlatforms,
      command_blockers: commandPlatformBlockersList,
      status: missingAdapterPlatforms.length > 0 || commandPlatformBlockersList.length > 0 ? "blocked" : "ready",
    },
    adapter: adapter ? {
      id: adapter.id,
      kind: adapter.kind,
      source_path: adapter.source_path || "",
      applies_to: adapterApplies,
      covered_platforms: adapterCoveredPlatforms,
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

export function runAdapterEvidenceCollector(input: Record<string, unknown> = Object(), options: Record<string, unknown> = Object()) {
  const plan = buildAdapterEvidencePlan(input, options);
  const execute = input.execute === true || input.executeAdapter === true || input.execute_adapter === true || options.execute === true || options.executeAdapter === true || options.execute_adapter === true;
  const allow = input.allowAdapterCommands === true || input.allow_adapter_commands === true || options.allowAdapterCommands === true || options.allow_adapter_commands === true;
  const writeArtifact = input.writeArtifact !== false && input.write_artifact !== false && options.writeArtifact !== false && options.write_artifact !== false;
  const baseStatus: string = plan.status === "blocked" ? "blocked" : execute ? "blocked" : "dry_run";
  const baseCode: string = plan.status === "blocked" ? plan.code : execute ? "ADAPTER_COMMAND_EXECUTION_NOT_ALLOWED" : "ADAPTER_EVIDENCE_DRY_RUN";
  const baseSummary: string = plan.status === "blocked"
    ? plan.summary
    : execute
      ? "Adapter command execution requires explicit authorization."
      : "Adapter evidence collector planned commands without executing them.";
  const result = {
    ...plan,
    mode: execute ? "execute" : "dry_run",
    status: baseStatus,
    code: baseCode,
    summary: baseSummary,
    platform_coverage: { ...plan.platform_coverage } as typeof plan.platform_coverage & {
      evidence_covered_platforms?: string[];
      missing_evidence_platforms?: string[];
    },
    command_results: [] as AdapterCommandResult[],
    collected_evidence: [] as Array<Record<string, unknown>>,
    ui_evidence: null as UiEvidence,
    artifacts: [] as string[],
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

  const commandResults: AdapterCommandResult[] = [];
  const evidenceRecords: Array<Record<string, unknown>> = [];
  for (const command of plan.commands) {
    const startedAt = nowIso();
    // P12.I2: route untrusted evidence_path through resolveWithinRoot咽喉.
    const evidenceGuard = command.evidence_path
      ? resolveWithinRoot(plan.project_root, command.evidence_path)
      : { ok: false, reason: "none" as const };
    if (command.evidence_path && !evidenceGuard.ok) {
      commandResults.push({
        id: command.id,
        command: command.command,
        started_at: startedAt,
        finished_at: nowIso(),
        status: "failed",
        exit_code: null,
        signal: null,
        error: `evidence_path escapes project root: ${command.evidence_path}`,
        stdout: "",
        stderr: "",
        evidence_path: null,
        evidence_file: null,
        evidence_found: false,
        adapter_applies_to: plan.adapter_applies_to || [],
        required_platform: plan.required_platform || null,
        required_platforms: plan.required_platforms || [],
      });
      continue;
    }
    // P12.I1: route adapter command through safe-exec — argv parsing rejects
    // shell metacharacters, never invokes sh -c. shell:true is banned by ci-guard.
    const executed = execCommand(command.command, {
      cwd: plan.project_root,
      timeout: command.timeout_ms,
      env: { ...process.env },
    });
    const evidencePath = evidenceGuard.ok ? (evidenceGuard.path || "") : "";
    const evidence = readJsonEvidence(evidencePath);
    if (evidence) evidenceRecords.push(evidence);
    commandResults.push({
      id: command.id,
      command: command.command,
      started_at: startedAt,
      finished_at: nowIso(),
      status: executed.ok && !executed.rejected ? "pass" : "failed",
      exit_code: executed.exit_code,
      signal: executed.signal || null,
      error: executed.rejected
        ? `command rejected: ${executed.reject_detail}`
        : (executed.error || null),
      stdout: redactDeep(truncate(executed.stdout)),
      stderr: redactDeep(truncate(executed.stderr)),
      evidence_path: evidencePath || null,
      evidence_file: evidencePath ? repoRelative(evidencePath, plan.project_root) : null,
      evidence_found: evidencePath ? existsSync(evidencePath) : null,
      adapter_applies_to: plan.adapter_applies_to || [],
      required_platform: plan.required_platform || null,
      required_platforms: plan.required_platforms || [],
    });
  }

  const failed = commandResults.filter((entry) => entry.status !== "pass");
  const missingEvidence = commandResults.filter((entry) => entry.evidence_path && entry.evidence_found === false);
  const evidenceCovered = unique(evidenceRecords.flatMap(evidenceCoveredPlatforms));
  const missingEvidencePlatforms = missingRequiredPlatforms(plan.required_platforms || [], evidenceCovered);
  result.platform_coverage = {
    ...plan.platform_coverage,
    evidence_covered_platforms: evidenceCovered,
    missing_evidence_platforms: missingEvidencePlatforms,
    status: missingEvidencePlatforms.length > 0 ? "blocked" : "pass",
  };
  result.status = failed.length > 0 || missingEvidence.length > 0 || missingEvidencePlatforms.length > 0 ? "blocked" : "pass";
  result.code = result.status === "pass"
    ? "ADAPTER_EVIDENCE_COLLECTED"
    : missingEvidencePlatforms.length > 0
      ? "ADAPTER_EVIDENCE_PLATFORM_MISMATCH"
      : "ADAPTER_EVIDENCE_COLLECTION_FAILED";
  result.summary = result.status === "pass"
    ? "Adapter evidence commands executed and evidence was collected."
    : missingEvidencePlatforms.length > 0
      ? "Adapter evidence does not cover the required platform."
      : "Adapter evidence collection failed or required evidence was missing.";
  result.command_results = commandResults;
  result.collected_evidence = evidenceRecords.map((record) => annotateEvidenceRecord(record, plan));
  result.ui_evidence = mergeEvidence(evidenceRecords);

  if (writeArtifact) {
    mkdirSync(dirname(plan.artifact_path), { recursive: true });
    writeFileSync(plan.artifact_path, JSON.stringify(result, null, 2), "utf8");
    (result.artifacts).push(plan.artifact_path);
  }

  return result;
}
