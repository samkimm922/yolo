import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectPrdContract } from "../src/runtime/gates/prd-contract-doctor.js";

const REGRESSION_FIXTURES = [
  "backend-api",
  "frontend-vite",
  "python-basic",
  "monorepo",
  "node-basic",
  "python-service",
  "dirty-tree",
  "failing-baseline",
];

function prdWithPostCondition(postCondition, scope = {}) {
  return {
    version: "2.0",
    id: "PRD-TARGET-COVERAGE",
    tasks: [{
      id: "TASK-TARGET-COVERAGE",
      status: "pending",
      scope: { targets: [{ file: "src/service.ts" }], ...scope },
      post_conditions: [postCondition],
    }],
  };
}

function targetCoverageFailures(result) {
  return result.failures.filter((finding) => finding.code === "TASK_TARGETS_MISSING_EXECUTABLE_COVERAGE");
}

describe("PRD target coverage narrowing", () => {
  for (const [type, params] of [
    ["tests_pass", { command: "npm test" }],
    ["test_file_passes", { command: "npm test", file: "test/service.test.ts" }],
  ]) {
    test(`${type} behavior verification covers declared targets`, () => {
      const result = inspectPrdContract(prdWithPostCondition({
        id: "POST-BEHAVIOR",
        type,
        severity: "FAIL",
        params,
      }));

      assert.equal(targetCoverageFailures(result).length, 0);
    });
  }

  test("non-behavior checks still require target-specific coverage for business-code tasks", () => {
    const result = inspectPrdContract(prdWithPostCondition({
      id: "POST-OTHER-FILE",
      type: "file_exists",
      severity: "FAIL",
      params: { file: "state/evidence.json" },
    }));

    assert.deepEqual(targetCoverageFailures(result)[0]?.missing_targets, ["src/service.ts"]);
  });

  test("typecheck alone does not prove target behavior", () => {
    const result = inspectPrdContract(prdWithPostCondition({
      id: "POST-TYPECHECK",
      type: "no_new_type_errors",
      severity: "FAIL",
      params: { command: "npm run typecheck" },
    }));

    assert.deepEqual(targetCoverageFailures(result)[0]?.missing_targets, ["src/service.ts"]);
  });

  for (const fixture of REGRESSION_FIXTURES) {
    test(`${fixture} expected-zero task is exempt from target-modification coverage`, () => {
      const prd = JSON.parse(readFileSync(resolve(`fixtures/${fixture}/prd.json`), "utf8"));
      const result = inspectPrdContract(prd);

      assert.ok(prd.tasks.every((task) => task.scope?.expected_zero_business_code === true));
      assert.equal(targetCoverageFailures(result).length, 0);
    });
  }
});
