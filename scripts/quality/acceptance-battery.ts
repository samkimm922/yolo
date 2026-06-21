// Quality-score hallucination battery (v2): does acceptance catch a run that LIES?
// A provider "hallucination" shows up as a run report that claims success without real,
// sufficient evidence. Acceptance must BLOCK those and only PASS a genuine run.
//
// Category maps to the user-facing failure mode "幻觉": a fabricated/insufficient run
// must never pass acceptance.

export type AcceptanceExpectation = "pass" | "blocked";

export type AcceptanceBatteryCase = {
  id: string;
  category: "hallucination";
  description: string;
  expect: AcceptanceExpectation;
  // Files created in the temp project (the task target must exist for a genuine pass).
  files?: Record<string, string>;
  prd: unknown;
  // The run report handed to acceptance (in-memory). Omit for "missing run evidence".
  runReport?: unknown;
  reviewReport?: unknown;
};

const TARGET = "src/service.ts";

function prd(task: Record<string, unknown> = {}) {
  return {
    version: "2.0",
    id: "PRD-20260525-ACCEPTQ-001",
    title: "Acceptance quality fixture",
    project: { name: "test", language: "typescript" },
    generated_by: "yolo-review-agent",
    generated_at: "2026-05-25T00:00:00.000Z",
    base_commit: "abcdef0",
    requirements: [{ id: "REQ-1", text: "Keep the service module typed." }],
    designs: [{ id: "DES-1", text: "Use target-file evidence." }],
    tasks: [{
      id: "FIX-ACCEPTQ-001",
      title: "Fix service module",
      priority: "P1",
      type: "bugfix",
      status: "completed",
      requirement_ids: ["REQ-1"],
      design_ids: ["DES-1"],
      scope: { targets: [{ file: TARGET }] },
      acceptance_criteria: ["Service module target is modified."],
      post_conditions: [{ id: "POST-TARGET", type: "target_file_modified", severity: "FAIL", params: { file: TARGET } }],
      ...task,
    }],
  };
}

function genuineRunReport() {
  return {
    status: "success",
    run_id: "run-test-001",
    summary: { planned: 1, completed: 1, failed: 0, blocked: 0, skipped: 0, evidence_failures: 0 },
  };
}

// A lifecycle stage wrapper masquerading as a run report (no real run_id / task summary).
function lifecycleWrapper() {
  return { schema: "yolo.lifecycle.stage.report.v1", stage: "run", status: "success" };
}

const FILES = { [TARGET]: "export const x = 1;\n" };

export const ACCEPTANCE_BATTERY: AcceptanceBatteryCase[] = [
  {
    id: "good-genuine-run",
    category: "hallucination",
    description: "A genuine successful run with a passing review must pass acceptance.",
    expect: "pass",
    files: FILES,
    prd: prd(),
    runReport: genuineRunReport(),
    reviewReport: { status: "pass", findings: [] },
  },
  {
    id: "halluc-missing-run",
    category: "hallucination",
    description: "No run evidence must block acceptance (not silently pass).",
    expect: "blocked",
    files: FILES,
    prd: prd(),
    runReport: undefined,
    reviewReport: { status: "pass", findings: [] },
  },
  {
    id: "halluc-insufficient-run",
    category: "hallucination",
    description: "A run report claiming success but missing run_id/summary must block.",
    expect: "blocked",
    files: FILES,
    prd: prd(),
    runReport: { status: "success" },
    reviewReport: { status: "pass", findings: [] },
  },
  {
    id: "halluc-wrapper-run",
    category: "hallucination",
    description: "A lifecycle stage wrapper must not count as run evidence.",
    expect: "blocked",
    files: FILES,
    prd: prd(),
    runReport: lifecycleWrapper(),
    reviewReport: { status: "pass", findings: [] },
  },
];
