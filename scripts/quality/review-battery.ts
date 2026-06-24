// Quality-score review scanner battery: review coverage metadata must fail closed
// even when the scanner reports findings.

import { inspectReviewScannerCoverage } from "../../src/runtime/review-loop/execution-helpers.js";

type ReviewBatteryCase = {
  id: string;
  category: "review_coverage_robustness";
  description: string;
  expect: "blocked";
  scanResult: string;
  expectedFiles?: string[];
};

type ReviewBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

const REVIEW_BATTERY: ReviewBatteryCase[] = [
  {
    id: "review_coverage_incomplete_blocks_even_with_findings",
    category: "review_coverage_robustness",
    description: "Coverage_status=incomplete must block even when findings are present.",
    expect: "blocked",
    scanResult: JSON.stringify({
      findings: [
        { file: "src/a.ts", severity: "error", rule_id: "unsafe", message: "Unsafe pattern" },
      ],
      coverage_artifact: {
        scanner_version: "battery",
        scanned_files: ["src/a.ts"],
        rules: ["unsafe"],
        expected_scope: ["src/a.ts", "src/b.ts"],
        coverage_status: "incomplete",
        missing_expected_files: ["src/b.ts"],
      },
    }),
  },
  {
    id: "scanner_cannot_self_greenlight_without_covering_changed_files",
    category: "review_coverage_robustness",
    description: "Scanner complete coverage claims must cover the external changed-file scope.",
    expect: "blocked",
    expectedFiles: ["src/changed.ts"],
    scanResult: JSON.stringify({
      findings: [],
      coverage_artifact: {
        scanner_version: "battery",
        scanned_files: ["src/unrelated.ts"],
        rules: ["unsafe"],
        expected_scope: ["src/changed.ts"],
        coverage_status: "complete",
      },
    }),
  },
];

export function runReviewBattery(): ReviewBatteryResult[] {
  return REVIEW_BATTERY.map((testCase) => {
    const result = inspectReviewScannerCoverage(
      testCase.scanResult,
      null,
      { expectedFiles: testCase.expectedFiles || [] },
    ) as { blocks_execution?: boolean; status?: string };
    const status = result.blocks_execution ? "blocked" : String(result.status || "pass");
    const correct = status === testCase.expect;
    return {
      id: testCase.id,
      category: testCase.category,
      expect: testCase.expect,
      actualExit: status === "blocked" ? 1 : 0,
      actualStatus: status,
      correct,
    };
  });
}
