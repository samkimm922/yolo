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
  kind?: "prd_check" | "artifact_integrity_escape";
  category: "hang_or_crash" | "cannot_develop";
  description: string;
  expect: CheckExpectation;
  files?: Record<string, string>;
  prd?: unknown;
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
    provider_capability: { opt_out: true },
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

function duplicateTaskIdPrd() {
  const prd = strictPrd();
  const firstTask = prd.tasks[0];
  return {
    ...prd,
    tasks: [
      firstTask,
      {
        ...firstTask,
        title: "Duplicate task id fixture",
        post_conditions: [
          { id: "POST-TARGET-DUP", type: "target_file_modified", severity: "FAIL", params: { file: VALID_TARGET } },
          { id: "POST-TYPECHECK-DUP", type: "no_new_type_errors", severity: "FAIL", params: { command: "npm run typecheck" } },
        ],
      },
    ],
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
  {
    id: "bad-duplicate-task-id",
    category: "hang_or_crash",
    description: "Duplicate task ids must be blocked because runner state updates are keyed by task id.",
    expect: "blocked",
    files: VALID_FILES,
    prd: duplicateTaskIdPrd(),
  },
  {
    id: "bad-null-prd-json",
    category: "hang_or_crash",
    description: "A valid-JSON null PRD must be structurally blocked, not crash inside contract evaluation.",
    expect: "blocked",
    files: VALID_FILES,
    prd: null,
  },
  {
    id: "bad-post-conditions-not-array",
    category: "hang_or_crash",
    description: "A task whose post_conditions is a string must be blocked, not crash on .filter.",
    expect: "blocked",
    files: VALID_FILES,
    prd: strictPrd({ post_conditions: "not-an-array" }),
  },
  {
    id: "bad-pre-conditions-not-array",
    category: "hang_or_crash",
    description: "A task whose pre_conditions is a truthy non-array (object/string) must be blocked, not crash the doctor's condition loop.",
    expect: "blocked",
    files: VALID_FILES,
    prd: strictPrd({ pre_conditions: { id: "PRE-A", type: "tests_pass", severity: "FAIL", params: { command: "npm test" } } }),
  },
  {
    id: "bad-scope-targets-not-array",
    category: "hang_or_crash",
    description: "A task whose scope.targets is a string must be blocked, not crash on .map.",
    expect: "blocked",
    files: VALID_FILES,
    prd: strictPrd({ scope: { targets: "src/a.js" } }),
  },
  {
    id: "artifact_path_escape_blocked",
    kind: "artifact_integrity_escape",
    category: "hang_or_crash",
    description: "Artifact integrity must not read or pass an absolute file outside rootDir.",
    expect: "blocked",
  },
  // H12: corrupt/unparseable tool output must never fail-open to an empty baseline.
  // A corrupt eslint baseline (non-array JSON) must structurally block, not pass.
  {
    id: "eslint_baseline_corrupt_blocks_check",
    category: "hang_or_crash",
    description: "A structurally invalid eslint baseline must block (fail-closed), not establish an empty baseline.",
    expect: "blocked",
    files: { ...VALID_FILES, "scripts/yolo/state/runtime/eslint-baseline.json": "{not valid json" },
    prd: { version: "2.0", id: "PRD-INVALID-BASELINE", tasks: "not-an-array" },
  },
  {
    id: "knip_baseline_corrupt_blocks_check",
    category: "hang_or_crash",
    description: "A structurally invalid dead_code baseline must block (fail-closed).",
    expect: "blocked",
    files: { ...VALID_FILES, "scripts/yolo/state/runtime/knip-baseline.json": "<<<corrupt>>>" },
    prd: { version: "2.0", id: "PRD-INVALID-KNIP-BASELINE", tasks: "not-an-array" },
  },
  // Negative: a well-formed (empty-keys) baseline must NOT be over-blocked at the
  // structural check layer when the PRD itself is otherwise valid.
  {
    id: "valid_baseline_keys_do_not_overblock_check",
    category: "cannot_develop",
    description: "A well-formed baseline (object with keys array) must not cause structural over-blocking of a valid PRD.",
    expect: "pass",
    files: { ...VALID_FILES, "scripts/yolo/state/runtime/eslint-baseline.json": JSON.stringify({ keys: [] }) },
    prd: strictPrd(),
  },
  // H1: a negative caller override (strictExecution:false) must NOT relax the gate
  // for a PRD that requires strict execution (L3/afk_ready). Such a PRD with
  // missing demand evidence must still block (fail-closed), not be disarmed.
  {
    id: "strict_false_input_must_not_relax_gate",
    category: "hang_or_crash",
    description: "A strict (L3/afk_ready) PRD must remain blocked even if a caller passes strictExecution:false to relax it.",
    expect: "blocked",
    files: VALID_FILES,
    prd: strictPrd({}, { demand: { id: "DEMAND-QUALITY", approval: { approved: false }, project_facts: { target_files: [], assumptions: [] } } }),
  },
  {
    id: "strict_prd_without_relax_override_still_passes",
    category: "cannot_develop",
    description: "A legitimate approved strict PRD must pass the gate (no over-blocking from the H1 fix).",
    expect: "pass",
    files: VALID_FILES,
    prd: strictPrd(),
  },
];
