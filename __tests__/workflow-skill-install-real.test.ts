import { describe, test } from "node:test";
import assert from "node:assert/strict";

describe("workflow skill install produces real content", () => {
  test("buildWorkflowSkillInstallPlan outputs non-stub SKILL.md content for each workflow", async () => {
    const { buildWorkflowSkillInstallPlan } = await import("../src/workflows/install.js");
    const { listWorkflows } = await import("../src/workflows/registry.js");
    const workflows = listWorkflows();
    assert.ok(workflows.length > 0, "registry must have at least one workflow");

    for (const workflow of workflows) {
      const plan = buildWorkflowSkillInstallPlan({
        projectRoot: "/tmp/yolo-real-content-test",
        target: "yolo",
        workflows: [workflow.id],
        agent: "generic",
      });

      const skillMdFile = plan.files.find(
        (file) => file.role === "skill_markdown" && file.descriptor_id === workflow.entrypoints.skill,
      );
      assert.ok(
        skillMdFile,
        `SKILL.md file must be present in plan for workflow "${workflow.id}"`,
      );

      const content = skillMdFile.content;

      // Must not be a stub
      assert.ok(
        !content.includes("# YOLO test artifact"),
        `SKILL.md for "${workflow.id}" must not be a stub artifact`,
      );

      // Must be a real skill markdown: heading, purpose section, entrypoints
      assert.match(
        content,
        /^# /m,
        `SKILL.md for "${workflow.id}" must start with a markdown heading`,
      );
      assert.ok(
        content.includes("## Purpose"),
        `SKILL.md for "${workflow.id}" must contain a Purpose section`,
      );
      assert.ok(
        content.includes("## Entrypoints"),
        `SKILL.md for "${workflow.id}" must contain an Entrypoints section`,
      );
      assert.ok(
        content.includes("Fail closed"),
        `SKILL.md for "${workflow.id}" must include fail-closed execution contract`,
      );
      assert.ok(
        content.includes(workflow.entrypoints.cli),
        `SKILL.md for "${workflow.id}" must reference its CLI entrypoint`,
      );

      // Content must be substantive — at least 200 chars
      assert.ok(
        content.length >= 200,
        `SKILL.md for "${workflow.id}" must be substantive (got ${content.length} chars)`,
      );
    }
  });

  test("buildWorkflowSkillInstallPlan SKILL.md content matches descriptor fields", async () => {
    const { buildWorkflowSkillInstallPlan } = await import("../src/workflows/install.js");

    const plan = buildWorkflowSkillInstallPlan({
      projectRoot: "/tmp/yolo-real-content-test",
      target: "yolo",
      workflows: ["fix"],
      agent: "generic",
    });

    const descriptor = plan.descriptors[0];
    const skillMdFile = plan.files.find((file) => file.role === "skill_markdown" && file.descriptor_id === "yolo.fix");
    assert.ok(skillMdFile, "SKILL.md file for yolo.fix must be present");

    const content = skillMdFile.content;
    // Heading must match workflow label
    assert.ok(
      content.includes(descriptor.name),
      `SKILL.md must include the workflow label "${descriptor.name}"`,
    );
    // Workflow id must appear
    assert.ok(
      content.includes(descriptor.workflow),
      `SKILL.md must reference the workflow id "${descriptor.workflow}"`,
    );
    // Purpose text must appear
    assert.ok(
      content.includes(descriptor.purpose),
      `SKILL.md must include the purpose text`,
    );
  });

  test("buildWorkflowSkillInstallPlan includes discover and learn workflows with real SKILL.md", async () => {
    const { buildWorkflowSkillInstallPlan } = await import("../src/workflows/install.js");

    for (const workflowId of ["discover", "learn"]) {
      const plan = buildWorkflowSkillInstallPlan({
        projectRoot: "/tmp/yolo-real-content-test",
        target: "yolo",
        workflows: [workflowId],
        agent: "generic",
      });

      assert.equal(plan.validation.status, "pass", `Plan for "${workflowId}" must be valid`);
      assert.ok(plan.descriptors.length === 1, `Plan for "${workflowId}" must have exactly one descriptor`);

      const descriptor = plan.descriptors[0];
      assert.equal(descriptor.workflow, workflowId, `Descriptor workflow must match "${workflowId}"`);

      const skillMdFile = plan.files.find(
        (file) => file.role === "skill_markdown" && file.descriptor_id === descriptor.id,
      );
      assert.ok(skillMdFile, `SKILL.md must be present in plan for "${workflowId}"`);

      const content = skillMdFile.content;
      assert.ok(
        !content.includes("# YOLO test artifact"),
        `SKILL.md for "${workflowId}" must not be a stub`,
      );
      assert.ok(
        content.includes("## Purpose"),
        `SKILL.md for "${workflowId}" must have a Purpose section`,
      );
      assert.ok(
        content.includes("Fail closed"),
        `SKILL.md for "${workflowId}" must include fail-closed contract`,
      );
    }
  });

  test("all workflows in listWorkflows have valid install plan status", async () => {
    const { buildWorkflowSkillInstallPlan } = await import("../src/workflows/install.js");
    const { listWorkflows } = await import("../src/workflows/registry.js");
    const workflows = listWorkflows();

    const plan = buildWorkflowSkillInstallPlan({
      projectRoot: "/tmp/yolo-real-content-test",
      target: "yolo",
      agent: "generic",
    });

    assert.equal(plan.validation.status, "pass", "All-workflows install plan must pass validation");
    assert.equal(plan.descriptors.length, workflows.length, "Plan must include every registered workflow");

    const skillMdFiles = plan.files.filter((file) => file.role === "skill_markdown");
    assert.equal(
      skillMdFiles.length,
      workflows.length,
      "Plan must include one SKILL.md per workflow",
    );

    for (const file of skillMdFiles) {
      assert.ok(
        file.content.includes("Fail closed"),
        `SKILL.md for descriptor "${file.descriptor_id}" must include fail-closed contract`,
      );
      assert.ok(
        !file.content.includes("# YOLO test artifact"),
        `SKILL.md for descriptor "${file.descriptor_id}" must not be a stub`,
      );
    }
  });
});
