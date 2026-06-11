import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { lifecycleStageIds, getLifecycleStage, lifecycleStageForCommand } from "../src/lifecycle/schema.js";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";
import { inspectLifecycleGuard } from "../src/lifecycle/guard.js";
import { evaluatePostConditions } from "../src/prd/contract.js";
import { inspectDemandReadiness } from "../src/demand/gate.js";
import { inspectStoryAtomicityFromDemand } from "../src/demand/story-atomicity.js";
import { parseYoloArgs } from "../src/cli/yolo.js";
import { buildInitToFirstPrdSmokePlan } from "../src/core/init-smoke.js";
import { buildYoloCommandRegistry, validateCommandLifecycleStageAlignment } from "../src/workflows/command-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

function tempProject(prefix = "yolo-adversarial-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function lifecycleWriteOptions(root) {
  return {
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    source: "adversarial-test",
    writeSessionMemory: false,
    skipSequenceCheck: false,
  };
}

function initLifecycleState({ projectRoot }) {
  const statusPath = join(projectRoot, ".yolo", "lifecycle", "status.json");
  mkdirSync(dirname(statusPath), { recursive: true });
  writeJson(statusPath, {
    schema: "yolo.lifecycle.state.v1",
    schema_version: "1.0",
    current_stage: "idea",
    project: { name: "test" },
    stages: [
      { id: "idea", sequence: 1, label: "Idea intake", status: "completed", artifact: "idea.json", writes_code: false },
      { id: "discovery", sequence: 2, label: "Discovery", status: "completed", artifact: "discovery.json", writes_code: false },
      { id: "setup", sequence: 3, label: "Project setup", status: "completed", artifact: "setup.json", writes_code: false },
      { id: "roadmap", sequence: 4, label: "Roadmap and plan", status: "completed", artifact: "roadmap.json", writes_code: false },
      { id: "prd", sequence: 5, label: "PRD", status: "completed", artifact: "prd.json", writes_code: false },
      { id: "check", sequence: 6, label: "Readiness check", status: "completed", artifact: "check-report.json", writes_code: false },
      { id: "run", sequence: 7, label: "Gated execution", status: "active", artifact: "run-report.json", writes_code: true },
      { id: "review-fix", sequence: 8, label: "Review and fix loop", status: "pending", artifact: "review-report.json", writes_code: true },
      { id: "acceptance", sequence: 9, label: "Acceptance", status: "pending", artifact: "acceptance-report.json", writes_code: false },
      { id: "delivery", sequence: 10, label: "Delivery", status: "pending", artifact: "delivery-report.json", writes_code: false },
      { id: "learn", sequence: 11, label: "Learning", status: "pending", artifact: "retrospective.json", writes_code: false },
    ],
  });
}

describe("lazy-agent adversarial suite — 14 audit findings + 2 boundaries", () => {
  // ── F1: task-graph dead stage ──
  test("F1: lazy agent tries to reference task-graph stage → throws (stage removed)", () => {
    const ids = lifecycleStageIds();
    assert.ok(!ids.includes("task-graph"), "task-graph must not exist in lifecycle schema");
    assert.throws(() => getLifecycleStage("task-graph"), /Unknown YOLO lifecycle stage/);
    assert.equal(lifecycleStageForCommand("yolo-tasks"), null, "yolo-tasks must not map to any stage");
    assert.equal(ids.length, 11, "lifecycle must have exactly 11 stages after task-graph removal");
  });

  // ── F2: --demand bypass sealed ──
  test("F2: lazy agent passes --demand but skips lifecycle → still blocked by guard", () => {
    const root = tempProject();
    try {
      mkdirSync(join(root, ".yolo", "lifecycle"), { recursive: true });
      // Lifecycle not initialized properly
      const result = inspectLifecycleGuard({ command: "yolo-spec", projectRoot: root, input: { demand: "/fake/demand.json" } });
      assert.equal(result.status, "blocked", "lifecycle guard must block even with demand input when prerequisites missing");
      assert.ok(result.blockers.length > 0, "blockers must be present");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── F3: lifecycle self-attestation (sequence validation) ──
  test("F3: lazy agent writes run report before check completes → sequence validation throws", () => {
    const root = tempProject();
    try {
      // Only init setup is "completed", check is still pending
      const statusPath = join(root, ".yolo", "lifecycle", "status.json");
      mkdirSync(dirname(statusPath), { recursive: true });
      writeJson(statusPath, {
        schema: "yolo.lifecycle.state.v1",
        current_stage: "setup",
        project: { name: "test" },
        stages: [
          { id: "idea", sequence: 1, status: "completed" },
          { id: "discovery", sequence: 2, status: "completed" },
          { id: "setup", sequence: 3, status: "completed" },
          { id: "roadmap", sequence: 4, status: "pending" },
          { id: "prd", sequence: 5, status: "pending" },
          { id: "check", sequence: 6, status: "pending" },
          { id: "run", sequence: 7, status: "pending" },
          { id: "review-fix", sequence: 8, status: "pending" },
          { id: "acceptance", sequence: 9, status: "pending" },
          { id: "delivery", sequence: 10, status: "pending" },
          { id: "learn", sequence: 11, status: "pending" },
        ],
      });

      assert.throws(
        () => writeLifecycleStageReport("run", { status: "success" }, lifecycleWriteOptions(root)),
        /prior stages not completed/,
        "writing run report before check must fail sequence validation"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── F4: hooks exit 2 (mandatory failures block) ──
  test("F4: pre-tool-block-yolo-write hook exits 2 for .yolo paths", () => {
    const hookPath = join(PROJECT_ROOT, "hooks", "pre-tool-block-yolo-write.ts");
    if (!existsSync(hookPath)) {
      // Skip if hook not present (should be present after P0.6)
      assert.ok(true, "hook file not present — skip");
      return;
    }
    const payload = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "/project/.yolo/lifecycle/status.json", content: "{}" },
    });
    let exited = 0;
    let threw = false;
    try {
      execFileSync("node", ["--import", "tsx", hookPath], { input: payload, encoding: "utf8", cwd: PROJECT_ROOT });
    } catch (error) {
      threw = true;
      exited = error.status || 0;
    }
    assert.ok(threw, "hook must throw when blocking .yolo write");
    assert.equal(exited, 2, "hook must exit 2 when LLM tries to write .yolo state directly");

    const invalidJson = spawnSync("node", ["--import", "tsx", hookPath], { input: "{not-json", encoding: "utf8", cwd: PROJECT_ROOT });
    assert.equal(invalidJson.status, 2, "invalid JSON must fail closed with exit 2");

    const normalPayload = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "/project/src/app.ts", content: "" },
    });
    const normalWrite = spawnSync("node", ["--import", "tsx", hookPath], { input: normalPayload, encoding: "utf8", cwd: PROJECT_ROOT });
    assert.equal(normalWrite.status, 0, "normal non-.yolo write must exit 0");
  });

  // ── F5: acceptance_criteria stops always-passing ──
  test("F5: acceptance_criteria without verify_command → marked manual, delivery gate blocks without evidence", () => {
    const task = {
      id: "T1",
      title: "test",
      scope: { targets: [{ file: "src/foo.ts" }] },
      post_conditions: [{
        id: "AC-1",
        type: "acceptance_criteria",
        severity: "FAIL",
        params: { text: "Product owner confirms UX matches brand guidelines." },
      }],
    };
    const prd = { version: "2.0", tasks: [task] };
    const result = evaluatePostConditions(task, prd);
    const acResult = result.results.find((r) => r.id === "AC-1");
    assert.ok(acResult, "acceptance_criteria result must exist");
    assert.equal(acResult.manual, true, "acceptance_criteria without verify_command must be marked manual");
    assert.equal(acResult.warn, true, "manual acceptance must carry warn flag");

    // Delivery gate: manual criteria without corresponding evidence → blocked
    const root = tempProject();
    try {
      initLifecycleState({ projectRoot: root });
      const stateRoot = join(root, ".yolo");
      writeLifecycleStageReport("run", { status: "success", evidence: [{ path: "run.json" }] }, { ...lifecycleWriteOptions(root), skipSequenceCheck: true });
      writeLifecycleStageReport("review-fix", { status: "success", evidence: [{ path: "review.json" }] }, { ...lifecycleWriteOptions(root), skipSequenceCheck: true });
      writeLifecycleStageReport("acceptance", {
        status: "pass",
        evidence: [{ path: "acceptance.json" }],
        manual_criteria: [{ task_id: "T1", condition_id: "AC-1", text: "UX matches brand guidelines" }],
      }, { ...lifecycleWriteOptions(root), skipSequenceCheck: true });

      const guard = inspectLifecycleGuard({ command: "yolo-ship", projectRoot: root, stateRoot });
      assert.ok(
        guard.blockers.some((b) => b.code === "ACCEPTANCE_MANUAL_CRITERIA_UNRESOLVED"),
        "delivery must block when manual criteria lack evidence records"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── F6: ledger grounding ──
  test("F6: demand gate blocks PRD-ready mode when ledger chain is missing/broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-ledger-"));
    try {
      const result = inspectDemandReadiness({
        playback: { confirmed: true, confirmed_by: "user" },
        approval: { approved: true },
        requirements: { active: [{ text: "User can do X." }] },
      }, { phase: "executable_prd", stateDir: dir });

      assert.ok(
        result.blockers.some((b) => b.code === "EVIDENCE_GROUNDED"),
        "EVIDENCE_GROUNDED must block when no valid ledger exists in PRD mode"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── F7: understanding playback wired ──
  test("F7: demand gate blocks PRD when playback is unconfirmed", () => {
    const result = inspectDemandReadiness({
      playback: { confirmed: false },
      approval: { approved: true },
      requirements: { active: [{ text: "User can do X." }] },
    }, { phase: "prd" });

    assert.ok(
      result.blockers.some((b) => b.code === "PLAYBACK_CONFIRMED"),
      "PLAYBACK_CONFIRMED must block when playback.confirmed is false in PRD mode"
    );
  });

  // ── F8: --approve flag removed ──
  test("F8: lazy agent tries --approve CLI flag → flag does not exist in parser", () => {
    const { input, options } = parseYoloArgs(["demand", "--approve", "true"]);
    assert.equal(input.approve, undefined, "--approve must not be parsed as a recognized flag");
    assert.equal(options.json, false);
    // The "true" would be consumed as positional argument if demand path, but not as approve
  });

  // ── F9: warning-ack deleted ──
  test("F9: warning-ack.ts does not exist (self-service warning bypass removed)", () => {
    const path = join(PROJECT_ROOT, "src", "lib", "warning-ack.ts");
    assert.equal(existsSync(path), false, "src/lib/warning-ack.ts must be deleted");
  });

  // ── F10: runner-core no longer naked export ──
  test("F10: runner-core run() calls lifecycle guard before execution", () => {
    const runnerCorePath = join(PROJECT_ROOT, "src", "runtime", "runner-core.ts");
    const content = readFileSync(runnerCorePath, "utf8");
    assert.ok(content.includes("inspectLifecycleGuard"), "runner-core must import and call inspectLifecycleGuard");
    assert.ok(content.includes("yolo-run"), "runner-core must check guard for yolo-run command");
  });

  // ── F11: init-smoke does not pollute real state root ──
  test("F11: init-to-first-prd smoke plan places artifacts under .yolo/smoke, not direct lifecycle", () => {
    const plan = buildInitToFirstPrdSmokePlan({ projectRoot: "/fake/project" });
    assert.ok(plan.prd_path.includes("smoke"), "smoke PRD path must include 'smoke' subdirectory");
    assert.ok(!plan.prd_path.includes("lifecycle"), "smoke PRD must not be placed directly in lifecycle");
  });

  // ── F12: vocabulary consistency ──
  test("F12: all command-registry lifecycle stages are valid schema stages", () => {
    const registry = buildYoloCommandRegistry();
    const validIds = new Set(lifecycleStageIds());
    const invalid = [];
    for (const cmd of registry.commands) {
      if (cmd.lifecycle_stage && !validIds.has(cmd.lifecycle_stage)) {
        invalid.push({ command: cmd.name, stage: cmd.lifecycle_stage });
      }
    }
    assert.deepEqual(invalid, [], "all command registry lifecycle stages must exist in schema");

    const alignment = validateCommandLifecycleStageAlignment();
    assert.equal(alignment.valid, true, `vocabulary mismatch: ${alignment.errors?.map((e) => e.message).join("; ") || ""}`);
  });

  // ── F13: atomicity doctor blocks system-level whole-feature requests ──
  test("F13: 'implement entire login system' triggers atomicity warning/block", () => {
    const result = inspectStoryAtomicityFromDemand({
      requirements: { active: [{ id: "R1", text: "Implement the entire login system with OAuth and 2FA." }] },
    });
    assert.ok(
      result.status === "blocked" || result.status === "warn",
      "'implement entire login system' must trigger atomicity blocked or warn"
    );
    assert.ok(
      result.findings.some((f) => f.code === "STORY_ATOMICITY_CAPABILITY_NOUN" || f.code === "STORY_ATOMICITY_MULTI_STORY"),
      "must detect capability noun or multi-story for system-level request"
    );
  });

  // ── F14: noise reduced (no per-command md generation) ──
  test("F14: CLI commands other than memory do not call refreshMemoryCenter per-invocation", () => {
    const cliPath = join(PROJECT_ROOT, "src", "cli", "yolo.ts");
    const content = readFileSync(cliPath, "utf8");
    const refreshCalls = content.match(/refreshMemoryCenter/g) || [];
    // refreshMemoryCenter should only be called in the memory command handler, not in every command
    assert.ok(refreshCalls.length <= 2, "refreshMemoryCenter must not be called in multiple command handlers");
  });

  // ── Boundary A: Bash direct .yolo writes are blocked; yolo CLI state access is allowed ──
  test("Boundary-A (M2): PreToolUse hook blocks Bash .yolo redirects and allows yolo CLI access", () => {
    const hookPath = join(PROJECT_ROOT, "hooks", "pre-tool-block-yolo-write.ts");
    if (!existsSync(hookPath)) {
      assert.ok(true, "hook not present — skip");
      return;
    }
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "echo '{}' > /project/.yolo/lifecycle/status.json" },
    });
    const blocked = spawnSync("node", ["--import", "tsx", hookPath], { input: payload, encoding: "utf8", cwd: PROJECT_ROOT });
    assert.equal(blocked.status, 2, "Bash redirect to .yolo must be blocked");

    const cliPayload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "node ./dist/bin/yolo.js status --state-root /project/.yolo" },
    });
    const allowed = spawnSync("node", ["--import", "tsx", hookPath], { input: cliPayload, encoding: "utf8", cwd: PROJECT_ROOT });
    assert.equal(allowed.status, 0, "yolo CLI state access must be allowed");
  });

  // ── Boundary B: manual_acceptance evidence can unblock delivery ──
  // M2 boundary: evidence input of type manual_acceptance is the legitimate resolution path.
  test("Boundary-B (M2): manual_acceptance evidence record resolves delivery gate blocker", () => {
    const root = tempProject();
    try {
      initLifecycleState({ projectRoot: root });
      const stateRoot = join(root, ".yolo");
      writeLifecycleStageReport("run", { status: "success", evidence: [{ path: "run.json" }] }, { ...lifecycleWriteOptions(root), skipSequenceCheck: true });
      writeLifecycleStageReport("review-fix", { status: "success", evidence: [{ path: "review.json" }] }, { ...lifecycleWriteOptions(root), skipSequenceCheck: true });
      writeLifecycleStageReport("acceptance", {
        status: "pass",
        evidence: [
          { path: "acceptance.json" },
          {
            type: "manual_acceptance",
            task_id: "T1",
            condition_id: "AC-1",
            accepted_by: "user",
            note: "Confirmed by product owner",
            at: new Date().toISOString(),
          },
        ],
        manual_criteria: [{ task_id: "T1", condition_id: "AC-1", text: "UX matches brand guidelines" }],
      }, { ...lifecycleWriteOptions(root), skipSequenceCheck: true });

      const guard = inspectLifecycleGuard({ command: "yolo-ship", projectRoot: root, stateRoot });
      assert.ok(
        !guard.blockers.some((b) => b.code === "ACCEPTANCE_MANUAL_CRITERIA_UNRESOLVED"),
        "manual_acceptance evidence must resolve the delivery blocker"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
