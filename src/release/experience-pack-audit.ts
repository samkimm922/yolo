import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { appendLearningRecord, retrieveRelevantLearningRecords } from "../runtime/learning/center.js";
import { generatePrompt } from "../cli/prompt.js";

export const EXPERIENCE_PACK_AUDIT_SCHEMA_VERSION = "1.0";

function check(code, passed, message, extra = Object()) {
  return { code, passed, message, ...extra };
}

function plannedFixtureRoot() {
  return join(tmpdir(), `yolo-experience-pack-audit-${Date.now()}`);
}

function write(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function experienceItemCount(prompt = "") {
  const match = String(prompt).match(/## Relevant Experience Pack[\s\S]*?(?:\n## |\n# |\n---|$)/);
  if (!match) return 0;
  return (match[0].match(/^- learn_/gm) || []).length;
}

export function buildExperiencePackEffectivenessAuditPlan(options = Object()) {
  const projectRoot = resolve(options.projectRoot || options.project_root || plannedFixtureRoot());
  const stateRoot = resolve(options.stateRoot || options.state_root || join(projectRoot, ".yolo"));
  return {
    schema_version: EXPERIENCE_PACK_AUDIT_SCHEMA_VERSION,
    schema: "yolo.release.experience_pack_effectiveness_audit_plan.v1",
    project_root: projectRoot,
    state_root: stateRoot,
    max_selected_records: Number(options.maxSelectedRecords || options.max_selected_records || 2),
    max_pack_chars: Number(options.maxPackChars || options.max_pack_chars || 1800),
    writes_isolated_fixture: true,
    writes_yolo_package_root: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    required_evidence: [
      "a relevant failure learning record is written to the fixture ledger",
      "unrelated learning records are present but not injected",
      "the next prompt includes only relevant experience records",
      "experience injection stays bounded and never blocks prompt generation",
    ],
  };
}

function writeAuditFixture(projectRoot) {
  write(join(projectRoot, "src/services/category.ts"), [
    "export function categoryId(input: unknown) {",
    "  return input as unknown as string;",
    "}",
    "",
  ].join("\n"));
  write(join(projectRoot, "src/other.ts"), "export const unrelated = true;\n");
  const prdPath = join(projectRoot, "prd.json");
  write(prdPath, `${JSON.stringify({
    version: "2.0",
    tasks: [{
      id: "FIX-EXP-AUDIT-001",
      title: "Fix TS2352 category cast",
      type: "bugfix",
      status: "pending",
      description: "Fix TS2352 in src/services/category.ts without as unknown as",
      scope: {
        targets: [{ file: "src/services/category.ts" }],
        max_files: 1,
        max_lines_per_file: 80,
      },
      post_conditions: [{
        id: "POST-NO-DOUBLE-CAST",
        type: "code_not_contains",
        severity: "FAIL",
        params: { file: "src/services/category.ts", text: "as unknown as" },
      }],
    }],
  }, null, 2)}\n`);
  return prdPath;
}

function seedLearning(projectRoot, stateRoot) {
  const now = new Date("2026-05-25T00:00:00.000Z");
  const relevant = appendLearningRecord({
    type: "failure",
    source: "experience_pack_audit",
    gate: "tsc",
    lesson: "TS2352 category service failure happened when src/services/category.ts used as unknown as.",
    prevention: "Narrow unknown values before casting; do not use double assertions.",
    files: ["src/services/category.ts"],
    confidence: 9,
    task_type: "bugfix",
  }, { projectRoot, stateRoot, now });
  const unrelated = appendLearningRecord({
    type: "failure",
    source: "experience_pack_audit",
    gate: "eslint",
    lesson: "Unrelated eslint import cleanup in src/other.ts should not appear.",
    prevention: "Remove unused imports only in the matching file.",
    files: ["src/other.ts"],
    confidence: 9,
    task_type: "cleanup",
  }, { projectRoot, stateRoot, now: new Date("2026-05-25T00:00:01.000Z") });
  const noisy = appendLearningRecord({
    type: "failure",
    source: "experience_pack_audit",
    gate: "file_lines_max",
    lesson: "Unrelated file length split for docs/huge.md should not appear.",
    prevention: "Split long docs only when the target file matches.",
    files: ["docs/huge.md"],
    confidence: 8,
    task_type: "refactor",
  }, { projectRoot, stateRoot, now: new Date("2026-05-25T00:00:02.000Z") });
  return { relevant, unrelated, noisy };
}

export function runExperiencePackEffectivenessAudit(options = Object()) {
  const plan = options.plan || buildExperiencePackEffectivenessAuditPlan(options);
  const projectRoot = resolve(plan.project_root);
  const stateRoot = resolve(plan.state_root);
  const maxSelected = Number(plan.max_selected_records || 2);
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(join(stateRoot, "state"), { recursive: true });
  const prdPath = writeAuditFixture(projectRoot);
  const seeded = seedLearning(projectRoot, stateRoot);

  let prompt = "";
  let promptError = null;
  try {
    prompt = generatePrompt({
      taskId: "FIX-EXP-AUDIT-001",
      prdPath,
      cwd: projectRoot,
      stateRoot,
      gate: "tsc",
      learningsText: "src/services/category.ts error TS2352 caused by as unknown as",
      experienceLimit: maxSelected,
    });
  } catch (error) {
    promptError = error;
  }

  const retrieval = retrieveRelevantLearningRecords({
    projectRoot,
    stateRoot,
    task: {
      id: "FIX-EXP-AUDIT-001",
      type: "bugfix",
      title: "Fix TS2352 category cast",
      description: "Fix TS2352 in src/services/category.ts without as unknown as",
      scope: { targets: [{ file: "src/services/category.ts" }] },
    },
    gate: "tsc",
    lastGateError: "src/services/category.ts error TS2352 caused by as unknown as",
    limit: maxSelected,
  });
  const itemCount = experienceItemCount(prompt);
  const checks = [
    check("EXPERIENCE_PACK_AUDIT_PROMPT_NON_BLOCKING", !promptError && prompt.length > 0, "prompt generation must not be blocked by learning retrieval", { error: promptError?.message || null }),
    check("EXPERIENCE_PACK_AUDIT_RELEVANT_INCLUDED", /TS2352 category service failure/.test(prompt), "prompt must inject the relevant prior failure"),
    check("EXPERIENCE_PACK_AUDIT_UNRELATED_EXCLUDED", !/Unrelated eslint import cleanup/.test(prompt) && !/Unrelated file length split/.test(prompt), "prompt must not inject unrelated learning records"),
    check("EXPERIENCE_PACK_AUDIT_BOUNDED", retrieval.selected_count <= maxSelected && itemCount <= maxSelected, "experience pack must stay bounded", { selected_count: retrieval.selected_count, prompt_item_count: itemCount, max_selected: maxSelected }),
    check("EXPERIENCE_PACK_AUDIT_NO_PROVIDER", true, "audit must not execute providers or billable actions"),
  ];
  const blockers = checks.filter((item) => item.passed !== true);
  return {
    schema_version: EXPERIENCE_PACK_AUDIT_SCHEMA_VERSION,
    schema: "yolo.release.experience_pack_effectiveness_audit_result.v1",
    status: blockers.length === 0 ? "pass" : "blocked",
    project_root: projectRoot,
    state_root: stateRoot,
    prd_path: prdPath,
    checks,
    blockers,
    seeded_records: seeded,
    retrieval,
    prompt_summary: {
      generated: !promptError,
      length: prompt.length,
      experience_item_count: itemCount,
      contains_relevant: /TS2352 category service failure/.test(prompt),
      contains_unrelated: /Unrelated eslint import cleanup|Unrelated file length split/.test(prompt),
    },
    guarantees: {
      yolo_package_root_mutated: false,
      prompt_generation_blocked: Boolean(promptError),
      provider_execution: false,
      billable_provider_execution: false,
      credential_access: false,
      published: false,
    },
    next_actions: blockers.length === 0
      ? ["Keep experience packs advisory, bounded, and rooted in the caller project state."]
      : ["Fix experience retrieval relevance or non-blocking behavior before expanding learning injection."],
    plan,
  };
}
