import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildPrdFromFindings } from "../src/prd/audit-to-prd.js";

function finding(files: string[]) {
  return {
    id: "AUDIT-BIZ-001",
    severity: "HIGH",
    kind: "atomic_fix",
    type: "business_layout",
    description: "Update business layout files",
    files,
  };
}

describe("audit-to-prd business file classification", () => {
  test("does not mark declared app/lib layout targets as zero-business", () => {
    const result = buildPrdFromFindings([
      finding(["app/page.tsx", "lib/store.ts"]),
    ], { config: { project: { business_file_patterns: ["app/**", "lib/**"] } } });

    assert.equal(result.prd.tasks[0].scope.expected_zero_business_code, undefined);
  });

  test("honors configured business_globs when deciding zero-business tasks", () => {
    const result = buildPrdFromFindings([
      finding(["components/nav.tsx"]),
    ], { config: { build: { business_globs: ["app/**", "lib/**"] } } });

    assert.equal(result.prd.tasks[0].scope.expected_zero_business_code, true);
  });
});
