import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createYoloSdk } from "../sdk.js";
import { workflowToSkillDescriptor } from "../src/workflows/registry.js";
import {
  buildWorkflowSkillInstallPlan,
  buildWorkflowSkillTargetSmokePlan,
  installWorkflowSkills,
  inspectWorkflowSkillInstallPlan,
  runWorkflowSkillTargetSmoke,
  validateWorkflowSkillDescriptor,
} from "../src/workflows/install.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-workflow-install-"));
}

describe("workflow skill install layer", () => {
  test("validateWorkflowSkillDescriptor blocks incomplete descriptors", () => {
    const valid = validateWorkflowSkillDescriptor(workflowToSkillDescriptor("pi", { agent: "claude" }));
    assert.equal(valid.status, "pass");
    assert.equal(valid.valid, true);

    const invalid = validateWorkflowSkillDescriptor({
      ...workflowToSkillDescriptor("pi"),
      verification: [],
    });
    assert.equal(invalid.status, "invalid");
    assert.ok(invalid.errors.some((error) => error.code === "SKILL_ARRAY_EMPTY" && error.field === "verification"));
  });

  test("buildWorkflowSkillInstallPlan creates markdown and JSON artifacts without writing", () => {
    const projectRoot = tempProject();
    const plan = buildWorkflowSkillInstallPlan({
      projectRoot,
      target: "yolo",
      workflows: ["fix", "review"],
      agent: "codex",
    });

    assert.equal(plan.schema, "yolo.workflow.skill_install_plan.v1");
    assert.equal(plan.target_dir, ".yolo/skills");
    assert.equal(plan.validation.status, "pass");
    assert.deepEqual(plan.descriptors.map((descriptor) => descriptor.id), ["yolo.fix", "yolo.review"]);
    assert.ok(plan.files.some((file) => file.path === ".yolo/skills/yolo.fix/skill.json"));
    assert.ok(plan.files.some((file) => file.path === ".yolo/skills/yolo.review/SKILL.md"));
    assert.ok(plan.files.some((file) => file.path === ".yolo/skills/RULES.md"));
    assert.ok(plan.files.some((file) => file.path === ".yolo/skills/triggers.json"));
    assert.ok(plan.files.some((file) => file.path === ".yolo/skills/index.json"));
    assert.equal(existsSync(join(projectRoot, ".yolo")), false);
  });

  test("installWorkflowSkills writes skill artifacts and preserves existing files by default", () => {
    const projectRoot = tempProject();
    const first = installWorkflowSkills({
      projectRoot,
      target: "agents",
      workflows: ["fix"],
      agent: "claude",
    });

    assert.equal(first.status, "success");
    assert.equal(first.target_dir, ".agents/skills");
    assert.ok(first.created.includes(".agents/skills/yolo.fix/skill.json"));
    assert.ok(first.created.includes(".agents/skills/yolo.fix/SKILL.md"));
    assert.ok(first.created.includes(".agents/skills/RULES.md"));
    assert.ok(first.created.includes(".agents/skills/triggers.json"));
    assert.ok(first.created.includes(".agents/skills/index.json"));

    const descriptor = JSON.parse(readFileSync(join(projectRoot, ".agents/skills/yolo.fix/skill.json"), "utf8"));
    assert.equal(descriptor.schema, "yolo.workflow.skill_descriptor.v1");
    assert.equal(descriptor.agent, "claude");
    assert.equal(descriptor.entrypoints.skill, "yolo.fix");
    const skillMarkdown = readFileSync(join(projectRoot, ".agents/skills/yolo.fix/SKILL.md"), "utf8");
    assert.match(skillMarkdown, /^---\nname: "yolo\.fix"\ndescription: /);
    assert.match(skillMarkdown, /Fail closed/);
    const rules = readFileSync(join(projectRoot, ".agents/skills/RULES.md"), "utf8");
    assert.match(rules, /skill\.json/);
    assert.match(rules, /triggers\.json/);
    assert.match(rules, /Fail closed/);
    const triggerIndex = JSON.parse(readFileSync(join(projectRoot, ".agents/skills/triggers.json"), "utf8"));
    assert.equal(triggerIndex.schema, "yolo.workflow.skill_trigger_index.v1");
    assert.equal(triggerIndex.target, "agents");
    assert.ok(triggerIndex.triggers.some((item) => item.trigger === "task.pending" && item.skill_id === "yolo.fix"));

    const second = installWorkflowSkills({
      projectRoot,
      target: "agents",
      workflows: ["fix"],
      agent: "claude",
    });
    assert.equal(second.status, "success");
    assert.deepEqual(second.created, []);
    assert.ok(second.skipped.includes(".agents/skills/yolo.fix/skill.json"));
  });

  test("inspectWorkflowSkillInstallPlan detects duplicate artifact paths", () => {
    const plan = buildWorkflowSkillInstallPlan({ projectRoot: tempProject(), workflow: "ship" });
    const duplicatePlan = {
      ...plan,
      files: [plan.files[0], plan.files[0]],
    };

    const result = inspectWorkflowSkillInstallPlan(duplicatePlan);
    assert.equal(result.status, "blocked");
    assert.ok(result.errors.some((error) => error.code === "SKILL_INSTALL_DUPLICATE_PATH"));
  });

  test("inspectWorkflowSkillInstallPlan requires target rules and trigger index", () => {
    const plan = buildWorkflowSkillInstallPlan({ projectRoot: tempProject(), workflow: "fix" });
    const missingConventionPlan = {
      ...plan,
      files: plan.files.filter((file) => file.role !== "agent_rules" && file.role !== "trigger_index"),
    };

    const result = inspectWorkflowSkillInstallPlan(missingConventionPlan);
    assert.equal(result.status, "blocked");
    assert.ok(result.errors.some((error) => error.code === "SKILL_INSTALL_AGENT_RULES_MISSING"));
    assert.ok(result.errors.some((error) => error.code === "SKILL_INSTALL_TRIGGER_INDEX_MISSING"));
  });

  test("runWorkflowSkillTargetSmoke installs target matrix in an external project", () => {
    const projectRoot = tempProject();
    const packageRoot = tempProject();
    const plan = buildWorkflowSkillTargetSmokePlan({
      projectRoot,
      packageRoot,
      targets: ["yolo", "agents", "claude"],
      workflows: ["fix"],
    });

    assert.equal(plan.schema, "yolo.workflow.skill_target_smoke_plan.v1");
    assert.deepEqual(plan.targets.map((target) => target.target), ["yolo", "agents", "claude"]);
    assert.deepEqual(plan.targets.map((target) => target.target_dir), [".yolo/skills", ".agents/skills", ".claude/skills"]);
    assert.deepEqual(plan.targets.map((target) => target.agent), ["generic", "generic", "claude"]);

    const result = runWorkflowSkillTargetSmoke({
      projectRoot,
      packageRoot,
      targets: ["yolo", "agents", "claude"],
      workflows: ["fix"],
    });

    assert.equal(result.status, "pass");
    assert.equal(result.failed_checks.length, 0);
    assert.deepEqual(result.installs.map((install) => install.target_dir), [".yolo/skills", ".agents/skills", ".claude/skills"]);
    assert.equal(existsSync(join(projectRoot, ".yolo/skills/yolo.fix/skill.json")), true);
    assert.equal(existsSync(join(projectRoot, ".yolo/skills/RULES.md")), true);
    assert.equal(existsSync(join(projectRoot, ".yolo/skills/triggers.json")), true);
    assert.equal(existsSync(join(projectRoot, ".agents/skills/yolo.fix/SKILL.md")), true);
    assert.equal(existsSync(join(projectRoot, ".claude/skills/index.json")), true);
    assert.ok(result.checks.some((item) => item.code === "WORKFLOW_SKILL_TARGET_TRIGGER_INDEX_SKILLS" && item.passed));
    assert.ok(result.checks.some((item) => item.code === "WORKFLOW_SKILL_TARGET_RULES_MARKDOWN" && item.passed));
    const claudeDescriptor = JSON.parse(readFileSync(join(projectRoot, ".claude/skills/yolo.fix/skill.json"), "utf8"));
    assert.equal(claudeDescriptor.agent, "claude");
    for (const dir of ["state", "data", "logs", ".yolo", ".agents", ".claude", ".codex"]) {
      assert.equal(existsSync(join(packageRoot, dir)), false, `${dir} must not be written under package root`);
    }
  });

  test("runWorkflowSkillTargetSmoke blocks package root pollution", () => {
    const projectRoot = tempProject();
    const packageRoot = tempProject();
    installWorkflowSkills({
      projectRoot: packageRoot,
      target: "claude",
      workflows: ["fix"],
    });

    const result = runWorkflowSkillTargetSmoke({
      projectRoot,
      packageRoot,
      targets: ["claude"],
      workflows: ["fix"],
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.failed_checks.some((item) =>
      item.code === "WORKFLOW_SKILL_PACKAGE_ROOT_CLEAN" && item.dir === ".claude"
    ));
  });

  test("createYoloSdk exposes workflow skill install helpers", () => {
    const projectRoot = tempProject();
    const sdk = createYoloSdk({ projectRoot });

    assert.equal(typeof sdk.workflows.buildSkillInstallPlan, "function");
    assert.equal(typeof sdk.workflows.buildSkillTargetSmokePlan, "function");
    assert.equal(typeof sdk.workflows.installSkills, "function");
    assert.equal(typeof sdk.workflows.inspectSkillInstallPlan, "function");
    assert.equal(typeof sdk.workflows.runSkillTargetSmoke, "function");
    assert.equal(typeof sdk.workflows.validateSkillDescriptor, "function");

    const plan = sdk.workflows.buildSkillInstallPlan({ workflow: "review" });
    assert.equal(plan.project_root, projectRoot);
    assert.deepEqual(plan.descriptors.map((descriptor) => descriptor.id), ["yolo.review"]);

    const smokePlan = sdk.workflows.buildSkillTargetSmokePlan({ targets: ["agents"], workflows: ["review"] });
    assert.equal(smokePlan.project_root, projectRoot);
    assert.equal(smokePlan.targets[0].target_dir, ".agents/skills");
  });
});
