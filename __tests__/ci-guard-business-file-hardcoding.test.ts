import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCiGuard } from "../scripts/ci-guard.js";

const FIXTURE_RELATIVE = "src/lib/evaluators/__business_hardcoding_fixture.ts";
const FIXTURE_PATH = join(process.cwd(), FIXTURE_RELATIVE);

describe("ci-guard business-file hardcoding guard", () => {
  test("passes on the clean tree", () => {
    const result = runCiGuard("business-file-hardcoding");
    assert.equal(result.status, "pass", JSON.stringify(result.checks.flatMap((check: any) => check.findings), null, 2));
  });

  test("fails when a new business-file prefix allowlist is introduced", () => {
    writeFileSync(FIXTURE_PATH, [
      "export function isBusinessFixture(file: string) {",
      '  return file.startsWith("src/");',
      "}",
      "",
    ].join("\n"));
    try {
      const result = runCiGuard("business-file-hardcoding");
      assert.equal(result.status, "fail");
      const check = result.checks.find((item: any) => item.name === "business-file-hardcoding");
      assert.ok(check);
      assert.ok(
        (check.findings || []).some((finding: any) =>
          finding.file === FIXTURE_RELATIVE && finding.code === "BUSINESS_FILE_HARDCODED_PREFIX"
        ),
        JSON.stringify(check.findings, null, 2),
      );
    } finally {
      rmSync(FIXTURE_PATH, { force: true });
    }

    const after = runCiGuard("business-file-hardcoding");
    assert.equal(after.status, "pass", "fixture was not cleaned up");
  });
});
