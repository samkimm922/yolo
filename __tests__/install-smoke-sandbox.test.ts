import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildWorkflowSkillTargetSmokePlan } from "../src/workflows/install.js";

describe("workflow skill target smoke sandbox safety", () => {
  test("smoke plan defaults to an os tmpdir sandbox, never the real cwd", () => {
    const plan = buildWorkflowSkillTargetSmokePlan({});
    const root = resolve(plan.project_root);
    assert.notEqual(root, resolve(process.cwd()));
    assert.ok(
      root.startsWith(resolve(tmpdir())),
      `smoke project_root must live under os tmpdir, got ${root}`,
    );
  });

  test("explicit projectRoot is still honored", () => {
    const explicit = resolve(tmpdir(), "yolo-explicit-smoke-root");
    const plan = buildWorkflowSkillTargetSmokePlan({ projectRoot: explicit });
    assert.equal(resolve(plan.project_root), explicit);
  });
});
