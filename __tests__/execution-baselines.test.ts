import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  BASELINE_FILE_NAMES,
  BASELINE_KINDS,
  BASELINE_RUNTIME_FILES,
  BASELINE_TOOLS,
  baselineArtifactHash,
  baselineFileName,
  captureExecutionBaselines,
  snapshotCommandOutput,
  pruneResolvedBaselineKeys,
  refreshBaselineAfterCommit,
} from "../src/runtime/execution/baselines.js";

describe("execution baseline helpers", () => {
  test("baseline runtime file names come from one kind catalog", () => {
    assert.deepEqual(BASELINE_KINDS, ["type_check", "lint"]);
    assert.deepEqual(BASELINE_TOOLS, BASELINE_KINDS);
    assert.equal(baselineFileName("type_check"), BASELINE_FILE_NAMES.type_check);
    assert.equal(baselineFileName("lint"), BASELINE_FILE_NAMES.lint);
    assert.deepEqual([...BASELINE_RUNTIME_FILES].sort(), ["eslint-baseline.json", "tsc-baseline.json"]);
  });

  test("snapshotCommandOutput extracts stable generic output-line keys", () => {
    assert.deepEqual(snapshotCommandOutput([
      "src/a.py:10: error: bad assignment",
      "src/a.py:10: error: duplicate",
      "src/b.py:2: error: missing module",
      "not an error",
    ].join("\n")), [
      "line:src/a.py:10: error: bad assignment",
      "line:src/a.py:10: error: duplicate",
      "line:src/b.py:2: error: missing module",
      "line:not an error",
    ]);
  });

  test("declared output rules add a stable rule prefix", () => {
    assert.deepEqual(snapshotCommandOutput(
      "src/a.py:1: F401 unused",
      { failure_output_rules: [{ id: "python-lint", contains: "F401" }] },
    ), ["rule:python-lint:src/a.py:1: F401 unused"]);
  });

  test("pruneResolvedBaselineKeys preserves generic current keys", () => {
    assert.deepEqual(pruneResolvedBaselineKeys([
      "line:src/a.py: existing",
      "line:src/fixed.py: removed",
    ], [
      "line:src/a.py: existing",
    ], "/repo"), ["line:src/a.py: existing"]);
  });

  test("captureExecutionBaselines supports mypy and ruff snapshots", () => {
    const writes = new Map();
    const commands = [];
    const execSync = (command) => {
      commands.push(command);
      if (command === "git status --porcelain") return " M src/a.py\n";
      if (command === "git stash create") return "stash-ref\n";
      if (command === "git stash apply stash-ref") return "";
      if (command === "git rev-parse HEAD") return "abc123\n";
      if (command.startsWith("mypy")) {
        const error = new Error("mypy failed") as Error & { status: number; stdout: string; stderr: string };
        error.status = 1;
        error.stdout = "src/a.py:1: error: existing\n";
        error.stderr = "type-check stderr\n";
        throw error;
      }
      if (command.startsWith("ruff")) return "src/a.py:2: F401 unused\n";
      return "";
    };

    const result = captureExecutionBaselines({
      rootDir: "/repo",
      config: { build: { type_check: "mypy", lint: "ruff check ." } },
      tscBaselinePath: "/repo/state/type-check.json",
      eslintBaselinePath: "/repo/state/lint.json",
      execSync,
      writeFileSync: (file, content) => writes.set(file, content),
    });

    assert.equal(result.status, "pass");
    assert.equal(result.blocks_execution, false);
    assert.equal(result.stash_ref, "stash-ref");
    assert.equal(result.restored, true);
    assert.deepEqual(result.type_check_keys, ["line:src/a.py:1: error: existing", "line:type-check stderr"]);
    assert.deepEqual(result.lint_keys, ["line:src/a.py:2: F401 unused"]);
    const typeBaseline = JSON.parse(writes.get("/repo/state/type-check.json"));
    const lintBaseline = JSON.parse(writes.get("/repo/state/lint.json"));
    assert.equal(typeBaseline.meta.tool, "type_check");
    assert.equal(typeBaseline.meta.output_schema, "yolo.execution.output_snapshot.v1");
    assert.equal(typeBaseline.meta.command, "mypy");
    assert.equal(typeBaseline.meta.artifact_hash, baselineArtifactHash(typeBaseline));
    assert.equal(lintBaseline.meta.tool, "lint");
    assert.equal(lintBaseline.meta.command, "ruff check .");
    assert.equal(lintBaseline.meta.artifact_hash, baselineArtifactHash(lintBaseline));
    assert.ok(commands.includes("git stash apply stash-ref"));
  });

  test("captureExecutionBaselines blocks when a required baseline command cannot run", () => {
    const writes = new Map();
    const execSync = (command) => {
      if (command === "git status --porcelain") return "";
      if (command === "git rev-parse HEAD") return "abc123\n";
      if (command.startsWith("missing-type-check")) {
        const error = new Error("missing-type-check: command not found") as Error & { status: number; stderr: string };
        error.status = 127;
        error.stderr = "missing-type-check: command not found\n";
        throw error;
      }
      return "";
    };

    const result = captureExecutionBaselines({
      rootDir: "/repo",
      config: { build: { type_check: "missing-type-check", lint: "ruff check ." } },
      tscBaselinePath: "/repo/state/type-check.json",
      eslintBaselinePath: "/repo/state/lint.json",
      execSync,
      writeFileSync: (file, content) => writes.set(file, content),
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blocks_execution, true);
    assert.deepEqual(result.blockers.map((blocker) => blocker.kind), ["type_check"]);
    const baseline = JSON.parse(writes.get("/repo/state/type-check.json"));
    assert.equal(baseline.meta.status, "blocked");
    assert.equal(baseline.meta.exit_code, 127);
    assert.equal(baseline.meta.reason, "baseline_command_unavailable");
  });

  test("refreshBaselineAfterCommit prunes resolved mypy and ruff snapshot keys", () => {
    const files = new Map([
      ["/repo/state/runtime/tsc-baseline.json", JSON.stringify({
        keys: ["line:src/a.py: existing", "line:src/fixed.py: removed"],
        meta: { created_at: "2026-01-01T00:00:00.000Z" },
      })],
      ["/repo/state/runtime/eslint-baseline.json", JSON.stringify({
        keys: ["line:src/a.py: lint existing", "line:src/warn.py: removed"],
      })],
    ]);
    const writes = new Map();
    const execFileSync = (bin) => {
      if (bin === "mypy") return "src/a.py: existing\n";
      if (bin === "ruff") return "src/a.py: lint existing\n";
      return "";
    };

    const results = refreshBaselineAfterCommit({
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
      config: { build: { type_check: "mypy", lint: "ruff check" } },
      execFileSync,
      existsSync: (file) => files.has(file),
      readFileSync: (file) => files.get(file),
      writeFileSync: (file, content) => writes.set(file, content),
      nowIso: () => "2026-05-24T00:00:00.000Z",
    });

    assert.deepEqual(results.map(({ kind, skipped, before, after, removed }) => ({
      kind,
      skipped,
      before,
      after,
      removed,
    })), [
      { kind: "type_check", skipped: false, before: 2, after: 1, removed: 1 },
      { kind: "lint", skipped: false, before: 2, after: 1, removed: 1 },
    ]);
    const refreshedType = JSON.parse(writes.get("/repo/state/runtime/tsc-baseline.json"));
    const refreshedLint = JSON.parse(writes.get("/repo/state/runtime/eslint-baseline.json"));
    assert.deepEqual(refreshedType.keys, ["line:src/a.py: existing"]);
    assert.equal(refreshedType.meta.updated_at, "2026-05-24T00:00:00.000Z");
    assert.equal(refreshedType.meta.artifact_hash, baselineArtifactHash(refreshedType));
    assert.deepEqual(refreshedLint.keys, ["line:src/a.py: lint existing"]);
  });

  test("refreshBaselineAfterCommit keeps old baseline when a command is missing", () => {
    const files = new Map([
      ["/repo/state/runtime/tsc-baseline.json", JSON.stringify({ keys: ["line:src/a.py: existing"] })],
      ["/repo/state/runtime/eslint-baseline.json", JSON.stringify({ keys: ["line:src/a.py: lint existing"] })],
    ]);
    const writes = new Map();
    const execFileSync = (bin) => {
      if (bin === "definitely-missing-cmd") {
        const error = new Error("definitely-missing-cmd: command not found") as Error & { status: number; stderr: string };
        error.status = 127;
        error.stderr = "definitely-missing-cmd: command not found\n";
        throw error;
      }
      return "src/a.py: lint existing\n";
    };
    const results = refreshBaselineAfterCommit({
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
      config: { build: { type_check: "definitely-missing-cmd", lint: "ruff" } },
      execFileSync,
      existsSync: (file) => files.has(file),
      readFileSync: (file) => files.get(file),
      writeFileSync: (file, content) => writes.set(file, content),
    });
    const typeResult = results.find((r) => r.kind === "type_check");
    assert.equal(typeResult.skipped, true);
    assert.equal(typeResult.reason, "refresh_failed");
    assert.equal(typeResult.exit_code, 127);
    assert.ok(!writes.has("/repo/state/runtime/tsc-baseline.json"));
    assert.equal(results.find((r) => r.kind === "lint").skipped, false);
  });
});
