import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../src/core/bootstrap.js";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";
import { runYoloCli } from "../src/cli/yolo.js";
import {
  buildYoloCommandRegistry,
  getYoloCommand,
  listYoloBridgeWorkflowIds,
  listYoloCommandNames,
  listYoloCommands,
  renderYoloCommandUsage,
} from "../src/workflows/command-registry.js";

function tempProject(prefix = "yolo-command-registry-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function captureIo(cwd, extra = {}) {
  const stdout = { text: "", write(chunk) { this.text += chunk; } };
  const stderr = { text: "", write(chunk) { this.text += chunk; } };
  return {
    io: { cwd, stdout, stderr, ...extra },
    stdout,
    stderr,
  };
}

function runnablePrd(id = "FIX-CLI-001") {
  return {
    version: "2.0",
    tasks: [{
      id,
      title: "Runnable CLI PRD",
      priority: "P1",
      type: "bugfix",
      status: "pending",
      description: "Exercise CLI PRD lookup.",
      scope: { targets: [{ file: "src/value.ts" }] },
      preconditions: [{ id: "PRE", type: "file_exists", params: { file: "src/value.ts" } }],
      post_conditions: [{ id: "POST", type: "code_contains", params: { file: "src/value.ts", text: "ok" } }],
    }],
  };
}

describe("YOLO command registry", () => {
  test("lists the full lifecycle command set from one source of truth", () => {
    assert.deepEqual(listYoloCommandNames(), [
      "yolo",
      "yolo-brainstorm",
      "yolo-demand",
      "yolo-interview",
      "yolo-discover",
      "yolo-discuss",
      "yolo-init",
      "yolo-setup",
      "yolo-plan",
      "yolo-prd",
      "yolo-check",
      "yolo-next",
      "yolo-run",
      "yolo-review",
      "yolo-fix",
      "yolo-accept",
      "yolo-ui-review",
      "yolo-eval",
      "yolo-release-candidate",
      "yolo-ship",
      "yolo-learn",
      "yolo-doctor",
      "yolo-install",
    ]);
  });

  test("classifies no-code and code-writing commands", () => {
    assert.deepEqual(listYoloCommands({ writesCode: true }).map((command) => command.name), [
      "yolo-run",
      "yolo-fix",
    ]);
    assert.equal(listYoloCommands({ noCode: true }).some((command) => command.name === "yolo-doctor"), true);
    assert.deepEqual(listYoloCommands({ recommended: true }).map((command) => command.name).slice(0, 3), [
      "yolo",
      "yolo-demand",
      "yolo-init",
    ]);
    assert.deepEqual(listYoloCommands({ compatibilityAliases: true }).map((command) => command.name), [
      "yolo-brainstorm",
      "yolo-interview",
      "yolo-discover",
      "yolo-discuss",
    ]);
    assert.equal(getYoloCommand("/yolo-setup").lifecycle_stage, "setup");
    assert.equal(getYoloCommand("/yolo-prd").lifecycle_stage, "prd");
    assert.equal(getYoloCommand("/yolo-interview").alias_for, "yolo-demand");
    assert.throws(() => getYoloCommand("wat"), /Unknown YOLO command/);
  });

  test("public mainline excludes implementation engines from recommended commands", () => {
    const names = listYoloCommands({ recommended: true }).map((command) => command.name);
    const engineNames = ["runner", "pi", "gate", "preflight", "yolo-runner", "yolo-pi", "yolo-gate", "yolo-prd-preflight"];

    assert.deepEqual(names.slice(0, 6), [
      "yolo",
      "yolo-demand",
      "yolo-init",
      "yolo-setup",
      "yolo-plan",
      "yolo-prd",
    ]);
    assert.equal(names.includes("yolo-check"), true);
    assert.equal(names.includes("yolo-run"), true);
    for (const name of names) assert.match(name, /^yolo(?:-|$)/);
    for (const name of engineNames) assert.equal(names.includes(name), false, `${name} must stay out of the public mainline`);

    const run = getYoloCommand("yolo-run");
    assert.equal(run.writes_code, true);
    assert.equal(run.requires_confirmation, true);
    assert.match(run.safety, /checked PRD/);
  });

  test("demand command defaults to one-question interview before PRD", () => {
    const demand = getYoloCommand("yolo-demand");
    const interview = getYoloCommand("yolo-interview");
    const demandText = [demand.description, demand.objective, demand.safety, demand.usage].join("\n");
    const interviewText = [interview.description, interview.objective, interview.safety, interview.usage].join("\n");

    assert.match(demandText, /one-question/);
    assert.match(demandText, /next_question/);
    assert.match(demandText, /不输出大段建议/);
    assert.match(demandText, /不进入 PRD/);
    assert.match(demandText, /批准最后/);
    assert.match(demandText, /不改代码/);
    assert.match(demandText, /do not enter PRD/i);
    assert.equal(demand.writes_code, false);
    assert.equal(demand.requires_confirmation, false);

    assert.equal(interview.alias_for, "yolo-demand");
    assert.match(interviewText, /same one-question demand interview host contract/);
    assert.match(interviewText, /next_question/);
    assert.match(interviewText, /不输出大段建议/);
    assert.match(interviewText, /不进入 PRD/);
    assert.match(interviewText, /不改代码/);
  });

  test("registry includes bridge workflows and command usage examples", () => {
    const registry = buildYoloCommandRegistry();

    assert.equal(registry.schema, "yolo.workflow.command_registry.v1");
    assert.deepEqual(listYoloBridgeWorkflowIds(), [
      "brainstorm",
      "demand",
      "interview",
      "discover",
      "discuss",
      "plan",
      "prd",
      "check",
      "pi",
      "review",
      "fix",
      "accept",
      "eval",
      "ship",
      "learn",
      "doctor",
    ]);
    assert.match(renderYoloCommandUsage("yolo-doctor"), /\/yolo-doctor/);
    assert.match(renderYoloCommandUsage("yolo-demand"), /聊清楚/);
    assert.match(renderYoloCommandUsage("yolo-demand"), /--stage dispatch/);
    assert.match(renderYoloCommandUsage("yolo-interview"), /一问一答/);
  });

  test("root CLI dispatches yolo-install through the registered install handler", async () => {
    const root = tempProject("yolo-install-cli-");
    try {
      const { io, stdout, stderr } = captureIo(root);
      const exitCode = await runYoloCli(["install", root, "--dry-run", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(stderr.text, "");
      assert.equal(exitCode, 0);
      assert.equal(payload.schema, "yolo.agent_bridge_install_result.v1");
      assert.equal(payload.status, "success");
      assert.equal(payload.dry_run, true);
      assert.equal(payload.project_root, root);
      assert.deepEqual(payload.scopes, ["project"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo run without PRD fails closed instead of using the YOLO package PRD", async () => {
    const root = tempProject("yolo-run-target-");
    const yoloRoot = tempProject("yolo-package-root-");
    try {
      mkdirSync(join(yoloRoot, "data/prd/current"), { recursive: true });
      writeFileSync(join(yoloRoot, "data/prd/current/package-prd.json"), JSON.stringify(runnablePrd("FIX-PACKAGE-001")), "utf8");

      const { io, stdout, stderr } = captureIo(root, { yoloRoot });
      const exitCode = await runYoloCli(["run", "--dry-run", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(stderr.text, "");
      assert.equal(exitCode, 2);
      assert.equal(payload.code, "MISSING_PRD_PATH");
      assert.match(payload.next_actions[0], /\.yolo\/data\/prd\/current/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(yoloRoot, { recursive: true, force: true });
    }
  });

  test("yolo review keeps cwd as project root and treats path arguments as review scope", async () => {
    const root = tempProject("yolo-review-scope-");
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/a.ts"), "console.log('a');\n", "utf8");
      writeFileSync(join(root, "src/b.ts"), "console.log('b');\n", "utf8");
      initProject({ projectRoot: root });
      writeLifecycleStageReport("run", {
        status: "success",
        summary: "run completed for scoped review test",
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        source: "command-registry-test",
        writeSessionMemory: false,
      });

      const { io, stdout, stderr } = captureIo(root);
      const exitCode = await runYoloCli(["review", "src/a.ts", "--cwd", root, "--json", "--no-write"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(stderr.text, "");
      assert.equal(exitCode, 0);
      assert.equal(payload.project_root, root);
      assert.deepEqual(payload.review_scope, ["src/a.ts"]);
      assert.equal(payload.scan.scanned_files, 1);
      assert.deepEqual([...new Set(payload.findings.map((finding) => finding.file))], ["src/a.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("demand compatibility aliases have matching yolo demand --stage handlers", async () => {
    const root = tempProject("yolo-demand-stage-");
    const demandText = [
      "Problem: stockouts are found too late",
      "Target User: store managers",
      "Success: manager sees a low stock alert before shelf-out",
      "Status quo: managers scan spreadsheets manually",
      "Evidence: support tickets mention missed replenishment",
      "Assumption: existing inventory feed is available",
      "Constraint: do not change billing",
      "Non-goal: no purchasing automation",
      "Scope: src/inventory/alerts.ts",
    ].join(". ");
    try {
      const aliases = listYoloCommands({ compatibilityAliases: true });
      assert.deepEqual(aliases.map((command) => [command.name, command.alias_for, command.demand_stage]), [
        ["yolo-brainstorm", "yolo-demand", "brainstorm"],
        ["yolo-interview", "yolo-demand", "interview"],
        ["yolo-discover", "yolo-demand", "discover"],
        ["yolo-discuss", "yolo-demand", "discuss"],
      ]);
      const prdCommand = getYoloCommand("yolo-prd");
      assert.equal(prdCommand.alias_for, undefined);
      assert.doesNotMatch(prdCommand.description, /Compatibility alias/);

      const checks = [
        { stage: "brainstorm", argv: ["demand", "--stage", "brainstorm", demandText, "--cwd", root, "--json", "--no-write"], code: "DEMAND_READY" },
        { stage: "interview", argv: ["demand", "--stage", "interview", "Need low stock alerts", "--cwd", root, "--json", "--no-write"], code: "INTERVIEW_OK" },
        { stage: "discover", argv: ["demand", "--stage", "discover", "Inventory alerts need clearer success criteria", "--cwd", root, "--json", "--no-write"], code: "DISCOVERY_BLOCKED" },
        { stage: "discuss", argv: ["demand", "--stage", "discuss", demandText, "--approve", "--cwd", root, "--json", "--no-write"], code: "DEMAND_BLOCKED" },
      ];

      for (const check of checks) {
        const { io, stdout, stderr } = captureIo(root);
        const exitCode = await runYoloCli(check.argv, io);
        const payload = JSON.parse(stdout.text);

        assert.equal(stderr.text, "", check.stage);
        assert.notEqual(payload.code, "UNKNOWN_DEMAND_COMMAND", check.stage);
        assert.notEqual(payload.code, "UNKNOWN_DEMAND_STAGE", check.stage);
        assert.equal(payload.code, check.code, check.stage);
        assert.ok([0, 1].includes(exitCode), check.stage);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
