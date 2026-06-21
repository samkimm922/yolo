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
];
