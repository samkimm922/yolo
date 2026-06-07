import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { buildLifecycleStateFiles } from "../lifecycle/state.js";
import { appendSessionMemory } from "../runtime/evidence/session-memory.js";
import { refreshMemoryCenter } from "../runtime/memory/center.js";

export const PROJECT_BOOTSTRAP_SCHEMA_VERSION = "1.0";

function normalizeProjectName(projectRoot, projectName) {
  const fallback = basename(projectRoot) || "project";
  return String(projectName || fallback).trim() || fallback;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function projectConfig(projectName) {
  return stableJson({
    schema_version: PROJECT_BOOTSTRAP_SCHEMA_VERSION,
    project: {
      name: projectName,
    },
    paths: {
      specs: "specs",
      lifecycle: ".yolo/lifecycle",
      state: ".yolo/state",
      memory: ".yolo/memory",
      context: ".yolo/context",
      packs: ".yolo/packs",
      adapters: ".yolo/adapters",
      templates: ".yolo/templates",
    },
    policy: {
      model_agnostic: true,
      quality_gate: "fail_closed",
      require_traceability: true,
    },
  });
}

function memoryIndexTemplate(projectName) {
  return [
    `# ${projectName} YOLO Memory`,
    "",
    "This folder is the human-readable memory center for YOLO automation in this project.",
    "",
    "## Start Every New Session",
    "",
    "Read these files before planning or changing code:",
    "",
    "1. `.yolo/context/README.md` for how domain, codebase, decisions, and handoff context work together.",
    "2. `.yolo/memory/CURRENT_HANDOFF.md` for the latest operator handoff and next action.",
    "3. `.yolo/memory/PROJECT_BRIEF.md` for users, surfaces, and product boundaries.",
    "4. `.yolo/memory/PROGRESS.md` for current phase, completed work, and next work.",
    "5. `.yolo/memory/OPEN_QUESTIONS.md` and `.yolo/memory/DECISION_LOG.md` before PRD or implementation decisions.",
    "",
    "## Files",
    "",
    "- `CURRENT_STATUS.md`: current project status, gates, and release/quality state.",
    "- `CURRENT_HANDOFF.md`: handoff notes for the next agent/session.",
    "- `PROJECT_BRIEF.md`: plain-language project purpose, users, surfaces, and boundaries.",
    "- `PROGRESS.md`: current phase, recent work, next work, and evidence expectations.",
    "- `PRD_PIPELINE.md`: idea to acceptance relay process and stage outputs.",
    "- `TASK_ATOMICITY.md`: plain-language rules for one-task-one-session work breakdown.",
    "- `OPEN_QUESTIONS.md`: unresolved product or execution questions.",
    "- `DECISION_LOG.md`: durable product and technical decisions.",
    "- `DOCUMENT_GOVERNANCE.md`: canonical document homes, naming rules, and anti-sprawl policy.",
    "- `PROJECT_TREE.md`: generated project structure snapshot.",
    "- `MEMORY_AUDIT.md`: classification of memory-related `.md` and `.jsonl` files.",
    "- `LEARNING_INDEX.md`: model-agnostic learning ledger summary.",
    "- `LESSONS_PLAYBOOK.md`: human-readable pitfalls and prevention notes.",
    "- `.yolo/lifecycle/status.json`: lifecycle state from idea to delivery and learning.",
    "",
    "## Machine Ledgers",
    "",
    "- `.yolo/state/changes.jsonl`: task plans, starts, completions, and file-change records.",
    "- `.yolo/state/events.jsonl`: runtime/manual events.",
    "- `.yolo/state/runs.jsonl`: run lifecycle records.",
    "- `.yolo/state/learning.jsonl`: lessons, pitfalls, rules, and recovery records.",
    "- `.yolo/state/session-memory.jsonl`: runner checkpoints and handoff memory.",
    "- `.yolo/state/questions.jsonl`: demand interview questions and answers.",
    "- `.yolo/state/decisions.jsonl`: structured product and technical decisions.",
    "- `.yolo/state/artifacts.jsonl`: generated artifacts and trace links.",
    "",
    "## PRD Intake",
    "",
    "- Use `.yolo/templates/prd-intake.md` for non-technical input before `/yolo-brainstorm`, `/yolo-interview`, `/yolo-discuss`, or `/yolo-prd`.",
    "- Use `PRD_PIPELINE.md` to keep idea, interview, brainstorm, discuss, PRD, check, run, and accept stages connected.",
    "- Use `TASK_ATOMICITY.md` before task generation so each task has scope, acceptance, evidence, and handoff notes.",
    "",
  ].join("\n");
}

function memoryStatusTemplate(projectName) {
  return [
    `# ${projectName} Current Status`,
    "",
    "- YOLO memory center has been initialized.",
    "- Add the first requirement in `specs/requirements.md`.",
    "- Keep lifecycle progress in `.yolo/lifecycle/status.json`.",
    "- Keep implementation evidence linked from `specs/tasks.md`.",
    "- Refresh this folder with `yolo memory refresh` after project structure or task state changes.",
    "",
  ].join("\n");
}

function memoryHandoffTemplate(projectName) {
  return [
    `# ${projectName} Handoff`,
    "",
    "## Read First",
    "",
    "- `.yolo/context/README.md` explains how context files work together.",
    "- `.yolo/memory/PROJECT_BRIEF.md` explains the product, users, surfaces, and boundaries.",
    "- `.yolo/memory/PROGRESS.md` explains current phase, recent work, and next work.",
    "- `.yolo/memory/OPEN_QUESTIONS.md` and `.yolo/memory/DECISION_LOG.md` explain blockers and decisions.",
    "",
    "## Current Context",
    "",
    "- Project memory has been bootstrapped, but no YOLO run has completed yet.",
    "",
    "## Next Operator Action",
    "",
    "- Write the first requirement, convert it into tasks, run gates, and let YOLO append checkpoint records to `.yolo/state/session-memory.jsonl`.",
    "",
    "## Handoff Checklist",
    "",
    "- Scope: name the files, surfaces, or workflows the next session may touch.",
    "- Acceptance: state what must be true for the work to count as done.",
    "- Evidence: list the commands, screenshots, reports, or artifacts that prove the result.",
    "- Carry-forward: record remaining questions, risks, and decisions in the canonical memory files.",
    "",
  ].join("\n");
}

function documentGovernanceTemplate(projectName) {
  return [
    `# ${projectName} Document Governance`,
    "",
    "## Canonical Homes",
    "",
    "- `.yolo/memory/` is the only home for human-readable YOLO operational memory in this project.",
    "- `.yolo/lifecycle/` is the only home for lifecycle stage artifacts and status.",
    "- `.yolo/state/*.jsonl` is the only home for machine-readable YOLO ledgers.",
    "- `.yolo/context/`, `.yolo/packs/`, and `.yolo/adapters/` are the only homes for resolver output, pack manifests, and adapter manifests.",
    "- `specs/` is the project-owned home for requirements, design, and executable task specs.",
    "- Temporary notes belong in `tmp/` and should be promoted or deleted after review.",
    "",
    "## Naming",
    "",
    "- `.yolo/memory/*.md`: `UPPER_SNAKE_CASE.md`.",
    "- Public/reference docs: `lower-kebab-case.md`.",
    "- Ledgers: `.jsonl`; manifests/configs: `.json`.",
    "",
    "## Rule",
    "",
    "Do not create a second source of truth for the same plan, status, handoff, tree, audit, learning, or governance content. Update the canonical file, then run `yolo memory refresh`.",
    "",
  ].join("\n");
}

function memoryTreeTemplate(projectName) {
  return [
    `# ${projectName} Project Tree`,
    "",
    "Project tree will be generated by `yolo memory refresh`.",
    "",
  ].join("\n");
}

function memoryAuditTemplate(projectName) {
  return [
    `# ${projectName} Memory Audit`,
    "",
    "No project-specific memory audit has been generated yet.",
    "",
    "Run `yolo memory refresh` after the first YOLO task or major file-structure change.",
    "",
  ].join("\n");
}

function projectBriefTemplate(projectName) {
  return [
    `# ${projectName} Project Brief`,
    "",
    "## How To Use This File",
    "- Read this before PRD, planning, or implementation work.",
    "- Keep it short enough for a new operator to understand the product in one pass.",
    "- Update it when users, surfaces, business boundaries, or product promises change.",
    "",
    "## Plain-Language Purpose",
    "- TBD: describe what this project helps users do.",
    "",
    "## Primary Users",
    "- TBD",
    "",
    "## Current Product Surface",
    "- TBD: list the main app, page, API, service, or workflow surfaces after the first memory refresh.",
    "",
    "## Operating Notes",
    "- Non-technical ideas should first go through `/yolo-brainstorm`, `/yolo-interview`, or `/yolo-discuss`.",
    "- Executable PRDs should be generated only after scenario matrix and atomic task readiness pass.",
    "- Before task work, read `.yolo/memory/TASK_ATOMICITY.md` and confirm scope, acceptance, evidence, and handoff are explicit.",
    "- Before PRD work, read `.yolo/memory/PRD_PIPELINE.md` and `.yolo/templates/prd-intake.md`.",
    "",
    "## Not In Scope",
    "- TBD: list product promises or work areas this project should not take on yet.",
    "",
    "## Decision Context",
    "- Durable product and architecture decisions belong in `.yolo/memory/DECISION_LOG.md`.",
    "- Structured decision records belong in `.yolo/state/decisions.jsonl`.",
    "- Hard-to-reverse decisions should be promoted to `.yolo/decisions/ADR-*.md`.",
    "",
  ].join("\n");
}

function progressTemplate(projectName) {
  return [
    `# ${projectName} Progress`,
    "",
    "## Session Start Checklist",
    "- Read `.yolo/memory/CURRENT_HANDOFF.md` before continuing work.",
    "- Check `.yolo/memory/OPEN_QUESTIONS.md` for blockers.",
    "- Check `.yolo/memory/DECISION_LOG.md` before changing product or architecture direction.",
    "- Check `.yolo/state/session-memory.jsonl` for recent runner checkpoints when available.",
    "",
    "## Current Phase",
    "- setup",
    "",
    "## Recently Completed",
    "- YOLO project memory initialized.",
    "",
    "## Next",
    "- Capture the first user problem in plain language.",
    "- Convert it into a scenario matrix before generating PRD tasks.",
    "- Fill `.yolo/templates/prd-intake.md` when the request comes from a non-technical user.",
    "",
    "## Evidence To Keep Current",
    "- Link task evidence from `specs/tasks.md`.",
    "- Append handoff checkpoints through `.yolo/state/session-memory.jsonl`.",
    "- Run `yolo memory refresh` after structural, task-state, or evidence changes.",
    "",
  ].join("\n");
}

function prdPipelineTemplate(projectName) {
  return [
    `# ${projectName} PRD Pipeline`,
    "",
    "Use this file to keep product discovery, PRD generation, implementation, and acceptance connected.",
    "",
    "## Relay Flow",
    "",
    "| Stage | Purpose | Main output | Memory home |",
    "|---|---|---|---|",
    "| idea | Capture the raw request in plain language. | Problem statement and initial goal. | `.yolo/lifecycle/idea.json`, `PROJECT_BRIEF.md` |",
    "| interview | Ask for missing facts before planning. | Questions, answers, blockers. | `.yolo/state/questions.jsonl`, `OPEN_QUESTIONS.md` |",
    "| brainstorm | Turn the idea into possible workflows and scenarios. | Scenario matrix and assumptions. | `.yolo/lifecycle/discovery.json`, `PROGRESS.md` |",
    "| discuss | Choose scope, tradeoffs, and non-goals. | Decisions and deferred items. | `DECISION_LOG.md`, `.yolo/state/decisions.jsonl` |",
    "| prd | Create executable requirements and atomic tasks. | PRD plus traceable tasks. | `specs/requirements.md`, `specs/design.md`, `specs/tasks.md` |",
    "| check | Validate readiness before execution. | Gate report, blockers, missing evidence. | `.yolo/lifecycle/check-report.json`, `CURRENT_STATUS.md` |",
    "| run | Execute one atomic task in one focused session. | Code change, logs, task evidence. | `.yolo/state/runs.jsonl`, `.yolo/state/session-memory.jsonl` |",
    "| accept | Confirm the user-visible result. | Acceptance report and final evidence. | `.yolo/lifecycle/acceptance-report.json`, `CURRENT_HANDOFF.md` |",
    "",
    "## Stage Rules",
    "",
    "- Do not skip from idea to run when target users, current pain, success proof, non-goals, or scope are unclear.",
    "- Use `.yolo/templates/prd-intake.md` when the request starts in non-technical language.",
    "- Use `TASK_ATOMICITY.md` before PRD task generation.",
    "- Keep questions in `OPEN_QUESTIONS.md` until answered or explicitly deferred.",
    "- Keep hard-to-reverse choices in `DECISION_LOG.md` and promote them to `.yolo/decisions/ADR-*.md` when needed.",
    "",
    "## Ready For PRD Checklist",
    "",
    "- Target user is named.",
    "- Current situation and pain are explained.",
    "- Desired outcome and success proof are concrete.",
    "- Non-goals and boundaries are explicit.",
    "- MVP is small enough to become atomic tasks.",
    "- Approval path is clear.",
    "",
  ].join("\n");
}

function taskAtomicityTemplate(projectName) {
  return [
    `# ${projectName} Task Atomicity`,
    "",
    "A task should be small enough for one focused session to finish, verify, and hand off without guessing.",
    "",
    "## Plain-Language Rule",
    "",
    "- One task changes one clear outcome for one user-visible workflow or one technical responsibility.",
    "- The next operator should be able to read the task and know exactly what to touch, what done means, how to prove it, and what to hand off.",
    "- If a task needs unrelated files, multiple product decisions, or several acceptance stories, split it.",
    "",
    "## Every Task Must Include",
    "",
    "- Scope: the files, surfaces, APIs, workflows, or docs that may be changed.",
    "- Acceptance: the user-visible or system-visible result that must be true.",
    "- Evidence: the command, report, screenshot, log, or artifact that proves acceptance.",
    "- Handoff: what changed, what remains, what risks exist, and where the next session starts.",
    "",
    "## Good Examples",
    "",
    "- Add low-stock warning copy to the inventory alert email and verify the email snapshot test.",
    "- Add one settings toggle for daily digest emails, including save behavior and one focused UI test.",
    "- Document the current billing retry decision in `DECISION_LOG.md` and link the source discussion.",
    "",
    "## Bad Examples",
    "",
    "- Improve onboarding.",
    "- Refactor the dashboard and fix bugs.",
    "- Build billing.",
    "- Make the app production ready.",
    "",
    "## Split A Task When",
    "",
    "- More than one user workflow changes.",
    "- The acceptance criteria need separate proofs.",
    "- A product decision is still open.",
    "- The implementation needs broad codebase exploration before scope is known.",
    "- Rollback would require undoing unrelated changes.",
    "",
  ].join("\n");
}

function contextReadmeTemplate(projectName) {
  return [
    `# ${projectName} Context Guide`,
    "",
    "Use this folder to help a new session understand the project before it plans, writes a PRD, or changes code.",
    "",
    "## How The Context Fits Together",
    "",
    "- Domain context lives in `.yolo/context/domain/`. It defines users, business terms, workflows, and plain-language meaning.",
    "- Codebase context lives in `.yolo/context/codebase/`. It maps architecture, structure, conventions, testing, dependencies, surfaces, and risk areas.",
    "- Decision context lives in `.yolo/memory/DECISION_LOG.md`, `.yolo/state/decisions.jsonl`, and `.yolo/decisions/ADR-*.md`.",
    "- Session context lives in `.yolo/memory/CURRENT_HANDOFF.md`, `.yolo/memory/PROGRESS.md`, `.yolo/memory/OPEN_QUESTIONS.md`, and `.yolo/state/session-memory.jsonl`.",
    "",
    "## Read Order",
    "",
    "1. Read `.yolo/memory/CURRENT_HANDOFF.md` for the current handoff and next operator action.",
    "2. Read `.yolo/memory/PROJECT_BRIEF.md` for product purpose, users, surfaces, and boundaries.",
    "3. Read `.yolo/memory/PROGRESS.md` for phase, recent work, next work, and evidence expectations.",
    "4. Read `.yolo/memory/OPEN_QUESTIONS.md` and `.yolo/memory/DECISION_LOG.md` before PRD or implementation decisions.",
    "5. Read the relevant files under `.yolo/context/domain/` and `.yolo/context/codebase/` before touching product behavior or code.",
    "",
    "## PRD Work",
    "",
    "- Start with `.yolo/templates/prd-intake.md` when user input is broad or non-technical.",
    "- Use `.yolo/memory/PRD_PIPELINE.md` to move from idea to interview, brainstorm, discuss, PRD, check, run, and accept.",
    "- Use `.yolo/memory/TASK_ATOMICITY.md` before splitting PRD tasks.",
    "",
    "## Update Rule",
    "",
    "- Update domain context when product language or user workflows change.",
    "- Update codebase context when architecture, surfaces, testing, or risk areas change.",
    "- Update decision context when a choice affects future work.",
    "- Update session context at handoff so the next session can continue without re-discovery.",
    "",
  ].join("\n");
}

function prdIntakeTemplate(projectName) {
  return [
    `# ${projectName} PRD Intake`,
    "",
    "Answer in short bullets. Unknown is acceptable, but mark it as unknown instead of guessing.",
    "",
    "## 1. Target Users",
    "- Who needs this?",
    "- What role, team, or customer type are they?",
    "",
    "## 2. Current Situation",
    "- What happens today?",
    "- Where does it happen?",
    "- What tools, screens, documents, or processes are involved?",
    "",
    "## 3. Pain",
    "- What is frustrating, slow, risky, expensive, or unclear?",
    "- How often does it happen?",
    "- Who feels the pain most?",
    "",
    "## 4. Desired Outcome",
    "- What should be easier, faster, safer, or more reliable after this work?",
    "- What should the user be able to do?",
    "",
    "## 5. Success Proof",
    "- How will we know this worked?",
    "- What metric, behavior, example, test, screenshot, or report would prove it?",
    "",
    "## 6. Not Doing",
    "- What should stay out of scope?",
    "- What should not change?",
    "",
    "## 7. Edge Cases",
    "- What unusual users, data, permissions, errors, or environments matter?",
    "- What failure should be handled clearly?",
    "",
    "## 8. MVP",
    "- What is the smallest useful version?",
    "- What can be deferred until later?",
    "",
    "## 9. Approval",
    "- Who can approve the PRD?",
    "- What must they review before implementation starts?",
    "",
  ].join("\n");
}

function openQuestionsTemplate(projectName) {
  return [
    `# ${projectName} Open Questions`,
    "",
    "Use this file for product or execution questions that block PRD generation or implementation.",
    "",
    "## Blocking",
    "- TBD",
    "",
    "## Deferred",
    "- TBD",
    "",
  ].join("\n");
}

function decisionLogTemplate(projectName) {
  return [
    `# ${projectName} Decision Log`,
    "",
    "Durable decisions should be summarized here and, when hard to reverse, promoted into `.yolo/decisions/ADR-*.md`.",
    "",
    "## Decisions",
    "- TBD",
    "",
  ].join("\n");
}

function contextDocTemplate(title, description, bullets = []) {
  return [
    `# ${title}`,
    "",
    description,
    "",
    "## Current Notes",
    bullets.length ? bullets.map((item) => `- ${item}`).join("\n") : "- TBD",
    "",
  ].join("\n");
}

function learningIndexTemplate(projectName) {
  return [
    `# ${projectName} Learning Index`,
    "",
    "No YOLO learning records have been generated yet.",
    "",
    "YOLO will use `.yolo/state/learning.jsonl` for model-agnostic lessons, pitfalls, rules, and recovery records.",
    "",
  ].join("\n");
}

function lessonsPlaybookTemplate(projectName) {
  return [
    `# ${projectName} Lessons Playbook`,
    "",
    "No lessons have been promoted yet.",
    "",
    "Lessons are advisory first. Only repeated, machine-verifiable lessons should become blocking gates.",
    "",
  ].join("\n");
}

function constitutionTemplate(projectName) {
  return [
    `# ${projectName} Constitution`,
    "",
    "## Principles",
    "",
    "- Requirements, design, tasks, and evidence must stay traceable.",
    "- Automation must fail closed when quality gates are missing or unclear.",
    "- Agent choice is replaceable; project policy is not tied to one model.",
    "- Existing user work must not be overwritten by default.",
    "",
    "## Quality Bar",
    "",
    "- Every implementation task needs explicit scope, acceptance checks, and verification evidence.",
    "- Bugs found in review become tracked tasks instead of informal notes.",
    "- Release readiness requires passing tests or documented degraded behavior.",
    "",
  ].join("\n");
}

function designMdTemplate(projectName) {
  return [
    `# ${projectName} Design System`,
    "",
    "This is the durable UI/UX contract for AI coding agents.",
    "",
    "## Product Direction",
    "",
    "- Audience:",
    "- Primary workflow:",
    "- Visual tone:",
    "- Accessibility bar: WCAG AA for core flows.",
    "",
    "## Interface Contract",
    "",
    "- Use `specs/design.md` for implementation architecture.",
    "- Use `UI-SPEC.md` or task-level `state_matrix` for screen states before implementation.",
    "- Every UI task must produce evidence for desktop/mobile layout, interaction states, runtime errors, and visual artifacts.",
    "",
    "## Quality Domains",
    "",
    "- Accessibility: contrast, focus states, labels, keyboard navigation.",
    "- Touch and interaction: 44px+ targets, visible feedback, no hover-only critical actions.",
    "- Responsive layout: no horizontal scroll, stable mobile/desktop structure.",
    "- Typography and color: readable scale, semantic tokens, no color-only meaning.",
    "- Performance: reserve media space and avoid layout shift.",
    "- Experience design: clear hierarchy, predictable navigation, useful empty/error/loading states.",
    "",
    "## Source Influences",
    "",
    "- `nextlevelbuilder/ui-ux-pro-max-skill`: priority-ordered UI/UX quality domains.",
    "- `nexu-io/open-design`: local-first design systems, sandboxed preview, durable artifacts.",
    "- `VoltAgent/awesome-design-md`: plain-text `DESIGN.md` as the design-system source for coding agents.",
    "- `goabstract/Awesome-Design-Tools`: resource taxonomy for colors, icons, information architecture, and research.",
    "- `DovAmir/awesome-design-patterns`: keep design/evidence adapters replaceable instead of hardcoding one tool.",
    "",
  ].join("\n");
}

function requirementsTemplate() {
  return [
    "# Requirements",
    "",
    "## Goal",
    "",
    "- Describe the user-visible outcome.",
    "",
    "## Success Criteria",
    "",
    "- List measurable acceptance criteria.",
    "",
    "## Constraints",
    "",
    "- List technical, business, security, and compatibility constraints.",
    "",
    "## Non-goals",
    "",
    "- List work that should stay out of scope.",
    "",
  ].join("\n");
}

function designTemplate() {
  return [
    "# Design",
    "",
    "## Approach",
    "",
    "- Explain the selected implementation approach.",
    "",
    "## Alternatives",
    "",
    "- Record meaningful alternatives and why they were not chosen.",
    "",
    "## Risks",
    "",
    "- List risks, mitigations, and rollback notes.",
    "",
  ].join("\n");
}

function tasksTemplate() {
  return [
    "# Tasks",
    "",
    "## Backlog",
    "",
    "- [ ] TASK-001: Add the first executable task with scope, gates, and verification.",
    "",
    "## Verification",
    "",
    "- Record commands, outputs, and evidence paths for each completed task.",
    "",
  ].join("\n");
}

function uiSpecTemplate() {
  return [
    "# UI-SPEC",
    "",
    "## Surface",
    "",
    "- Name:",
    "- Route/component:",
    "- Primary user goal:",
    "",
    "## State Matrix",
    "",
    "| State | Required UI | Evidence |",
    "|-------|-------------|----------|",
    "| Loading |  |  |",
    "| Empty |  |  |",
    "| Success |  |  |",
    "| Error |  |  |",
    "| Mobile |  |  |",
    "| Desktop |  |  |",
    "",
    "## Interaction Contract",
    "",
    "- Primary action:",
    "- Secondary actions:",
    "- Keyboard/touch behavior:",
    "- Loading/error feedback:",
    "",
    "## Visual Contract",
    "",
    "- Layout:",
    "- Typography:",
    "- Color tokens:",
    "- Icon system:",
    "- Motion:",
    "",
    "## Evidence Checklist",
    "",
    "- [ ] Page/surface reachable.",
    "- [ ] Critical path passed.",
    "- [ ] Required states present.",
    "- [ ] No runtime errors.",
    "- [ ] No content overlap or text overflow.",
    "- [ ] Mobile and desktop visual artifacts attached.",
    "",
  ].join("\n");
}

function specsReadme() {
  return [
    "# Specs",
    "",
    "This directory holds the project-level requirements, design notes, executable tasks, and evidence links used by YOLO.",
    "",
    "- `requirements.md`: user goals, success criteria, constraints, and non-goals.",
    "- `design.md`: selected approach, alternatives, risks, and rollback notes.",
    "- `tasks.md`: executable work items and verification evidence.",
    "",
  ].join("\n");
}

export function buildProjectBootstrapPlan(options = {}) {
  const projectRoot = resolve(options.projectRoot || options.cwd || process.cwd());
  const projectName = normalizeProjectName(projectRoot, options.projectName || options.name);
  const lifecycle = buildLifecycleStateFiles({ projectName, now: options.now });
  const directories = [
    ".yolo",
    ".yolo/lifecycle",
    ".yolo/memory",
    ".yolo/context",
    ".yolo/context/domain",
    ".yolo/context/codebase",
    ".yolo/decisions",
    ".yolo/packs",
    ".yolo/adapters",
    ".yolo/state",
    ".yolo/state/runtime",
    ".yolo/templates",
    "specs",
  ];
  const files = [
    { path: ".yolo/config.json", role: "config", content: projectConfig(projectName) },
    { path: ".yolo/constitution.md", role: "constitution", content: constitutionTemplate(projectName) },
    { path: "DESIGN.md", role: "design-system", content: designMdTemplate(projectName) },
    ...lifecycle.files,
    { path: ".yolo/memory/MEMORY_INDEX.md", role: "memory", content: memoryIndexTemplate(projectName) },
    { path: ".yolo/memory/CURRENT_STATUS.md", role: "memory", content: memoryStatusTemplate(projectName) },
    { path: ".yolo/memory/CURRENT_HANDOFF.md", role: "memory", content: memoryHandoffTemplate(projectName) },
    { path: ".yolo/memory/PROJECT_BRIEF.md", role: "memory", content: projectBriefTemplate(projectName) },
    { path: ".yolo/memory/PROGRESS.md", role: "memory", content: progressTemplate(projectName) },
    { path: ".yolo/memory/PRD_PIPELINE.md", role: "memory", content: prdPipelineTemplate(projectName) },
    { path: ".yolo/memory/TASK_ATOMICITY.md", role: "memory", content: taskAtomicityTemplate(projectName) },
    { path: ".yolo/memory/OPEN_QUESTIONS.md", role: "memory", content: openQuestionsTemplate(projectName) },
    { path: ".yolo/memory/DECISION_LOG.md", role: "memory", content: decisionLogTemplate(projectName) },
    { path: ".yolo/memory/DOCUMENT_GOVERNANCE.md", role: "memory", content: documentGovernanceTemplate(projectName) },
    { path: ".yolo/memory/LEARNING_INDEX.md", role: "memory", content: learningIndexTemplate(projectName) },
    { path: ".yolo/memory/LESSONS_PLAYBOOK.md", role: "memory", content: lessonsPlaybookTemplate(projectName) },
    { path: ".yolo/memory/PROJECT_TREE.md", role: "memory", content: memoryTreeTemplate(projectName) },
    { path: ".yolo/memory/MEMORY_AUDIT.md", role: "memory", content: memoryAuditTemplate(projectName) },
    { path: ".yolo/context/README.md", role: "context", content: contextReadmeTemplate(projectName) },
    { path: ".yolo/context/domain/GLOSSARY.md", role: "context", content: contextDocTemplate(`${projectName} Domain Glossary`, "Canonical business terms for non-technical demand discussions.") },
    { path: ".yolo/context/codebase/ARCHITECTURE.md", role: "context", content: contextDocTemplate(`${projectName} Architecture Map`, "High-level architecture notes discovered by YOLO memory refresh and code scouts.") },
    { path: ".yolo/context/codebase/STRUCTURE.md", role: "context", content: contextDocTemplate(`${projectName} Structure Map`, "Important folders, entrypoints, and ownership boundaries.") },
    { path: ".yolo/context/codebase/CONVENTIONS.md", role: "context", content: contextDocTemplate(`${projectName} Conventions`, "Local naming, layout, state, API, and test conventions.") },
    { path: ".yolo/context/codebase/TESTING.md", role: "context", content: contextDocTemplate(`${projectName} Testing Map`, "Known test commands, test folders, and verification expectations.") },
    { path: ".yolo/context/codebase/DEPENDENCIES.md", role: "context", content: contextDocTemplate(`${projectName} Dependencies`, "Frameworks, package managers, integrations, and external services.") },
    { path: ".yolo/context/codebase/SURFACES.md", role: "context", content: contextDocTemplate(`${projectName} Product Surfaces`, "User-visible pages, APIs, services, jobs, and data surfaces that PRD tasks may target.") },
    { path: ".yolo/context/codebase/RISK_AREAS.md", role: "context", content: contextDocTemplate(`${projectName} Risk Areas`, "Fragile, security-sensitive, data-sensitive, or high-churn areas.") },
    { path: ".yolo/state/changes.jsonl", role: "memory-ledger", content: "" },
    { path: ".yolo/state/events.jsonl", role: "memory-ledger", content: "" },
    { path: ".yolo/state/runs.jsonl", role: "memory-ledger", content: "" },
    { path: ".yolo/state/learning.jsonl", role: "memory-ledger", content: "" },
    { path: ".yolo/state/session-memory.jsonl", role: "memory-ledger", content: "" },
    { path: ".yolo/state/questions.jsonl", role: "memory-ledger", content: "" },
    { path: ".yolo/state/decisions.jsonl", role: "memory-ledger", content: "" },
    { path: ".yolo/state/artifacts.jsonl", role: "memory-ledger", content: "" },
    { path: ".yolo/templates/requirements.md", role: "template", content: requirementsTemplate() },
    { path: ".yolo/templates/design.md", role: "template", content: designTemplate() },
    { path: ".yolo/templates/tasks.md", role: "template", content: tasksTemplate() },
    { path: ".yolo/templates/UI-SPEC.md", role: "template", content: uiSpecTemplate() },
    { path: ".yolo/templates/prd-intake.md", role: "template", content: prdIntakeTemplate(projectName) },
    { path: "specs/README.md", role: "spec", content: specsReadme() },
    { path: "specs/requirements.md", role: "spec", content: requirementsTemplate() },
    { path: "specs/design.md", role: "spec", content: designTemplate() },
    { path: "specs/tasks.md", role: "spec", content: tasksTemplate() },
  ];

  return {
    schema_version: PROJECT_BOOTSTRAP_SCHEMA_VERSION,
    project_root: projectRoot,
    project_name: projectName,
    directories,
    files,
    file_count: files.length,
  };
}

export function initProject(options = {}) {
  const plan = buildProjectBootstrapPlan(options);
  const force = options.force === true;
  const dryRun = options.dryRun === true || options.dry_run === true;
  const createdDirs = [];
  const created = [];
  const overwritten = [];
  const skipped = [];

  for (const dir of plan.directories) {
    const absoluteDir = join(plan.project_root, dir);
    if (!existsSync(absoluteDir)) {
      createdDirs.push(dir);
      if (!dryRun) mkdirSync(absoluteDir, { recursive: true });
    }
  }

  for (const file of plan.files) {
    const absoluteFile = join(plan.project_root, file.path);
    const exists = existsSync(absoluteFile);
    if (exists && !force) {
      skipped.push(file.path);
      continue;
    }

    if (!dryRun) {
      mkdirSync(dirname(absoluteFile), { recursive: true });
      writeFileSync(absoluteFile, file.content, "utf8");
    }

    if (exists) overwritten.push(file.path);
    else created.push(file.path);
  }

  let session_memory = null;
  let memory_refresh = null;
  const freshMemory = created.includes(".yolo/memory/MEMORY_INDEX.md");
  if (!dryRun && freshMemory) {
    session_memory = appendSessionMemory({
      argv: [
        `--state-root=${join(plan.project_root, ".yolo")}`,
        "--type=project_init",
        "--source=yolo-init",
        "--summary=YOLO project memory, lifecycle, specs, context map, and ledgers initialized.",
        "--refs=.yolo/memory/CURRENT_HANDOFF.md,.yolo/memory/PROJECT_TREE.md,specs/requirements.md",
      ],
      now: options.now ? new Date(options.now) : new Date(),
    });
    memory_refresh = refreshMemoryCenter({
      projectRoot: plan.project_root,
      stateRoot: join(plan.project_root, ".yolo"),
      legacyPointers: true,
      applyRetention: false,
      migrateLearning: false,
    });
  }

  return {
    status: "success",
    summary: dryRun ? "planned YOLO project bootstrap" : "initialized YOLO project",
    exit_code: 0,
    schema_version: plan.schema_version,
    project_root: plan.project_root,
    project_name: plan.project_name,
    dry_run: dryRun,
    force,
    created_dirs: createdDirs,
    created,
    overwritten,
    skipped,
    session_memory,
    memory_refresh,
    artifacts: plan.files.map((file) => file.path),
    next_actions: [
      "Capture the first user problem in plain language with /yolo-brainstorm, /yolo-interview, or /yolo-discuss.",
      "Let YOLO convert the conversation into a scenario matrix before executable PRD generation.",
      "Review .yolo/memory/CURRENT_HANDOFF.md before each new session.",
      "Keep verification evidence linked from specs/tasks.md and .yolo/state/session-memory.jsonl.",
      "Use yolo memory refresh after structural or task-state changes.",
    ],
  };
}
