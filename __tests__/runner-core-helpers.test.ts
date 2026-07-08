import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/lib/config.js";
import { computeTaskTimeout, execNodeScript } from "../src/runtime/runner-core-helpers.js";

describe("runner core helper execution", () => {
  test("uses runner.task_timeout_m from loaded config as the task timeout cap", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-timeout-config-"));
    const configPath = join(root, "config.yaml");
    const srcDir = join(root, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "large.ts"), Array.from({ length: 100 }, (_, i) => `const value${i} = ${i};`).join("\n"), "utf8");
    try {
      writeFileSync(configPath, [
        'version: "2.0"',
        "runner:",
        "  task_timeout_m: 2",
        "",
      ].join("\n"), "utf8");
      loadConfig({ path: configPath, forceReload: true });

      assert.equal(computeTaskTimeout([{ file: "src/large.ts" }], { rootDir: root }), 120000);
    } finally {
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("defaults to a low task timeout floor instead of the old eight minute minimum", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-timeout-default-"));
    try {
      assert.equal(
        computeTaskTimeout([], { rootDir: root, config: { runner: { task_timeout_m: 30 } } }),
        120000,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scales timeout from target line count when rootDir is provided", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-timeout-lines-"));
    const srcDir = join(root, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "medium.ts"), Array.from({ length: 80 }, (_, i) => `export const line${i} = ${i};`).join("\n"), "utf8");
    try {
      assert.equal(
        computeTaskTimeout(
          [{ file: "src/medium.ts" }],
          { rootDir: root, config: { runner: { task_timeout_m: 30, task_timeout_floor_s: 120 } } },
        ),
        200000,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses declared max_lines_per_file as a minimum budget for existing targets", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-timeout-existing-budget-"));
    const srcDir = join(root, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "small.ts"), Array.from({ length: 65 }, (_, i) => `export const line${i} = ${i};`).join("\n"), "utf8");
    try {
      assert.equal(
        computeTaskTimeout(
          [{ file: "src/small.ts" }],
          {
            rootDir: root,
            config: { runner: { task_timeout_m: 30, task_timeout_floor_s: 120 } },
            scope: { max_lines_per_file: 120 },
          },
        ),
        300000,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("scales timeout for greenfield targets from declared max_lines_per_file", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-timeout-greenfield-"));
    try {
      assert.equal(
        computeTaskTimeout(
          [{ file: "src/new-cli.ts" }],
          {
            rootDir: root,
            config: { runner: { task_timeout_m: 30, task_timeout_floor_s: 120 } },
            scope: { max_lines_per_file: 120 },
          },
        ),
        300000,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the executor default floor for automated acceptance test generation tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-timeout-acceptance-"));
    try {
      assert.equal(
        computeTaskTimeout(
          [{ file: "test/cli-acceptance.test.ts" }],
          {
            rootDir: root,
            config: { runner: { task_timeout_m: 30, task_timeout_floor_s: 120 } },
            scope: { max_lines_per_file: 120 },
            task: {
              id: "DEMAND-AUTOMATED-ACCEPTANCE-TEST-001",
              task_kind: "demand_atomic_task",
              test_generation: { mode: "add_minimal" },
            },
          },
        ),
        600000,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not raise ordinary demand task timeouts to the executor floor", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-timeout-demand-"));
    try {
      assert.equal(
        computeTaskTimeout(
          [{ file: "src/new-cli.ts" }],
          {
            rootDir: root,
            config: { runner: { task_timeout_m: 30, task_timeout_floor_s: 120 } },
            scope: { max_lines_per_file: 120 },
            task: { id: "DEMAND-REQ-001-0010101", task_kind: "demand_atomic_task" },
          },
        ),
        300000,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows the task timeout floor to be configured", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-timeout-floor-"));
    try {
      assert.equal(
        computeTaskTimeout([], { rootDir: root, config: { runner: { task_timeout_m: 30, task_timeout_floor_s: 45 } } }),
        45000,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects path traversal in target file that escapes rootDir", () => {
    const base = mkdtempSync(join(tmpdir(), "yolo-trav-"));
    const root = join(base, "project");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(base, "trap.txt"), "x\n".repeat(60), "utf8");
    writeFileSync(join(root, "legit.txt"), "ok\n", "utf8");
    try {
      const baselineResult = computeTaskTimeout(
        [{ file: "legit.txt" }],
        { rootDir: root, config: { runner: { task_timeout_m: 30, task_timeout_floor_s: 1 } } },
      );
      assert.ok(baselineResult > 1000, "in-root file should scale timeout above floor");

      const traversalResult = computeTaskTimeout(
        [{ file: "../trap.txt" }],
        { rootDir: root, config: { runner: { task_timeout_m: 30, task_timeout_floor_s: 1 } } },
      );
      assert.equal(traversalResult, 1000, "traversal result should be floor (trap file NOT read)");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("still reads in-root files for timeout scaling", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-task-timeout-inroot-"));
    const srcDir = join(root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "work.ts"), "x\n".repeat(100), "utf8");
    try {
      const result = computeTaskTimeout(
        [{ file: "src/work.ts" }],
        { rootDir: root, config: { runner: { task_timeout_m: 30, task_timeout_floor_s: 1 } } },
      );
      assert.ok(result > 1000, "in-root file should contribute to timeout");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails loudly when the requested helper script is missing", () => {
    const toolsRoot = mkdtempSync(join(tmpdir(), "yolo-tools-root-"));
    try {
      const result = execNodeScript("prompt.js", [], { toolsRoot, cwd: toolsRoot });

      assert.equal(result.ok, false);
      assert.equal(result.stdout, "");
      assert.equal(result.code, "HELPER_SCRIPT_NOT_FOUND");
      assert.equal(result.helperMissing, true);
      assert.match(result.stderr, /helper script not found/);
      assert.match(result.stderr, /prompt\.js/);
      assert.match(result.stderr, new RegExp(toolsRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(toolsRoot, { recursive: true, force: true });
    }
  });
});
