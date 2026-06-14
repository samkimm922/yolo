import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { initLifecycleState } from "../src/lifecycle/state.js";
import { inspectLifecycleGuard, nextLifecycleAction } from "../src/lifecycle/guard.js";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";
import { runYoloCli, KNOWN_YOLO_COMMAND_WORDS } from "../src/cli/yolo.js";
import { runPiCli } from "../src/cli/pi.js";
import { runRunnerRuntime } from "../src/runtime/runner-runtime.js";
import { runPiRuntime } from "../src/runtime/pi-runtimes.js";
import { runPiAgent } from "../src/agents/pi.js";
import { DEFAULT_YOLO_PUBLIC_COMMAND_NAMES, YOLO_COMMANDS } from "../src/workflows/command-registry.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-lifecycle-guard-"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function capture() {
  let text = "";
  return {
    stream: { write: (chunk: string) => { text += chunk; } },
    json: (): Record<string, unknown> => JSON.parse(text),
    text: () => text,
  };
}

function lifecycleWriteOptions(root) {
  return {
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    source: "unit",
    writeSessionMemory: false,
    skipSequenceCheck: true,
  };
}

function writeRunPass(root) {
  return writeLifecycleStageReport("run", {
    status: "success",
    summary: "run passed",
    evidence: [{ path: "state/reports/run/run-report.json" }],
  }, lifecycleWriteOptions(root));
}

function writeReviewPass(root, report = {}) {
  return writeLifecycleStageReport("review-fix", {
    status: "success",
    summary: "review passed",
    findings: [],
    evidence: [{ path: "state/review/review-report.json" }],
    ...report,
  }, lifecycleWriteOptions(root));
}

function writeAcceptancePass(root, report = {}) {
  return writeLifecycleStageReport("acceptance", {
    status: "pass",
    summary: "acceptance passed",
    evidence: [{ path: "state/acceptance/evidence.json" }],
    ...report,
  }, lifecycleWriteOptions(root));
}

describe("lifecycle guard", () => {
  test("blocks downstream commands before lifecycle initialization", () => {
    const root = tempProject();
    try {
      const result = inspectLifecycleGuard({ command: "yolo-run", projectRoot: root });

      assert.equal(result.status, "blocked");
      assert.equal(result.code, "LIFECYCLE_NOT_INITIALIZED");
      assert.equal(result.recommended_command, "yolo init");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks plan until discovery artifact or completed discovery exists", () => {
    const root = tempProject();
    try {
      initLifecycleState({ projectRoot: root });

      const blocked = inspectLifecycleGuard({ command: "yolo-plan", projectRoot: root });
      assert.equal(blocked.status, "blocked");
      assert.deepEqual(blocked.missing_required_stages, ["discovery"]);

      const discoveryDir = join(root, ".yolo", "discovery");
      mkdirSync(discoveryDir, { recursive: true });
      writeJson(join(discoveryDir, "discovery.json"), { status: "success" });

      const allowed = inspectLifecycleGuard({ command: "yolo-plan", projectRoot: root });
      assert.equal(allowed.status, "pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks run until check stage completed", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    const prdPath = join(root, "specs", "prd.json");
    try {
      writeJson(prdPath, { schema: "test.prd" });
      initLifecycleState({ projectRoot: root });
      const blocked = inspectLifecycleGuard({ command: "yolo-run", projectRoot: root, prdPath });
      assert.equal(blocked.status, "blocked");
      assert.deepEqual(blocked.missing_required_stages, ["discovery", "roadmap", "check"]);

      writeLifecycleStageReport("discovery", { status: "success" }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      writeLifecycleStageReport("roadmap", { status: "success" }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      const outOfOrder = inspectLifecycleGuard({ command: "yolo-run", projectRoot: root, prdPath });
      assert.equal(outOfOrder.status, "blocked");
      assert.deepEqual(outOfOrder.missing_required_stages, ["check"]);

      writeLifecycleStageReport("check", {
        status: "pass",
        summary: "check passed",
        prd_path: prdPath,
      }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      const allowed = inspectLifecycleGuard({ command: "yolo-run", projectRoot: root, prdPath });
      assert.equal(allowed.status, "pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks run when check lifecycle artifact wraps a blocked report", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    const prdPath = join(root, "specs", "prd.json");
    try {
      writeJson(prdPath, { schema: "test.prd" });
      initLifecycleState({ projectRoot: root });
      writeLifecycleStageReport("discovery", { status: "success" }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      writeLifecycleStageReport("roadmap", { status: "success" }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      const checkWrite = writeLifecycleStageReport("check", {
        status: "success",
        summary: "check wrapper completed",
        prd_path: prdPath,
      }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      writeJson(checkWrite.artifact_path, {
        ...checkWrite.report,
        status: "completed",
        prd_path: prdPath,
        report: {
          status: "blocked",
          prd_path: prdPath,
          blockers: [{ code: "STORY_ATOMICITY_MULTI_STORY" }],
        },
      });

      const guard = inspectLifecycleGuard({ command: "yolo-run", projectRoot: root, stateRoot, prdPath });
      assert.equal(guard.status, "blocked");
      assert.deepEqual(guard.missing_required_stages, ["check"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks run when check lifecycle artifact wraps a warning report", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    const prdPath = join(root, "specs", "prd.json");
    try {
      writeJson(prdPath, { schema: "test.prd" });
      initLifecycleState({ projectRoot: root });
      writeLifecycleStageReport("discovery", { status: "success" }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      writeLifecycleStageReport("roadmap", { status: "success" }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      const checkWrite = writeLifecycleStageReport("check", {
        status: "completed",
        summary: "check wrapper completed",
        prd_path: prdPath,
        report: {
          status: "warning",
          prd_path: prdPath,
          warnings: [{ code: "DEMAND_CONTRACT_MISSING" }],
        },
      }, {
        projectRoot: root,
        stateRoot,
        source: "unit",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      const guard = inspectLifecycleGuard({ command: "yolo-run", projectRoot: root, stateRoot, prdPath });
      assert.equal(checkWrite.report.status, "completed");
      assert.equal(guard.status, "blocked");
      assert.deepEqual(guard.missing_required_stages, ["check"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks acceptance until review-fix evidence exists", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      initLifecycleState({ projectRoot: root });
      writeLifecycleStageReport("run", { status: "success" }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      const blocked = inspectLifecycleGuard({ command: "yolo-accept", projectRoot: root });
      assert.equal(blocked.status, "blocked");
      assert.deepEqual(blocked.missing_required_stages, ["review-fix"]);

      writeLifecycleStageReport("review-fix", { status: "success" }, {
        projectRoot: root,
        stateRoot,
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      const allowed = inspectLifecycleGuard({ command: "yolo-accept", projectRoot: root });
      assert.equal(allowed.status, "pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("next action follows the first incomplete main stage", () => {
    const root = tempProject();
    try {
      assert.equal(nextLifecycleAction({ projectRoot: root }).command, "yolo init");
      initLifecycleState({ projectRoot: root });
      assert.equal(nextLifecycleAction({ projectRoot: root }).command, "yolo demand --stage interview");

      writeLifecycleStageReport("discovery", { status: "success" }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      assert.equal(nextLifecycleAction({ projectRoot: root }).command, "yolo tasks");

      writeLifecycleStageReport("roadmap", { status: "warning", summary: "plan has warnings" }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      assert.equal(nextLifecycleAction({ projectRoot: root }).command, "yolo tasks");

      writeLifecycleStageReport("roadmap", { status: "success", summary: "plan passed" }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      assert.equal(nextLifecycleAction({ projectRoot: root }).command, "yolo spec");

      writeLifecycleStageReport("prd", { status: "success", summary: "prd compiled" }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      assert.equal(nextLifecycleAction({ projectRoot: root }).command, "yolo check");

      for (const stage of ["prd", "check", "run", "review-fix"]) {
        writeLifecycleStageReport(stage, { status: "success" }, {
          projectRoot: root,
          stateRoot: join(root, ".yolo"),
          writeSessionMemory: false,
          skipSequenceCheck: true,
        });
      }
      writeLifecycleStageReport("acceptance", { status: "warning" }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      assert.equal(nextLifecycleAction({ projectRoot: root }).command, "yolo release accept");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo next handles unreadable lifecycle status without throwing", async () => {
    const root = tempProject();
    try {
      initLifecycleState({ projectRoot: root });
      writeFileSync(join(root, ".yolo", "lifecycle", "status.json"), "{", "utf8");

      const out = capture();
      const exitCode = await runYoloCli(["status", `--cwd=${root}`, "--json"], {
        cwd: root,
        stdout: out.stream,
      });
      const result = out.json();

      assert.equal(exitCode, 0);
      assert.equal(result.recommended_command, "yolo doctor");
      const guard = result.guard;
      assert.equal(
        typeof guard === "object" && guard !== null && "current_stage" in guard
          ? (guard as Record<string, unknown>).current_stage
          : undefined,
        null,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CLI blocks run before check and reports yolo next", async () => {
    const root = tempProject();
    try {
      initLifecycleState({ projectRoot: root });

      const blockedOut = capture();
      const blockedErr = capture();
      const exitCode = await runYoloCli([
        "run",
        "specs/prd.json",
        `--cwd=${root}`,
        "--json",
      ], { cwd: root, stdout: blockedOut.stream, stderr: blockedErr.stream });
      const blocked = blockedOut.json();

      assert.equal(exitCode, 2);
      assert.equal(blocked.code, "LIFECYCLE_GUARD_BLOCKED");
      assert.deepEqual(blocked.missing_required_stages, ["discovery", "roadmap", "prd", "check"]);

      const nextOut = capture();
      const nextExit = await runYoloCli(["status", `--cwd=${root}`, "--json"], {
        cwd: root,
        stdout: nextOut.stream,
      });
      const next = nextOut.json();

      assert.equal(nextExit, 0);
      assert.equal(next.recommended_command, "yolo demand --stage interview");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legacy yolo PRD and yolo-pi execute entrypoints fail closed behind guard", async () => {
    const root = tempProject();
    try {
      initLifecycleState({ projectRoot: root });

      const yoloOut = capture();
      const yoloExit = await runYoloCli([
        "--prd",
        "specs/prd.json",
        `--cwd=${root}`,
        "--json",
      ], { cwd: root, stdout: yoloOut.stream });
      assert.equal(yoloExit, 2);
      assert.equal(yoloOut.json().code, "LIFECYCLE_GUARD_BLOCKED");

      const piOut = capture();
      const piExit = await runPiCli([
        "--execute",
        "--prd",
        "specs/prd.json",
        `--cwd=${root}`,
        "--json",
      ], { cwd: root, stdout: piOut.stream });
      assert.equal(piExit, 2);
      assert.equal(piOut.json().code, "LIFECYCLE_GUARD_BLOCKED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("direct runner and PI runtime APIs fail closed behind lifecycle guard", async () => {
    const root = tempProject();
    const prdPath = join(root, "prd.json");
    try {
      writeJson(prdPath, { version: "2.0", tasks: [] });

      const runner = await runRunnerRuntime({ prdPath, projectRoot: root });
      assert.equal(runner.status, "error");
      assert.equal(runner.code, "LIFECYCLE_NOT_INITIALIZED");
      assert.equal(runner.exit_code, 2);

      initLifecycleState({ projectRoot: root });
      const seen = [];
      const pi = await runPiAgent({
        prdPath,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        execute: true,
        executor: async (action) => {
          seen.push(action.id);
          return { status: "success", summary: action.id };
        },
      });

      assert.equal(pi.status, "error");
      assert.equal(pi.stop_condition, "lifecycle_guard");
      assert.deepEqual((pi as { lifecycle_guard: { missing_required_stages: string[] } }).lifecycle_guard.missing_required_stages, ["discovery", "roadmap", "check"]);
      assert.deepEqual(seen, ["pi.prd.preflight"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks ship when run report is blocked even if acceptance evidence passes", async () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    const prdPath = join(root, "prd.json");
    try {
      writeJson(prdPath, { version: "2.0", tasks: [] });
      initLifecycleState({ projectRoot: root });
      const runWrite = writeRunPass(root);
      writeJson(runWrite.artifact_path, {
        ...runWrite.report,
        status: "completed",
        evidence: [{ path: "external-e2e-pass.json" }],
        report: {
          status: "blocked",
          summary: "YOLO lifecycle run is blocked.",
        },
      });
      writeReviewPass(root);
      writeAcceptancePass(root);

      const guard = inspectLifecycleGuard({ command: "yolo-ship", projectRoot: root, stateRoot, prdPath });
      assert.equal(guard.status, "blocked");
      assert.ok(guard.blockers.some((blocker) => blocker.code === "RUN_REPORT_BLOCKED"));

      const ship = await runPiRuntime("ship", { prdPath, projectRoot: root, stateRoot });
      assert.equal(ship.status, "error");
      assert.equal(ship.code, "LIFECYCLE_GUARD_BLOCKED");
      assert.ok(ship.blockers.some((blocker) => blocker.code === "RUN_REPORT_BLOCKED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks ship when acceptance report is pending or has no evidence", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      initLifecycleState({ projectRoot: root });
      writeRunPass(root);
      writeReviewPass(root);
      writeLifecycleStageReport("acceptance", {
        status: "pending",
        summary: "acceptance is still waiting for evidence",
      }, lifecycleWriteOptions(root));

      const guard = inspectLifecycleGuard({ command: "yolo-ship", projectRoot: root, stateRoot });
      assert.equal(guard.status, "blocked");
      assert.ok(guard.blockers.some((blocker) => blocker.code === "ACCEPTANCE_REPORT_PENDING"));
      assert.ok(guard.blockers.some((blocker) => blocker.code === "ACCEPTANCE_EVIDENCE_EMPTY"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks ship when review-fix is pending or must-fix work remains", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    try {
      initLifecycleState({ projectRoot: root });
      writeRunPass(root);
      writeLifecycleStageReport("review-fix", {
        status: "pending",
        summary: "review fixes are still open",
      }, lifecycleWriteOptions(root));
      writeAcceptancePass(root);

      const pending = inspectLifecycleGuard({ command: "yolo-ship", projectRoot: root, stateRoot });
      assert.equal(pending.status, "blocked");
      assert.ok(pending.blockers.some((blocker) => blocker.code === "REVIEW_FIX_PENDING"));

      writeReviewPass(root, {
        findings: [{
          finding_id: "REV-001",
          severity: "HIGH",
          must_fix_before_ship: true,
          message: "Fix before ship.",
        }],
      });
      writeAcceptancePass(root);

      const mustFix = inspectLifecycleGuard({ command: "yolo-ship", projectRoot: root, stateRoot });
      assert.equal(mustFix.status, "blocked");
      assert.ok(mustFix.blockers.some((blocker) => blocker.code === "REVIEW_FIX_MUST_FIX_BEFORE_SHIP"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("negative: yolo-learn is blocked until delivery is completed with an artifact", async () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    const prdPath = join(root, "prd.json");
    try {
      writeJson(prdPath, { version: "2.0", tasks: [] });
      initLifecycleState({ projectRoot: root });
      writeRunPass(root);
      writeReviewPass(root);
      writeAcceptancePass(root);

      const guard = inspectLifecycleGuard({ command: "yolo-learn", projectRoot: root, stateRoot, prdPath });
      assert.equal(guard.status, "blocked");
      assert.deepEqual(guard.missing_required_stages, ["delivery"]);

      const learn = await runPiRuntime("learn", { prdPath, projectRoot: root, stateRoot });
      assert.equal(learn.status, "error");
      assert.equal(learn.code, "LIFECYCLE_GUARD_BLOCKED");
      assert.equal(learn.lifecycle_guard.missing_required_stages.includes("delivery"), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S2 yolo auto --dry-run routes through pi and produces action plan with expected phases", async () => {
    const root = tempProject();
    try {
      const out = capture();
      const exitCode = await runYoloCli(["auto", "--dry-run", "--json", "test inventory alerts feature", `--cwd=${root}`], {
        cwd: root,
        stdout: out.stream,
      });
      const result = out.json();

      assert.equal(exitCode, 2, "auto --dry-run returns exit 2 for dry-run plan ready");
      assert.equal(result.code, "AUTO_PLAN_READY");
      assert.ok(result.plan, "result must contain a plan");
      const actions = (result.plan as Record<string, unknown>).actions as Record<string, unknown>[] | undefined;
      const phaseIds = (actions || []).map((a) => (a.phase || a.id || "") as string);
      const phaseSet = new Set(phaseIds);
      const expectedPhases = ["prd_contract", "implementation", "review", "acceptance", "delivery"];
      const foundPhases = expectedPhases.filter((p) =>
        phaseIds.some((id) => id.includes(p)) || [...phaseSet].some((id) => id.includes(p)),
      );
      assert.ok(foundPhases.length >= 3, `expected at least 3 of ${expectedPhases.join(", ")} in plan phases: ${phaseIds.join(", ")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S2 unknown command yolo frobnicate exits 2 with error", async () => {
    const root = tempProject();
    try {
      let stderr = "";
      const exitCode = await runYoloCli(["frobnicate", `--cwd=${root}`], {
        cwd: root,
        stdout: { write: () => {} },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      assert.equal(exitCode, 2, "unknown command must exit 2");
      assert.ok(stderr.includes("Unknown command"), `stderr must mention Unknown command: ${stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S2 bare yolo <prd> still passes through to runner", async () => {
    const root = tempProject();
    try {
      let stderr = "";
      const exitCode = await runYoloCli(["prd.json", `--cwd=${root}`, "--json"], {
        cwd: root,
        stdout: { write: () => {} },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      // Should NOT exit 0 — it may block on lifecycle guard or missing PRD, but should NOT be "Unknown command"
      assert.notEqual(stderr.includes("Unknown command"), true, `bare PRD path should not trigger Unknown command: ${stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S2 KNOWN_YOLO_COMMAND_WORDS includes all 4 stable surface verbs", () => {
    assert.ok(KNOWN_YOLO_COMMAND_WORDS.has("auto"), "auto must be in known words");
    assert.ok(KNOWN_YOLO_COMMAND_WORDS.has("demand"), "demand must be in known words");
    assert.ok(KNOWN_YOLO_COMMAND_WORDS.has("ship"), "ship must be in known words");
    assert.ok(KNOWN_YOLO_COMMAND_WORDS.has("status"), "status must be in known words");
  });

  test("S3 deprecated alias names all exit 2 with redirect to stable verbs", async () => {
    const deprecatedNames = [
      "office-hours",
      "brainstorm",
      "discover",
      "discuss",
      "plan",
      "prd",
      "accept",
      "ui-review",
      "release-candidate",
      "release-gate",
      "next",
    ];

    const root = tempProject();
    try {
      for (const name of deprecatedNames) {
        let stderr = "";
        const exitCode = await runYoloCli([name, `--cwd=${root}`, "--json"], {
          cwd: root,
          stdout: { write: () => {} },
          stderr: { write: (chunk) => { stderr += chunk; } },
        });
        assert.equal(exitCode, 2, `yolo ${name} must exit 2`);
        assert.ok(
          stderr.includes("no longer a standalone command"),
          `yolo ${name} must mention deprecation: got "${stderr}"`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("S3 registry↔CLI alignment: non-registry command names error instead of silent execution", async () => {
    const registryNames = new Set(YOLO_COMMANDS.map((cmd) => cmd.name));
    // All old alias names removed from the public surface and the command registry.
    // Every one must produce an error on stderr and exit 2 instead of silently executing.
    const removedNames = [
      "office-hours",
      "brainstorm",
      "discover",
      "discuss",
      "plan",
      "prd",
      "accept",
      "ui-review",
      "release-candidate",
      "release-gate",
      "next",
      "pi",
      "gate",
      "preflight",
    ];

    const root = tempProject();
    try {
      for (const name of removedNames) {
        assert.equal(
          registryNames.has(name),
          false,
          `${name} must NOT be in command registry`,
        );

        let stderr = "";
        const exitCode = await runYoloCli([name, `--cwd=${root}`, "--json"], {
          cwd: root,
          stdout: { write: () => {} },
          stderr: { write: (chunk) => { stderr += chunk; } },
        });
        assert.equal(exitCode, 2, `yolo ${name} must exit 2 (registry-driven check)`);
        assert.ok(
          stderr.length > 0,
          `yolo ${name} must produce an error message on stderr`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Regression: non-technical users paste recommended_command / next_actions straight
  // into a terminal. Slash forms (/yolo-*) are unknown-shell commands there. Every
  // recommended_command across every lifecycle state must be a runnable `yolo ...`.
  test("recommended_command is always a runnable yolo subcommand, never a slash form", async () => {
    const root = tempProject();
    try {
      const runnableSubcommands = new Set([
        "yolo init", "yolo doctor", "yolo status",
        "yolo demand --stage interview", "yolo demand --stage brainstorm",
        "yolo demand --stage discover", "yolo demand --stage discuss",
        "yolo tasks", "yolo spec", "yolo check", "yolo run",
        "yolo review", "yolo release accept", "yolo ship", "yolo learn",
      ]);

      const checkCommand = (cmd: string, where: string) => {
        assert.ok(
          typeof cmd === "string" && cmd.length > 0,
          `${where} must set a non-empty command string`,
        );
        assert.ok(
          !cmd.startsWith("/"),
          `${where}="${cmd}" must not be a slash form — terminal users cannot run it`,
        );
        assert.ok(
          cmd.startsWith("yolo "),
          `${where}="${cmd}" must start with "yolo " so it runs in a plain shell`,
        );
        assert.ok(
          runnableSubcommands.has(cmd),
          `${where}="${cmd}" is not a recognized runnable yolo subcommand`,
        );
      };

      // 1. No status file at all → setup gate.
      checkCommand(
        nextLifecycleAction({ projectRoot: root }).command,
        "nextLifecycleAction (uninitialized)",
      );

      // 2. Walk every lifecycle stage boundary; each recommended_command must be runnable.
      initLifecycleState({ projectRoot: root });
      const stageSequence: Array<{ stage: string; expectCmd: string }> = [
        { stage: "discovery", expectCmd: "yolo demand --stage interview" },
        { stage: "roadmap", expectCmd: "yolo tasks" },
        { stage: "prd", expectCmd: "yolo spec" },
        { stage: "check", expectCmd: "yolo check" },
        { stage: "run", expectCmd: "yolo run" },
        { stage: "review-fix", expectCmd: "yolo review" },
        { stage: "acceptance", expectCmd: "yolo release accept" },
        { stage: "delivery", expectCmd: "yolo ship" },
      ];
      const completed: string[] = [];
      for (const { stage, expectCmd } of stageSequence) {
        const before = nextLifecycleAction({ projectRoot: root }).command;
        checkCommand(before, `nextLifecycleAction before ${stage}`);
        assert.equal(before, expectCmd, `stage boundary before ${stage}`);
        // Also exercise the guard's recommended_command path for an arbitrary downstream command.
        const guard = inspectLifecycleGuard(
          { command: "yolo-run", projectRoot: root },
          {},
        );
        checkCommand(guard.recommended_command, `inspectLifecycleGuard.recommended_command at ${stage} boundary`);
        for (const action of guard.next_actions || []) {
          assert.ok(
            !action.includes("/yolo-"),
            `next_actions at ${stage} must not reference slash commands: ${action}`,
          );
        }
        writeLifecycleStageReport(stage, { status: "success" }, {
          projectRoot: root,
          stateRoot: join(root, ".yolo"),
          writeSessionMemory: false,
          skipSequenceCheck: true,
        });
        completed.push(stage);
      }

      // 3. Unreadable status → doctor recommendation.
      writeFileSync(join(root, ".yolo", "lifecycle", "status.json"), "{", "utf8");
      checkCommand(
        nextLifecycleAction({ projectRoot: root }).command,
        "nextLifecycleAction (unreadable status)",
      );

      // 4. End-to-end via the CLI surface non-technical users actually run.
      rmSync(join(root, ".yolo"), { recursive: true, force: true });
      initLifecycleState({ projectRoot: root });
      const out = capture();
      const exit = await runYoloCli(["status", `--cwd=${root}`, "--json"], {
        cwd: root,
        stdout: out.stream,
      });
      assert.equal(exit, 0);
      const status = out.json() as { recommended_command?: unknown };
      checkCommand(
        String(status.recommended_command ?? ""),
        "yolo status CLI recommended_command",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
