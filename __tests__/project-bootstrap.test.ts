import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildProjectBootstrapPlan, initProject } from "../src/core/bootstrap.js";
import { createYoloSdk } from "../sdk.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(readFileSync(resolve(YOLO_DIR, "package.json"), "utf8"));

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-init-"));
}

describe("project bootstrap", () => {
  test("buildProjectBootstrapPlan returns the public beta directory skeleton", () => {
    const root = tempProject();
    try {
      const plan = buildProjectBootstrapPlan({ projectRoot: root, projectName: "demo-app" });

      assert.equal(plan.project_root, root);
      assert.equal(plan.project_name, "demo-app");
      assert.deepEqual(plan.directories, [
        ".yolo",
        ".yolo/lifecycle",
        ".yolo/memory",
        ".yolo/context",
        ".yolo/context/domain",
        ".yolo/context/codebase",
        ".yolo/decisions",
        ".yolo/packs",
        ".yolo/adapters",
        ".yolo/state",
        ".yolo/state/runtime",
        ".yolo/templates",
        "specs",
      ]);
      assert.deepEqual(plan.files.map((file) => file.path), [
        ".yolo/config.json",
        ".yolo/constitution.md",
        "DESIGN.md",
        ".yolo/lifecycle/status.json",
        ".yolo/lifecycle/idea.json",
        ".yolo/lifecycle/discovery.json",
        ".yolo/lifecycle/setup.json",
        ".yolo/lifecycle/roadmap.json",
        ".yolo/lifecycle/task-graph.json",
        ".yolo/lifecycle/prd.json",
        ".yolo/lifecycle/check-report.json",
        ".yolo/lifecycle/run-report.json",
        ".yolo/lifecycle/review-report.json",
        ".yolo/lifecycle/acceptance-report.json",
        ".yolo/lifecycle/delivery-report.json",
        ".yolo/lifecycle/retrospective.json",
        ".yolo/memory/MEMORY_INDEX.md",
        ".yolo/memory/CURRENT_STATUS.md",
        ".yolo/memory/CURRENT_HANDOFF.md",
        ".yolo/memory/PROJECT_BRIEF.md",
        ".yolo/memory/PROGRESS.md",
        ".yolo/memory/OPEN_QUESTIONS.md",
        ".yolo/memory/DECISION_LOG.md",
        ".yolo/memory/DOCUMENT_GOVERNANCE.md",
        ".yolo/memory/LEARNING_INDEX.md",
        ".yolo/memory/LESSONS_PLAYBOOK.md",
        ".yolo/memory/PROJECT_TREE.md",
        ".yolo/memory/MEMORY_AUDIT.md",
        ".yolo/context/domain/GLOSSARY.md",
        ".yolo/context/codebase/ARCHITECTURE.md",
        ".yolo/context/codebase/STRUCTURE.md",
        ".yolo/context/codebase/CONVENTIONS.md",
        ".yolo/context/codebase/TESTING.md",
        ".yolo/context/codebase/DEPENDENCIES.md",
        ".yolo/context/codebase/SURFACES.md",
        ".yolo/context/codebase/RISK_AREAS.md",
        ".yolo/state/changes.jsonl",
        ".yolo/state/events.jsonl",
        ".yolo/state/runs.jsonl",
        ".yolo/state/learning.jsonl",
        ".yolo/state/session-memory.jsonl",
        ".yolo/state/questions.jsonl",
        ".yolo/state/decisions.jsonl",
        ".yolo/state/artifacts.jsonl",
        ".yolo/templates/requirements.md",
        ".yolo/templates/design.md",
        ".yolo/templates/tasks.md",
        ".yolo/templates/UI-SPEC.md",
        "specs/README.md",
        "specs/requirements.md",
        "specs/design.md",
        "specs/tasks.md",
      ]);
      assert.equal(plan.files.every((file) => !file.path.startsWith("/") && file.content.includes(root) === false), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("initProject creates .yolo and specs without overwriting existing files", () => {
    const root = tempProject();
    try {
      const first = initProject({ projectRoot: root, projectName: "demo-app" });
      assert.equal(first.status, "success");
      assert.equal(first.created.length, 52);
      assert.equal(first.memory_refresh.status, "ok");
      assert.equal(existsSync(join(root, ".yolo/config.json")), true);
      assert.equal(existsSync(join(root, ".yolo/constitution.md")), true);
      assert.equal(existsSync(join(root, ".yolo/lifecycle/status.json")), true);
      assert.equal(existsSync(join(root, ".yolo/lifecycle/retrospective.json")), true);
      assert.equal(existsSync(join(root, ".yolo/memory/MEMORY_INDEX.md")), true);
      assert.equal(existsSync(join(root, ".yolo/memory/PROJECT_BRIEF.md")), true);
      assert.equal(existsSync(join(root, ".yolo/memory/PROGRESS.md")), true);
      assert.equal(existsSync(join(root, ".yolo/memory/OPEN_QUESTIONS.md")), true);
      assert.equal(existsSync(join(root, ".yolo/memory/DECISION_LOG.md")), true);
      assert.equal(existsSync(join(root, ".yolo/memory/DOCUMENT_GOVERNANCE.md")), true);
      assert.equal(existsSync(join(root, ".yolo/memory/LEARNING_INDEX.md")), true);
      assert.equal(existsSync(join(root, ".yolo/context")), true);
      assert.equal(existsSync(join(root, ".yolo/context/domain/GLOSSARY.md")), true);
      assert.equal(existsSync(join(root, ".yolo/context/codebase/ARCHITECTURE.md")), true);
      assert.equal(existsSync(join(root, ".yolo/context/codebase/SURFACES.md")), true);
      assert.equal(existsSync(join(root, ".yolo/packs")), true);
      assert.equal(existsSync(join(root, ".yolo/adapters")), true);
      assert.equal(existsSync(join(root, ".yolo/state/changes.jsonl")), true);
      assert.equal(existsSync(join(root, ".yolo/state/learning.jsonl")), true);
      assert.equal(existsSync(join(root, ".yolo/state/questions.jsonl")), true);
      assert.equal(existsSync(join(root, ".yolo/state/decisions.jsonl")), true);
      assert.equal(existsSync(join(root, ".yolo/state/artifacts.jsonl")), true);
      assert.equal(existsSync(join(root, ".yolo/templates/design.md")), true);
      assert.equal(existsSync(join(root, ".yolo/templates/UI-SPEC.md")), true);
      assert.equal(existsSync(join(root, "DESIGN.md")), true);
      assert.equal(existsSync(join(root, "specs/tasks.md")), true);

      writeFileSync(join(root, "specs/requirements.md"), "custom requirements\n", "utf8");
      const second = initProject({ projectRoot: root, projectName: "demo-app" });
      assert.equal(second.skipped.includes("specs/requirements.md"), true);
      assert.equal(readFileSync(join(root, "specs/requirements.md"), "utf8"), "custom requirements\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("initProject dry-run reports artifacts without writing files", () => {
    const root = tempProject();
    try {
      const result = initProject({ projectRoot: root, dryRun: true });

      assert.equal(result.dry_run, true);
      assert.equal(result.created.length, 52);
      assert.equal(result.memory_refresh, null);
      assert.equal(existsSync(join(root, ".yolo/config.json")), false);
      assert.equal(existsSync(join(root, ".yolo/lifecycle/status.json")), false);
      assert.equal(existsSync(join(root, ".yolo/memory/MEMORY_INDEX.md")), false);
      assert.equal(existsSync(join(root, "specs/README.md")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("createYoloSdk exposes project bootstrap under the project namespace", () => {
    const root = tempProject();
    try {
      const sdk = createYoloSdk({ projectRoot: root });
      const result = sdk.project.initProject({ projectName: "sdk-demo" });

      assert.equal(result.project_root, root);
      assert.equal(existsSync(join(root, ".yolo/config.json")), true);
      assert.equal(existsSync(join(root, ".yolo/lifecycle/status.json")), true);
      assert.equal(existsSync(join(root, ".yolo/memory/CURRENT_HANDOFF.md")), true);
      assert.equal(existsSync(join(root, "DESIGN.md")), true);
      const config = JSON.parse(readFileSync(join(root, ".yolo/config.json"), "utf8"));
      assert.equal(config.project.name, "sdk-demo");
      assert.equal(config.paths.lifecycle, ".yolo/lifecycle");
      assert.equal(config.paths.memory, ".yolo/memory");
      assert.equal(config.paths.context, ".yolo/context");
      assert.equal(config.paths.packs, ".yolo/packs");
      assert.equal(config.paths.adapters, ".yolo/adapters");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo init CLI creates the bootstrap structure and returns JSON", () => {
    const root = tempProject();
    try {
      const result = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin.yolo),
        "init",
        "--cwd",
        root,
        "--name",
        "cli-demo",
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" });

      assert.equal(result.stderr, "");
      assert.equal(result.status, 0);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "success");
      assert.equal(payload.project_name, "cli-demo");
      assert.equal(payload.created.includes(".yolo/config.json"), true);
      assert.equal(payload.created.includes(".yolo/lifecycle/status.json"), true);
      assert.equal(payload.created.includes(".yolo/memory/MEMORY_INDEX.md"), true);
      assert.equal(payload.created.includes(".yolo/memory/DOCUMENT_GOVERNANCE.md"), true);
      assert.equal(payload.created.includes(".yolo/memory/LEARNING_INDEX.md"), true);
      assert.equal(payload.created.includes("DESIGN.md"), true);
      assert.equal(existsSync(join(root, "specs/design.md")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo memory refresh CLI updates initialized project memory", () => {
    const root = tempProject();
    try {
      initProject({ projectRoot: root, projectName: "memory-cli-demo" });
      writeFileSync(join(root, "src.js"), "export const ok = true;\n", "utf8");

      const result = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin.yolo),
        "memory",
        "refresh",
        root,
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" });

      assert.equal(result.stderr, "");
      assert.equal(result.status, 0);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "ok");
      assert.equal(payload.memory_dir, join(root, ".yolo/memory"));
      assert.match(readFileSync(join(root, ".yolo/memory/PROJECT_TREE.md"), "utf8"), /src\.js/);
      assert.match(readFileSync(join(root, ".yolo/memory/LEARNING_INDEX.md"), "utf8"), /Records: 0/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("lifecycle commands auto-refresh initialized project memory", () => {
    const root = tempProject();
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
      initProject({ projectRoot: root, projectName: "auto-memory-demo" });

      const result = spawnSync(process.execPath, [
        resolve(YOLO_DIR, packageJson.bin.yolo),
        "brainstorm",
        demandText,
        `--cwd=${root}`,
        "--json",
      ], { cwd: YOLO_DIR, encoding: "utf8" });

      assert.equal(result.stderr, "");
      assert.equal(result.status, 0, result.stdout);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.code, "DEMAND_READY");
      assert.equal(payload.memory_refresh.status, "ok");
      assert.equal(payload.memory_refresh.memory_dir, join(root, ".yolo/memory"));
      assert.match(readFileSync(join(root, ".yolo/memory/CURRENT_STATUS.md"), "utf8"), /## Project Brain/);
      assert.match(readFileSync(join(root, ".yolo/memory/CURRENT_STATUS.md"), "utf8"), /Latest demand session: `DEMAND-/);
      assert.match(readFileSync(join(root, ".yolo/memory/CURRENT_HANDOFF.md"), "utf8"), /## Next Operator Action/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("core bootstrap package export imports without side effects", () => {
    const output = execFileSync(process.execPath, [
      "-e",
      "import('yolo/core/bootstrap').then((m)=>console.log(Object.keys(m).sort().join(',')))",
    ], { cwd: YOLO_DIR, encoding: "utf8" });

    assert.match(output, /buildProjectBootstrapPlan/);
    assert.match(output, /initProject/);
  });
});
