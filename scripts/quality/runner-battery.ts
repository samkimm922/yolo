// Quality-score capability battery (runner track): does the runner correctly judge
// whether a task is DONE? The runner accepts/retries a task based on its post-condition
// evaluators. A false PASS = it ships incomplete work; a false FAIL = it gets stuck on
// good work. Both are runner-quality failures the user feels as "runner 干得不好".
//
// Category: runner_outcome_accuracy. Each case sets up a known project state, runs the
// task's post-conditions, and expects a specific verdict.

export type RunnerExpectation = "done" | "not_done";

export type RunnerBatteryCase = {
  id: string;
  expect: RunnerExpectation;          // "done" → post-conditions must all pass
  description: string;
  // Files committed as the BASE state (before the "task" runs).
  baseFiles: Record<string, string>;
  // Files written AFTER base (the "task's" edits). Omit to leave base untouched.
  editFiles?: Record<string, string>;
  // Files removed AFTER base (the "task's" deletions). Omit to keep base files.
  deleteFiles?: string[];
  // The task whose post_conditions are evaluated.
  task: unknown;
};

const TARGET = "src/feature.ts";

function targetModifiedTask(extraConditions: unknown[] = []) {
  return {
    id: "TASK-RUNNER-1",
    title: "Implement feature",
    scope: { targets: [{ file: TARGET }] },
    post_conditions: [
      { id: "POST-TARGET", type: "target_file_modified", severity: "FAIL", params: { file: TARGET } },
      ...extraConditions,
    ],
  };
}

export const RUNNER_BATTERY: RunnerBatteryCase[] = [
  {
    id: "done-target-modified",
    expect: "done",
    description: "Target file was edited → target_file_modified must pass.",
    baseFiles: { [TARGET]: "export const v = 1;\n" },
    editFiles: { [TARGET]: "export const v = 2; // implemented\n" },
    task: targetModifiedTask(),
  },
  {
    id: "notdone-target-untouched",
    expect: "not_done",
    description: "Target file unchanged → runner must NOT think the task is done.",
    baseFiles: { [TARGET]: "export const v = 1;\n" },
    task: targetModifiedTask(),
  },
  {
    id: "done-code-contains",
    expect: "done",
    description: "Edited file contains the required marker → code_contains passes.",
    baseFiles: { [TARGET]: "export const v = 1;\n" },
    editFiles: { [TARGET]: "export const v = 2;\nexport const FLAG = true;\n" },
    task: targetModifiedTask([
      { id: "POST-CONTAINS", type: "code_contains", severity: "FAIL", params: { file: TARGET, text: "FLAG" } },
    ]),
  },
  {
    id: "notdone-code-missing-marker",
    expect: "not_done",
    description: "Edited file is missing the required marker → must NOT pass.",
    baseFiles: { [TARGET]: "export const v = 1;\n" },
    editFiles: { [TARGET]: "export const v = 2;\n" },
    task: targetModifiedTask([
      { id: "POST-CONTAINS", type: "code_contains", severity: "FAIL", params: { file: TARGET, text: "FLAG" } },
    ]),
  },
  {
    id: "notdone-target-only-twin-file-changed",
    expect: "not_done",
    description:
      "Same-named file in a nested dir was edited but the actual target was NOT modified → must NOT pass (suffix-only path match is a false positive).",
    baseFiles: { [TARGET]: "export const v = 1;\n" },
    editFiles: { "tests/src/feature.ts": "test('twins', () => 1);\n" },
    task: targetModifiedTask(),
  },
  {
    id: "notdone-code-contains-partial-missing",
    expect: "not_done",
    description:
      "code_contains with multiple files, only one exists and contains the marker; the other is missing → must NOT pass (missing file cannot satisfy 'must contain').",
    baseFiles: { "src/a.ts": "export const A = 1;\n" },
    editFiles: { "src/a.ts": "export const A = 2;\nexport const FLAG = true;\n" },
    task: {
      id: "TASK-RUNNER-MULTI",
      title: "Implement feature across two files",
      scope: { targets: [{ file: "src/a.ts" }, { file: "src/b.ts" }] },
      post_conditions: [
        {
          id: "POST-CONTAINS-MULTI",
          type: "code_contains",
          severity: "FAIL",
          params: { files: ["src/a.ts", "src/b.ts"], text: "FLAG" },
        },
      ],
    },
  },
  {
    id: "done-file-lines-max-on-missing-file",
    expect: "done",
    description:
      "Target file was deleted as part of the task → file_lines_max is vacuously satisfied (no file = no lines to exceed). The runner used to mark the task as not done on a missing file even when the deletion was the intended outcome.",
    baseFiles: { "src/legacy.ts": "export const old = 1;\n" },
    deleteFiles: ["src/legacy.ts"],
    task: {
      id: "TASK-RUNNER-LINES-MISSING",
      title: "Remove legacy file",
      scope: {
        targets: [{ file: "src/legacy.ts" }],
        expected_zero_business_code: true,
      },
      post_conditions: [
        { id: "POST-LINES", type: "file_lines_max", severity: "FAIL", params: { file: "src/legacy.ts", max: 150 } },
        { id: "POST-FILE-GONE", type: "file_not_exists", severity: "FAIL", params: { file: "src/legacy.ts" } },
      ],
    },
  },
  {
    id: "done-code-contains-exact-zero",
    expect: "done",
    description:
      "code_contains with count.exact = 0 passes when the marker is absent; previously exact:0 fell through to the default min=1 check and reported a false not_done.",
    baseFiles: { [TARGET]: "export const v = 1;\nexport const LEGACY = true;\n" },
    editFiles: { [TARGET]: "export const v = 2;\n" },
    task: targetModifiedTask([
      {
        id: "POST-EXACT-ZERO",
        type: "code_contains",
        severity: "FAIL",
        params: { file: TARGET, text: "LEGACY", count: { exact: 0 } },
      },
    ]),
  },
  {
    id: "done-code-contains-exact-zero-missing-file",
    expect: "done",
    description:
      "code_contains with count.exact = 0 passes when the target file was deleted; a missing file has zero occurrences, so the runner must not report a false not_done.",
    baseFiles: { [TARGET]: "export const v = 1;\nexport const LEGACY = true;\n" },
    deleteFiles: [TARGET],
    task: {
      id: "TASK-RUNNER-EXACT-ZERO-MISSING",
      title: "Remove legacy marker",
      scope: { targets: [{ file: TARGET }] },
      post_conditions: [
        {
          id: "POST-EXACT-ZERO-MISSING",
          type: "code_contains",
          severity: "FAIL",
          params: { file: TARGET, text: "LEGACY", count: { exact: 0 } },
        },
      ],
    },
  },
];
