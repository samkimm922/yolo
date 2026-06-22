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
import { buildRunFinalAnswer } from "../src/runtime/evidence/report.js";
import { buildYoloCommandRegistry, validateCommandLifecycleStageAlignment } from "../src/workflows/command-registry.js";
import { createYoloSdk } from "../sdk.js";

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
      tool_input: { file_path: ".yolo/lifecycle/status.json", content: "{}" },
    });
    let exited = 0;
    let threw = false;
    try {
      execFileSync("node", ["--import", "tsx", hookPath], { input: payload, encoding: "utf8", timeout: 30000, cwd: PROJECT_ROOT });
    } catch (error) {
      threw = true;
      exited = error.status || 0;
    }
    assert.ok(threw, "hook must throw when blocking .yolo write");
    assert.equal(exited, 2, "hook must exit 2 when LLM tries to write .yolo state directly");

    const invalidJson = spawnSync("node", ["--import", "tsx", hookPath], { input: "{not-json", encoding: "utf8", timeout: 30000, cwd: PROJECT_ROOT });
    assert.equal(invalidJson.status, 2, "invalid JSON must fail closed with exit 2");

    const normalPayload = JSON.stringify({
      tool_name: "Write",
      tool_input: { file_path: "/project/src/app.ts", content: "" },
    });
    const normalWrite = spawnSync("node", ["--import", "tsx", hookPath], { input: normalPayload, encoding: "utf8", timeout: 30000, cwd: PROJECT_ROOT });
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
  test("F8: lazy agent tries --approve CLI flag → unknown flag is rejected with a structured error", () => {
    assert.throws(
      () => parseYoloArgs(["demand", "--approve", "true"]),
      (error) => {
        const e = error as { code?: string; flag?: string };
        return e.code === "CLI_UNKNOWN_FLAG" && e.flag === "--approve";
      },
      "--approve must be rejected as an unknown flag instead of being silently ignored"
    );
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
    assert.equal(alignment.valid, true, `vocabulary mismatch: ${alignment.violations?.map((e) => e.message).join("; ") || ""}`);
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
      tool_input: { command: "echo '{}' > .yolo/lifecycle/status.json" },
    });
    const blocked = spawnSync("node", ["--import", "tsx", hookPath], { input: payload, encoding: "utf8", timeout: 30000, cwd: PROJECT_ROOT });
    assert.equal(blocked.status, 2, "Bash redirect to .yolo must be blocked");

    const cliPayload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "node ./dist/bin/yolo.js status --state-root /project/.yolo" },
    });
    const allowed = spawnSync("node", ["--import", "tsx", hookPath], { input: cliPayload, encoding: "utf8", timeout: 30000, cwd: PROJECT_ROOT });
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

  // ── P6.C1: lifecycle self-certification bypasses are blocked ──
  test("P6.C1: skipSequenceCheck + fake missing evidence paths → ship blocked by evidence validation", () => {
    const root = tempProject();
    try {
      const statusPath = join(root, ".yolo", "lifecycle", "status.json");
      mkdirSync(dirname(statusPath), { recursive: true });
      writeJson(statusPath, {
        schema: "yolo.lifecycle.state.v1",
        current_stage: "delivery",
        project: { name: "test" },
        stages: [
          { id: "idea", sequence: 1, status: "completed" },
          { id: "discovery", sequence: 2, status: "completed" },
          { id: "setup", sequence: 3, status: "completed" },
          { id: "roadmap", sequence: 4, status: "completed" },
          { id: "prd", sequence: 5, status: "completed" },
          { id: "check", sequence: 6, status: "completed" },
          { id: "run", sequence: 7, status: "completed" },
          { id: "review-fix", sequence: 8, status: "completed" },
          { id: "acceptance", sequence: 9, status: "completed" },
          { id: "delivery", sequence: 10, status: "active" },
          { id: "learn", sequence: 11, status: "pending" },
        ],
      });
      writeLifecycleStageReport("run", { status: "success", evidence: [{ path: "missing-run.json" }] }, { ...lifecycleWriteOptions(root), skipSequenceCheck: true });
      writeLifecycleStageReport("acceptance", { status: "pass", evidence: [{ path: "missing-acceptance.json" }] }, { ...lifecycleWriteOptions(root), skipSequenceCheck: true });

      const guard = inspectLifecycleGuard({ command: "yolo-ship", projectRoot: root, stateRoot: join(root, ".yolo") });
      assert.equal(guard.status, "blocked", "ship must be blocked when evidence paths are fake");
      assert.ok(
        guard.blockers.some((b) => b.code === "RUN_EVIDENCE_PATH_MISSING"),
        "missing run evidence path must be a blocker"
      );
      assert.ok(
        guard.blockers.some((b) => b.code === "ACCEPTANCE_EVIDENCE_PATH_MISSING"),
        "missing acceptance evidence path must be a blocker"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("P6.C1: contradictory lifecycle reports → drift blocker", () => {
    const root = tempProject();
    try {
      const stateRoot = join(root, ".yolo");
      const statusPath = join(stateRoot, "lifecycle", "status.json");
      mkdirSync(dirname(statusPath), { recursive: true });
      writeJson(statusPath, {
        schema: "yolo.lifecycle.state.v1",
        current_stage: "run",
        project: { name: "test" },
        stages: [
          { id: "idea", sequence: 1, status: "completed" },
          { id: "discovery", sequence: 2, status: "completed" },
          { id: "setup", sequence: 3, status: "completed" },
          { id: "roadmap", sequence: 4, status: "completed" },
          { id: "prd", sequence: 5, status: "completed" },
          { id: "check", sequence: 6, status: "pending" },
          { id: "run", sequence: 7, status: "completed" },
          { id: "review-fix", sequence: 8, status: "pending" },
          { id: "acceptance", sequence: 9, status: "pending" },
          { id: "delivery", sequence: 10, status: "pending" },
          { id: "learn", sequence: 11, status: "pending" },
        ],
      });
      // Write run artifact with an earlier timestamp than prd to trigger timestamp contradiction.
      writeLifecycleStageReport("prd", { status: "success" }, { ...lifecycleWriteOptions(root), skipSequenceCheck: true, now: "2026-01-02T00:00:00.000Z" });
      writeLifecycleStageReport("run", { status: "success" }, { ...lifecycleWriteOptions(root), skipSequenceCheck: true, now: "2026-01-01T00:00:00.000Z" });

      const guard = inspectLifecycleGuard({ command: "yolo-ship", projectRoot: root, stateRoot });
      assert.equal(guard.status, "blocked", "ship must be blocked when lifecycle drift is detected");
      assert.ok(
        guard.blockers.some((b) => b.code === "LIFECYCLE_DRIFT_TIMESTAMP_CONTRADICTION"),
        "timestamp contradiction must be a drift blocker"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("P6.C1: SDK public lifecycle.writeStageReport strips skipSequenceCheck → cannot bypass sequence validation", () => {
    const root = tempProject();
    try {
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
      const sdk = createYoloSdk({ projectRoot: root, ensureDirs: false });
      assert.throws(
        () => sdk.lifecycle.writeStageReport("run", { status: "success" }, { skipSequenceCheck: true }),
        /prior stages not completed/,
        "SDK public surface must not allow skipSequenceCheck to bypass validation"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── P6.H1: Bash .yolo access — deny-by-default, only yolo CLI allowed ──
  function runHook(toolName, command) {
    const hookPath = join(PROJECT_ROOT, "hooks", "pre-tool-block-yolo-write.ts");
    const payload = JSON.stringify({ tool_name: toolName, tool_input: { command } });
    return spawnSync("node", ["--import", "tsx", hookPath], {
      input: payload,
      encoding: "utf8",
      timeout: 30000,
      cwd: PROJECT_ROOT,
    });
  }

  test("P6.H1: non-yolo Bash commands referencing .yolo are blocked (14 cases)", () => {
    const hookPath = join(PROJECT_ROOT, "hooks", "pre-tool-block-yolo-write.ts");
    if (!existsSync(hookPath)) {
      assert.ok(true, "hook not present — skip");
      return;
    }

    const blocked = [
      // 1-2: node inline eval, relative + absolute
      "node -e \"require('fs').writeFileSync('.yolo/lifecycle/status.json', '{}')\"",
      "node --eval \"require('fs').writeFileSync('.yolo/lifecycle/status.json', '{}')\"",
      // 3: python inline eval
      "python3 -c \"open('.yolo/state.json', 'w').write('{}')\"",
      // 4-6: common write utilities (no special detector needed)
      "cp /tmp/seed.json .yolo/lifecycle/status.json",
      "mv /tmp/seed.json .yolo/lifecycle/status.json",
      "touch .yolo/lifecycle/status.json",
      // 7-8: shell redirects, relative + absolute
      "echo '{}' > .yolo/lifecycle/status.json",
      "echo '{}' >> .yolo/lifecycle/status.json",
      // 9-10: tee / sed
      "tee .yolo/lifecycle/status.json < /tmp/seed",
      "sed -i 's/a/b/' .yolo/lifecycle/status.json",
      // 11-12: curl / dd
      "curl -o .yolo/state.json https://example.com/seed",
      "dd if=/dev/zero of=.yolo/lifecycle/status.json bs=1 count=1",
      // 13: removal / destructive access is also a .yolo reference
      "rm -rf .yolo",
      // 14: command chain where one segment is not a yolo CLI
      "yolo status --state-root .yolo; node -e \"require('fs').writeFileSync('.yolo/status.json', '{}')\"",
    ];

    for (const command of blocked) {
      const result = runHook("Bash", command);
      assert.equal(result.status, 2, `must be blocked: ${command}`);
      assert.ok(
        String(result.stderr).includes("blocked") || String(result.stderr).includes(".yolo"),
        `blocked response must mention .yolo: ${command}`
      );
    }
  });

  test("P6.H1: yolo CLI invocations referencing .yolo are allowed", () => {
    const hookPath = join(PROJECT_ROOT, "hooks", "pre-tool-block-yolo-write.ts");
    if (!existsSync(hookPath)) {
      assert.ok(true, "hook not present — skip");
      return;
    }

    const allowed = [
      "yolo status --state-root /project/.yolo",
      "yolo status --state-root .yolo",
      "./yolo run --state-root .yolo",
      "node ./dist/bin/yolo.js status --state-root /project/.yolo",
      "node --import tsx src/bin/yolo.js init /project --json",
      "node --loader tsx src/bin/yolo.ts status --state-root .yolo",
      "yolo status --state-root .yolo && yolo run --state-root .yolo",
    ];

    for (const command of allowed) {
      const result = runHook("Bash", command);
      assert.equal(result.status, 0, `yolo CLI must be allowed: ${command}`);
    }
  });

  test("P6.H1: non-.yolo references are not blocked", () => {
    const hookPath = join(PROJECT_ROOT, "hooks", "pre-tool-block-yolo-write.ts");
    if (!existsSync(hookPath)) {
      assert.ok(true, "hook not present — skip");
      return;
    }

    const allowed = [
      "cat config.json",
      "echo '{}' > myyolo/status.json",
      "node -e \"require('fs').writeFileSync('config.yololike', '{}')\"",
      "ls projectyolo",
    ];

    for (const command of allowed) {
      const result = runHook("Bash", command);
      assert.equal(result.status, 0, `non-.yolo command must not be blocked: ${command}`);
    }
  });

  test("P6.H3: case-insensitive .yolo variants are blocked", () => {
    const hookPath = join(PROJECT_ROOT, "hooks", "pre-tool-block-yolo-write.ts");
    if (!existsSync(hookPath)) {
      assert.ok(true, "hook not present — skip");
      return;
    }

    const variants = [".YOLO", ".Yolo", ".yOlO"];
    for (const variant of variants) {
      for (const toolName of ["Write", "Edit", "Bash"]) {
        const filePath = `${variant}/lifecycle/status.json`;
        const command = `echo '{}' > ${variant}/lifecycle/status.json`;
        const payload = JSON.stringify({
          tool_name: toolName,
          tool_input: toolName === "Bash" ? { command } : { file_path: filePath },
        });
        const result = spawnSync("node", ["--import", "tsx", hookPath], {
          input: payload,
          encoding: "utf8",
          timeout: 30000,
          cwd: PROJECT_ROOT,
        });
        assert.equal(result.status, 2, `${toolName} must block ${variant}`);
      }
    }
  });

  test("P6.H3: lowercase .yolo control group remains blocked", () => {
    const hookPath = join(PROJECT_ROOT, "hooks", "pre-tool-block-yolo-write.ts");
    if (!existsSync(hookPath)) {
      assert.ok(true, "hook not present — skip");
      return;
    }
    const payload = JSON.stringify({ tool_name: "Write", tool_input: { file_path: ".yolo/lifecycle/status.json" } });
    const result = spawnSync("node", ["--import", "tsx", hookPath], {
      input: payload,
      encoding: "utf8",
      timeout: 30000,
      cwd: PROJECT_ROOT,
    });
    assert.equal(result.status, 2, "lowercase .yolo must still be blocked");
  });

  test("P6.H1: settings-minimal.json matcher registers Bash hook", () => {
    const settingsPath = join(PROJECT_ROOT, "settings-minimal.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const matchers = (settings.hooks?.PreToolUse || []).map((entry) => entry.matcher);
    const bashRegistered = matchers.some((matcher) => typeof matcher === "string" && /\bBash\b/.test(matcher));
    assert.ok(bashRegistered, "settings-minimal.json PreToolUse matcher must include Bash");
  });

  test("P6.M1: final answer outcome derives from verifiable fields, not report.status", () => {
    const finalAnswer = buildRunFinalAnswer({
      run_id: "RUN-P6-M1",
      status: "success",
      summary: { planned: 1, completed: 1, failed: 0, skipped: 0, blocked: 0 },
      tasks: { completed: ["FIX-1"], failed: [], skipped: [], blocked: [] },
      gates: { failed_count: 1, failed_tasks: ["FIX-1"] },
      review: { issue_count: 0, error_count: 0 },
    });

    assert.equal(finalAnswer.outcome, "needs_attention");
    assert.ok(finalAnswer.blockers.some((blocker) => blocker.includes("failed gates: 1")));
  });

  test("P6.M2: external .yolo paths such as /tmp/.yolo are not blocked", () => {
    const hookPath = join(PROJECT_ROOT, "hooks", "pre-tool-block-yolo-write.ts");
    if (!existsSync(hookPath)) {
      assert.ok(true, "hook not present — skip");
      return;
    }

    const allowed = [
      { tool_name: "Write", tool_input: { file_path: "/tmp/.yolo/scratch.json" } },
      { tool_name: "Edit", tool_input: { file_path: "/var/tmp/.yolo/state.json" } },
      { tool_name: "Bash", tool_input: { command: "cat /tmp/.yolo/scratch.json" } },
      { tool_name: "Bash", tool_input: { command: "echo '{}' > /tmp/.yolo/scratch.json" } },
      { tool_name: "Bash", tool_input: { command: "ls /tmp/.yolo" } },
    ];

    for (const payload of allowed) {
      const result = spawnSync("node", ["--import", "tsx", hookPath], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        timeout: 30000,
        cwd: PROJECT_ROOT,
      });
      assert.equal(result.status, 0, `external .yolo path must not be blocked: ${JSON.stringify(payload)}`);
    }
  });
});
