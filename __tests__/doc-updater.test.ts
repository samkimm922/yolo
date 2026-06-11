import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateDocs } from "../src/runtime/execution/doc-updater.js";

describe("doc updater", () => {
  test("writes session snapshot and delivery docs under the provided project root", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "yolo-doc-updater-"));
    try {
      await updateDocs({
        taskId: "T-DOC",
        taskTitle: "Doc root",
        modifiedFiles: ["src/a.ts"],
        status: "PASS",
      }, {
        rootDir,
        execFileSync: () => "",
      });

      const session = join(rootDir, "docs/memory/SESSION.md");
      const snapshot = join(rootDir, "docs/memory/SNAPSHOT.md");
      const delivery = join(rootDir, "docs/memory/DELIVERY_LOG.md");

      assert.equal(existsSync(session), true);
      assert.equal(existsSync(snapshot), true);
      assert.equal(existsSync(delivery), true);
      assert.match(readFileSync(session, "utf8"), /T-DOC/);
      assert.match(readFileSync(delivery, "utf8"), /src\/a\.ts/);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
