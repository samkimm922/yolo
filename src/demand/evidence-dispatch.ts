import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadConfig } from "../core/config.js";
import { spawnProviderPrompt as defaultSpawnProviderPrompt } from "../runtime/execution/provider-adapter.js";
import {
  buildDemandSessionState,
  DEMAND_EVIDENCE_RESULT_SCHEMA,
  DEMAND_EVIDENCE_RESULT_SCHEMA_VERSION,
  demandSessionSchemaError,
  inspectDemandPrdReadiness,
} from "./router.js";
import type { DemandBlocker, DemandPrdReadinessResult, DemandSessionStateResult } from "./router.js";
import { redactDeep } from "../lib/security/redact.js";
import {
  evidenceRequirementBlockers,
  evidenceRequirementSummary,
} from "./evidence-requirements.js";

export const DEMAND_EVIDENCE_DISPATCH_SCHEMA_VERSION = "1.0";
export const DEMAND_EVIDENCE_DISPATCH_SCHEMA = "yolo.demand.evidence_dispatch.v1";
const VALID_EVIDENCE_SCOPES = new Set(["project", "external", "user", "unknown"]);

// Loose input/options/session records (N4 pattern): demand dispatch inputs are
// assembled from user/agent data and read as `Record<string, unknown>`, narrowed
// at each touch point, never widened to `any`.
type Loose = Record<string, unknown>;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeId(value: unknown): string {
  return clean(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "demand-evidence";
}

function resolveRoot(value: unknown, fallback: string = process.cwd()): string {
  return resolve(clean(value) || fallback);
}

function resolvePath(root: string, path: unknown): string {
  if (!path) return "";
  const p = clean(path);
  return p && isAbsolute(p) ? p : resolve(root, p);
}

function repoRelative(path: string, projectRoot: string): string {
  return relative(projectRoot, path).replace(/\\/g, "/");
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJson(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableJson(value), "utf8");
  return path;
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}

function excludedDir(name: string): boolean {
  return [".git", "node_modules", "dist", "coverage", ".next", ".cache"].includes(name);
}

function gitFiles(projectRoot: string): string[] | null {
  const run = spawnSync("git", ["-C", projectRoot, "ls-files", "-co", "--exclude-standard", "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (run.status !== 0 || !run.stdout) return null;
  return run.stdout.split("\0").filter(Boolean);
}

function walkFiles(root: string, dir: string = root, acc: string[] = []): string[] {
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDir(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, path, acc);
    else acc.push(relative(root, path).replace(/\\/g, "/"));
  }
  return acc;
}

function boundaryEntryDigest(path: string): string | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `symlink:${readlinkSync(path)}`;
    if (stat.isFile()) return `file:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    return `node:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function buildBoundarySnapshot(projectRoot: string, allowedRoots: string[] = []): Map<string, string> {
  const allowed = allowedRoots.map((path) => resolve(path));
  const git = gitFiles(projectRoot);
  const files = git ? [...new Set([...git, ...walkFiles(projectRoot)])] : walkFiles(projectRoot);
  const snapshot = new Map<string, string>();
  for (const file of files) {
    const absolute = resolve(projectRoot, file);
    if (allowed.some((root) => isWithin(absolute, root))) continue;
    const digest = boundaryEntryDigest(absolute);
    if (digest) snapshot.set(file.replace(/\\/g, "/"), digest);
  }
  return snapshot;
}

interface BoundaryChange {
  path: string;
  change: "deleted" | "modified" | "added";
}

function diffBoundarySnapshots(before: Map<string, string>, after: Map<string, string>): BoundaryChange[] {
  const changes: BoundaryChange[] = [];
  for (const [file, digest] of before.entries()) {
    if (!after.has(file)) changes.push({ path: file, change: "deleted" });
    else if (after.get(file) !== digest) changes.push({ path: file, change: "modified" });
  }
  for (const [file] of after.entries()) {
    if (!before.has(file)) changes.push({ path: file, change: "added" });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function truncate(value: unknown, max: number = 12000): string {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n[truncated ${text.length - max} chars]` : text;
}

function asArray<T = unknown>(value: unknown): T[] {
  if (value == null) return [] as T[];
  return (Array.isArray(value) ? value : [value]) as T[];
}

function isNonMissingStatusItem(value: unknown): boolean {
  const text = clean(value).toLowerCase();
  if (!text) return true;
  if (/\b(but|except|however|unless)\b/.test(text)) return false;
  if (/^(no|none|nothing)\b.*\b(missing|unresolved|open|remaining|blockers?|gaps?)\b/.test(text)) return true;
  if (/^all\b.*\b(complete|completed|covered|satisfied|verified|resolved)\b/.test(text)) return true;
  if (/\b(no conflicts?|100%)\b/.test(text) && !/\b(missing|needed|required|unresolved|gap|blocker|blocked)\b/.test(text)) return true;
  return false;
}

function sanitizeMissing(value: unknown): string[] {
  return asArray(value)
    .flatMap((item) => String(item ?? "").split(/\r?\n/))
    .map(clean)
    .filter(Boolean)
    .filter((item) => !isNonMissingStatusItem(item));
}

function evidenceScopeErrors(value: unknown): string[] {
  return asArray(value).flatMap((record, index) => {
    if (!record || typeof record !== "object") return [`evidence[${index}] must be an object with scope.`];
    const r = record as Loose;
    const scope = clean(r.scope || r.evidence_scope || r.source_scope).toLowerCase();
    if (VALID_EVIDENCE_SCOPES.has(scope)) return [];
    return [`evidence[${index}] must declare scope as project, external, user, or unknown.`];
  });
}

function explicitDemandSessionPath(input: Loose = Object()): string {
  const legacyDemandPath = typeof input.demand === "string" ? input.demand : "";
  return clean(input.demandPath || input.demand_path || input.sessionPath || input.session_path || legacyDemandPath);
}

interface DemandSessionRead {
  explicit: boolean;
  ok: boolean;
  code?: string;
  path?: string;
  message?: string;
  session?: unknown;
}

function readExplicitDemandSession(input: Loose = Object(), projectRoot: string): DemandSessionRead {
  const path = explicitDemandSessionPath(input);
  if (!path) return { explicit: false, ok: true, session: null };
  const demandPath = resolvePath(projectRoot, path);
  const sessionPath = existsSync(demandPath) && !demandPath.endsWith(".json") ? join(demandPath, "session.json") : demandPath;
  if (!existsSync(sessionPath)) {
    return {
      explicit: true,
      ok: false,
      code: "DEMAND_SESSION_NOT_FOUND",
      path: sessionPath,
      message: `Demand session not found: ${sessionPath}`,
    };
  }
  try {
    const session = JSON.parse(readFileSync(sessionPath, "utf8"));
    const schemaError = demandSessionSchemaError(session, sessionPath);
    if (schemaError) {
      return {
        explicit: true,
        ok: false,
        code: "DEMAND_SESSION_SCHEMA_INVALID",
        path: sessionPath,
        message: schemaError,
      };
    }
    return { explicit: true, ok: true, path: sessionPath, session };
  } catch (error) {
    return {
      explicit: true,
      ok: false,
      code: "DEMAND_SESSION_JSON_INVALID",
      path: sessionPath,
      message: `Demand session JSON parse failed: ${(error as Error).message}`,
    };
  }
}

function readDemandSession(input: Loose = Object(), projectRoot: string): unknown {
  if (input.session && typeof input.session === "object") return input.session;
  const explicit = readExplicitDemandSession(input, projectRoot);
  if (explicit.explicit) return explicit.ok ? explicit.session : null;
  const path = clean(input.demand);
  if (!path) return null;
  const demandPath = resolvePath(projectRoot, path);
  const sessionPath = existsSync(demandPath) && !demandPath.endsWith(".json") ? join(demandPath, "session.json") : demandPath;
  if (!existsSync(sessionPath)) return null;
  try {
    return JSON.parse(readFileSync(sessionPath, "utf8"));
  } catch {
    return null;
  }
}

function invalidDemandSessionDispatchResult(read: DemandSessionRead, input: Loose = Object(), options: Loose = Object(), projectRoot: string, stateRoot: string, execute: boolean): Loose {
  return {
    schema_version: DEMAND_EVIDENCE_DISPATCH_SCHEMA_VERSION,
    schema: DEMAND_EVIDENCE_DISPATCH_SCHEMA,
    status: "blocked",
    code: "DEMAND_SESSION_INVALID",
    summary: read.message || "Explicit demand session source is invalid.",
    generated_at: nowIso(),
    project_root: projectRoot,
    state_root: stateRoot,
    output_dir: null,
    output_file: null,
    mode: execute ? "execute" : "dry_run",
    execution_policy: {
      default_mode: "fail_closed",
      execute_requires: ["valid demand session"],
      writes_business_code: false,
      agent_instruction: "blocked_invalid_demand_session",
      agent_tool_profile: agentToolProfile(input, options),
    },
    demand_status: null,
    actions: [] as unknown[],
    blockers: [{
      code: read.code || "DEMAND_SESSION_INVALID",
      message: read.message || "Explicit demand session source is invalid.",
      path: read.path || null,
      human_needed: true,
    }],
    agent_results: [] as unknown[],
    provider_runs: [] as unknown[],
    artifacts: [] as string[],
  };
}

function dispatchIdFor(input: Loose = Object(), status: Loose = Object()): string {
  const explicit = clean(input.dispatchId || input.dispatch_id);
  if (explicit) return safeId(explicit);
  const session = clean((status.state as Loose)?.session_id) || clean(status.demand_id) || clean(input.id) || clean(input.demandId) || clean(input.demand_id) || "dispatch";
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
  const suffix = Math.random().toString(36).slice(2, 8);
  return safeId(`${session}-${stamp}-${suffix}`);
}

function outputDirFor(input: Loose = Object(), options: Loose = Object(), projectRoot: string, stateRoot: string, status: Loose): string {
  const explicit = input.outputDir || input.output_dir || options.outputDir || options.output_dir;
  if (explicit) return resolvePath(projectRoot, explicit);
  return join(stateRoot, "demand", "evidence", dispatchIdFor(input, status));
}

function agentToolProfile(input: Loose = Object(), options: Loose = Object()): string {
  return clean(options.agentToolProfile || options.agent_tool_profile || options.toolProfile || options.tool_profile || input.agentToolProfile || input.agent_tool_profile || input.toolProfile || input.tool_profile || "boundary").toLowerCase();
}

function safeClaudePermissionMode(value: unknown): string {
  const mode = clean(value || "acceptEdits");
  return ["bypasspermissions", "dangerously-skip-permissions"].includes(mode.toLowerCase()) ? "acceptEdits" : mode;
}

function safeRepoRelativePath(value: unknown): string {
  const path = clean(value).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path || path === "." || path === ".." || path.startsWith("../") || path.includes("/../")) return "";
  return path;
}

export interface BoundaryMutationProbe {
  enabled: boolean;
  path: string;
  content: string;
}

function boundaryMutationProbe(input: Loose = Object(), options: Loose = Object()): BoundaryMutationProbe | null {
  const path = safeRepoRelativePath(
    options.boundaryMutationProbe
    || options.boundary_mutation_probe
    || input.boundaryMutationProbe
    || input.boundary_mutation_probe,
  );
  if (!path) return null;
  return {
    enabled: true,
    path,
    content: clean(
      options.boundaryMutationProbeContent
      || options.boundary_mutation_probe_content
      || input.boundaryMutationProbeContent
      || input.boundary_mutation_probe_content,
    ) || `YOLO boundary mutation probe ${nowIso()}`,
  };
}

function actionForTask(task: Loose, index: number, outputDir: string, projectRoot: string) {
  const role = clean(task.role) || `agent-${index + 1}`;
  const outputPath = join(outputDir, `${safeId(role)}.json`);
  return {
    id: `demand.evidence.${safeId(role)}`,
    role,
    status: "pending",
    reason: clean(task.reason) || "",
    protocol: task.protocol || {},
    prompt_ref: `${role}.prompt`,
    output_path: outputPath,
    output_file: repoRelative(outputPath, projectRoot),
  };
}

export function buildDemandEvidenceDispatchPlan(input: Loose = Object(), options: Loose = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || input.cwd || options.projectRoot || options.project_root || options.cwd);
  const stateRoot = resolveRoot(input.stateRoot || input.state_root || options.stateRoot || options.state_root, join(projectRoot, ".yolo"));
  const toolProfile = agentToolProfile(input, options);
  const status: Loose = ((options.status as Loose) || buildDemandSessionState({
    ...input,
    projectRoot,
    stateRoot,
  }, {
    ...options,
    projectRoot,
    stateRoot,
  })) as Loose;
  const mutationProbe = boundaryMutationProbe(input, options);
  const outputDir = outputDirFor(input, options, projectRoot, stateRoot, status);
  const tasks = (status.state as Loose)?.evidence_tasks as Loose[] || [];
  const actions = tasks.map((task, index) => actionForTask(task, index, outputDir, projectRoot));

  return {
    schema_version: DEMAND_EVIDENCE_DISPATCH_SCHEMA_VERSION,
    schema: DEMAND_EVIDENCE_DISPATCH_SCHEMA,
    status: actions.length > 0 ? "ready" : "pass",
    code: actions.length > 0 ? "DEMAND_EVIDENCE_DISPATCH_READY" : "DEMAND_EVIDENCE_NOT_REQUIRED",
    summary: actions.length > 0
      ? "Demand evidence agents are planned and require explicit execution authorization."
      : "Demand status does not require evidence agent dispatch.",
    generated_at: nowIso(),
    project_root: projectRoot,
    state_root: stateRoot,
    output_dir: outputDir,
    output_file: repoRelative(outputDir, projectRoot),
    execution_policy: {
      default_mode: "dry_run",
      execute_requires: ["executeAgents=true", "allowAgentDispatch=true"],
      writes_business_code: false,
      agent_instruction: "boundary_controlled",
      agent_tool_profile: toolProfile,
      boundary: {
        project_mutation: "forbidden",
        allowed_write_roots: [repoRelative(outputDir, projectRoot)],
      },
      boundary_mutation_probe: mutationProbe ? {
        enabled: true,
        path: mutationProbe.path,
        expected: "BOUNDARY_PROJECT_MUTATION blocker",
      } : undefined,
    },
    boundary_mutation_probe: mutationProbe,
    demand_status: status,
    actions,
  };
}

function renderJsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function buildDemandEvidenceAgentPrompt({ action = Object(), plan = Object(), previousResults = [] } = Object() as { action?: Loose; plan?: Loose; previousResults?: unknown[] }): string {
  const protocol = (action.protocol as Loose) || {};
  const status = (plan.demand_status as Loose) || {};
  const executionPolicy = (plan.execution_policy as Loose) || {};
  const toolProfile = clean(executionPolicy.agent_tool_profile || "boundary");
  const mutationProbe = plan.boundary_mutation_probe as BoundaryMutationProbe | undefined;
  const renderedProtocol = mutationProbe?.enabled
    ? {
      ...protocol,
      objective: "Execute the controlled boundary mutation probe, then report evidence.",
      prompt: `This is a disposable fixture project. The usual non-editing evidence protocol is suspended only for this one probe file. Use a write-capable tool, such as Write, Edit, or Bash redirection, to create or modify exactly ${mutationProbe.path} with the configured probe content. Do not modify any other target project file. Return JSON evidence after the write attempt.`,
      writes_code: "probe_write_only",
    }
    : protocol;
  return [
    `You are the YOLO demand evidence ${action.role} agent.`,
    "",
    "Hard rules:",
    "- Tools may be available, including shell, fetch, search, and write tools.",
    mutationProbe?.enabled
      ? `- Boundary mutation probe is explicitly enabled for a disposable fixture. You must attempt the probe write before returning JSON. Create or modify exactly this repo-relative target project file: ${mutationProbe.path}. Write this exact content: ${JSON.stringify(mutationProbe.content)}. Do not modify any other target project file. If no write-capable tool is available, put that in missing and recommendation=block.`
      : "- Boundary: do not modify target project files. If verification would require mutation, report it in missing.",
    `- Allowed artifact/scratch root for this dispatch: ${plan.output_dir}`,
    "- Do not ask permission to write the evidence result. Do not write the result file yourself; the harness captures stdout and writes artifacts.",
    "- Do not treat assumptions as facts.",
    "- missing must be [] when nothing is missing; never put status notes such as 'no missing data identified' into missing.",
    "- Every evidence record must include scope: project, external, user, or unknown.",
    "- If Current demand status includes evidence_requirements, any evidence record that satisfies one must set covers to the matching requirement id.",
    "- Project facts require project-scoped evidence from code, tests, docs, config, logs, or artifacts, with a repo-relative path or file locator.",
    "- If a project fact cannot be verified from files/docs/tests/logs/artifacts, put it in missing or assumptions.",
    "- If the demand explicitly asks for external research/fetch/search, actually use an available web/fetch/search-capable tool such as WebFetch, WebSearch, an MCP web reader, browser fetch, or equivalent. Record those records as scope=external; if no such tool is available, put that in missing.",
    toolProfile.includes("research") ? "- Web/fetch/search-capable tools are allowed for external research; mark those records as scope=external and do not use them as project facts." : "- External research tools may be available; mark external records as scope=external and do not use them as project facts.",
    toolProfile.includes("research") ? "- If the demand text includes a URL or explicit external research request, your result must include at least one external evidence record with scope=external and a url/tool/source summary, unless you report the web tool as unavailable in missing." : "",
    toolProfile === "full" ? "- Full tools may be available for stress probes, but this demand evidence protocol still forbids modifying target project files." : "",
    "- Keep summary and why as plain JSON strings. Avoid raw double quotes or backslashes inside strings; escape them if unavoidable.",
    "- Return one JSON object only to stdout. No markdown, no prose outside JSON.",
    "",
    `Project root: ${plan.project_root}`,
    `State root: ${plan.state_root}`,
    "",
    "Your protocol:",
    renderJsonBlock({
      role: action.role,
      objective: renderedProtocol.objective,
      prompt: renderedProtocol.prompt,
      writes_code: renderedProtocol.writes_code,
      result_schema: renderedProtocol.result_schema,
    }),
    "",
    "Current demand status:",
    renderJsonBlock(status),
    "",
    "Previous evidence results:",
    renderJsonBlock(previousResults),
    "",
    "Required JSON shape:",
    renderJsonBlock({
      schema_version: DEMAND_EVIDENCE_RESULT_SCHEMA_VERSION,
      schema: DEMAND_EVIDENCE_RESULT_SCHEMA,
      role: action.role,
      status: "completed | blocked",
      completed: true,
      claim: "The factual claim you verified or challenged.",
      confidence: "low | medium | high",
      evidence: [
        {
          path: "repo-relative path or file locator; required when scope is project",
          url: "external URL when scope is external",
          line: "line number or range when available",
          scope: "project | external | user | unknown",
          source: "project_code | project_test | project_docs | project_config | project_log | project_artifact | external_web | external_docs | user | unknown",
          summary: "short evidence summary",
          why: "why this evidence matters",
          covers: ["EVREQ-... requirement ids satisfied by this record"],
        },
      ],
      assumptions: ["unverified assumptions, if any"],
      risks: ["risk if claim is wrong"],
      missing: ["what still needs verification"],
      recommendation: "proceed | clarify | cross_check | block",
      result: {
        verdict: "pass | blocked",
        notes: "brief verifier notes",
      },
    }),
  ].join("\n");
}

interface JsonCandidateResult {
  parsed: unknown;
  repaired: boolean;
  error: string;
}

function parseJsonCandidate(candidate: string): JsonCandidateResult {
  try {
    return { parsed: JSON.parse(candidate), repaired: false, error: "" };
  } catch (error) {
    const repaired = candidate
      .replace(/("line"\s*:\s*)(\d+)\s*-\s*(\d+)(\s*[,}])/g, '$1"$2-$3"$4')
      .replace(/("line"\s*:\s*)(\d+)\s*-\s*(\d+)"(\s*[,}])/g, '$1"$2-$3"$4')
      .replace(/\\(?!["\\/bfnrtu])/g, "\\\\")
      .replace(/([,{]\s*)"\s+"([A-Za-z_][\w-]*)"\s*:/g, '$1"$2":')
      .replace(/,\s*([}\]])/g, "$1");
    if (repaired !== candidate) {
      try {
        return { parsed: JSON.parse(repaired), repaired: true, error: "" };
      } catch {}
    }
    return { parsed: null, repaired: false, error: (error as Error).message };
  }
}

function extractJsonObject(text: string = ""): JsonCandidateResult {
  const trimmed = clean(text);
  if (!trimmed) return { parsed: null, repaired: false, error: "empty provider output" };
  const direct = parseJsonCandidate(trimmed);
  if (direct.parsed) return direct;
  const errors = [direct.error].filter(Boolean);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const fencedParse = parseJsonCandidate(fenced[1]);
    if (fencedParse.parsed) return fencedParse;
    if (fencedParse.error) errors.push(fencedParse.error);
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = parseJsonCandidate(trimmed.slice(start, end + 1));
    if (sliced.parsed) return sliced;
    if (sliced.error) errors.push(sliced.error);
  }
  return { parsed: null, repaired: false, error: errors.find(Boolean) || "no JSON object found in provider output" };
}

function normalizeAgentResult({ action = Object(), providerRun = Object(), parsed = null, parseError = "" } = Object() as { action?: Loose; providerRun?: Loose; parsed?: unknown; parseError?: string }): Loose {
  const run = providerRun as Loose;
  if (!run.success || !parsed || typeof parsed !== "object") {
    const errorCode = !parsed ? "EVIDENCE_AGENT_INVALID_JSON" : "EVIDENCE_AGENT_PROVIDER_FAILED";
    return {
      schema_version: DEMAND_EVIDENCE_RESULT_SCHEMA_VERSION,
      schema: DEMAND_EVIDENCE_RESULT_SCHEMA,
      role: action.role,
      status: "failed",
      completed: false,
      claim: clean(action.reason) || `Demand evidence ${clean(action.role)}`,
      confidence: "low",
      evidence: [],
      assumptions: [],
      risks: ["Evidence agent did not return a valid completed result."],
      missing: [
        `${errorCode}: ${parseError || "Evidence agent did not return a valid JSON object."}`,
      ],
      recommendation: "block",
      result: {
        verdict: "blocked",
        error_code: errorCode,
        provider: run.provider || null,
        exit_code: run.exitCode ?? null,
        timed_out: run.timedOut === true,
        raw_output_excerpt: truncate(run.stderr || run.stdout || "No agent output.", 2000),
      },
    };
  }

  const parsedRecord = parsed as Loose;
  const normalized: Loose = {
    schema_version: parsedRecord.schema_version || DEMAND_EVIDENCE_RESULT_SCHEMA_VERSION,
    schema: parsedRecord.schema || DEMAND_EVIDENCE_RESULT_SCHEMA,
    ...parsedRecord,
    role: parsedRecord.role || action.role,
    status: parsedRecord.status || "completed",
    completed: parsedRecord.completed !== false,
  };
  normalized.missing = sanitizeMissing(normalized.missing);
  const scopeErrors = evidenceScopeErrors(normalized.evidence);
  if (scopeErrors.length > 0) {
    normalized.status = "blocked";
    normalized.completed = true;
    normalized.recommendation = "block";
    normalized.missing = [...(normalized.missing as string[]), ...scopeErrors];
    normalized.result = {
      ...(normalized.result as Loose || {}),
      verdict: "blocked",
      error_code: "EVIDENCE_SCOPE_REQUIRED",
    };
  }
  return normalized;
}

function executionConfig(input: Loose = Object(), options: Loose = Object()): Loose {
  const loaded = (options.config || input.config || loadConfig(options.configPath ? { path: options.configPath as string } : false)) as Loose;
  const ai: Loose = {
    ...((loaded.ai as Loose) || {}),
  };
  const mutationProbe = boundaryMutationProbe(input, options);
  const provider = clean(options.provider || input.provider || input.executor || ai.provider || ai.executor || "");
  const model = clean(options.model || input.model || "");
  const agentCommand = clean(options.agentCommand || options.agent_command || input.agentCommand || input.agent_command || input.customCommand || input.custom_command);
  const maxBudgetUsd = clean(options.maxBudgetUsd || options.max_budget_usd || input.maxBudgetUsd || input.max_budget_usd);
  const agentToolProfile = clean(options.agentToolProfile || options.agent_tool_profile || options.toolProfile || options.tool_profile || input.agentToolProfile || input.agent_tool_profile || input.toolProfile || input.tool_profile || "boundary").toLowerCase();
  const allowFullAgentTools = options.allowFullAgentTools === true
    || options.allow_full_agent_tools === true
    || input.allowFullAgentTools === true
    || input.allow_full_agent_tools === true;
  if (provider) {
    ai.provider = provider;
    ai.executor = provider;
  }
  if (model) {
    ai.model = model;
    if (provider === "codex") ai.codex_model = model;
  }
  if (agentCommand) ai.custom_command = agentCommand;
  if (maxBudgetUsd) ai.max_budget_usd = maxBudgetUsd;
  if ((ai.provider || ai.executor) === "codex") {
    if (!model && !clean(ai.codex_model) && /\bclaude\b/i.test(clean(ai.model))) ai.model = "";
  }
  if ((ai.provider || ai.executor) === "claude") {
    const normalizedProfile = ["research", "fetch", "web", "web-research", "external-research"].includes(agentToolProfile)
      ? "research"
      : ["full", "all", "write", "execution"].includes(agentToolProfile) && allowFullAgentTools
        ? "full"
        : "boundary";
    ai.settings = "";
    ai.claude_tools = "default";
    ai.claude_allowed_tools = mutationProbe?.enabled
      ? "Read,Glob,Grep,Write,Edit,Bash"
      : "Read,Glob,Grep,WebFetch,WebSearch";
    ai.claude_disallowed_tools = mutationProbe?.enabled ? "" : "Write,Edit,Bash";
    ai.claude_disable_slash_commands = false;
    ai.claude_no_session_persistence = true;
    ai.claude_permission_mode = safeClaudePermissionMode(ai.claude_permission_mode);
    ai.agent_tool_profile = mutationProbe?.enabled ? "boundary_probe" : normalizedProfile;
  }
  if ((ai.provider || ai.executor) === "custom") {
    ai.custom_sandbox = "boundary";
  }
  return {
    ...loaded,
    ai,
  };
}

export async function runDemandEvidenceDispatchRuntime(input: Loose = Object(), options: Loose = Object()) {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || input.cwd || options.projectRoot || options.project_root || options.cwd);
  const stateRoot = resolveRoot(input.stateRoot || input.state_root || options.stateRoot || options.state_root, join(projectRoot, ".yolo"));
  const execute = input.executeAgents === true
    || input.execute_agents === true
    || input.execute === true
    || options.executeAgents === true
    || options.execute_agents === true
    || options.execute === true;
  const allow = input.allowAgentDispatch === true
    || input.allow_agent_dispatch === true
    || options.allowAgentDispatch === true
    || options.allow_agent_dispatch === true;
  const writeArtifact = input.writeArtifact !== false
    && input.write_artifact !== false
    && options.writeArtifact !== false
    && options.write_artifact !== false;
  const demandSessionRead = readExplicitDemandSession(input, projectRoot);
  if (demandSessionRead.explicit && !demandSessionRead.ok) {
    return invalidDemandSessionDispatchResult(demandSessionRead, input, options, projectRoot, stateRoot, execute);
  }

  const plan = buildDemandEvidenceDispatchPlan(input, {
    ...options,
    projectRoot,
    stateRoot,
  });

  const result: Loose = Object.assign(Object() as Loose, {
    ...plan,
    mode: execute ? "execute" : "dry_run",
    status: (plan as Loose).actions && ((plan as Loose).actions as unknown[]).length === 0 ? "pass" : execute ? "blocked" : "dry_run",
    code: (plan as Loose).actions && ((plan as Loose).actions as unknown[]).length === 0
      ? "DEMAND_EVIDENCE_NOT_REQUIRED"
      : execute
        ? "DEMAND_EVIDENCE_AGENT_DISPATCH_NOT_ALLOWED"
        : "DEMAND_EVIDENCE_DISPATCH_DRY_RUN",
    summary: (plan as Loose).actions && ((plan as Loose).actions as unknown[]).length === 0
      ? (plan as Loose).summary
      : execute
        ? "Demand evidence agent execution requires explicit authorization."
        : "Demand evidence agents planned without execution.",
    agent_results: [] as unknown[],
    provider_runs: [] as unknown[],
    artifacts: [] as string[],
  });

  const planActions = ((plan as Loose).actions as Loose[]) || [];
  if (planActions.length === 0 || !execute) return result;
  if (!allow) return result;

  const spawnProviderPrompt = (options.spawnProviderPrompt as ((prompt: string, opts: Record<string, unknown>) => Promise<Loose>) | undefined) || defaultSpawnProviderPrompt;
  const config = executionConfig(input, options);
  const configAi = (config as Loose).ai as Loose | undefined;
  const timeout = Number(input.timeout_ms || input.timeoutMs || options.timeout_ms || options.timeoutMs || configAi?.timeout_ms || 480000);
  mkdirSync((plan as Loose).output_dir as string, { recursive: true });
  const boundaryBefore = buildBoundarySnapshot((plan as Loose).project_root as string, [(plan as Loose).output_dir as string]);

  const previousResults: unknown[] = [];
  for (const action of planActions) {
    const prompt = buildDemandEvidenceAgentPrompt({ action, plan, previousResults });
    let providerRun: Loose;
    try {
      providerRun = await spawnProviderPrompt(prompt, {
        timeout,
        cwd: (plan as Loose).project_root,
        rootDir: (plan as Loose).project_root,
        runtimeDir: (plan as Loose).output_dir,
        config,
        detectModelProvider: () => clean(configAi?.provider || configAi?.executor || input.provider || options.provider || "claude"),
      }) as Loose;
    } catch (error) {
      providerRun = {
        success: false,
        provider: clean(configAi?.provider || configAi?.executor || input.provider || options.provider || "unknown"),
        command: null,
        exitCode: null,
        stdout: "",
        stderr: (error as Error).message,
        timedOut: false,
      };
    }
    const parsedOutput = extractJsonObject(clean(providerRun.stdout));
    const agentResult = normalizeAgentResult({
      action,
      providerRun,
      parsed: parsedOutput.parsed,
      parseError: parsedOutput.error,
    });
    previousResults.push(agentResult);
    (result.provider_runs as Loose[]).push({
      role: action.role,
      provider: providerRun.provider || null,
      command: providerRun.command || null,
      success: providerRun.success === true,
      exit_code: providerRun.exitCode ?? null,
      signal: providerRun.signal || null,
      timed_out: providerRun.timedOut === true,
      json_repaired: parsedOutput.repaired === true,
      parse_error: parsedOutput.parsed ? "" : truncate(parsedOutput.error, 500),
      stdout: redactDeep(truncate(providerRun.stdout, 2000)),
      stderr: redactDeep(truncate(providerRun.stderr, 2000)),
    });
    (result.agent_results as Loose[]).push(agentResult as Loose);
    if (writeArtifact) (result.artifacts as string[]).push(writeJson(action.output_path as string, agentResult));
  }
  const boundaryAfter = buildBoundarySnapshot((plan as Loose).project_root as string, [(plan as Loose).output_dir as string]);
  const boundaryChanges = diffBoundarySnapshots(boundaryBefore, boundaryAfter);
  result.boundary = {
    project_mutation: boundaryChanges.length > 0 ? "violated" : "clean",
    allowed_write_roots: [repoRelative((plan as Loose).output_dir as string, (plan as Loose).project_root as string)],
    changes: boundaryChanges,
  };

  const session = readDemandSession(input, (plan as Loose).project_root as string) || ((plan as Loose).demand_status as Loose | undefined)?.session || undefined;
  const readiness = inspectDemandPrdReadiness({
    ...input,
    evidence_results: result.agent_results,
  }, {
    ...options,
    session,
    projectRoot: (plan as Loose).project_root,
    stateRoot: (plan as Loose).state_root,
    triage: ((plan as Loose).demand_status as Loose | undefined)?.triage,
  });
  const boundaryBlockers = boundaryChanges.map((change) => ({
    code: "BOUNDARY_PROJECT_MUTATION",
    message: `Evidence agent changed project file outside allowed artifact root: ${change.path} (${change.change}).`,
    path: change.path,
    change: change.change,
  }));
  const requirementBlockers = evidenceRequirementBlockers(readiness.evidence_requirements);
  const readinessBlockerKeys = new Set(readiness.blockers.map((blocker) => {
    const b = blocker as DemandBlocker & Loose;
    return `${blocker.code}\u0000${b.evidence_requirement_id || b.id || ""}\u0000${b.topic || ""}`;
  }));
  const dispatchRequirementBlockers = requirementBlockers.filter((blocker) =>
    !readinessBlockerKeys.has(`${blocker.code}\u0000${blocker.evidence_requirement_id || blocker.id || ""}\u0000${blocker.topic || ""}`)
  );
  const runtimeBlockers = [...boundaryBlockers, ...dispatchRequirementBlockers];
  const finalReadiness: DemandPrdReadinessResult = runtimeBlockers.length > 0
    ? {
      ...readiness,
      blockers: [...readiness.blockers, ...(runtimeBlockers as DemandBlocker[])],
      prd_intake_ready: false,
      executable_prd_ready: false,
      prd_ready: false,
    }
    : readiness;
  result.readiness = finalReadiness;
  result.status = finalReadiness.prd_intake_ready ? "pass" : "blocked";
  result.code = finalReadiness.prd_intake_ready ? "DEMAND_EVIDENCE_DISPATCH_PRD_INTAKE_READY" : "DEMAND_EVIDENCE_DISPATCH_BLOCKED";
  result.summary = finalReadiness.prd_intake_ready
    ? "Demand evidence agents completed and PRD intake readiness passed."
    : "Demand evidence agents completed, but readiness still has blockers.";
  result.demand_status_after_dispatch = {
    ...((plan as Loose).demand_status as Loose),
    readiness: finalReadiness,
    state: {
      ...(((plan as Loose).demand_status as Loose | undefined)?.state as Loose || {}),
      blockers: finalReadiness.blockers,
      assumptions: finalReadiness.assumptions,
      missing_slots: finalReadiness.missing_slots,
      evidence_requirements: finalReadiness.evidence_requirements || [],
      evidence_requirement_summary: evidenceRequirementSummary(finalReadiness.evidence_requirements || []),
      prd_intake_ready: finalReadiness.prd_intake_ready,
      executable_prd_ready: finalReadiness.executable_prd_ready,
    },
  };
  if (writeArtifact) (result.artifacts as string[]).push(writeJson(join((plan as Loose).output_dir as string, "dispatch.json"), result));
  return result;
}
