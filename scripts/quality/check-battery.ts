// Quality-score robustness battery (v1): fixed PRD cases for the `yolo check` gate.
// Each case asserts a deterministic outcome — a "good" PRD must pass, a malformed /
// boundary PRD must be structurally blocked (never crash, never silently pass).
//
// Categories map to the user-facing failure modes the soak loop targets:
//   - hang_or_crash  ("卡死"):   malformed input must be rejected structurally, not crash/pass.
//   - cannot_develop ("无法开发"): a legitimate PRD must pass the gate, not be over-blocked.
//
// The battery is intentionally fixed so the score is comparable across commits.
// Add cases to expose new territory (this may lower the score); fix code to raise it.

export type CheckExpectation = "pass" | "blocked";

export type CheckBatteryCase = {
  id: string;
  category: "hang_or_crash" | "cannot_develop";
  description: string;
  expect: CheckExpectation;
  files?: Record<string, string>;
  prd: unknown;
};

const VALID_TARGET = "src/a.js";
const VALID_FILES: Record<string, string> = { [VALID_TARGET]: "module.exports = {};\n" };

function strictPrd(taskOverrides: Record<string, unknown> = {}, prdOverrides: Record<string, unknown> = {}) {
  return {
    version: "2.0",
    id: "PRD-20260525-QUALITY-001",
    title: "Quality battery fixture",
    project: { name: "test", language: "javascript" },
    generated_by: "yolo-demand",
    generated_at: "2026-05-25T00:00:00.000Z",
    base_commit: "abcdef0",
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-QUALITY",
      approval: { approved: true, effective_for_prd: true },
      project_facts: { target_files: [{ file: VALID_TARGET, status: "verified" }], assumptions: [] },
      quality_report: { schema_version: "1.0", schema: "yolo.demand.quality.v1", status: "pass", total_score: 100, dimensions: [] },
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: { schema_version: "1.0", schema: "yolo.demand.quality.v1", status: "pass", total_score: 100, dimensions: [] },
    },
    requirements: [{ id: "REQ-1", text: "For operators, keep a small module update tracked.", demand_trace: { evidence: ["EVID-1"] } }],
    designs: [{ id: "DES-1", text: "Use target-file evidence." }],
    tasks: [{
      id: "FIX-QUALITY-001",
      title: "Fix small module",
      priority: "P1",
      type: "bugfix",
      task_kind: "atomic_fix",
      status: "pending",
      requirement_ids: ["REQ-1"],
      design_ids: ["DES-1"],
      scope: { targets: [{ file: VALID_TARGET }] },
      acceptance_criteria: ["Small module target is modified."],
      post_conditions: [
        { id: "POST-TARGET", type: "target_file_modified", severity: "FAIL", params: { file: VALID_TARGET } },
        { id: "POST-TYPECHECK", type: "no_new_type_errors", severity: "FAIL", params: { command: "npm run typecheck" } },
      ],
      ...taskOverrides,
    }],
    ...prdOverrides,
  };
}

const altTargetDemand = {
  id: "DEMAND-QUALITY",
  approval: { approved: true, effective_for_prd: true },
  project_facts: { target_files: [{ file: "src/util/helper.js", status: "verified" }], assumptions: [] },
  quality_report: { schema_version: "1.0", schema: "yolo.demand.quality.v1", status: "pass", total_score: 100, dimensions: [] },
};

export const CHECK_BATTERY: CheckBatteryCase[] = [
  {
    id: "good-strict-prd",
    category: "cannot_develop",
    description: "A legitimate approved-demand PRD must pass the check gate.",
    expect: "pass",
    files: VALID_FILES,
    prd: strictPrd(),
  },
  {
    id: "good-alt-target",
    category: "cannot_develop",
    description: "A legitimate PRD targeting another in-root file must pass.",
    expect: "pass",
    files: { "src/util/helper.js": "module.exports = {};\n" },
    prd: strictPrd(
      {
        scope: { targets: [{ file: "src/util/helper.js" }] },
        post_conditions: [
          { id: "POST-TARGET", type: "target_file_modified", severity: "FAIL", params: { file: "src/util/helper.js" } },
          { id: "POST-TYPECHECK", type: "no_new_type_errors", severity: "FAIL", params: { command: "npm run typecheck" } },
        ],
      },
      { demand: altTargetDemand },
    ),
  },
  {
    id: "bad-tasks-not-array",
    category: "hang_or_crash",
    description: "tasks as a string must be structurally blocked, not crash.",
    expect: "blocked",
    files: VALID_FILES,
    prd: { version: "2.0", id: "PRD-INVALID", tasks: "not-an-array" },
  },
  {
    id: "bad-control-char-title",
    category: "hang_or_crash",
    description: "NUL control character in a PRD string must be rejected.",
    expect: "blocked",
    files: VALID_FILES,
    prd: strictPrd({}, { title: "Fix" + String.fromCharCode(0) + "module" }),
  },
  {
    id: "bad-target-traversal",
    category: "hang_or_crash",
    description: "A task target path escaping the project root must be blocked.",
    expect: "blocked",
    files: VALID_FILES,
    prd: strictPrd({ scope: { targets: [{ file: "../../etc/passwd" }] } }),
  },
  {
    id: "bad-target-absolute-outside",
    category: "hang_or_crash",
    description: "An absolute target path outside the root must be blocked.",
    expect: "blocked",
    files: VALID_FILES,
    prd: strictPrd({ scope: { targets: [{ file: "/etc/hosts" }] } }),
  },
  {
    id: "bad-empty-object",
    category: "hang_or_crash",
    description: "An empty object PRD must be structurally blocked.",
    expect: "blocked",
    files: VALID_FILES,
    prd: {},
  },
  {
    id: "bad-missing-tasks",
    category: "hang_or_crash",
    description: "A PRD with no tasks must be blocked, not silently pass.",
    expect: "blocked",
    files: VALID_FILES,
    prd: strictPrd({}, { tasks: [] }),
  },
];
