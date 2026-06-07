import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  baselineArtifactHash,
  captureExecutionBaselines,
  parseEslintBaselineErrorKeys,
  parseEslintBaselineKeys,
  parseTscBaselineKeys,
  pruneResolvedBaselineKeys,
  refreshBaselineAfterCommit,
} from "../src/runtime/execution/baselines.js";

describe("execution baseline helpers", () => {
  test("parseTscBaselineKeys extracts stable file:line:code keys", () => {
    assert.deepEqual(parseTscBaselineKeys([
      "src/a.ts(10,5): error TS2322: bad assignment",
      "src/a.ts(10,5): error TS2322: duplicate",
      "src/b.tsx(2,1): error TS2307: missing module",
      "not an error",
    ].join("\n")), [
      "src/a.ts:10:TS2322",
      "src/b.tsx:2:TS2307",
    ]);
  });

  test("parseEslintBaselineKeys extracts unique file:line:rule keys from JSON output", () => {
    const output = `prefix\n${JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        messages: [
          { line: 3, ruleId: "no-console" },
          { line: 3, ruleId: "no-console" },
          { line: 4 },
        ],
      },
    ])}`;

    assert.deepEqual(parseEslintBaselineKeys(output, "/repo"), [
      "src/a.ts:3:no-console",
    ]);
  });

  test("parseEslintBaselineErrorKeys keeps only error severity findings", () => {
    const output = JSON.stringify([
      {
        filePath: "/repo/src/a.ts",
        messages: [
          { line: 2, ruleId: "semi", severity: 2 },
          { line: 3, ruleId: "no-alert", severity: 1 },
          { line: 4, ruleId: "eqeqeq", severity: 0 },
          { line: 5, severity: 2 },
        ],
      },
    ]);

    assert.deepEqual(parseEslintBaselineErrorKeys(output, "/repo"), [
      "src/a.ts:2:semi",
    ]);
  });

  test("pruneResolvedBaselineKeys preserves current keys and legacy file:code matches", () => {
    const pruned = pruneResolvedBaselineKeys([
      "/repo/src/a.ts:1:TS1000",
      "src/a.ts:TS2000",
      "src/fixed.ts:TS3000",
      "./src/gone.ts:4:TS4000",
    ], [
      "src/a.ts:1:TS1000",
      "src/a.ts:9:TS2000",
    ], "/repo");

    assert.deepEqual(pruned, [
      "src/a.ts:1:TS1000",
      "src/a.ts:TS2000",
    ]);
  });

  test("captureExecutionBaselines writes tsc and eslint baselines and restores dirty snapshot", () => {
    const writes = new Map();
    const commands = [];
    const execSync = (command) => {
      commands.push(command);
      if (command === "git status --porcelain") return " M src/a.ts\n";
      if (command === "git stash create") return "stash-ref\n";
      if (command === "git stash apply stash-ref") return "";
      if (command === "git rev-parse HEAD") return "abc123\n";
      if (command.startsWith("tsc")) {
        const error = new Error("tsc failed");
        error.status = 2;
        error.stdout = "src/a.ts(1,1): error TS1000: bad\n";
        error.stderr = "typecheck stderr\n";
        throw error;
      }
      if (command.startsWith("eslint")) {
        return JSON.stringify([{ filePath: "/repo/src/a.ts", messages: [{ line: 2, ruleId: "semi" }] }]);
      }
      return "";
    };
    const writeFileSync = (file, content) => writes.set(file, content);

    const result = captureExecutionBaselines({
      rootDir: "/repo",
      config: { build: { type_check: "tsc", lint: "eslint" } },
      tscBaselinePath: "/repo/state/tsc.json",
      eslintBaselinePath: "/repo/state/eslint.json",
      execSync,
      writeFileSync,
    });

    assert.equal(result.status, "pass");
    assert.equal(result.blocks_execution, false);
    assert.equal(result.stash_ref, "stash-ref");
    assert.equal(result.restored, true);
    assert.deepEqual(result.tsc_keys, ["src/a.ts:1:TS1000"]);
    assert.deepEqual(result.eslint_keys, ["src/a.ts:2:semi"]);
    const tscBaseline = JSON.parse(writes.get("/repo/state/tsc.json"));
    const eslintBaseline = JSON.parse(writes.get("/repo/state/eslint.json"));
    assert.deepEqual(tscBaseline.keys, ["src/a.ts:1:TS1000"]);
    assert.equal(tscBaseline.meta.command, "tsc");
    assert.equal(tscBaseline.meta.exit_code, 2);
    assert.equal(tscBaseline.meta.stderr_tail, "typecheck stderr\n");
    assert.equal(tscBaseline.meta.commit, "abc123");
    assert.equal(tscBaseline.meta.artifact_hash, baselineArtifactHash(tscBaseline));
    assert.deepEqual(eslintBaseline.keys, ["src/a.ts:2:semi"]);
    assert.equal(eslintBaseline.meta.command, "eslint");
    assert.equal(eslintBaseline.meta.exit_code, 0);
    assert.equal(eslintBaseline.meta.commit, "abc123");
    assert.equal(eslintBaseline.meta.artifact_hash, baselineArtifactHash(eslintBaseline));
    assert.ok(commands.includes("git stash apply stash-ref"));
  });

  test("captureExecutionBaselines blocks when a required baseline command cannot run", () => {
    const writes = new Map();
    const execSync = (command) => {
      if (command === "git status --porcelain") return "";
      if (command === "git rev-parse HEAD") return "abc123\n";
      if (command.startsWith("missing-tsc")) {
        const error = new Error("missing-tsc: command not found");
        error.status = 127;
        error.stderr = "missing-tsc: command not found\n";
        throw error;
      }
      return "[]";
    };

    const result = captureExecutionBaselines({
      rootDir: "/repo",
      config: { build: { type_check: "missing-tsc", lint: "eslint" } },
      tscBaselinePath: "/repo/state/tsc.json",
      eslintBaselinePath: "/repo/state/eslint.json",
      execSync,
      writeFileSync: (file, content) => writes.set(file, content),
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blocks_execution, true);
    assert.deepEqual(result.blockers.map((blocker) => blocker.tool), ["tsc"]);
    const tscBaseline = JSON.parse(writes.get("/repo/state/tsc.json"));
    assert.equal(tscBaseline.meta.status, "blocked");
    assert.equal(tscBaseline.meta.exit_code, 127);
    assert.equal(tscBaseline.meta.reason, "baseline_command_unavailable");
  });

  test("refreshBaselineAfterCommit prunes resolved tsc and eslint baseline keys", () => {
    const files = new Map([
      ["/repo/state/runtime/tsc-baseline.json", JSON.stringify({
        keys: ["src/a.ts:1:TS1000", "src/fixed.ts:2:TS2000"],
        meta: { created_at: "2026-01-01T00:00:00.000Z" },
      })],
      ["/repo/state/runtime/eslint-baseline.json", JSON.stringify({
        keys: ["src/a.ts:2:semi", "src/warn.ts:3:no-alert"],
      })],
    ]);
    const writes = new Map();
    const commands = [];
    const execFileSync = (bin, args) => {
      commands.push([bin, ...args].join(" "));
      if (args[1].startsWith("tsc")) {
        return "src/a.ts(1,1): error TS1000: bad\n";
      }
      if (args[1].startsWith("eslint")) {
        return JSON.stringify([
          {
            filePath: "/repo/src/a.ts",
            messages: [{ line: 2, ruleId: "semi", severity: 2 }],
          },
          {
            filePath: "/repo/src/warn.ts",
            messages: [{ line: 3, ruleId: "no-alert", severity: 1 }],
          },
        ]);
      }
      return "";
    };
    const existsSync = (file) => files.has(file);
    const readFileSync = (file) => files.get(file);
    const writeFileSync = (file, content) => writes.set(file, content);

    const results = refreshBaselineAfterCommit({
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
      config: { build: { type_check: "tsc", lint: "eslint" } },
      execFileSync,
      existsSync,
      readFileSync,
      writeFileSync,
      nowIso: () => "2026-05-24T00:00:00.000Z",
    });

    assert.deepEqual(results.map(({ tool, skipped, before, after, removed }) => ({
      tool,
      skipped,
      before,
      after,
      removed,
    })), [
      { tool: "tsc", skipped: false, before: 2, after: 1, removed: 1 },
      { tool: "eslint", skipped: false, before: 2, after: 1, removed: 1 },
    ]);
    assert.equal(commands.length, 2);
    const refreshedTsc = JSON.parse(writes.get("/repo/state/runtime/tsc-baseline.json"));
    const refreshedEslint = JSON.parse(writes.get("/repo/state/runtime/eslint-baseline.json"));
    assert.deepEqual(refreshedTsc.keys, ["src/a.ts:1:TS1000"]);
    assert.equal(refreshedTsc.meta.created_at, "2026-01-01T00:00:00.000Z");
    assert.equal(refreshedTsc.meta.updated_at, "2026-05-24T00:00:00.000Z");
    assert.equal(refreshedTsc.meta.command, "tsc");
    assert.equal(refreshedTsc.meta.exit_code, 0);
    assert.equal(refreshedTsc.meta.artifact_hash, baselineArtifactHash(refreshedTsc));
    assert.deepEqual(refreshedEslint.keys, ["src/a.ts:2:semi"]);
    assert.equal(refreshedEslint.meta.updated_at, "2026-05-24T00:00:00.000Z");
    assert.equal(refreshedEslint.meta.command, "eslint");
    assert.equal(refreshedEslint.meta.artifact_hash, baselineArtifactHash(refreshedEslint));
  });
});
