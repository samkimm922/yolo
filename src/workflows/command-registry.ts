export const YOLO_COMMAND_REGISTRY_SCHEMA_VERSION = "1.0";
export const YOLO_COMMAND_REGISTRY_SCHEMA = "yolo.workflow.command_registry.v1";

export const YOLO_COMMANDS = [
  {
    name: "yolo",
    lifecycle_stage: "idea",
    workflow: "pi",
    description: "Route a plain-language request to the safest YOLO workflow in Codex or Claude Code.",
    argumentHint: "<requirement, PRD path, or what you want YOLO to do>",
    objective: "Act as the YOLO dispatcher. Use yolo-next when lifecycle state is unclear, otherwise pick brainstorm, interview, discuss, discover, plan, PRD, check, run, review, accept, ship, learn, doctor, or install based on the user's intent; default to no-code discovery or plan when intent is ambiguous.",
    mode: "dispatch",
    writes_code: false,
    requires_confirmation: false,
    safety: "Do not edit code unless the user explicitly asks to execute with /yolo-run or /yolo-fix and the PRD/preflight is ready.",
    usage: "/yolo 增加低库存预警，先判断应该走发现、计划、检查还是执行",
  },
  {
    name: "yolo-brainstorm",
    lifecycle_stage: "idea",
    workflow: "brainstorm",
    description: "Compatibility alias for /yolo-demand --stage brainstorm; explores an early idea before discovery.",
    argumentHint: "<plain-language idea>",
    objective: "Create a demand artifact pack with VISION, REFLECTION, INVESTIGATION, initial REQUIREMENTS, CONTEXT, ROADMAP, and readiness gaps without writing business code.",
    mode: "brainstorm",
    alias_for: "yolo-demand",
    demand_stage: "brainstorm",
    visibility: "compatibility_alias",
    writes_code: false,
    requires_confirmation: false,
    safety: "Brainstorm-only. Stop after brainstorm artifacts and next-stage recommendation. Do not generate executable PRD or modify source files.",
    usage: "/yolo-brainstorm 我想做一个库存预警产品，但还没确定用户和切入口",
  },
  {
    name: "yolo-demand",
    lifecycle_stage: "idea",
    workflow: "demand",
    description: "Unified demand-stage interview host: route brainstorm, interview, discovery, discussion, evidence dispatch, and PRD readiness while defaulting to one-question clarification.",
    argumentHint: "[--stage brainstorm|interview|discover|discuss|prd|status|dispatch|evidence] <idea or --demand session.json>",
    objective: "Act as the YOLO demand interview facilitator, not a general advice agent. Run one user-facing conversation that routes internally between brainstorm, interview, discovery, discussion, status, evidence dispatch, and PRD readiness; default to one-question mode. When required slots are missing, ask exactly one next_question in plain language, stop, and wait for the answer. Do not output long recommendation lists, do not enter PRD, keep assumptions separate from verified facts, require project evidence for factual claims, cross-check risky facts, and only recommend the next stage after the demand slots are complete.",
    mode: "demand",
    recommended: true,
    writes_code: false,
    requires_confirmation: false,
    safety: "Demand-stage only. 不改代码, do not edit business code, and do not compile executable PRD in the same turn. 缺槽位时只返回一个 next_question, 不输出大段建议, 不进入 PRD. 批准最后: demand approval is collected only after required slots are concrete, and execution authorization is separate. Evidence dispatch defaults to dry-run and only executes provider agents with explicit --execute-agents --allow-agent-dispatch; agent tools stay capable, while harness boundary audits block any target-project mutation outside evidence artifacts.",
    usage: "/yolo-demand 我想把库存预警需求聊清楚；缺槽位时请 one-question 只问一个 next_question，暂时不要生成 PRD，不改代码；/yolo-demand --stage dispatch --execute-agents --allow-agent-dispatch 执行 evidence agents",
  },
  {
    name: "yolo-interview",
    lifecycle_stage: "discovery",
    workflow: "interview",
    description: "Compatibility alias for /yolo-demand --stage interview; uses the same one-question demand interview host contract.",
    argumentHint: "<plain-language idea, interview session, or answer>",
    objective: "Use the unified /yolo-demand protocol in interview mode. Collect non-technical answers one question at a time, return exactly one next_question when slots are missing, track coverage, preserve question/answer handoff state, and convert the interview into demand artifacts only when enough facts are present.",
    mode: "interview",
    alias_for: "yolo-demand",
    demand_stage: "interview",
    visibility: "compatibility_alias",
    writes_code: false,
    requires_confirmation: false,
    safety: "Interview-only. Ask one clear question at a time, preserve answers, stop with handoff state, 不输出大段建议, 不进入 PRD, 不改代码. 批准最后; converting or approving interview output is not execution authorization.",
    usage: "/yolo-interview 我想做库存预警，请 one-question 一问一答把需求问清楚；缺槽位时只返回一个 next_question，不改代码",
  },
  {
    name: "yolo-discover",
    lifecycle_stage: "discovery",
    workflow: "discover",
    description: "Compatibility alias for /yolo-demand --stage discover; clarifies a vague requirement before planning.",
    argumentHint: "<plain-language idea or unclear requirement>",
    objective: "Create a discovery brief with problem, target user, success criteria, constraints, unknowns, risks, and whether the idea is ready for PRD.",
    mode: "discover",
    alias_for: "yolo-demand",
    demand_stage: "discover",
    visibility: "compatibility_alias",
    writes_code: false,
    requires_confirmation: false,
    safety: "Discovery-only. Stop after discovery readiness and next-stage recommendation. Do not create executable tasks or modify source files.",
    usage: "/yolo-discover 我想给库存系统做一个预警能力，但细节还不清楚",
  },
  {
    name: "yolo-discuss",
    lifecycle_stage: "discovery",
    workflow: "discuss",
    description: "Compatibility alias for /yolo-demand --stage discuss; runs a deeper demand discussion loop before PRD.",
    argumentHint: "<idea or demand session>",
    objective: "Close vision, reflection, investigation, questioning rounds, depth verification, requirements confirmation, and approval into REQUIREMENTS.md, CONTEXT.md, ROADMAP.md, and APPROVAL.json.",
    mode: "discuss",
    alias_for: "yolo-demand",
    demand_stage: "discuss",
    visibility: "compatibility_alias",
    writes_code: false,
    requires_confirmation: false,
    safety: "Discussion-only. Stop after requirements/context/roadmap/approval artifacts. Do not compile executable PRD until a later PRD stage is explicitly selected.",
    usage: "/yolo-discuss 库存预警需求，继续追问灰区并确认 REQUIREMENTS/CONTEXT/ROADMAP",
  },
  {
    name: "yolo-init",
    lifecycle_stage: "setup",
    workflow: "doctor",
    description: "Initialize YOLO project memory, lifecycle, specs, and governance files.",
    argumentHint: "<project path or project name>",
    objective: "Bootstrap the target project with .yolo lifecycle, memory, state ledgers, templates, and specs without touching application code.",
    mode: "init",
    writes_code: false,
    requires_confirmation: true,
    safety: "Only write YOLO project scaffolding. Do not overwrite existing files unless force is explicitly approved.",
    usage: "/yolo-init 当前项目，生成 YOLO 记忆和生命周期骨架",
  },
  {
    name: "yolo-setup",
    lifecycle_stage: "setup",
    workflow: "doctor",
    description: "Safely set up YOLO for a new, partial, or already-initialized project.",
    argumentHint: "<project path>",
    objective: "Classify the target project, initialize only missing YOLO scaffolding, install project-scope Codex/Claude entrypoints, run doctor, and report remaining factual gaps without inventing project context.",
    mode: "setup",
    writes_code: false,
    requires_confirmation: true,
    safety: "Setup may write YOLO scaffolding and agent bridge files, but must not overwrite existing files by default or generate business-status onboarding content.",
    usage: "/yolo-setup 当前项目，自动判断项目状态并安全安装 YOLO",
  },
  {
    name: "yolo-plan",
    lifecycle_stage: "roadmap",
    workflow: "plan",
    description: "Turn a clarified requirement into an implementation plan without changing code.",
    argumentHint: "<plain-language requirement>",
    objective: "Create or inspect a YOLO implementation plan from the user's requirement; route back to discovery when the requirement is too vague.",
    mode: "plan",
    writes_code: false,
    requires_confirmation: false,
    safety: "Plan-only. Stop after plan artifacts and next-stage recommendation. Do not modify source files, configs, migrations, or tests.",
    usage: "/yolo-plan 我要给库存系统增加低库存预警",
  },
  {
    name: "yolo-prd",
    lifecycle_stage: "prd",
    workflow: "prd",
    description: "Compile approved discovery and plan artifacts into an executable PRD/spec.",
    argumentHint: "<approved plan, discovery brief, or PRD draft path>",
    objective: "Generate or validate an executable PRD with atomic tasks, preconditions, postconditions, acceptance checks, and traceability.",
    mode: "prd",
    writes_code: false,
    requires_confirmation: false,
    safety: "Spec-generation only. Stop after PRD/spec artifacts and next-stage recommendation. Block when requirements, task scope, acceptance checks, or traceability are weak.",
    usage: "/yolo-prd 把这个已确认计划转成可执行 PRD",
  },
  {
    name: "yolo-check",
    lifecycle_stage: "check",
    workflow: "check",
    description: "Check whether a PRD, plan, or project state is ready to execute.",
    argumentHint: "<PRD path, plan path, or project path>",
    objective: "Run YOLO readiness checks, PRD/preflight validation, product readiness, adapter readiness, and gate analysis before implementation.",
    mode: "check",
    writes_code: false,
    requires_confirmation: false,
    safety: "Validation-only. Stop after readiness report and next-stage recommendation. Report blockers instead of pushing through weak specs.",
    usage: "/yolo-check specs/prd-low-stock-alert.json",
  },
  {
    name: "yolo-next",
    lifecycle_stage: "check",
    workflow: "doctor",
    description: "Inspect YOLO lifecycle state and report the only safe next stage without changing code.",
    argumentHint: "<project path or current project>",
    objective: "Read .yolo/lifecycle/status.json, enforce lifecycle guard boundaries, and recommend the next allowed /yolo-* command instead of letting the agent jump stages.",
    mode: "next",
    writes_code: false,
    requires_confirmation: false,
    safety: "Read-only. Do not advance lifecycle, generate downstream artifacts, or modify source files.",
    usage: "/yolo-next 当前项目应该安全地做哪一步",
  },
  {
    name: "yolo-run",
    lifecycle_stage: "run",
    workflow: "fix",
    description: "Execute an approved and checked YOLO PRD with gates, review, fixes, and evidence.",
    argumentHint: "<approved PRD path>",
    objective: "Execute an already checked PRD through YOLO implementation, review, fix, and final gate flow.",
    mode: "run",
    writes_code: true,
    requires_confirmation: true,
    safety: "Requires explicit user confirmation and a checked PRD. Stop on any gate failure.",
    usage: "/yolo-run 我确认执行 specs/prd-low-stock-alert.json",
  },
  {
    name: "yolo-review",
    lifecycle_stage: "review-fix",
    workflow: "review",
    description: "Review implementation quality and produce scoped fix tasks.",
    argumentHint: "<changed files, PRD path, or review scope>",
    objective: "Review scoped code against the PRD/spec, classify findings, and produce fix tasks or blockers.",
    mode: "review",
    writes_code: false,
    requires_confirmation: false,
    safety: "Review first. Do not auto-fix unless the user explicitly asks for fixes.",
    usage: "/yolo-review 按 PRD 检查这次改动",
  },
  {
    name: "yolo-fix",
    lifecycle_stage: "review-fix",
    workflow: "fix",
    description: "Apply approved fix tasks from review findings with gates and evidence.",
    argumentHint: "<approved fix task, PRD path, or review finding path>",
    objective: "Execute scoped fixes for approved review findings, then rerun the relevant gates and evidence capture.",
    mode: "fix",
    writes_code: true,
    requires_confirmation: true,
    safety: "Requires explicit approval of fix scope. Do not widen the diff beyond the listed findings.",
    usage: "/yolo-fix 我确认修复 review 报告里的阻塞项",
  },
  {
    name: "yolo-accept",
    lifecycle_stage: "acceptance",
    workflow: "accept",
    description: "Collect acceptance evidence after implementation and review/fix loops.",
    argumentHint: "<PRD path, acceptance manifest, or implemented feature>",
    objective: "Verify product acceptance criteria, runtime evidence, UI/accessibility/visual evidence when relevant, and unresolved blocker state.",
    mode: "accept",
    writes_code: false,
    requires_confirmation: false,
    safety: "Evidence-only. Do not mark accepted when required product or UI evidence is missing.",
    usage: "/yolo-accept 检查这个功能是否达到验收标准",
  },
  {
    name: "yolo-ui-review",
    lifecycle_stage: "acceptance",
    workflow: "accept",
    description: "Review UI readiness, accessibility, runtime errors, and visual evidence for frontend tasks.",
    argumentHint: "<URL, PRD path, or UI surface>",
    objective: "Collect UI-specific acceptance evidence including state coverage, runtime errors, accessibility, and visual review notes.",
    mode: "ui-review",
    writes_code: false,
    requires_confirmation: false,
    safety: "Review-only. Do not edit UI code unless the user explicitly asks for a fix task.",
    usage: "/yolo-ui-review 检查这个页面是否符合 PRD 和 UI 验收",
  },
  {
    name: "yolo-eval",
    lifecycle_stage: "check",
    workflow: "eval",
    description: "Run YOLO benchmark fixtures and rubric scoring before public readiness claims.",
    argumentHint: "<benchmark results path or release evidence>",
    objective: "Score discovery, PRD, UI acceptance, evidence, runner compatibility, and non-technical command quality against fixed benchmark fixtures.",
    mode: "eval",
    writes_code: false,
    requires_confirmation: false,
    safety: "Evaluation-only. Do not fabricate results; fail closed when benchmark evidence is missing or below threshold.",
    usage: "/yolo-eval 用 benchmark 结果检查 YOLO 质量是否达到公开准备度",
  },
  {
    name: "yolo-ship",
    lifecycle_stage: "delivery",
    workflow: "ship",
    description: "Fail closed before release on weak spec, broken gates, missing evidence, or open findings.",
    argumentHint: "<PRD path, run id, or release scope>",
    objective: "Produce a ship/no-ship verdict with release evidence, remaining blockers, rollback notes, and handoff paths.",
    mode: "ship",
    writes_code: false,
    requires_confirmation: false,
    safety: "Do not publish, deploy, or tag a release; only report readiness unless separately authorized.",
    usage: "/yolo-ship 判断这个功能是否可以交付",
  },
  {
    name: "yolo-learn",
    lifecycle_stage: "learn",
    workflow: "learn",
    description: "Promote useful lessons, pitfalls, and recovery patterns into YOLO memory.",
    argumentHint: "<run report, review report, failure, or lesson>",
    objective: "Record reusable lessons in bounded model-agnostic memory and avoid injecting unrelated context into future prompts.",
    mode: "learn",
    writes_code: false,
    requires_confirmation: false,
    safety: "Learning-only. Advisory lessons must not become blocking gates until repeated and machine-verifiable.",
    usage: "/yolo-learn 记录这次踩坑，之后遇到类似问题提醒我",
  },
  {
    name: "yolo-doctor",
    lifecycle_stage: "check",
    workflow: "doctor",
    description: "Inspect YOLO project state, lifecycle files, command registry, and agent integration readiness.",
    argumentHint: "<project path or install scope>",
    objective: "Explain whether YOLO is initialized and integrated in this project, what is missing, and what the next safe action is.",
    mode: "doctor",
    writes_code: false,
    requires_confirmation: false,
    safety: "Inspect-only. Do not install, edit, publish, or execute providers.",
    usage: "/yolo-doctor 检查当前项目的 YOLO 是否装好、能不能用",
  },
  {
    name: "yolo-install",
    lifecycle_stage: "setup",
    workflow: "doctor",
    description: "Install or update YOLO agent skills and commands into the current project or user agent environment.",
    argumentHint: "<project path or install scope>",
    objective: "Install YOLO bridge instructions, native skills, workflow descriptors, and command files so the user can call YOLO from chat.",
    mode: "install",
    writes_code: false,
    requires_confirmation: true,
    safety: "Explain the files that will be written before changing project or user-level agent directories.",
    usage: "/yolo-install 把 YOLO 装到当前项目和 Claude/Codex",
  },
];

export const DEFAULT_YOLO_COMMAND_NAMES = YOLO_COMMANDS.map((command) => command.name);
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
  return clean(name).replace(/^\//, "").toLowerCase();
}

export function listYoloCommands(options = {}) {
  const commands = YOLO_COMMANDS.map(clone);
  if (options.recommended === true || options.recommended_only === true) {
    return commands.filter((command) => command.visibility !== "compatibility_alias");
  }
  if (options.compatibilityAliases === true || options.compatibility_aliases === true) {
    return commands.filter((command) => command.visibility === "compatibility_alias");
  }
  if (options.writesCode === true || options.writes_code === true) {
    return commands.filter((command) => command.writes_code === true);
  }
  if (options.noCode === true || options.no_code === true) {
    return commands.filter((command) => command.writes_code !== true);
  }
  return commands;
}

export function listYoloCommandNames(options = {}) {
  return listYoloCommands(options).map((command) => command.name);
}

export function getYoloCommand(name = "yolo") {
  const commandName = normalizeCommandName(name);
  const command = YOLO_COMMANDS.find((item) => item.name === commandName);
  if (!command) {
    throw new Error(`Unknown YOLO command "${name}". Available commands: ${DEFAULT_YOLO_COMMAND_NAMES.join(", ")}`);
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

export function buildYoloCommandRegistry() {
  return {
    schema_version: YOLO_COMMAND_REGISTRY_SCHEMA_VERSION,
    schema: YOLO_COMMAND_REGISTRY_SCHEMA,
    commands: listYoloCommands(),
    workflows: listYoloBridgeWorkflowIds(),
  };
}
