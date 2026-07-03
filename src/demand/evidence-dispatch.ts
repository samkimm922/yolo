import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadConfig } from "../core/config.js";
import { spawnProviderPrompt as defaultSpawnProviderPrompt } from "../runtime/execution/provider-adapter.js";
import { resolveExecutorTimeoutMs } from "../lib/toolchain.js";
import {
  buildDemandSessionState,
  DEMAND_EVIDENCE_RESULT_SCHEMA,
  DEMAND_EVIDENCE_RESULT_SCHEMA_VERSION,
  demandSessionSchemaError,
  inspectDemandPrdReadiness,
} from "./router.js";
import { redactDeep } from "../lib/security/redact.js";
import {
  evidenceRequirementBlockers,
  evidenceRequirementSummary,
} from "./evidence-requirements.js";
import type {
  DemandEvidenceResult,
  DemandMaybeArray,
  DemandRecord,
  DemandRuntimeInput,
  DemandRuntimeOptions,
  DemandSession,
} from "./graph.js";
import type {
  DemandBlocker,
  DemandPrdReadinessResult,
  DemandSessionStateResult,
} from "./router.js";

export const DEMAND_EVIDENCE_DISPATCH_SCHEMA_VERSION = "1.0";
export const DEMAND_EVIDENCE_DISPATCH_SCHEMA = "yolo.demand.evidence_dispatch.v1";
const VALID_EVIDENCE_SCOPES = new Set(["project", "external", "user", "unknown"]);

export interface BoundaryChange {
  path: string;
  change: "deleted" | "modified" | "added";
}

type BoundarySnapshot = Map<string, string>;

export interface BoundaryMutationProbe {
  enabled: boolean;
  path: string;
  content: string;
}

export interface DemandEvidenceAiConfig extends DemandRecord {
  provider?: string;
  executor?: string;
  model?: string;
  codex_model?: string;
  codex_sandbox?: string;
  codex_approval?: string;
  settings?: string;
  claude_tools?: string;
  claude_allowed_tools?: string;
  claude_disallowed_tools?: string;
  claude_disable_slash_commands?: boolean;
  claude_no_session_persistence?: boolean;
  claude_permission_mode?: string;
  agent_tool_profile?: string;
  max_budget_usd?: string;
  timeout_ms?: number | string;
}

export interface DemandEvidenceProviderOptions extends DemandRecord {
  timeout?: number;
  cwd?: string;
  rootDir?: string;
  runtimeDir: string;
  config: DemandRecord & { ai: DemandEvidenceAiConfig };
  detectModelProvider?: () => string;
}

export interface DemandEvidenceBoundaryResult extends DemandRecord {
  project_mutation: string;
  allowed_write_roots: string[];
  changes: BoundaryChange[];
}

export interface DemandEvidenceDispatchInput extends DemandRuntimeInput {
  dispatchId?: unknown;
  dispatch_id?: unknown;
  boundaryMutationProbe?: unknown;
  boundary_mutation_probe?: unknown;
  boundaryMutationProbeContent?: unknown;
  boundary_mutation_probe_content?: unknown;
  agentToolProfile?: unknown;
  agent_tool_profile?: unknown;
  toolProfile?: unknown;
  tool_profile?: unknown;
  provider?: unknown;
  executor?: unknown;
  model?: unknown;
  agentCommand?: unknown;
  agent_command?: unknown;
  customCommand?: unknown;
  custom_command?: unknown;
  maxBudgetUsd?: unknown;
  max_budget_usd?: unknown;
  allowFullAgentTools?: boolean;
  allow_full_agent_tools?: boolean;
  timeout_ms?: unknown;
  timeoutMs?: unknown;
  config?: DemandRecord;
}

export interface DemandEvidenceProviderRun extends DemandRecord {
  success?: boolean;
  provider?: string | null;
  command?: unknown;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

export type DemandEvidenceSpawnProviderPrompt = (
  prompt: string,
  options: DemandEvidenceProviderOptions,
) => Promise<DemandEvidenceProviderRun>;

export interface DemandEvidenceDispatchOptions extends DemandRuntimeOptions {
  status?: DemandSessionStateResult;
  spawnProviderPrompt?: DemandEvidenceSpawnProviderPrompt;
  boundaryMutationProbe?: unknown;
  boundary_mutation_probe?: unknown;
  boundaryMutationProbeContent?: unknown;
  boundary_mutation_probe_content?: unknown;
  agentToolProfile?: unknown;
  agent_tool_profile?: unknown;
  toolProfile?: unknown;
  tool_profile?: unknown;
  provider?: unknown;
  model?: unknown;
  agentCommand?: unknown;
  agent_command?: unknown;
  maxBudgetUsd?: unknown;
  max_budget_usd?: unknown;
  allowFullAgentTools?: boolean;
  allow_full_agent_tools?: boolean;
  timeout_ms?: unknown;
  timeoutMs?: unknown;
  config?: DemandRecord;
  configPath?: unknown;
}

interface ExplicitDemandSessionRead {
  explicit: boolean;
  ok: boolean;
  session: DemandSession | null;
  path?: string;
  code?: string;
  message?: string;
}

interface DemandEvidenceTaskLike extends DemandRecord {
  role?: string;
  reason?: string;
  protocol?: unknown;
}

export interface DemandEvidenceAction extends DemandRecord {
  id: string;
  role: string;
  status: string;
  reason: string;
  protocol: unknown;
  prompt_ref: string;
  output_path: string;
  output_file: string;
}

export interface DemandEvidenceDispatchPlan extends DemandRecord {
  schema_version: string;
  schema: string;
  status: string;
  code: string;
  summary: string;
  generated_at: string;
  project_root: string;
  state_root: string;
  output_dir: string;
  output_file: string;
  execution_policy: DemandRecord;
  boundary_mutation_probe: BoundaryMutationProbe | null;
  demand_status: DemandSessionStateResult;
  actions: DemandEvidenceAction[];
}

export interface DemandEvidenceDispatchResult extends DemandRecord {
  schema_version: string;
  schema: string;
  status: string;
  code: string;
  summary: string;
  generated_at: string;
  project_root: string;
  state_root: string;
  output_dir: string | null;
  output_file: string | null;
  actions: DemandEvidenceAction[];
  agent_results: DemandEvidenceResult[];
  provider_runs: DemandRecord[];
  blockers?: DemandBlocker[];
  artifacts: string[];
  demand_status?: DemandSessionStateResult | null;
  readiness?: DemandPrdReadinessResult;
  demand_status_after_dispatch?: DemandRecord;
  boundary?: DemandEvidenceBoundaryResult;
}

interface JsonParseResult {
  parsed: unknown | null;
  repaired: boolean;
  error: string;
}

interface NormalizeAgentResultInput extends DemandRecord {
  action?: Partial<DemandEvidenceAction> & DemandRecord;
  providerRun?: DemandEvidenceProviderRun;
  parsed?: unknown | null;
  parseError?: string;
}

interface DemandEvidenceAgentPromptInput extends DemandRecord {
  action?: Partial<DemandEvidenceAction> & DemandRecord;
  plan?: Partial<DemandEvidenceDispatchPlan> & DemandRecord;
  previousResults?: DemandEvidenceResult[];
}

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
  const normalizedPath = clean(path);
  return isAbsolute(normalizedPath) ? normalizedPath : resolve(root, normalizedPath);
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
  return rel === "" || (rel && !rel.startsWith("..") && !isAbsolute(rel));
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
  let entries: Dirent[] = [];
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

function buildBoundarySnapshot(projectRoot: string, allowedRoots: string[] = []): BoundarySnapshot {
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

function diffBoundarySnapshots(before: BoundarySnapshot, after: BoundarySnapshot): BoundaryChange[] {
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

function asArray<T = unknown>(value: DemandMaybeArray<T> | T): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? [...value] as T[] : [value as T];
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
    const evidence = record as DemandRecord;
    const scope = clean(evidence.scope || evidence.evidence_scope || evidence.source_scope).toLowerCase();
    if (VALID_EVIDENCE_SCOPES.has(scope)) return [];
    return [`evidence[${index}] must declare scope as project, external, user, or unknown.`];
  });
}

function explicitDemandSessionPath(input: DemandEvidenceDispatchInput = Object()): string {
  const legacyDemandPath = typeof input.demand === "string" ? input.demand : "";
  return clean(input.demandPath || input.demand_path || input.sessionPath || input.session_path || legacyDemandPath);
}

function readExplicitDemandSession(input: DemandEvidenceDispatchInput = Object(), projectRoot: string): ExplicitDemandSessionRead {
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
      session: null,
      message: `Demand session not found: ${sessionPath}`,
    };
  }
  try {
    const session = JSON.parse(readFileSync(sessionPath, "utf8")) as DemandSession;
    const schemaError = demandSessionSchemaError(session, sessionPath);
    if (schemaError) {
      return {
        explicit: true,
        ok: false,
        code: "DEMAND_SESSION_SCHEMA_INVALID",
        path: sessionPath,
        session: null,
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
      session: null,
      message: `Demand session JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function readDemandSession(input: DemandEvidenceDispatchInput = Object(), projectRoot: string): DemandSession | null {
  if (input.session && typeof input.session === "object") return input.session as DemandSession;
  const explicit = readExplicitDemandSession(input, projectRoot);
  if (explicit.explicit) return explicit.ok ? explicit.session : null;
  const path = clean(input.demand);
  if (!path) return null;
  const demandPath = resolvePath(projectRoot, path);
  const sessionPath = existsSync(demandPath) && !demandPath.endsWith(".json") ? join(demandPath, "session.json") : demandPath;
  if (!existsSync(sessionPath)) return null;
  try {
    return JSON.parse(readFileSync(sessionPath, "utf8")) as DemandSession;
  } catch {
    return null;
  }
}

function invalidDemandSessionDispatchResult(
  read: ExplicitDemandSessionRead,
  input: DemandEvidenceDispatchInput = Object(),
  options: DemandEvidenceDispatchOptions = Object(),
  projectRoot: string,
  stateRoot: string,
  execute: boolean,
): DemandEvidenceDispatchResult {
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
    actions: [],
    blockers: [{
      code: read.code || "DEMAND_SESSION_INVALID",
      message: read.message || "Explicit demand session source is invalid.",
      path: read.path || null,
      human_needed: true,
    }],
    agent_results: [],
    provider_runs: [],
    artifacts: [],
  };
}

function dispatchIdFor(input: DemandEvidenceDispatchInput = Object(), status: DemandSessionStateResult | DemandRecord = Object()): string {
  const explicit = clean(input.dispatchId || input.dispatch_id);
  if (explicit) return safeId(explicit);
  const statusRecord = status as DemandRecord;
  const stateRecord = statusRecord.state && typeof statusRecord.state === "object" ? statusRecord.state as DemandRecord : {};
  const session = stateRecord.session_id || statusRecord.demand_id || input.id || input.demandId || input.demand_id || "dispatch";
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
  const suffix = Math.random().toString(36).slice(2, 8);
  return safeId(`${session}-${stamp}-${suffix}`);
}

function outputDirFor(
  input: DemandEvidenceDispatchInput = Object(),
  options: DemandEvidenceDispatchOptions = Object(),
  projectRoot: string,
  stateRoot: string,
  status: DemandSessionStateResult | DemandRecord,
): string {
  const explicit = input.outputDir || input.output_dir || options.outputDir || options.output_dir;
  if (explicit) return resolvePath(projectRoot, explicit);
  return join(stateRoot, "demand", "evidence", dispatchIdFor(input, status));
}

function agentToolProfile(input: DemandEvidenceDispatchInput = Object(), options: DemandEvidenceDispatchOptions = Object()): string {
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

function boundaryMutationProbe(input: DemandEvidenceDispatchInput = Object(), options: DemandEvidenceDispatchOptions = Object()): BoundaryMutationProbe | null {
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

function actionForTask(task: DemandEvidenceTaskLike, index: number, outputDir: string, projectRoot: string): DemandEvidenceAction {
  const role = task.role || `agent-${index + 1}`;
  const outputPath = join(outputDir, `${safeId(role)}.json`);
  return {
    id: `demand.evidence.${safeId(role)}`,
    role,
    status: "pending",
    reason: task.reason || "",
    protocol: task.protocol || {},
    prompt_ref: `${role}.prompt`,
    output_path: outputPath,
    output_file: repoRelative(outputPath, projectRoot),
  };
}

export function buildDemandEvidenceDispatchPlan(
  input: DemandEvidenceDispatchInput = Object(),
  options: DemandEvidenceDispatchOptions = Object(),
): DemandEvidenceDispatchPlan {
  const projectRoot = resolveRoot(input.projectRoot || input.project_root || input.cwd || options.projectRoot || options.project_root || options.cwd);
  const stateRoot = resolveRoot(input.stateRoot || input.state_root || options.stateRoot || options.state_root, join(projectRoot, ".yolo"));
  const toolProfile = agentToolProfile(input, options);
  const status = options.status || buildDemandSessionState({
    ...input,
    projectRoot,
    stateRoot,
  }, {
    ...options,
    projectRoot,
    stateRoot,
  });
  const mutationProbe = boundaryMutationProbe(input, options);
  const outputDir = outputDirFor(input, options, projectRoot, stateRoot, status);
  const tasks = status.state?.evidence_tasks || [];
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

export function buildDemandEvidenceAgentPrompt({ action = Object(), plan = Object(), previousResults = [] }: DemandEvidenceAgentPromptInput = Object()): string {
  const protocol = (action.protocol && typeof action.protocol === "object" ? action.protocol : {}) as DemandRecord;
  const status = plan.demand_status || {};
  const executionPolicy = (plan.execution_policy && typeof plan.execution_policy === "object" ? plan.execution_policy : {}) as DemandRecord;
  const toolProfile = clean(executionPolicy.agent_tool_profile || "boundary");
  const mutationProbe = plan.boundary_mutation_probe;
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

function parseJsonCandidate(candidate: string): JsonParseResult {
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
    return { parsed: null, repaired: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function extractJsonObject(text: unknown = ""): JsonParseResult {
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

function normalizeAgentResult({ action = Object(), providerRun = Object(), parsed = null, parseError = "" }: NormalizeAgentResultInput = Object()): DemandEvidenceResult {
  if (!providerRun.success || !parsed || typeof parsed !== "object") {
    const errorCode = !parsed ? "EVIDENCE_AGENT_INVALID_JSON" : "EVIDENCE_AGENT_PROVIDER_FAILED";
    return {
      schema_version: DEMAND_EVIDENCE_RESULT_SCHEMA_VERSION,
      schema: DEMAND_EVIDENCE_RESULT_SCHEMA,
      role: action.role,
      status: "failed",
      completed: false,
      claim: action.reason || `Demand evidence ${action.role}`,
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
        provider: providerRun.provider || null,
        exit_code: providerRun.exitCode ?? null,
        timed_out: providerRun.timedOut === true,
        raw_output_excerpt: truncate(providerRun.stderr || providerRun.stdout || "No agent output.", 2000),
      },
    };
  }

  const parsedRecord = parsed as DemandRecord;
  const normalized: DemandEvidenceResult = {
    schema_version: parsedRecord.schema_version as string | undefined || DEMAND_EVIDENCE_RESULT_SCHEMA_VERSION,
    schema: parsedRecord.schema as string | undefined || DEMAND_EVIDENCE_RESULT_SCHEMA,
    ...parsedRecord,
    role: parsedRecord.role as string | undefined || action.role,
    status: parsedRecord.status as string | undefined || "completed",
    completed: parsedRecord.completed !== false,
  };
  const normalizedMissing = sanitizeMissing(normalized.missing);
  normalized.missing = normalizedMissing;
  const scopeErrors = evidenceScopeErrors(normalized.evidence);
  if (scopeErrors.length > 0) {
    normalized.status = "blocked";
    normalized.completed = true;
    normalized.recommendation = "block";
    normalized.missing = [...normalizedMissing, ...scopeErrors];
    normalized.result = {
      ...(normalized.result || {}),
      verdict: "blocked",
      error_code: "EVIDENCE_SCOPE_REQUIRED",
    };
  }
  return normalized;
}

function executionConfig(input: DemandEvidenceDispatchInput = Object(), options: DemandEvidenceDispatchOptions = Object()): DemandRecord & { ai: DemandRecord } {
  const configPath = clean(options.configPath);
  const loaded = (options.config || input.config || loadConfig(configPath ? { path: configPath } : false)) as DemandRecord & { ai?: DemandRecord };
  const ai: DemandRecord = {
    ...(loaded.ai || {}),
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

export async function runDemandEvidenceDispatchRuntime(
  input: DemandEvidenceDispatchInput = Object(),
  options: DemandEvidenceDispatchOptions = Object(),
): Promise<DemandEvidenceDispatchResult> {
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

  const result: DemandEvidenceDispatchResult = Object.assign(Object(), {
    ...plan,
    mode: execute ? "execute" : "dry_run",
    status: plan.actions.length === 0 ? "pass" : execute ? "blocked" : "dry_run",
    code: plan.actions.length === 0
      ? "DEMAND_EVIDENCE_NOT_REQUIRED"
      : execute
        ? "DEMAND_EVIDENCE_AGENT_DISPATCH_NOT_ALLOWED"
        : "DEMAND_EVIDENCE_DISPATCH_DRY_RUN",
    summary: plan.actions.length === 0
      ? plan.summary
      : execute
        ? "Demand evidence agent execution requires explicit authorization."
        : "Demand evidence agents planned without execution.",
    agent_results: [],
    provider_runs: [],
    artifacts: [],
  });

  if (plan.actions.length === 0 || !execute) return result;
  if (!allow) return result;

  const spawnProviderPrompt: DemandEvidenceSpawnProviderPrompt = options.spawnProviderPrompt
    || defaultSpawnProviderPrompt as DemandEvidenceSpawnProviderPrompt;
  const config = executionConfig(input, options);
  const timeout = Number(input.timeout_ms || input.timeoutMs || options.timeout_ms || options.timeoutMs || resolveExecutorTimeoutMs(config));
  mkdirSync(plan.output_dir, { recursive: true });
  const boundaryBefore = buildBoundarySnapshot(plan.project_root, [plan.output_dir]);

  const previousResults: DemandEvidenceResult[] = [];
  for (const action of plan.actions) {
    const prompt = buildDemandEvidenceAgentPrompt({ action, plan, previousResults });
    let providerRun: DemandEvidenceProviderRun;
    try {
      providerRun = await spawnProviderPrompt(prompt, {
        timeout,
        cwd: plan.project_root,
        rootDir: plan.project_root,
        runtimeDir: plan.output_dir,
        config,
        detectModelProvider: () => clean(config.ai?.provider || config.ai?.executor || input.provider || options.provider || "claude"),
      });
    } catch (error) {
      providerRun = {
        success: false,
        provider: clean(config.ai?.provider || config.ai?.executor || input.provider || options.provider || "unknown"),
        command: null,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      };
    }
    const parsedOutput = extractJsonObject(providerRun.stdout);
    const agentResult = normalizeAgentResult({
      action,
      providerRun,
      parsed: parsedOutput.parsed,
      parseError: parsedOutput.error,
    });
    previousResults.push(agentResult);
    result.provider_runs.push({
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
    result.agent_results.push(agentResult);
    if (writeArtifact) result.artifacts.push(writeJson(action.output_path, agentResult));
  }
  const boundaryAfter = buildBoundarySnapshot(plan.project_root, [plan.output_dir]);
  const boundaryChanges = diffBoundarySnapshots(boundaryBefore, boundaryAfter);
  result.boundary = {
    project_mutation: boundaryChanges.length > 0 ? "violated" : "clean",
    allowed_write_roots: [repoRelative(plan.output_dir, plan.project_root)],
    changes: boundaryChanges,
  };

  const demandStatusSession = "session" in plan.demand_status ? plan.demand_status.session : undefined;
  const session = readDemandSession(input, plan.project_root)
    || (demandStatusSession && typeof demandStatusSession === "object" ? demandStatusSession as DemandSession : undefined);
  const readiness = inspectDemandPrdReadiness({
    ...input,
    evidence_results: result.agent_results,
  }, {
    ...options,
    session,
    projectRoot: plan.project_root,
    stateRoot: plan.state_root,
    triage: plan.demand_status?.triage,
  });
  const boundaryBlockers = boundaryChanges.map((change) => ({
    code: "BOUNDARY_PROJECT_MUTATION",
    message: `Evidence agent changed project file outside allowed artifact root: ${change.path} (${change.change}).`,
    path: change.path,
    change: change.change,
  }));
  const requirementBlockers = evidenceRequirementBlockers(readiness.evidence_requirements);
  const readinessBlockerKeys = new Set(asArray(readiness.blockers).map((blocker) => `${blocker.code}\u0000${blocker.evidence_requirement_id || blocker.id || ""}\u0000${blocker.topic || ""}`));
  const dispatchRequirementBlockers = requirementBlockers.filter((blocker) =>
    !readinessBlockerKeys.has(`${blocker.code}\u0000${blocker.evidence_requirement_id || blocker.id || ""}\u0000${blocker.topic || ""}`)
  );
  const runtimeBlockers = [...boundaryBlockers, ...dispatchRequirementBlockers];
  const finalReadiness = runtimeBlockers.length > 0
    ? {
      ...readiness,
      blockers: [...readiness.blockers, ...runtimeBlockers],
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
    ...plan.demand_status,
    readiness: finalReadiness,
    state: {
      ...(plan.demand_status?.state || {}),
      blockers: finalReadiness.blockers,
      assumptions: finalReadiness.assumptions,
      missing_slots: finalReadiness.missing_slots,
      evidence_requirements: finalReadiness.evidence_requirements || [],
      evidence_requirement_summary: evidenceRequirementSummary(finalReadiness.evidence_requirements || []),
      prd_intake_ready: finalReadiness.prd_intake_ready,
      executable_prd_ready: finalReadiness.executable_prd_ready,
    },
  };
  if (writeArtifact) result.artifacts.push(writeJson(join(plan.output_dir, "dispatch.json"), result));
  return result;
}
