import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execNodeScript } from "../src/runtime/runner-core-helpers.js";

describe("runner core helper execution", () => {
  test("fails loudly when the requested helper script is missing", () => {
    const toolsRoot = mkdtempSync(join(tmpdir(), "yolo-tools-root-"));
    try {
      const result = execNodeScript("prompt.js", [], { toolsRoot, cwd: toolsRoot });

      assert.equal(result.ok, false);
      assert.equal(result.stdout, "");
      assert.equal(result.code, "HELPER_SCRIPT_NOT_FOUND");
      assert.equal(result.helperMissing, true);
      assert.match(result.stderr, /helper script not found/);
      assert.match(result.stderr, /prompt\.js/);
      assert.match(result.stderr, new RegExp(toolsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(toolsRoot, { recursive: true, force: true });
    }
  });
});
