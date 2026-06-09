import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { detectProjectState } from "../src/demand/project-state-detector.js";
import { inspectDemandTriage } from "../src/demand/router.js";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "yolo-project-state-"));
}

function write(root: string, rel: string, content: string) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("project state detector (brownfield from filesystem, not wording)", () => {
  test("empty project has no existing code", () => {
    const root = tempRoot();
    try {
      const state = detectProjectState(root);
      assert.equal(state.has_existing_code, false);
      assert.equal(state.source_file_count, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("project with a source file is detected as existing code regardless of wording", () => {
    const root = tempRoot();
    try {
      write(root, "src/app.ts", "export const x = 1;\n");
      const state = detectProjectState(root);
      assert.equal(state.has_existing_code, true);
      assert.ok(state.source_file_count >= 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("node_modules and dist are ignored when counting source files", () => {
    const root = tempRoot();
    try {
      write(root, "node_modules/pkg/index.js", "module.exports = {};\n");
      write(root, "dist/bundle.js", "console.log(1);\n");
      const state = detectProjectState(root);
      assert.equal(state.has_existing_code, false);
      assert.equal(state.source_file_count, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing project root is safe (no existing code)", () => {
    const state = detectProjectState(join(tmpdir(), "yolo-does-not-exist-xyz-123"));
    assert.equal(state.has_existing_code, false);
  });

  test("greenfield wording in a project that already has code is classified brownfield", () => {
    const root = tempRoot();
    try {
      write(root, "src/app.ts", "export function run() { return 1; }\n");
      const triage = inspectDemandTriage(
        { objective: "Brand new feature idea from scratch for a startup MVP", projectRoot: root },
        { projectRoot: root },
      );
      assert.notEqual(triage.context_type, "greenfield");
      assert.ok(triage.reason_codes.includes("EXISTING_PROJECT_FACTS"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty project with greenfield wording stays greenfield", () => {
    const root = tempRoot();
    try {
      const triage = inspectDemandTriage(
        { objective: "Brand new feature idea from scratch for a startup MVP", projectRoot: root },
        { projectRoot: root },
      );
      assert.equal(triage.context_type, "greenfield");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
