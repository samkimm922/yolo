import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDemandDiscussRuntime, runDemandPrdRuntime } from "../src/demand/runtime.js";
import { planControlledParallelWaves } from "../src/runtime/parallel/wave-planner.js";

function isTestFile(file = "") {
  const path = String(file).toLowerCase();
  return /(^|\/)(__tests__|tests?|specs?)\//.test(path) || /\.(test|spec)\./.test(path);
}

function writeProjectFile(root, file, content) {
  const path = join(root, file);
  mkdirSync(join(root, file.split("/").slice(0, -1).join("/") || "."), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function seedInventoryProject(root) {
  writeProjectFile(root, "src/pages/inventory-list.tsx", [
    "export function InventoryList({ items }) {",
    "  return <ul>{items.map((item) => <li key={item.sku}>{item.sku}{item.quantity <= item.lowStockThreshold ? <span>Low stock</span> : null}</li>)}</ul>;",
    "}",
    "",
  ].join("\n"));
  writeProjectFile(root, "src/services/inventory-alerts.ts",
    "export function isLowStock(item) { return item.quantity <= item.lowStockThreshold; }\n");
  writeProjectFile(root, "src/services/inventory-alerts.test.ts",
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isLowStock } from './inventory-alerts';\ntest('low stock threshold', () => assert.equal(isLowStock({ quantity: 1, lowStockThreshold: 2 }), true));\n");
}

function baseDiscussInput(root, overrides = {}) {
  return {
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    idea: "Show store managers low-stock alerts in the inventory list.",
    target_users: ["store manager"],
    status_quo: ["Managers only see raw inventory counts."],
    evidence: ["Agent read src/pages/inventory-list.tsx and confirmed inventory rows expose item.quantity and item.lowStockThreshold."],
    assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
    success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
    proof: ["A screenshot or component test shows an inline 'Low stock' badge after the SKU when item.quantity <= item.lowStockThreshold."],
    visual_style: ["Use an inline text label with the current list typography and no new color system."],
    constraints: ["Do not change order import behavior."],
    non_goals: ["Do not build supplier ordering."],
    target_files: ["src/pages/inventory-list.tsx"],
    decisions: ["Start with an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
    roadmap: ["MVP badge in inventory list."],
    exceptions: ["What if the inventory system is down?"],
    approve: true,
    playback: { confirmed: true, confirmed_by: "user" },
    writeArtifacts: true,
    ...overrides,
  };
}

/** Get tasks from PRD result regardless of blocked/success status. */
function getTasks(prdResult) {
  return prdResult.compiled?.prd?.tasks || prdResult.prd?.tasks || [];
}

describe("P2.16 task schema enhancement", () => {
  test("tasks include inputs and expected_output populated from read_first and scope targets", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p2-16-io-"));
    try {
      seedInventoryProject(root);
      const discuss = runDemandDiscussRuntime(baseDiscussInput(root, {
        target_files: ["src/pages/inventory-list.tsx", "src/services/inventory-alerts.ts"],
      }));

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      const tasks = getTasks(prd);
      assert.ok(tasks.length > 0, `must have tasks (status=${prd.status}, code=${prd.code})`);

      for (const task of tasks) {
        assert.ok(Array.isArray(task.inputs), `task ${task.id} must have inputs array`);
        assert.ok(task.inputs.length > 0, `task ${task.id} must have at least one input`);
        for (const input of task.inputs) {
          assert.equal(typeof input, "string", `input "${input}" must be a string`);
        }

        assert.ok(Array.isArray(task.expected_output), `task ${task.id} must have expected_output array`);
        assert.ok(task.expected_output.length > 0, `task ${task.id} must have at least one expected_output`);
        for (const output of task.expected_output) {
          assert.equal(typeof output, "string", `expected_output "${output}" must be a string`);
        }

        const scopeFiles = task.scope.targets.map((t) => t.file);
        for (const output of task.expected_output) {
          assert.ok(scopeFiles.includes(output), `expected_output "${output}" must be in scope targets`);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dependency graph is derivable from inputs and expected_output", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p2-16-depgraph-"));
    try {
      seedInventoryProject(root);
      const discuss = runDemandDiscussRuntime(baseDiscussInput(root, {
        success_criteria: ["Inventory service marks low-stock SKUs.", "Inventory list displays a visible low-stock badge."],
        target_files: ["src/services/inventory-alerts.ts", "src/pages/inventory-list.tsx", "src/services/inventory-alerts.test.ts"],
      }));

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      const tasks = getTasks(prd);
      assert.ok(tasks.length > 0, `must have tasks (status=${prd.status}, code=${prd.code})`);

      // Production tasks must have depends_on derived from non-test inputs ∩ expected_output
      for (const taskB of tasks) {
        const bOutputs = new Set((taskB.expected_output || []).filter((f) => !isTestFile(f)));
        for (const taskA of tasks) {
          if (taskA.id === taskB.id) continue;
          const aOutputs = new Set((taskA.expected_output || []).filter((f) => !isTestFile(f)));
          const bInputs = (taskB.inputs || []).filter((f) => !isTestFile(f));
          const hasOverlap = bInputs.some((input) => aOutputs.has(input) && !bOutputs.has(input));
          if (hasOverlap) {
            assert.ok(taskB.depends_on.includes(taskA.id),
              `task ${taskB.id} must depend on ${taskA.id} because its non-test external inputs overlap with ${taskA.id}'s expected_output`);
          }
        }
      }

      // No false positives: tasks without non-test overlap must not have file-derived dependency
      for (const taskB of tasks) {
        const bOutputs = new Set((taskB.expected_output || []).filter((f) => !isTestFile(f)));
        for (const taskA of tasks) {
          if (taskA.id === taskB.id) continue;
          const aOutputs = new Set((taskA.expected_output || []).filter((f) => !isTestFile(f)));
          const bInputs = (taskB.inputs || []).filter((f) => !isTestFile(f));
          const hasOverlap = bInputs.some((input) => aOutputs.has(input) && !bOutputs.has(input));
          if (!hasOverlap) {
            assert.equal(taskB.depends_on.includes(taskA.id), false,
              `task ${taskB.id} must NOT depend on ${taskA.id} because there is no non-test external input/output overlap`);
          }
        }
      }

      // Wave-planner consumption: dependent tasks must not share the same wave
      const testTasks = tasks.filter((t) =>
        (t.expected_output || []).some((f) => /\.(test|spec)\./.test(f)),
      );
      const implTasks = tasks.filter((t) =>
        (t.expected_output || []).some((f) => !/\.(test|spec)\./.test(f)),
      );
      assert.ok(testTasks.length > 0, "must have test tasks");
      assert.ok(implTasks.length > 0, "must have implementation tasks");

      // With no completed tasks, dependent tasks should be unscheduled
      const pendingPlan = planControlledParallelWaves({ tasks });
      assert.equal(pendingPlan.status, "blocked");
      const dependentTask = tasks.find((t) => t.depends_on.length > 0);
      assert.ok(dependentTask, "must have at least one task with derived dependency");
      assert.equal(pendingPlan.waves.some((w) => w.task_ids.includes(dependentTask.id)), false,
        `dependent task ${dependentTask.id} must not be scheduled when its dependency is pending`);
      assert.ok(pendingPlan.blockers.some((b) => b.task_id === dependentTask.id),
        `dependent task ${dependentTask.id} must appear in blockers when dependency is pending`);

      // With all dependencies completed, dependent task should be scheduled
      const dependencyIds = dependentTask.depends_on;
      const completedPlan = planControlledParallelWaves({ tasks, completedTaskIds: dependencyIds });
      assert.equal(completedPlan.waves.some((w) => w.task_ids.includes(dependentTask.id)), true,
        `dependent task ${dependentTask.id} must be scheduled when its dependencies ${dependencyIds.join(",")} are completed`);
      // Wave-planner graph must include the derived dependency edge
      for (const dependencyId of dependencyIds) {
        assert.ok(completedPlan.graph.edges.some((e) => e.from === dependencyId && e.to === dependentTask.id),
          `wave-planner graph must include edge from ${dependencyId} to ${dependentTask.id}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tasks include must_haves triad (Truths/Artifacts/Key Links) in handoff", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p2-16-musthaves-"));
    try {
      seedInventoryProject(root);
      const discuss = runDemandDiscussRuntime(baseDiscussInput(root));

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      const tasks = getTasks(prd);
      assert.ok(tasks.length > 0, `must have tasks (status=${prd.status}, code=${prd.code})`);

      for (const task of tasks) {
        const mustHaves = task.handoff?.must_haves;
        assert.ok(mustHaves, `task ${task.id} handoff must include must_haves`);

        assert.ok(Array.isArray(mustHaves.truths), "must_haves.truths must be an array");
        assert.ok(mustHaves.truths.length > 0, "must_haves.truths must not be empty");
        for (const truth of mustHaves.truths) {
          assert.equal(typeof truth, "string", `truth "${truth}" must be a string`);
        }

        assert.ok(Array.isArray(mustHaves.artifacts), "must_haves.artifacts must be an array");
        assert.ok(mustHaves.artifacts.length >= 3, "must_haves.artifacts must have at least 3 entries");
        assert.ok(mustHaves.artifacts.some((a) => a.includes("session.json")), "artifacts must include session.json path");
        assert.ok(mustHaves.artifacts.some((a) => a.includes("handoff.md")), "artifacts must include handoff.md path");
        assert.ok(mustHaves.artifacts.some((a) => a.includes("evidence.jsonl")), "artifacts must include evidence.jsonl path");

        assert.ok(Array.isArray(mustHaves.key_links), "must_haves.key_links must be an array");
        assert.ok(mustHaves.key_links.length >= 4, "must_haves.key_links must have at least 4 entries");
        assert.ok(mustHaves.key_links.some((link) => link.startsWith("demand:")), "key_links must include demand link");
        assert.ok(mustHaves.key_links.some((link) => link.startsWith("requirement:")), "key_links must include requirement link");
        assert.ok(mustHaves.key_links.some((link) => link.startsWith("scenario:")), "key_links must include scenario link");
        assert.ok(mustHaves.key_links.some((link) => link.startsWith("surface:")), "key_links must include surface link");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("compile-time rejects verify_command with pipe character", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p2-16-verify-pipe-"));
    try {
      seedInventoryProject(root);
      const discuss = runDemandDiscussRuntime(baseDiscussInput(root));

      discuss.session.scenario_matrix.scenarios[0].verify_command = "npm test | grep PASS";
      writeFileSync(join(discuss.demand_dir, "session.json"), JSON.stringify(discuss.session, null, 2) + "\n", "utf8");

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.ok(prd.blockers.some((b) => b.code === "ILLEGAL_VERIFY_COMMAND"));
      const blocker = prd.blockers.find((b) => b.code === "ILLEGAL_VERIFY_COMMAND");
      assert.ok(blocker.message.includes("npm test | grep PASS"));
      assert.ok(blocker.message.includes("|"));
      assert.ok(blocker.message.includes("single safe command"));
      assert.equal(prd.prd, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("compile-time rejects verify_command with redirect", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p2-16-verify-redirect-"));
    try {
      seedInventoryProject(root);
      const discuss = runDemandDiscussRuntime(baseDiscussInput(root));

      discuss.session.scenario_matrix.scenarios[0].verify_command = "npm test > output.txt";
      writeFileSync(join(discuss.demand_dir, "session.json"), JSON.stringify(discuss.session, null, 2) + "\n", "utf8");

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.ok(prd.blockers.some((b) => b.code === "ILLEGAL_VERIFY_COMMAND"));
      const blocker = prd.blockers.find((b) => b.code === "ILLEGAL_VERIFY_COMMAND");
      assert.ok(blocker.message.includes("npm test > output.txt"));
      assert.ok(blocker.message.includes(">"));
      assert.equal(prd.prd, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("compile-time rejects verify_command with semicolon", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p2-16-verify-semicolon-"));
    try {
      seedInventoryProject(root);
      const discuss = runDemandDiscussRuntime(baseDiscussInput(root));

      discuss.session.scenario_matrix.scenarios[0].verify_command = "npm test; echo done";
      writeFileSync(join(discuss.demand_dir, "session.json"), JSON.stringify(discuss.session, null, 2) + "\n", "utf8");

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.ok(prd.blockers.some((b) => b.code === "ILLEGAL_VERIFY_COMMAND"));
      const blocker = prd.blockers.find((b) => b.code === "ILLEGAL_VERIFY_COMMAND");
      assert.ok(blocker.message.includes("npm test; echo done"));
      assert.ok(blocker.message.includes(";"));
      assert.equal(prd.prd, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("compile-time preserves valid verify_command without pipe/redirect/semicolon", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p2-16-verify-valid-"));
    try {
      seedInventoryProject(root);
      const discuss = runDemandDiscussRuntime(baseDiscussInput(root));

      discuss.session.scenario_matrix.scenarios[0].verify_command = "npm test";
      writeFileSync(join(discuss.demand_dir, "session.json"), JSON.stringify(discuss.session, null, 2) + "\n", "utf8");

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      const tasks = getTasks(prd);
      assert.ok(tasks.length > 0, `must have tasks (status=${prd.status}, code=${prd.code})`);

      for (const task of tasks) {
        const acceptCond = task.post_conditions.find((c) => c.type === "acceptance_criteria");
        assert.ok(acceptCond, `task ${task.id} must have acceptance_criteria`);
        assert.equal(acceptCond.params.verify_command, "npm test");
        assert.equal(acceptCond.severity, "FAIL");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
