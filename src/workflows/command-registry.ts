import { lifecycleStageIds } from "../lifecycle/schema.js";

export const YOLO_COMMAND_REGISTRY_SCHEMA_VERSION = "1.1";
export const YOLO_COMMAND_REGISTRY_SCHEMA = "yolo.workflow.command_registry.v1";
export const YOLO_COMMAND_SURFACE_BUDGET = 4;

export const DEFAULT_YOLO_PUBLIC_COMMAND_NAMES = [
  "demand",
  "auto",
  "ship",
  "status",
];

function stableCommand(command) {
  return {
    surface: "stable",
    stability: "stable",
    visibility: "default",
    ...command,
  };
}

function compatibilityCommand(command) {
  return {
    surface: "compat",
    stability: "compat",
    visibility: "hidden",
    ...command,
  };
}

function internalCommand(command) {
  return {
    surface: "internal",
    stability: "internal",
    visibility: "hidden",
    ...command,
  };
}

export const YOLO_COMMANDS = [
  stableCommand({
    name: "demand",
    lifecycle_stage: "idea",
    workflow: "demand",
    description: "Clarify an idea through one-question demand status, office-hours mode, evidence dispatch, and approved-demand handoff.",
    argumentHint: "[status|dispatch|--mode office-hours|--stage brainstorm|interview|discover|discuss] <idea>",
    objective: "Act as the YOLO demand facilitator. Ask exactly one next_question when required slots are missing, keep assumptions separate from verified facts, produce approved demand artifacts only after approval, do not enter PRD, and do not enter executable spec generation or code execution in the same turn.",
    mode: "demand",
    aliases: ["yolo demand", "yolo-demand"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Demand-stage only. 不改代码, do not edit business code, and do not compile executable PRD in the same turn. 缺槽位时只返回一个 next_question, 不输出大段建议, 不进入 PRD. 批准最后: demand approval is not execution authorization.",
    usage: "yolo demand --mode office-hours \"我想把库存预警需求聊清楚\"",
  }),
  stableCommand({
    name: "auto",
    lifecycle_stage: "idea",
    workflow: "pi",
    description: "Auto-run the full YOLO pipeline: clarify → spec → check → implement → review → deliver.",
    argumentHint: "<idea or requirement> [--dry-run] [--json]",
    objective: "Orchestrate the full YOLO lifecycle from idea through delivery, stopping at any gate that fails. Each stage is independently gated by the lifecycle guard.",
    mode: "auto",
    aliases: ["yolo auto", "yolo-auto"],
    writes_code: true,
    requires_confirmation: true,
    safety: "Auto-orchestration. Each stage is independently gated. Stop on any gate failure. Do not skip gates.",
    usage: "yolo auto \"Add low-stock alerts to inventory dashboard\" --dry-run --json",
  }),
  stableCommand({
    name: "ship",
    lifecycle_stage: "delivery",
    workflow: "ship",
    description: "Fail closed before release on weak spec, broken gates, missing evidence, or review findings.",
    argumentHint: "<PRD path> [--json]",
    objective: "Produce a ship/no-ship delivery verdict from acceptance evidence and gate results.",
    mode: "ship",
    aliases: ["yolo ship", "yolo-ship"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Do not publish, deploy, tag, or mark a release ready when any required gate is missing, unknown, or unparseable.",
    usage: "yolo ship specs/prd.json --json",
  }),
  stableCommand({
    name: "status",
    lifecycle_stage: "idea",
    workflow: "doctor",
    description: "Read YOLO project state and report the only safe next action.",
    argumentHint: "[--cwd <dir>] [--json]",
    objective: "Inspect lifecycle state, command registry health, and current blockers without changing files; return one safe next command.",
    mode: "status",
    aliases: ["yolo status", "yolo-status"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Read-only. Do not advance lifecycle, generate downstream artifacts, or modify source files.",
    usage: "yolo status --json",
  }),
  internalCommand({
    name: "spec",
    alias_for: "auto",
    deprecation_target: "auto",
    lifecycle_stage: "prd",
    workflow: "prd",
    description: "Compile approved demand, discovery, or plan artifacts into an executable PRD/spec.",
    argumentHint: "[--discovery <discovery.json>|--demand <session.json|dir>] [--output <prd.json>] [--json]",
    objective: "Generate or validate an executable spec with atomic tasks, preconditions, postconditions, acceptance checks, and traceability.",
    mode: "prd",
    aliases: ["yolo spec", "yolo-spec"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Spec-generation only. Stop after spec artifacts and next-stage recommendation. Block when requirements, task scope, acceptance checks, or traceability are weak.",
    usage: "yolo spec --demand .yolo/demand/DEMAND-123/session.json --output specs/prd.json",
  }),
  internalCommand({
    name: "tasks",
    alias_for: "auto",
    deprecation_target: "auto",
    lifecycle_stage: "roadmap",
    workflow: "plan",
    description: "Split clarified demand or discovery into task-ready implementation steps without changing code.",
    argumentHint: "[--discovery <discovery.json>] [--json]",
    objective: "Produce ordered, atomic task planning with scope, risk, gate, and handoff information before execution.",
    mode: "tasks",
    aliases: ["yolo tasks", "yolo-tasks"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Planning/task-breakdown only. Do not modify source files, configs, migrations, or tests.",
    usage: "yolo tasks --discovery .yolo/discovery/discovery.json --json",
  }),
  internalCommand({
    name: "run",
    alias_for: "auto",
    deprecation_target: "auto",
    lifecycle_stage: "run",
    workflow: "pi",
    description: "Execute an approved and checked PRD/task through the YOLO harness.",
    argumentHint: "<approved PRD path> [--dry-run] [--executor claude|codex|custom|auto] [--json]",
    objective: "Execute an already checked PRD through implementation, review hooks, gates, and evidence capture.",
    mode: "run",
    aliases: ["yolo run", "yolo-run"],
    writes_code: true,
    requires_confirmation: true,
    safety: "Requires explicit user confirmation and a checked PRD. Stop on any gate failure.",
    usage: "yolo run specs/prd-low-stock-alert.json --dry-run --json",
  }),
  internalCommand({
    name: "check",
    alias_for: "auto",
    deprecation_target: "auto",
    lifecycle_stage: "check",
    workflow: "check",
    description: "Validate spec, product readiness, adapter readiness, tests, and execution gates before edits.",
    argumentHint: "<PRD path, plan path, or project path> [--strict|--release] [--json]",
    objective: "Run YOLO readiness checks, PRD/preflight validation, product readiness, adapter readiness, and gate analysis before implementation.",
    mode: "check",
    aliases: ["yolo check", "yolo-check"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Validation-only. Stop after readiness report and next-stage recommendation. Report blockers instead of pushing through weak specs.",
    usage: "yolo check specs/prd-low-stock-alert.json --strict --json",
  }),
  internalCommand({
    name: "review",
    alias_for: "auto",
    deprecation_target: "auto",
    lifecycle_stage: "review-fix",
    workflow: "review",
    description: "Review implementation quality and produce scoped findings or fix tasks.",
    argumentHint: "[changed files, PRD path, or review scope] [--json]",
    objective: "Review scoped code against the PRD/spec, classify findings, and produce fix tasks or blockers.",
    mode: "review",
    aliases: ["yolo review", "yolo-review"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Review first. Do not auto-fix unless the user explicitly asks for execution through yolo auto after checks pass.",
    usage: "yolo review src/inventory/alerts.ts --json",
  }),
  internalCommand({
    name: "release",
    alias_for: "ship",
    deprecation_target: "ship",
    lifecycle_stage: "delivery",
    workflow: "ship",
    description: "Run acceptance, package, dogfood, public SDK, and release-candidate gates without publishing.",
    argumentHint: "[candidate|accept|ship] [--mode rc|publish] [--dry-run] [--json]",
    objective: "Fail closed before any release claim on weak spec, broken gates, missing evidence, package smoke gaps, dogfood gaps, or open findings.",
    mode: "release",
    aliases: ["yolo release", "yolo-release"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Do not publish, deploy, tag, or mark a release ready when any required gate is missing, unknown, or unparseable.",
    usage: "yolo release --mode rc --dry-run --json",
  }),
  internalCommand({
    name: "init",
    alias_for: "status",
    deprecation_target: "status",
    lifecycle_stage: "setup",
    workflow: "doctor",
    description: "Internal setup utility; hidden from default help.",
    argumentHint: "[path] [--name <name>] [--force] [--dry-run] [--json]",
    objective: "Bootstrap YOLO scaffolding for a target project.",
    mode: "init",
    aliases: ["yolo init", "yolo-init"],
    writes_code: false,
    requires_confirmation: true,
    safety: "Only write YOLO project scaffolding. Do not overwrite existing files unless force is explicitly approved.",
    usage: "yolo init . --dry-run --json",
  }),
  internalCommand({
    name: "setup",
    alias_for: "status",
    deprecation_target: "status",
    lifecycle_stage: "setup",
    workflow: "doctor",
    description: "Internal setup utility; hidden from default help.",
    argumentHint: "[path] [--target codex|claude|both] [--scope project|user|both] [--dry-run] [--json]",
    objective: "Classify the target project and safely install missing YOLO scaffolding.",
    mode: "setup",
    aliases: ["yolo setup", "yolo-setup"],
    writes_code: false,
    requires_confirmation: true,
    safety: "Setup may write YOLO scaffolding and agent bridge files, but must not overwrite existing files by default.",
    usage: "yolo setup . --dry-run --json",
  }),
  internalCommand({
    name: "install",
    alias_for: "status",
    deprecation_target: "status",
    lifecycle_stage: "setup",
    workflow: "doctor",
    description: "Internal install utility; hidden from default help.",
    argumentHint: "[path] [--target codex|claude|both] [--scope project|user|both] [--dry-run] [--json]",
    objective: "Install YOLO bridge instructions, native skills, workflow descriptors, and command files.",
    mode: "install",
    aliases: ["yolo install", "yolo-install"],
    writes_code: false,
    requires_confirmation: true,
    safety: "Explain files that will be written before changing project or user-level agent directories.",
    usage: "yolo install . --dry-run --json",
  }),
  internalCommand({
    name: "doctor",
    alias_for: "status",
    deprecation_target: "status",
    lifecycle_stage: "idea",
    workflow: "doctor",
    description: "Internal diagnostic utility; hidden from default help.",
    argumentHint: "[path] [--json]",
    objective: "Inspect YOLO project state, lifecycle files, command registry, and agent integration readiness.",
    mode: "doctor",
    aliases: ["yolo doctor", "yolo-doctor"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Inspect-only. Do not install, edit, publish, or execute providers.",
    usage: "yolo doctor . --json",
  }),
  internalCommand({
    name: "eval",
    alias_for: "auto",
    deprecation_target: "auto",
    lifecycle_stage: "check",
    workflow: "eval",
    description: "Internal benchmark/eval workflow; hidden from default help.",
    argumentHint: "[--results <benchmark-results.json>] [--baseline <report.json>] [--json]",
    objective: "Score YOLO quality against benchmark fixtures before public readiness claims.",
    mode: "eval",
    aliases: ["yolo eval", "yolo-eval"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Evaluation-only. Do not fabricate results; fail closed when benchmark evidence is missing.",
    usage: "yolo eval --json",
  }),
  internalCommand({
    name: "runner",
    alias_for: "auto",
    deprecation_target: "auto",
    lifecycle_stage: "run",
    workflow: "fix",
    description: "Internal engine-only runner; hidden from default help.",
    argumentHint: "<PRD path> [--dry-run] [--json]",
    objective: "Debug the lower-level runner behind yolo auto.",
    mode: "runner",
    aliases: ["yolo runner", "yolo-runner"],
    writes_code: true,
    requires_confirmation: true,
    safety: "Engine-only. Prefer yolo auto unless debugging runner internals.",
    usage: "yolo runner specs/prd.json --dry-run --json",
  }),
  internalCommand({
    name: "progress-ui-evidence",
    alias_for: "ship",
    deprecation_target: "ship",
    lifecycle_stage: "acceptance",
    workflow: "accept",
    description: "Internal UI evidence helper; hidden from default help.",
    argumentHint: "[path] [--output <file>] [--json]",
    objective: "Generate progress dashboard UI/UX evidence for acceptance flows.",
    mode: "progress-ui-evidence",
    aliases: ["ui-evidence", "yolo ui-evidence", "yolo progress-ui-evidence"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Evidence-only. Do not edit UI code.",
    usage: "yolo progress-ui-evidence . --json",
  }),
  internalCommand({
    name: "memory",
    alias_for: "status",
    deprecation_target: "status",
    lifecycle_stage: "learn",
    workflow: "learn",
    description: "Internal memory maintenance utility; hidden from default help.",
    argumentHint: "refresh [path] [--dry-run] [--json]",
    objective: "Refresh YOLO memory center and bounded learning artifacts.",
    mode: "memory",
    aliases: ["yolo memory", "yolo-memory"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Memory-only. Do not alter business source files.",
    usage: "yolo memory refresh . --dry-run --json",
  }),
  internalCommand({
    name: "learn",
    alias_for: "ship",
    deprecation_target: "ship",
    lifecycle_stage: "learn",
    workflow: "learn",
    description: "Internal learning workflow; hidden from default help.",
    argumentHint: "[lesson] [--json]",
    objective: "Promote useful lessons, pitfalls, and recovery patterns into bounded YOLO memory.",
    mode: "learn",
    aliases: ["yolo learn", "yolo-learn"],
    writes_code: false,
    requires_confirmation: false,
    safety: "Learning-only. Advisory lessons must not become blocking gates until repeated and machine-verifiable.",
    usage: "yolo learn \"记录这次踩坑\" --json",
  }),
];

export const DEFAULT_YOLO_COMMAND_NAMES = [...DEFAULT_YOLO_PUBLIC_COMMAND_NAMES];
export const ALL_YOLO_COMMAND_NAMES = YOLO_COMMANDS.map((command) => command.name);
export const DEFAULT_YOLO_BRIDGE_WORKFLOW_IDS = [
  "brainstorm",
  "demand",
  "interview",
  "discover",
  "discuss",
  "plan",
  "prd",
  "check",
  "pi",
  "review",
  "fix",
  "accept",
  "eval",
  "ship",
  "learn",
  "doctor",
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeCommandName(name = "") {
  return clean(name)
    .replace(/^\//, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function commandMatches(command, normalizedName) {
  if (normalizeCommandName(command.name) === normalizedName) return true;
  return (command.aliases || []).some((alias) => normalizeCommandName(alias) === normalizedName);
}

export function listYoloCommands(options = Object()) {
  const commands = YOLO_COMMANDS.map(clone);
  if (options.all === true || options.includeHidden === true || options.include_hidden === true) return commands;
  if (options.stable === true || options.defaultSurface === true || options.default_surface === true || options.recommended === true || options.recommended_only === true) {
    return commands.filter((command) => command.stability === "stable" && command.visibility === "default");
  }
  if (options.compatibilityAliases === true || options.compatibility_aliases === true || options.compat === true) {
    return commands.filter((command) => command.stability === "compat");
  }
  if (options.internal === true) {
    return commands.filter((command) => command.stability === "internal");
  }
  if (options.visibility) {
    return commands.filter((command) => command.visibility === options.visibility);
  }
  if (options.stability) {
    return commands.filter((command) => command.stability === options.stability);
  }
  if (options.surface) {
    return commands.filter((command) => command.surface === options.surface);
  }
  if (options.writesCode === true || options.writes_code === true) {
    return commands.filter((command) => command.writes_code === true);
  }
  if (options.noCode === true || options.no_code === true) {
    return commands.filter((command) => command.writes_code !== true);
  }
  return commands.filter((command) => command.stability === "stable" && command.visibility === "default");
}

export function listYoloCommandNames(options = Object()) {
  return listYoloCommands(options).map((command) => command.name);
}

export function getYoloCommand(name = "status") {
  const commandName = normalizeCommandName(name);
  const command = YOLO_COMMANDS.find((item) => commandMatches(item, commandName));
  if (!command) {
    throw new Error(`Unknown YOLO command "${name}". Available stable commands: ${DEFAULT_YOLO_COMMAND_NAMES.join(", ")}`);
  }
  return clone(command);
}

export function renderYoloCommandUsage(commandInput) {
  const command = typeof commandInput === "string" ? getYoloCommand(commandInput) : getYoloCommand(commandInput.name);
  return command.usage;
}

export function listYoloBridgeWorkflowIds() {
  return [...DEFAULT_YOLO_BRIDGE_WORKFLOW_IDS];
}

function collisionRows(commands = YOLO_COMMANDS) {
  const seen = new Map();
  const collisions = [];
  for (const command of commands) {
    for (const raw of [command.name, ...(command.aliases || [])]) {
      const key = normalizeCommandName(raw);
      if (!key) continue;
      const existing = seen.get(key);
      if (existing) {
        collisions.push({ key, first: existing, second: command.name });
      } else {
        seen.set(key, command.name);
      }
    }
  }
  return collisions;
}

export function inspectYoloCommandRegistry(registry = buildYoloCommandRegistry()) {
  const commands = registry.all_commands || registry.commands || [];
  const stable = commands.filter((command) => command.stability === "stable" && command.visibility === "default");
  const nonStable = commands.filter((command) => command.stability !== "stable");
  const errors = [];
  const warnings = [];
  const collisions = collisionRows(commands);

  if (registry.schema !== YOLO_COMMAND_REGISTRY_SCHEMA) {
    errors.push({ code: "COMMAND_REGISTRY_SCHEMA_MISMATCH", message: "command registry schema is not supported" });
  }
  if (stable.length > YOLO_COMMAND_SURFACE_BUDGET) {
    errors.push({ code: "COMMAND_SURFACE_BUDGET_EXCEEDED", count: stable.length, budget: YOLO_COMMAND_SURFACE_BUDGET });
  }
  if (stable.map((command) => command.name).join("\n") !== DEFAULT_YOLO_PUBLIC_COMMAND_NAMES.join("\n")) {
    errors.push({ code: "COMMAND_SURFACE_ORDER_CHANGED", expected: DEFAULT_YOLO_PUBLIC_COMMAND_NAMES, actual: stable.map((command) => command.name) });
  }
  if (collisions.length > 0) {
    errors.push({ code: "COMMAND_ALIAS_COLLISION", collisions });
  }
  for (const command of nonStable) {
    if (!command.alias_for) {
      errors.push({ code: "COMMAND_ALIAS_FOR_MISSING", command: command.name });
    }
    if (!["compat", "internal"].includes(command.stability)) {
      errors.push({ code: "COMMAND_STABILITY_INVALID", command: command.name, stability: command.stability });
    }
    if (command.visibility !== "hidden") {
      errors.push({ code: "COMMAND_VISIBILITY_INVALID", command: command.name, visibility: command.visibility });
    }
  }
  for (const command of stable) {
    if (command.visibility !== "default") {
      warnings.push({ code: "STABLE_COMMAND_NOT_DEFAULT_VISIBLE", command: command.name });
    }
  }

  return {
    status: errors.length > 0 ? "blocked" : (warnings.length > 0 ? "warning" : "pass"),
    valid: errors.length === 0,
    surface_budget: YOLO_COMMAND_SURFACE_BUDGET,
    stable_count: stable.length,
    stable_commands: stable.map((command) => command.name),
    compat_count: commands.filter((command) => command.stability === "compat").length,
    internal_count: commands.filter((command) => command.stability === "internal").length,
    collisions,
    errors,
    warnings,
  };
}

export function buildYoloCommandRegistry() {
  const commands = listYoloCommands({ defaultSurface: true });
  const allCommands = YOLO_COMMANDS.map(clone);
  return {
    schema_version: YOLO_COMMAND_REGISTRY_SCHEMA_VERSION,
    schema: YOLO_COMMAND_REGISTRY_SCHEMA,
    surface_budget: YOLO_COMMAND_SURFACE_BUDGET,
    default_surface: DEFAULT_YOLO_PUBLIC_COMMAND_NAMES.map((name) => getYoloCommand(name)),
    commands,
    all_commands: allCommands,
    compatibility_aliases: listYoloCommands({ compatibilityAliases: true }),
    internal_commands: listYoloCommands({ internal: true }),
    workflows: listYoloBridgeWorkflowIds(),
  };
}

export function validateCommandLifecycleStageAlignment() {
  const validStageIds = lifecycleStageIds();
  const violations = [];

  for (const command of YOLO_COMMANDS) {
    if (!validStageIds.includes(command.lifecycle_stage)) {
      violations.push({
        command: command.name,
        lifecycle_stage: command.lifecycle_stage,
        message: `lifecycle_stage "${command.lifecycle_stage}" is not a valid lifecycle stage ID`,
      });
    }
  }

  const commandStageIds = new Set(YOLO_COMMANDS.map((c) => c.lifecycle_stage));
  const uncoveredStages = validStageIds.filter((id) => !commandStageIds.has(id));

  return {
    valid: violations.length === 0,
    violations,
    uncovered_stages: uncoveredStages,
    covered_stages: validStageIds.filter((id) => commandStageIds.has(id)),
    total_commands: YOLO_COMMANDS.length,
    total_stages: validStageIds.length,
  };
}
