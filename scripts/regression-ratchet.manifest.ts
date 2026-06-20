export type RegressionRatchetEntry = {
  id: string;
  summary: string;
  fix_commit_or_pr: string;
  test_file: string;
  test_name_pattern: string;
};

export const regressionRatchetManifest = [
  {
    id: "YB-044",
    summary: "malformed PRD tasks non-array returns structured check JSON instead of crashing",
    fix_commit_or_pr: "PR #44 / ca53e38",
    test_file: "__tests__/check-report.test.ts",
    test_name_pattern: "yolo check returns structured JSON when PRD tasks is not an array",
  },
  {
    id: "YB-045",
    summary: "demand dispatch alias inputs fail closed for invalid explicit demand sessions",
    fix_commit_or_pr: "PR #45 / 65932bd",
    test_file: "__tests__/demand-evidence-dispatch.test.ts",
    test_name_pattern: "explicit invalid demand session sources fail closed",
  },
  {
    id: "YB-041",
    summary: "acceptance defaults to the latest real state run report instead of lifecycle wrapper evidence",
    fix_commit_or_pr: "PR #41 / 4b0dec5",
    test_file: "__tests__/acceptance-report.test.ts",
    test_name_pattern: "P8.H1: default acceptance prefers latest state run report over lifecycle stage wrapper",
  },
  {
    id: "YB-040",
    summary: "repeated-failure fuse stops retry and review-loop phases",
    fix_commit_or_pr: "PR #40 / 4b9bea1",
    test_file: "__tests__/run-lifecycle-orchestrator.test.ts",
    test_name_pattern: "runTaskPipeline skips retry and review after repeated failure fuse",
  },
  {
    id: "YB-039",
    summary: "successful write-capable lifecycle stages refresh post-run source snapshots",
    fix_commit_or_pr: "PR #39 / d1f2bd6",
    test_file: "__tests__/lifecycle-source-snapshot.test.ts",
    test_name_pattern: "successful write-capable lifecycle stage refreshes post-run source snapshot",
  },
] satisfies RegressionRatchetEntry[];
