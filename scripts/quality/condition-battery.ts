// Quality-score condition evaluator battery: individual evaluators must fail closed
// when their target evidence is missing or untrustworthy.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evalCodeNotContains } from "../../src/lib/evaluators/code-check.js";
import { evalFileLinesMax } from "../../src/lib/evaluators/file-check.js";
import { evaluatePostConditions } from "../../src/prd/contract.js";

type ConditionBatteryCase = {
  id: string;
  category: "condition_evaluator_robustness";
  description: string;
  expect: "blocked";
  run: (root: string) => unknown;
};

type ConditionBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

const CONDITION_BATTERY: ConditionBatteryCase[] = [
  {
    id: "code_not_contains_missing_target_blocks",
    category: "condition_evaluator_robustness",
    description: "code_not_contains must not pass when every requested target file is missing.",
    expect: "blocked",
    run: (root) => evalCodeNotContains(
      { file: "src/missing.ts", text: "SECRET" },
      { targets: [{ file: "src/missing.ts" }] },
      root,
    ),
  },
  {
    id: "file_lines_max_missing_target_blocks",
    category: "condition_evaluator_robustness",
    description: "file_lines_max must not pass when the requested target file is missing.",
    expect: "blocked",
    run: (root) => evalFileLinesMax(
      { file: "src/missing.ts", max: 150 },
      { targets: [{ file: "src/missing.ts" }] },
      root,
    ),
  },
  {
    id: "target_file_modified_path_escape_blocks",
    category: "condition_evaluator_robustness",
    description: "target_file_modified must block repo-escaping target paths even when changedFiles echoes the same escape.",
    expect: "blocked",
    run: (root) => {
      const report = evaluatePostConditions({
        id: "TASK-PATH-ESCAPE",
        scope: { targets: [{ file: "../sibling/src/feature.ts" }] },
        post_conditions: [{
          id: "POST-TARGET",
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: "../sibling/src/feature.ts" },
        }],
      }, {}, {
        root,
        cwd: root,
        changedFiles: ["../sibling/src/feature.ts"],
      }) as { results?: Array<{ id?: string; passed?: boolean }> };
      return report.results?.find((result) => result.id === "POST-TARGET") || {};
    },
  },
];

function statusFromResult(result: unknown) {
  const record = (result || {}) as { passed?: boolean };
  return record.passed === true ? "pass" : "blocked";
}

export function runConditionBattery(): ConditionBatteryResult[] {
  return CONDITION_BATTERY.map((testCase) => {
    const root = mkdtempSync(join(tmpdir(), "yolo-condition-battery-"));
    try {
      const status = statusFromResult(testCase.run(root));
      const correct = status === testCase.expect;
      return {
        id: testCase.id,
        category: testCase.category,
        expect: testCase.expect,
        actualExit: status === "pass" ? 0 : 1,
        actualStatus: status,
        correct,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
