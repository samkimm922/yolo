import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../src/core/bootstrap.js";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";
import { runYoloCli } from "../src/cli/yolo.js";
import {
  DEFAULT_YOLO_PUBLIC_COMMAND_NAMES,
  YOLO_COMMAND_SURFACE_BUDGET,
  buildYoloCommandRegistry,
  getYoloCommand,
  inspectYoloCommandRegistry,
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
  test("lists the 8 stable user-facing commands by default", () => {
    assert.equal(YOLO_COMMAND_SURFACE_BUDGET, 8);
    assert.deepEqual(DEFAULT_YOLO_PUBLIC_COMMAND_NAMES, [
      "status",
      "demand",
      "spec",
      "tasks",
      "run",
      "check",
      "review",
      "release",
    ]);
    assert.deepEqual(listYoloCommandNames(), DEFAULT_YOLO_PUBLIC_COMMAND_NAMES);
    assert.ok(listYoloCommandNames({ includeHidden: true }).length > DEFAULT_YOLO_PUBLIC_COMMAND_NAMES.length);
  });

  test("classifies no-code and code-writing commands", () => {
    assert.deepEqual(listYoloCommands({ writesCode: true }).map((command) => command.name), [
      "run",
      "yolo-fix",
      "runner",
    ]);
    assert.equal(listYoloCommands({ noCode: true }).some((command) => command.name === "doctor"), true);
    assert.deepEqual(listYoloCommands({ recommended: true }).map((command) => command.name), DEFAULT_YOLO_PUBLIC_COMMAND_NAMES);
    assert.ok(listYoloCommands({ compatibilityAliases: true }).every((command) => command.stability === "compat"));
    assert.equal(getYoloCommand("/yolo-setup").stability, "internal");
    assert.equal(getYoloCommand("/yolo-prd").alias_for, "spec");
    assert.equal(getYoloCommand("/yolo-interview").alias_for, "demand");
    assert.equal(getYoloCommand("yolo demand").name, "demand");
    assert.throws(() => getYoloCommand("wat"), /Unknown YOLO command/);
  });

  test("public mainline excludes compatibility aliases and implementation engines", () => {
    const names = listYoloCommands({ recommended: true }).map((command) => command.name);
    const hiddenNames = ["office-hours", "runner", "pi", "gate", "preflight", "yolo-runner", "yolo-pi", "yolo-gate", "yolo-prd-preflight", "yolo-release-candidate"];

    assert.deepEqual(names, DEFAULT_YOLO_PUBLIC_COMMAND_NAMES);
    assert.equal(names.length, 8);
    assert.equal(names.includes("check"), true);
    assert.equal(names.includes("run"), true);
    for (const name of hiddenNames) assert.equal(names.includes(name), false, `${name} must stay out of the public mainline`);

    const run = getYoloCommand("run");
    assert.equal(run.writes_code, true);
    assert.equal(run.requires_confirmation, true);
    assert.match(run.safety, /checked PRD/);
  });

  test("demand command defaults to one-question interview before PRD", () => {
    const demand = getYoloCommand("demand");
    const interview = getYoloCommand("yolo-interview");
    const officeHours = getYoloCommand("office-hours");
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

    assert.equal(interview.alias_for, "demand");
    assert.match(interviewText, /same one-question demand interview host contract/);
    assert.match(interviewText, /next_question/);
    assert.match(interviewText, /不输出大段建议/);
    assert.match(interviewText, /不进入 PRD/);
    assert.match(interviewText, /不改代码/);
    assert.equal(officeHours.alias_for, "demand");
    assert.equal(officeHours.visibility, "hidden");
    assert.match(officeHours.usage, /yolo demand --mode office-hours/);
  });

  test("registry includes bridge workflows, surface budget, and command usage examples", () => {
    const registry = buildYoloCommandRegistry();
    const inspection = inspectYoloCommandRegistry(registry);

    assert.equal(registry.schema, "yolo.workflow.command_registry.v1");
    assert.equal(registry.schema_version, "1.1");
    assert.equal(registry.surface_budget, 8);
    assert.equal(inspection.status, "pass");
    assert.equal(inspection.collisions.length, 0);
    assert.deepEqual(registry.commands.map((command) => command.name), DEFAULT_YOLO_PUBLIC_COMMAND_NAMES);
    assert.equal(registry.default_surface.length, 8);
    assert.ok(registry.all_commands.length > registry.commands.length);
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
    assert.match(renderYoloCommandUsage("status"), /yolo status/);
    assert.match(renderYoloCommandUsage("demand"), /office-hours/);
    assert.match(renderYoloCommandUsage("yolo-prd"), /yolo spec/);
    assert.match(renderYoloCommandUsage("yolo-interview"), /--stage interview/);
  });

  test("status/spec/tasks/release stable routes are present", async () => {
    const root = tempProject("yolo-stable-routes-");
    try {
      const { io, stdout, stderr } = captureIo(root);
      const exitCode = await runYoloCli(["status", "--cwd", root, "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(stderr.text, "");
      assert.equal(exitCode, 0);
      assert.equal(payload.code, "YOLO_NEXT_READY");
      assert.deepEqual(["status", "spec", "tasks", "release"].map((name) => getYoloCommand(name).stability), [
        "stable",
        "stable",
        "stable",
        "stable",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      const aliases = listYoloCommands({ compatibilityAliases: true }).filter((command) => command.alias_for === "demand");
      assert.deepEqual(aliases.map((command) => [command.name, command.alias_for, command.demand_stage]), [
        ["yolo-brainstorm", "demand", "brainstorm"],
        ["yolo-interview", "demand", "interview"],
        ["yolo-discover", "demand", "discover"],
        ["yolo-discuss", "demand", "discuss"],
        ["office-hours", "demand", undefined],
      ]);
      const prdCommand = getYoloCommand("yolo-prd");
      assert.equal(prdCommand.alias_for, "spec");
      assert.equal(prdCommand.visibility, "hidden");

      const checks = [
        { stage: "brainstorm", argv: ["demand", "--stage", "brainstorm", demandText, "--cwd", root, "--json", "--no-write"], codes: ["DEMAND_READY", "DEMAND_WARNING"] },
        { stage: "interview", argv: ["demand", "--stage", "interview", "Need low stock alerts", "--cwd", root, "--json", "--no-write"], code: "INTERVIEW_OK" },
        { stage: "discover", argv: ["demand", "--stage", "discover", "Inventory alerts need clearer success criteria", "--cwd", root, "--json", "--no-write"], code: "DISCOVERY_BLOCKED" },
        { stage: "discuss", argv: ["demand", "--stage", "discuss", demandText, "--approve", "--cwd", root, "--json", "--no-write"], code: "DEMAND_BLOCKED" },
        { stage: "office-hours", argv: ["office-hours", "Need low stock alerts", "--cwd", root, "--json", "--no-write"], codes: ["DEMAND_BLOCKED", "DEMAND_STATUS_READY", "OFFICE_HOURS_CHOICE_REQUIRED"] },
      ];

      for (const check of checks) {
        const { io, stdout, stderr } = captureIo(root);
        const exitCode = await runYoloCli(check.argv, io);
        const payload = JSON.parse(stdout.text);

        assert.equal(stderr.text, "", check.stage);
        assert.notEqual(payload.code, "UNKNOWN_DEMAND_COMMAND", check.stage);
        assert.notEqual(payload.code, "UNKNOWN_DEMAND_STAGE", check.stage);
        if (check.codes) assert.ok(check.codes.includes(payload.code), `${check.stage}: ${payload.code}`);
        else assert.equal(payload.code, check.code, check.stage);
        assert.equal(exitCode, payload.status === "warning" ? 2 : payload.status === "blocked" || payload.status === "error" ? 1 : 0, check.stage);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("public yolo demand status exits nonzero when demand evidence is missing", async () => {
    const root = tempProject("yolo-demand-status-missing-");
    try {
      const { io, stdout, stderr } = captureIo(root);
      const exitCode = await runYoloCli(["demand", "status", "--demand", "missing-session.json", "--cwd", root, "--json", "--no-write"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(stderr.text, "");
      assert.notEqual(exitCode, 0);
      assert.equal(payload.status, "blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
