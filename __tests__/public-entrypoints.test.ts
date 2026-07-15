import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildContextPackForTask, validateContextPack } from "../src/runtime/execution/context-pack-validator.js";
import { inspectPrdContract } from "../src/runtime/gates/prd-contract-doctor.js";
import { reviewFindingsToPrdTasks } from "../src/review/findings-to-tasks.js";
import { runInitToFirstPrdSmoke } from "../src/core/init-smoke.js";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";
import { inferDefaultCliPrdPath } from "../src/cli/yolo.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const packageJson: { exports: Record<string, string>; bin: Record<string, string>; scripts: Record<string, string> } = JSON.parse(readFileSync(resolve(YOLO_DIR, "package.json"), "utf8"));

describe("public package entrypoints", () => {
  test("Phase 1A public exports route through src boundaries", () => {
    assert.equal(packageJson.exports["./agents"], "./dist/src/agents/presets.js");
    assert.equal(packageJson.exports["./pi"], "./dist/src/agents/pi.js");
    assert.equal(packageJson.exports["./runtime"], "./dist/src/runtime/runner-runtime.js");
    assert.equal(packageJson.exports["./config"], "./dist/src/core/config.js");
    assert.equal(packageJson.exports["./prd-preflight"], "./dist/src/prd/preflight.js");
    assert.equal(packageJson.exports["./prd-migrate-gates"], "./dist/src/prd/migration.js");
    assert.ok(Object.values(packageJson.bin).every((target) => target.startsWith("./dist/bin/")));
  });

  for (const [exportName, target] of Object.entries(packageJson.exports)) {
    test(`export ${exportName} imports without side effects`, async () => {
      const file = resolve(YOLO_DIR, target);
      assert.equal(existsSync(file), true, `${exportName} target missing: ${target}`);

      const module = await import(pathToFileURL(file).href);
      assert.ok(Object.keys(module).length > 0, `${exportName} exported no module bindings`);
    });
  }

  for (const [binName, target] of Object.entries(packageJson.bin)) {
    test(`bin ${binName} exists and parses`, () => {
      const file = resolve(YOLO_DIR, target);
      assert.equal(existsSync(file), true, `${binName} target missing: ${target}`);
      assert.match(readFileSync(file, "utf8"), /^#!\/usr\/bin\/env node/);
      execFileSync(process.execPath, ["--check", file], { cwd: YOLO_DIR, encoding: "utf8" });
    });
  }

  test("converted bins call src CLI modules instead of legacy script spawner", () => {
    for (const binName of ["yolo", "yolo-gate", "yolo-pi", "yolo-prompt", "yolo-prd-preflight", "yolo-prd-migrate-gates"]) {
      const source = readFileSync(resolve(YOLO_DIR, packageJson.bin[binName]), "utf8");
      assert.match(source, /src\/cli\//);
      assert.doesNotMatch(source, /runLegacyScript/);
    }
  });

  test("root yolo help keeps ordinary users on the public mainline", () => {
    const result = spawnSync(process.execPath, [
      resolve(YOLO_DIR, packageJson.bin.yolo),
      "--help",
    ], { cwd: YOLO_DIR, encoding: "utf8" });

    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^  yolo demand\b/m);
    assert.match(result.stdout, /^  yolo auto\b/m);
    assert.match(result.stdout, /^  yolo ship\b/m);
    assert.match(result.stdout, /^  yolo status\b/m);
    assert.match(result.stdout, /普通 Claude\/Codex\/GUI 集成只展示 4 个稳定入口/);
    assert.doesNotMatch(result.stdout, /^  yolo spec\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo tasks\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo run\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo check\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo review\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo release\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo prd\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo plan\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo next\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo office-hours\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo release-candidate\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo pi\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo gate\b/m);
    assert.doesNotMatch(result.stdout, /^  yolo preflight\b/m);
  });

  test("legacy yolo PRD entrypoint fails closed behind lifecycle guard", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-legacy-prd-"));
    try {
      const missingPrd = join(root, "missing-prd.json");
      const result = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin.yolo),
        `--prd=${missingPrd}`,
        `--cwd=${root}`,
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" });

      assert.equal(result.stderr, "");
      assert.equal(result.status, 2);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "blocked");
      assert.equal(payload.code, "LIFECYCLE_NOT_INITIALIZED");
      assert.equal(payload.recommended_command, "yolo init");

      const pi = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin["yolo-pi"]),
        "--execute",
        `--prd=${missingPrd}`,
        `--cwd=${root}`,
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" });
      assert.equal(pi.stderr, "");
      assert.equal(pi.status, 2);
      const piPayload = JSON.parse(pi.stdout);
      assert.equal(piPayload.status, "blocked");
      assert.equal(piPayload.code, "LIFECYCLE_NOT_INITIALIZED");

      const runner = spawnSync(process.execPath, [
        resolve(YOLO_DIR, "dist/runner.js"),
        `--prd=${missingPrd}`,
        `--cwd=${root}`,
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" });
      assert.equal(runner.stderr, "");
      assert.equal(runner.status, 2);
      const runnerPayload = JSON.parse(runner.stdout);
      assert.equal(runnerPayload.status, "blocked");
      assert.equal(runnerPayload.code, "LIFECYCLE_NOT_INITIALIZED");

      const acceptance = spawnSync(process.execPath, [
        resolve(YOLO_DIR, "dist/src/runtime/acceptance/report.js"),
        missingPrd,
        `--cwd=${root}`,
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" });
      assert.equal(acceptance.stderr, "");
      assert.equal(acceptance.status, 2);
      const acceptancePayload = JSON.parse(acceptance.stdout);
      assert.equal(acceptancePayload.status, "blocked");
      assert.equal(acceptancePayload.code, "LIFECYCLE_NOT_INITIALIZED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo check resolves relative PRD paths against --cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-check-cwd-"));
    try {
      const smoke = await runInitToFirstPrdSmoke({ projectRoot: root, projectName: "cwd-app" });
      const relativePrd = join(root, "specs/prd.json");
      writeFileSync(relativePrd, readFileSync(smoke.prd_path, "utf8"), "utf8");

      const result = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin.yolo),
        "check",
        "specs/prd.json",
        `--cwd=${root}`,
        "--json",
        "--no-write",
      ], { cwd: YOLO_DIR, encoding: "utf8" });

      assert.equal(result.stderr, "");
      assert.equal(result.status, 0, result.stdout);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.prd_path, relativePrd);
      const preflight = payload.checks.find((check) => check.name === "prd_preflight");
      assert.equal(preflight.preflight.runner_readiness.can_execute, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo check and run default to demand prd.json instead of session.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-prd-default-"));
    try {
      const smoke = await runInitToFirstPrdSmoke({ projectRoot: root, projectName: "demand-default-app" });
      const demandDir = join(root, ".yolo", "demand", "DEMAND-ENTRY");
      mkdirSync(demandDir, { recursive: true });
      const demandPrd = join(demandDir, "prd.json");
      const demandSession = join(demandDir, "session.json");
      writeFileSync(demandPrd, readFileSync(smoke.prd_path, "utf8"), "utf8");
      writeFileSync(demandSession, JSON.stringify({
        schema: "yolo.demand.session.v1",
        id: "DEMAND-ENTRY",
        tasks: [],
      }, null, 2), "utf8");

      assert.equal(inferDefaultCliPrdPath({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
      }), demandPrd);

      writeLifecycleStageReport("discovery", {
        status: "success",
        summary: "test discovery",
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        source: "public-entrypoints-test",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      writeLifecycleStageReport("roadmap", {
        status: "success",
        summary: "test roadmap",
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        source: "public-entrypoints-test",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      writeLifecycleStageReport("prd", {
        status: "success",
        prd_path: demandPrd,
        artifacts: [demandPrd],
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        source: "public-entrypoints-test",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      const check = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin.yolo),
        "check",
        `--cwd=${root}`,
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" });
      assert.equal(check.stderr, "");
      assert.equal(check.status, 0, check.stdout);
      const checkPayload = JSON.parse(check.stdout);
      assert.equal(checkPayload.prd_path, demandPrd);
      assert.notEqual(checkPayload.prd_path, demandSession);

      const run = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin.yolo),
        "run",
        `--cwd=${root}`,
        "--dry-run",
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" });
      assert.equal(run.stderr, "");
      assert.equal(run.status, 0, run.stdout);
      const runPayload = JSON.parse(run.stdout);
      assert.equal(runPayload.status, "dry_run");
      assert.equal(runPayload.code, "PI_DRY_RUN_READY");
      assert.equal(runPayload.exit_code, 0);
      assert.equal(runPayload.plan.artifacts.prdPath, demandPrd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo run uses PI by default and runner remains available as engine-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-run-pi-"));
    try {
      const smoke = await runInitToFirstPrdSmoke({ projectRoot: root, projectName: "pi-app" });
      const relativePrd = join(root, "specs/prd.json");
      writeFileSync(relativePrd, readFileSync(smoke.prd_path, "utf8"), "utf8");
      writeLifecycleStageReport("discovery", {
        status: "success",
        summary: "test discovery",
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        source: "public-entrypoints-test",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      writeLifecycleStageReport("roadmap", {
        status: "success",
        summary: "test roadmap",
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        source: "public-entrypoints-test",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });
      writeLifecycleStageReport("prd", {
        status: "success",
        prd_path: relativePrd,
        artifacts: [relativePrd],
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        source: "public-entrypoints-test",
        writeSessionMemory: false,
        skipSequenceCheck: true,
      });

      const check = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin.yolo),
        "check",
        "specs/prd.json",
        `--cwd=${root}`,
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" });
      assert.equal(check.stderr, "");
      assert.equal(check.status, 0, check.stdout);

      const pi = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin.yolo),
        "run",
        "specs/prd.json",
        `--cwd=${root}`,
        "--dry-run",
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" });
      assert.equal(pi.stderr, "");
      assert.equal(pi.status, 0, pi.stdout);
      const piPayload = JSON.parse(pi.stdout);
      assert.equal(piPayload.status, "dry_run");
      assert.equal(piPayload.exit_code, 0);
      assert.equal(piPayload.dry_run, true);
      assert.equal(piPayload.stop_condition, "dry_run_after_runner");
      assert.ok(piPayload.plan.actions.some((action) => action.id === "pi.acceptance"));
      assert.ok(piPayload.plan.actions.some((action) => action.id === "pi.delivery.ship"));
      assert.deepEqual(piPayload.observations.map((item) => item.action_id), [
        "pi.intake",
        "pi.prd.preflight",
        "pi.execute.runner",
      ]);

      const runner = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin.yolo),
        "runner",
        "specs/prd.json",
        `--cwd=${root}`,
        "--dry-run",
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" });
      assert.equal(runner.stderr, "");
      assert.equal(runner.status, 0, runner.stdout);
      const runnerPayload = JSON.parse(runner.stdout);
      assert.equal(runnerPayload.status, "dry_run");
      assert.equal(runnerPayload.code, "RUNNER_DRY_RUN_READY");
      assert.equal(runnerPayload.exit_code, 0);
      assert.equal(runnerPayload.dry_run, true);
      assert.equal(runnerPayload.artifacts[0], relativePrd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo lifecycle commands dispatch to real discovery runtime instead of PRD paths", () => {
    const result = spawnSync(process.execPath, [
      resolve(YOLO_DIR, packageJson.bin.yolo),
      "demand",
      "--stage",
      "discover",
      "Inventory alerts need clearer success criteria",
      "--json",
      "--no-write",
    ], { cwd: YOLO_DIR, encoding: "utf8" });
    const payload = JSON.parse(result.stdout);

    assert.equal(result.stderr, "");
    assert.equal(result.status, 1);
    assert.equal(payload.status, "blocked");
    assert.equal(payload.code, "DISCOVERY_BLOCKED");
    assert.equal(payload.discovery.schema, "yolo.discovery.artifact.v1");
    assert.equal(payload.discovery.ready_for_plan, false);
  });

  test("yolo demand commands dispatch to brainstorm and discuss runtimes", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-cli-"));
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
      const brainstorm = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin.yolo),
        "demand",
        "--stage",
        "brainstorm",
        demandText,
        `--cwd=${root}`,
        "--json",
        "--no-write",
      ], { cwd: YOLO_DIR, encoding: "utf8" });
      assert.equal(brainstorm.stderr, "");
      const brainstormPayload = JSON.parse(brainstorm.stdout);
      assert.ok(["DEMAND_READY", "DEMAND_WARNING"].includes(brainstormPayload.code));
      assert.equal(brainstorm.status, brainstormPayload.code === "DEMAND_READY" ? 0 : 2);
      assert.equal(brainstormPayload.session.schema, "yolo.demand.session.v1");
      assert.equal(brainstormPayload.guarantees.writes_business_code, false);

      const discuss = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin.yolo),
        "demand",
        "--stage",
        "discuss",
        demandText,
        "--decision=Low stock alert is the MVP wedge",
        `--cwd=${root}`,
        "--json",
        "--no-write",
      ], { cwd: YOLO_DIR, encoding: "utf8" });
      assert.equal(discuss.stderr, "");
      assert.ok([0, 1].includes(discuss.status), discuss.stdout);
      const discussPayload = JSON.parse(discuss.stdout);
      assert.ok(["DEMAND_READY", "DEMAND_BLOCKED", "DEMAND_WARNING"].includes(discussPayload.code));
      assert.equal(discussPayload.session.phase, "discuss");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo-pi bin calls src CLI without changing output shape", () => {
    const result = spawnSync(process.execPath, [
      resolve(YOLO_DIR, packageJson.bin["yolo-pi"]),
      "--prd",
      "data/prd/current/prd-yolo-p40-progress-dashboard.json",
      "--json",
    ], { cwd: YOLO_DIR, encoding: "utf8" });
    assert.equal(result.stderr, "");
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);

    assert.equal(payload.status, "not_run");
    assert.equal(payload.code, "PI_PLAN_NOT_EXECUTED");
    assert.equal(payload.plan.input_source, "prd");
    assert.ok(payload.plan.actions.some((action) => action.id === "pi.execute.runner"));
  });

  test("yolo-prd-preflight bin calls src CLI and returns JSON", () => {
    const result = spawnSync(process.execPath, [
      resolve(YOLO_DIR, packageJson.bin["yolo-prd-preflight"]),
      "data/prd/current/prd-yolo-p40-progress-dashboard.json",
      "--json",
    ], { cwd: YOLO_DIR, encoding: "utf8" });

    assert.equal(result.stderr, "");
    assert.ok([0, 1].includes(result.status));
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.file.endsWith("data/prd/current/prd-yolo-p40-progress-dashboard.json"), true);
    assert.ok(["pass", "warning", "blocked"].includes(payload.status));
  });

  test("yolo-prd-migrate-gates bin calls src CLI and returns dry-run JSON", () => {
    const proc = spawnSync(process.execPath, [
      resolve(YOLO_DIR, packageJson.bin["yolo-prd-migrate-gates"]),
      "data/prd/current/prd-yolo-p40-progress-dashboard.json",
      "--json",
    ], { cwd: YOLO_DIR, encoding: "utf8" });
    const result = JSON.parse(proc.stdout);

    assert.equal(proc.stderr, "");
    assert.ok([0, 1].includes(proc.status));
    assert.equal(result.dry_run, true);
    assert.equal(result.file.endsWith("data/prd/current/prd-yolo-p40-progress-dashboard.json"), true);
    assert.ok(["success", "blocked"].includes(result.status));
  });

  test("yolo-gate bin calls src CLI and evaluates against --cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-gate-cli-"));
    const taskId = "FIX-PUBLIC-901";
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      const logDir = join(root, ".yolo/state/runtime");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(root, "src/value.ts"), "export const value = 'gate-pass';\n", "utf8");
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({
        version: "2.0",
        tasks: [{
          id: taskId,
          title: "Gate pass task",
          priority: "P1",
          type: "bugfix",
          status: "pending",
          scope: {
            targets: [{ file: "src/value.ts" }],
            expected_zero_business_code: true,
          },
          post_conditions: [{
            id: "POST-VALUE",
            type: "code_contains",
            severity: "FAIL",
            params: { file: "src/value.ts", text: "gate-pass" },
          }],
        }],
      }), "utf8");

      const result = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin["yolo-gate"]),
        `--task=${taskId}`,
        `--prd=${prdPath}`,
        `--cwd=${root}`,
        `--log-dir=${logDir}`,
      ], { cwd: YOLO_DIR, encoding: "utf8" });

      assert.equal(result.status, 0);
      assert.match(result.stdout, /ALL PASSED/);
      assert.equal(result.stderr, "");
      assert.ok(readdirSync(logDir).some((file) => file.startsWith(`gate-${taskId}-`)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo-prompt bin calls src CLI without changing prompt output shape", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prompt-cli-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/value.ts"), "export const value = 'prompt-pass';\n", "utf8");
      const prdPath = join(root, "prd.json");
      writeFileSync(prdPath, JSON.stringify({
        version: "2.0",
        tasks: [{
          id: "FIX-PROMPT-901",
          title: "Prompt pass task",
          priority: "P1",
          type: "bugfix",
          status: "pending",
          description: "Keep prompt output stable",
          scope: {
            targets: [{ file: "src/value.ts" }],
            expected_zero_business_code: true,
          },
          post_conditions: [{
            id: "POST-VALUE",
            type: "code_contains",
            severity: "FAIL",
            params: { file: "src/value.ts", text: "prompt-pass" },
          }],
        }],
      }), "utf8");

      const output = execFileSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin["yolo-prompt"]),
        "--task=FIX-PROMPT-901",
        `--prd=${prdPath}`,
        `--cwd=${root}`,
      ], { cwd: YOLO_DIR, encoding: "utf8" });

      assert.match(output, /# FIX-PROMPT-901 — Prompt pass task/);
      assert.match(output, /src\/value\.ts/);
      assert.match(output, /text: `prompt-pass`/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runner support modules", () => {
  test("context pack validator passes a strict task pack", () => {
    const task = {
      id: "FIX-PUBLIC-001",
      title: "Fix public entrypoints",
      type: "bugfix",
      status: "pending",
      priority: "P1",
      scope: {
        targets: [{ file: "src/index.ts" }],
        readonly_files: ["src/types.ts"],
        max_files: 2,
      },
      post_conditions: [{
        id: "POST-FILE",
        type: "target_file_modified",
        severity: "FAIL",
        params: { file: "src/index.ts" },
      }],
    };

    const pack = buildContextPackForTask(task, { root: YOLO_DIR, attempt: 1 });
    const result = validateContextPack(pack, { root: YOLO_DIR });

    assert.equal(result.status, "pass");
    assert.equal(result.blocks_execution, false);
    assert.equal(result.stats.target_count, 1);
  });

  test("context pack validator blocks unsafe target and readonly target overlap", () => {
    const pack = buildContextPackForTask({
      id: "FIX-PUBLIC-002",
      type: "bugfix",
      status: "pending",
      scope: {
        targets: [{ file: "../outside.ts" }, { file: "src/index.ts" }],
        readonly_files: ["src/index.ts"],
      },
      post_conditions: [{
        id: "POST-FILE",
        type: "target_file_modified",
        severity: "FAIL",
        params: { file: "src/index.ts" },
      }],
    }, { root: YOLO_DIR, attempt: 1 });

    const result = validateContextPack(pack, { root: YOLO_DIR });

    assert.equal(result.status, "fail");
    assert.equal(result.blocks_execution, true);
    assert.ok(result.failures.some((failure) => failure.code === "CONTEXT_PACK_UNSAFE_TARGET"));
    const conflict = result.failures.find((failure) => failure.code === "CONTEXT_PACK_TARGET_READONLY_CONFLICT");
    assert.ok(conflict, "expected CONTEXT_PACK_TARGET_READONLY_CONFLICT failure");
    assert.deepEqual(conflict.files, ["src/index.ts"]);
    assert.match(conflict.detail, /src\/index\.ts/);
    assert.match(conflict.detail, /remove src\/index\.ts from scope\.targets or scope\.readonly_files/i);
    assert.ok(conflict.remediation, "expected a remediation hint for the conflict");
  });

  test("context pack validator blocks max files exceeded with count vs max and a split hint", () => {
    const pack = buildContextPackForTask({
      id: "FIX-PUBLIC-002B",
      type: "bugfix",
      status: "pending",
      scope: {
        targets: [
          { file: "src/a.ts" },
          { file: "src/b.ts" },
          { file: "src/c.ts" },
        ],
        max_files: 2,
      },
      post_conditions: [{
        id: "POST-FILE",
        type: "target_file_modified",
        severity: "FAIL",
        params: { file: "src/a.ts" },
      }],
    }, { root: YOLO_DIR, attempt: 1 });

    const result = validateContextPack(pack, { root: YOLO_DIR });

    assert.equal(result.status, "fail");
    assert.equal(result.blocks_execution, true);
    const exceeded = result.failures.find((failure) => failure.code === "CONTEXT_PACK_MAX_FILES_EXCEEDED");
    assert.ok(exceeded, "expected CONTEXT_PACK_MAX_FILES_EXCEEDED failure");
    assert.equal(exceeded.target_count, 3);
    assert.equal(exceeded.max_files, 2);
    assert.match(exceeded.detail, /3 exceeds scope\.max_files 2/);
    assert.match(exceeded.detail, /split the task into smaller tasks or raise scope\.max_files/i);
    assert.ok(exceeded.remediation, "expected a remediation hint for max files exceeded");
  });

  test("context pack validator blocks new targets below a symlink outside root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-context-pack-root-"));
    const outside = mkdtempSync(join(tmpdir(), "yolo-context-pack-outside-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      symlinkSync(outside, join(root, "src", "link-out"));
      const pack = buildContextPackForTask({
        id: "FIX-PUBLIC-003",
        type: "bugfix",
        status: "pending",
        scope: {
          targets: [{ file: "src/link-out/new.ts" }],
        },
        post_conditions: [{
          id: "POST-FILE",
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: "src/link-out/new.ts" },
        }],
      }, { root, attempt: 1 });

      const result = validateContextPack(pack, { root });

      assert.equal(result.status, "fail");
      assert.equal(result.blocks_execution, true);
      assert.ok(result.failures.some((failure) =>
        failure.code === "CONTEXT_PACK_UNSAFE_TARGET" &&
        failure.file === "src/link-out/new.ts"
      ));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("context pack validator allows greenfield targets inside root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-context-pack-greenfield-"));
    try {
      const pack = buildContextPackForTask({
        id: "FIX-PUBLIC-004",
        type: "feature",
        status: "pending",
        scope: {
          targets: [{ file: "src/new-file.ts" }],
        },
        post_conditions: [{
          id: "POST-FILE",
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: "src/new-file.ts" },
        }],
      }, { root, attempt: 1 });

      const result = validateContextPack(pack, { root });

      assert.equal(result.status, "pass", JSON.stringify(result.failures, null, 2));
      assert.equal(result.blocks_execution, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("review findings convert into contract-clean PRD tasks", () => {
    const converted = reviewFindingsToPrdTasks([{
      finding_id: "SEC-001",
      scanner_id: "xss-innerHTML",
      severity: "CRITICAL",
      dimension: "security",
      description: "Remove unsafe innerHTML usage",
      file: "src/pages/profile.tsx:24",
      match: "innerHTML",
      must_fix_before_ship: true,
    }], { round: 2 });

    assert.equal(converted.blocks_ship, true);
    assert.equal(converted.tasks.length, 1);

    const task = converted.tasks[0];
    assert.equal(task.id, "FIX-R2-001");
    assert.equal(task.type, "security");
    assert.equal(task.priority, "P0");
    assert.deepEqual(task.scope.targets, [{ file: "src/pages/profile.tsx" }]);

    const contract = inspectPrdContract({ tasks: converted.tasks });
    assert.equal(contract.blocks_execution, false);
  });
});
