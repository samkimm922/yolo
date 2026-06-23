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
  // Files that should be executable for command-runner fixtures.
  executableFiles?: string[];
  // Relative directories to prepend to PATH while evaluating this case.
  envPathPrepend?: string[];
  // Override config.build.test while evaluating this case.
  buildTestCommand?: string;
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

function removedFileTask(file: string, text: string) {
  return {
    id: "TASK-RUNNER-2",
    title: "Remove marker from file",
    scope: {
      targets: [{ file }],
      expected_zero_business_code: true,
    },
    post_conditions: [
      { id: "POST-NO-TEXT", type: "code_not_contains", severity: "FAIL", params: { file, text } },
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
    id: "evalTestsPass_empty_output_fails",
    expect: "not_done",
    description:
      "tests_pass with a successful vitest process but no JSON result is untrusted and must not mark the task done.",
    baseFiles: {
      "bin/pnpm": "#!/usr/bin/env node\nprocess.exit(0);\n",
    },
    executableFiles: ["bin/pnpm"],
    envPathPrepend: ["bin"],
    buildTestCommand: "",
    task: {
      id: "TASK-RUNNER-TESTS-EMPTY",
      title: "Verify tests",
      scope: { expected_zero_business_code: true },
      post_conditions: [
        { id: "POST-TESTS", type: "tests_pass", severity: "FAIL", params: {} },
      ],
    },
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
    id: "notdone-code-not-contains-missing-file",
    expect: "not_done",
    description:
      "Target file is absent without allow_missing/file_not_exists intent -> code_not_contains must block instead of passing vacuously.",
    baseFiles: {},
    editFiles: {},
    task: removedFileTask("src/legacy.ts", "FLAG"),
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
    id: "notdone-forbidden-pattern-new-file",
    expect: "not_done",
    description:
      "New untracked file contains a forbidden pattern (as any); no_forbidden_patterns must detect it. Previously the evaluator skipped untracked files because git diff returns empty for them — false DONE.",
    baseFiles: { "src/old.ts": "export const a = 1;\n" },
    editFiles: { "src/new.ts": "const x = y as any;\n" },
    task: {
      id: "TASK-RUNNER-FORBIDDEN",
      title: "Add new file with forbidden pattern",
      scope: {
        targets: [{ file: "src/new.ts" }],
        expected_zero_business_code: true,
      },
      post_conditions: [
        {
          id: "POST-FORBIDDEN",
          type: "no_forbidden_patterns",
          severity: "FAIL",
          params: {
            patterns: [{ pattern: "as any", severity: "FAIL" }],
            targets: ["src/new.ts"],
          },
        },
      ],
    },
  },
  {
    id: "done-required-side-effect-import-present",
    expect: "done",
    description:
      "required_imports_present with only import_path must accept a valid side-effect import. `import \"./polyfill\";` is complete when no named/default binding is required; previously the runner reported a false not_done.",
    baseFiles: {
      "src/app.ts": "export const ready = false;\n",
      "src/polyfill.ts": "globalThis.__polyfilled = true;\n",
    },
    editFiles: {
      "src/app.ts": "import \"./polyfill\";\nexport const ready = true;\n",
    },
    task: {
      id: "TASK-RUNNER-IMPORT-SIDE-EFFECT",
      title: "Load the feature polyfill",
      scope: { targets: [{ file: "src/app.ts" }] },
      post_conditions: [
        {
          id: "POST-IMPORT",
          type: "required_imports_present",
          severity: "FAIL",
          params: { file: "src/app.ts", import_path: "./polyfill" },
        },
      ],
    },
  },
  {
    id: "notdone-required-named-import-missing",
    expect: "not_done",
    description:
      "required_imports_present with named imports must verify the requested symbol, not only the import source path. Importing a different symbol from the same module is incomplete work and must not pass.",
    baseFiles: {
      "src/app.ts": "export function run() { return 1; }\n",
      "src/dep.ts": "export const useFeature = () => true;\nexport const other = 1;\n",
    },
    editFiles: {
      "src/app.ts": "import { other } from \"./dep\";\nexport function run() { return other; }\n",
    },
    task: {
      id: "TASK-RUNNER-IMPORT-NAMED",
      title: "Use the required feature helper",
      scope: { targets: [{ file: "src/app.ts" }] },
      post_conditions: [
        {
          id: "POST-IMPORT",
          type: "required_imports_present",
          severity: "FAIL",
          params: { file: "src/app.ts", import_path: "./dep", named: ["useFeature"] },
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
        { id: "POST-LINES", type: "file_lines_max", severity: "FAIL", params: { file: "src/legacy.ts", max: 150, delete_intent: true } },
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
  {
    id: "done-file-lines-max-trailing-newline",
    expect: "done",
    description:
      "A 150-line file with a trailing newline is within a 150-line limit. Previously split('\\n').length counted the trailing empty segment as an extra line, producing a false not_done.",
    baseFiles: { [TARGET]: Array(100).fill("// base").join("\n") + "\n" },
    editFiles: { [TARGET]: Array(150).fill("// line").join("\n") + "\n" },
    task: {
      id: "TASK-RUNNER-LINES-TRAILING",
      title: "Implement feature in exactly 150 lines",
      scope: { targets: [{ file: TARGET }], expected_zero_business_code: true },
      post_conditions: [
        { id: "POST-LINES", type: "file_lines_max", severity: "FAIL", params: { file: TARGET, max: 150 } },
      ],
    },
  },
  {
    id: "done-lint-warning-only",
    expect: "done",
    description:
      "eslint exits 0 with only warnings (severity 1) → no_new_lint_errors must pass. Previously the runner counted warnings as new lint errors and reported a false not_done.",
    baseFiles: { "src/feature.ts": "export const x = 1;\n" },
    editFiles: { "src/feature.ts": "export const x = 1;\n// harmless edit\n" },
    task: {
      id: "TASK-RUNNER-LINT-WARN",
      title: "Edit feature without adding lint errors",
      scope: { targets: [{ file: "src/feature.ts" }], expected_zero_business_code: true },
      post_conditions: [
        {
          id: "POST-LINT-WARN",
          type: "no_new_lint_errors",
          severity: "FAIL",
          params: {
            command:
              'node -e \'console.log(JSON.stringify([{filePath:"src/feature.ts",messages:[{ruleId:"no-console",severity:1,line:1}]}]))\'',
          },
        },
      ],
    },
  },
  {
    id: "done-code-contains-range-zero-missing-file",
    expect: "done",
    description:
      "code_contains with count.min=0/max=N passes when the target file was deleted; a missing file has zero occurrences, so the runner must not report a false not_done for removal tasks.",
    baseFiles: { [TARGET]: "export const v = 1;\nexport const LEGACY = true;\nexport const LEGACY2 = true;\n" },
    deleteFiles: [TARGET],
    task: {
      id: "TASK-RUNNER-RANGE-ZERO-MISSING",
      title: "Remove legacy marker file",
      scope: { targets: [{ file: TARGET }], expected_zero_business_code: true },
      post_conditions: [
        {
          id: "POST-RANGE-ZERO-MISSING",
          type: "code_contains",
          severity: "FAIL",
          params: { file: TARGET, text: "LEGACY", count: { min: 0, max: 1 } },
        },
      ],
    },
  },
  {
    id: "done-pretty-tsc-baseline-error",
    expect: "done",
    description:
      "TypeScript pretty-format errors that already exist in tsc-baseline.json are not new type errors; no_new_type_errors must pass instead of reporting a false not_done.",
    baseFiles: {
      "src/feature.ts": "export const v = 1;\n",
      "src/legacy.ts": "export const legacy: string = 1;\n",
      "scripts/yolo/state/runtime/tsc-baseline.json": "{\n  \"keys\": [\n    \"src/legacy.ts:1:TS2322\"\n  ]\n}\n",
      "tsc.js":
        "console.log('src/legacy.ts:1:14 - error TS2322: Type number is not assignable to type string.');\nprocess.exit(1);\n",
    },
    editFiles: {
      "src/feature.ts": "export const v = 2;\n",
    },
    task: {
      id: "TASK-RUNNER-TSC-PRETTY-BASELINE",
      title: "Implement feature without new type errors",
      scope: { targets: [{ file: "src/feature.ts" }] },
      post_conditions: [
        { id: "POST-TARGET", type: "target_file_modified", severity: "FAIL", params: { file: "src/feature.ts" } },
        { id: "POST-TSC", type: "no_new_type_errors", severity: "FAIL", params: { command: "node tsc.js" } },
      ],
    },
  },
  {
    id: "done-absolute-tsc-baseline-error",
    expect: "done",
    description:
      "A TypeScript error reported with an absolute in-repo path can still match a relative tsc-baseline.json key; otherwise no_new_type_errors reports a false not_done for an existing error.",
    baseFiles: {
      "src/feature.ts": "export const v = 1;\n",
      "src/legacy.ts": "export const legacy: string = 1;\n",
      "scripts/yolo/state/runtime/tsc-baseline.json": "{\n  \"keys\": [\n    \"src/legacy.ts:1:TS2322\"\n  ]\n}\n",
      "tsc.js":
        "console.log(process.cwd() + '/src/legacy.ts(1,14): error TS2322: Type number is not assignable to type string.');\nprocess.exit(1);\n",
    },
    editFiles: {
      "src/feature.ts": "export const v = 2;\n",
    },
    task: {
      id: "TASK-RUNNER-TSC-ABSOLUTE-BASELINE",
      title: "Implement feature without new type errors",
      scope: { targets: [{ file: "src/feature.ts" }] },
      post_conditions: [
        { id: "POST-TARGET", type: "target_file_modified", severity: "FAIL", params: { file: "src/feature.ts" } },
        { id: "POST-TSC", type: "no_new_type_errors", severity: "FAIL", params: { command: "node tsc.js" } },
      ],
    },
  },
  {
    id: "notdone-type-error-outside-target",
    expect: "not_done",
    description:
      "no_new_type_errors is a project gate: a task that edits the target file but introduces a new TS error in another changed file is not done. Previously the runner filtered errors outside scope.targets and reported a false DONE.",
    baseFiles: {
      "src/feature.ts": "export const v = 1;\n",
      "src/other.ts": "export const other = 1;\n",
      "tsc.js":
        "console.log('src/other.ts(1,14): error TS2322: Type number is not assignable to type string.');\nprocess.exit(1);\n",
    },
    editFiles: {
      "src/feature.ts": "export const v = 2;\n",
      "src/other.ts": "export const other: string = 1;\n",
    },
    task: {
      id: "TASK-RUNNER-TSC-OUTSIDE-TARGET",
      title: "Implement feature without new type errors",
      scope: { targets: [{ file: "src/feature.ts" }] },
      post_conditions: [
        { id: "POST-TARGET", type: "target_file_modified", severity: "FAIL", params: { file: "src/feature.ts" } },
        { id: "POST-TSC", type: "no_new_type_errors", severity: "FAIL", params: { command: "node tsc.js" } },
      ],
    },
  },
];
