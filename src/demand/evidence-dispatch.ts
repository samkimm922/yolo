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
  inspectDemandPrdReadiness,
} from "./router.js";
import { redact } from "../lib/security/redact.js";
import { detectExternalResearchSignal } from "../lib/research-signal.js";

export const DEMAND_EVIDENCE_DISPATCH_SCHEMA_VERSION = "1.0";
export const DEMAND_EVIDENCE_DISPATCH_SCHEMA = "yolo.demand.evidence_dispatch.v1";
const VALID_EVIDENCE_SCOPES = new Set(["project", "external", "user", "unknown"]);

function clean(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function safeId(value) {
  return clean(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "demand-evidence";
}

function resolveRoot(value, fallback = process.cwd()) {
  return resolve(clean(value) || fallback);
}

function resolvePath(root, path) {
  if (!path) return "";
  return isAbsolute(path) ? path : resolve(root, path);
}

function repoRelative(path, projectRoot) {
  return relative(projectRoot, path).replace(/\\/g, "/");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableJson(value), "utf8");
  return path;
}

function isWithin(path, root) {
  const rel = relative(root, path);
  return rel === "" || (rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function excludedDir(name) {
  return [".git", "node_modules", "dist", "coverage", ".next", ".cache"].includes(name);
}

function gitFiles(projectRoot) {
  const run = spawnSync("git", ["-C", projectRoot, "ls-files", "-co", "--exclude-standard", "-z"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (run.status !== 0 || !run.stdout) return null;
  return run.stdout.split("\0").filter(Boolean);
}

function walkFiles(root, dir = root, acc = []) {
  let entries = [];
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

function boundaryEntryDigest(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `symlink:${readlinkSync(path)}`;
    if (stat.isFile()) return `file:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
    return `node:${stat.mode}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function buildBoundarySnapshot(projectRoot, allowedRoots = []) {
  const allowed = allowedRoots.map((path) => resolve(path));
  const git = gitFiles(projectRoot);
  const files = git ? [...new Set([...git, ...walkFiles(projectRoot)])] : walkFiles(projectRoot);
  const snapshot = new Map();
  for (const file of files) {
    const absolute = resolve(projectRoot, file);
    if (allowed.some((root) => isWithin(absolute, root))) continue;
    const digest = boundaryEntryDigest(absolute);
    if (digest) snapshot.set(file.replace(/\\/g, "/"), digest);
  }
  return snapshot;
}

function diffBoundarySnapshots(before, after) {
  const changes = [];
  for (const [file, digest] of before.entries()) {
    if (!after.has(file)) changes.push({ path: file, change: "deleted" });
    else if (after.get(file) !== digest) changes.push({ path: file, change: "modified" });
  }
  for (const [file] of after.entries()) {
    if (!before.has(file)) changes.push({ path: file, change: "added" });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function truncate(value, max = 12000) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}\n[truncated ${text.length - max} chars]` : text;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function isNonMissingStatusItem(value) {
  const text = clean(value).toLowerCase();
  if (!text) return true;
  if (/\b(but|except|however|unless)\b/.test(text)) return false;
  if (/^(no|none|nothing)\b.*\b(missing|unresolved|open|remaining|blockers?|gaps?)\b/.test(text)) return true;
  if (/^all\b.*\b(complete|completed|covered|satisfied|verified|resolved)\b/.test(text)) return true;
  if (/\b(no conflicts?|100%)\b/.test(text) && !/\b(missing|needed|required|unresolved|gap|blocker|blocked)\b/.test(text)) return true;
  return false;
}

function sanitizeMissing(value) {
  return asArray(value)
    .flatMap((item) => String(item ?? "").split(/\r?\n/))
    .map(clean)
    .filter(Boolean)
    .filter((item) => !isNonMissingStatusItem(item));
}

function evidenceScopeErrors(value) {
  return asArray(value).flatMap((record, index) => {
    if (!record || typeof record !== "object") return [`evidence[${index}] must be an object with scope.`];
    const scope = clean(record.scope || record.evidence_scope || record.source_scope).toLowerCase();
    if (VALID_EVIDENCE_SCOPES.has(scope)) return [];
    return [`evidence[${index}] must declare scope as project, external, user, or unknown.`];
  });
}

function demandRequestsExternalResearch(input = Object(), plan = Object()) {
  const text = [
    input.objective,
    input.problem,
    input.research,
    input.external_research,
    input.success_criteria,
    input.constraints,
    input.risks,
    plan.demand_status?.state?.slot_values?.problem,
    plan.demand_status?.state?.slot_values?.desired_outcome,
  ].flatMap(asArray).map(clean).join("\n");
  // Shared single-source detection (src/lib/research-signal.ts). Same URL +
  // explicit-request patterns as before, plus external-reference intent, so
  // discovery and demand agree on what "requires external evidence" means.
  return detectExternalResearchSignal(text).requires_external;
}

function externalEvidencePresent(agentResults = []) {
  return asArray(agentResults).some((result) => asArray(result?.evidence).some((record) => {
    if (!record || typeof record !== "object") return false;
    const scope = clean(record.scope || record.evidence_scope || record.source_scope).toLowerCase();
    const source = clean(record.source || record.kind || record.type).toLowerCase();
    return scope === "external" || !!record.url || source.startsWith("external_");
  }));
}

function readDemandSession(input = Object(), projectRoot) {
  if (input.session && typeof input.session === "object") return input.session;
  const path = clean(input.demandPath || input.demand_path || input.sessionPath || input.session_path || input.demand);
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

function dispatchIdFor(input = Object(), status = Object()) {
  const explicit = clean(input.dispatchId || input.dispatch_id);
  if (explicit) return safeId(explicit);
  const session = status?.state?.session_id || status?.demand_id || input.id || input.demandId || input.demand_id || "dispatch";
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
  const suffix = Math.random().toString(36).slice(2, 8);
  return safeId(`${session}-${stamp}-${suffix}`);
}

function outputDirFor(input = Object(), options = Object(), projectRoot, stateRoot, status) {
  const explicit = input.outputDir || input.output_dir || options.outputDir || options.output_dir;
  if (explicit) return resolvePath(projectRoot, explicit);
  return join(stateRoot, "demand", "evidence", dispatchIdFor(input, status));
}

function agentToolProfile(input = Object(), options = Object()) {
  return clean(options.agentToolProfile || options.agent_tool_profile || options.toolProfile || options.tool_profile || input.agentToolProfile || input.agent_tool_profile || input.toolProfile || input.tool_profile || "boundary").toLowerCase();
}

function safeClaudePermissionMode(value) {
  const mode = clean(value || "default");
  return ["bypasspermissions", "dangerously-skip-permissions"].includes(mode.toLowerCase()) ? "default" : mode;
}

function safeRepoRelativePath(value) {
  const path = clean(value).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path || path === "." || path === ".." || path.startsWith("../") || path.includes("/../")) return "";
  return path;
}

function boundaryMutationProbe(input = Object(), options = Object()) {
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

function actionForTask(task, index, outputDir, projectRoot) {
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

export function buildDemandEvidenceDispatchPlan(input = Object(), options = Object()) {
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

function renderJsonBlock(value) {
  return JSON.stringify(value, null, 2);
}

export function buildDemandEvidenceAgentPrompt({ action = Object(), plan = Object(), previousResults = [] } = Object()) {
  const protocol = action.protocol || {};
  const status = plan.demand_status || {};
  const toolProfile = clean(plan.execution_policy?.agent_tool_profile || "boundary");
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

function parseJsonCandidate(candidate) {
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
    return { parsed: null, repaired: false, error: error.message };
  }
}

function extractJsonObject(text = "") {
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

function normalizeAgentResult({ action = Object(), providerRun = Object(), parsed = null, parseError = "" } = Object()) {
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

  const normalized = {
    schema_version: parsed.schema_version || DEMAND_EVIDENCE_RESULT_SCHEMA_VERSION,
    schema: parsed.schema || DEMAND_EVIDENCE_RESULT_SCHEMA,
    ...parsed,
    role: parsed.role || action.role,
    status: parsed.status || "completed",
    completed: parsed.completed !== false,
  };
  normalized.missing = sanitizeMissing(normalized.missing);
  const scopeErrors = evidenceScopeErrors(normalized.evidence);
  if (scopeErrors.length > 0) {
    normalized.status = "blocked";
    normalized.completed = true;
    normalized.recommendation = "block";
    normalized.missing = [...normalized.missing, ...scopeErrors];
    normalized.result = {
      ...(normalized.result || {}),
      verdict: "blocked",
      error_code: "EVIDENCE_SCOPE_REQUIRED",
    };
  }
  return normalized;
}

function executionConfig(input = Object(), options = Object()) {
  const loaded = options.config || input.config || loadConfig(options.configPath ? { path: options.configPath } : false);
  const ai = {
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

export async function runDemandEvidenceDispatchRuntime(input = Object(), options = Object()) {
  const plan = buildDemandEvidenceDispatchPlan(input, options);
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

  const result = Object.assign(Object(), {
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

  const spawnProviderPrompt = options.spawnProviderPrompt || defaultSpawnProviderPrompt;
  const config = executionConfig(input, options);
  const timeout = Number(input.timeout_ms || input.timeoutMs || options.timeout_ms || options.timeoutMs || config.ai?.timeout_ms || 480000);
  mkdirSync(plan.output_dir, { recursive: true });
  const boundaryBefore = buildBoundarySnapshot(plan.project_root, [plan.output_dir]);

  const previousResults = [];
  for (const action of plan.actions) {
    const prompt = buildDemandEvidenceAgentPrompt({ action, plan, previousResults });
    let providerRun;
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
        stderr: error.message,
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
      stdout: redact(truncate(providerRun.stdout, 2000)),
      stderr: redact(truncate(providerRun.stderr, 2000)),
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

  const session = readDemandSession(input, plan.project_root) || plan.demand_status?.session || undefined;
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
  const externalResearchBlockers = demandRequestsExternalResearch(input, plan) && !externalEvidencePresent(result.agent_results)
    ? [{
      code: "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED",
      message: "Demand explicitly requested external web/fetch/search evidence, but no agent result included scope=external evidence with a URL or external source.",
    }]
    : [];
  const runtimeBlockers = [...boundaryBlockers, ...externalResearchBlockers];
  const finalReadiness = runtimeBlockers.length > 0
    ? {
      ...readiness,
      blockers: [...readiness.blockers, ...runtimeBlockers],
      prd_ready: false,
    }
    : readiness;
  result.readiness = finalReadiness;
  result.status = finalReadiness.prd_ready ? "pass" : "blocked";
  result.code = finalReadiness.prd_ready ? "DEMAND_EVIDENCE_DISPATCH_READY_FOR_PRD" : "DEMAND_EVIDENCE_DISPATCH_BLOCKED";
  result.summary = finalReadiness.prd_ready
    ? "Demand evidence agents completed and PRD readiness passed."
    : "Demand evidence agents completed, but readiness still has blockers.";
  result.demand_status_after_dispatch = {
    ...plan.demand_status,
    readiness: finalReadiness,
    state: {
      ...(plan.demand_status?.state || {}),
      blockers: finalReadiness.blockers,
      assumptions: finalReadiness.assumptions,
      missing_slots: finalReadiness.missing_slots,
      prd_ready: finalReadiness.prd_ready,
    },
  };
  if (writeArtifact) result.artifacts.push(writeJson(join(plan.output_dir, "dispatch.json"), result));
  return result;
}
