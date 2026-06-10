import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { scopedOutOfScopeFiles } from "../src/runtime/execution/change-set.js";

describe("scopedOutOfScopeFiles — empty scope targets", () => {
  test("returns unscoped:true when task has no scope targets", () => {
    const result = scopedOutOfScopeFiles(["src/a.ts"], {});
    assert.equal(result.unscoped, true);
    assert.deepEqual(result.targetFiles, []);
    assert.deepEqual(result.outOfScope, []);
  });

  test("returns unscoped:true when task scope.targets is empty array", () => {
    const result = scopedOutOfScopeFiles(["src/a.ts"], { scope: { targets: [] } });
    assert.equal(result.unscoped, true);
    assert.deepEqual(result.targetFiles, []);
    assert.deepEqual(result.outOfScope, []);
  });

  test("returns unscoped:true when files list is empty but targets is also empty", () => {
    const result = scopedOutOfScopeFiles([], {});
    assert.equal(result.unscoped, true);
  });

  test("does NOT include unscoped when targets are present and files list is empty", () => {
    const result = scopedOutOfScopeFiles([], {
      scope: { targets: [{ file: "src/a.ts" }] },
    });
    assert.equal(result.unscoped, undefined);
    assert.deepEqual(result.targetFiles, ["src/a.ts"]);
    assert.deepEqual(result.outOfScope, []);
  });

  test("does NOT include unscoped when targets are present and scope filtering runs", () => {
    const result = scopedOutOfScopeFiles(
      ["src/a.ts", "src/b.ts"],
      { scope: { targets: [{ file: "src/a.ts" }] } },
      { isFileAllowedByScope: (file) => file === "src/a.ts" },
    );
    assert.equal(result.unscoped, undefined);
    assert.deepEqual(result.outOfScope, ["src/b.ts"]);
  });
});
