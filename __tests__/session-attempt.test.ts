import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { prepareProviderSession } from "../src/runtime/execution/session-attempt.js";

function task(overrides = {}) {
  return {
    id: "FIX-SESSION-ATTEMPT",
    scope: { targets: [{ file: "src/a.ts" }] },
    ...overrides,
  };
}

describe("session attempt helpers", () => {
  test("blocks before prompt when context pack validation fails", async () => {
    const bashLogs = [];
    const result = await prepareProviderSession({
      task: task(),
      prdPath: "prd.json",
      attempt: 2,
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
      validateContextPack: async () => ({
        ok: false,
        result: {
          blocks_execution: true,
          failures: [{ code: "CONTEXT_TARGET_MISSING" }],
        },
      }),
      logTaskBash: (...entry) => bashLogs.push(entry),
      execNode: () => {
        throw new Error("execNode should not be called");
      },
    });

    assert.equal(result.action, "return");
    assert.equal(result.reason, "context_pack_blocked");
    assert.equal(result.failReason, "context-pack-validator blocked: CONTEXT_TARGET_MISSING");
    assert.equal(result.result.status, "failed");
    assert.equal(result.transition.prd_update.phase, "context_pack");
    assert.deepEqual(bashLogs[0].slice(0, 3), ["FIX-SESSION-ATTEMPT", "context-pack-validator", "fail"]);
  });

  test("returns prompt failure before baseline capture or worktree creation", async () => {
    const commands = [];
    const result = await prepareProviderSession({
      task: task(),
      prdPath: "prd.json",
      attempt: 1,
      mode: "fix",
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
      validateContextPack: async () => ({
        ok: true,
        result: { status: "pass", blocks_execution: false, failures: [] },
      }),
      execNode: (script, args) => {
        commands.push([script, args]);
        if (script === "learn.js") return { ok: true, stdout: "lesson" };
        return { ok: false, stdout: "prompt failed" };
      },
      captureBaselines: () => {
        throw new Error("captureBaselines should not be called");
      },
      createWorktree: () => {
        throw new Error("createWorktree should not be called");
      },
      logTaskBash: () => {},
    });

    assert.deepEqual(result, {
      action: "return",
      reason: "prompt_failed",
      result: { status: "failed", reason: "prompt 生成失败" },
    });
    assert.equal(commands.length, 2);
    assert.equal(commands[0][0], "learn.js");
    assert.deepEqual(commands[0][1], ["--load", "--project-root=/repo"]);
    assert.equal(commands[1][0], "prompt.js");
    assert.ok(commands[1][1].includes("--cwd=/repo"));
  });

  test("prepares prompt, baselines, worktree, and provider session", async () => {
    const bashLogs = [];
    const progressLogs = [];
    const events = [];
    const commands = [];
    let baselineArgs = null;
    let createdWorktree = null;
    const nowValues = [1000, 3500];

    const result = await prepareProviderSession({
      task: task(),
      prdPath: "prd.json",
      attempt: 3,
      mode: "dev",
      lastGateError: "tsc failed in src/a.ts",
      rootDir: "/repo",
      runtimeDir: "/repo/state/runtime",
      config: { build: { type_check: "npm run typecheck" } },
      tscBaselinePath: "/repo/state/runtime/tsc-baseline.json",
      eslintBaselinePath: "/repo/state/runtime/eslint-baseline.json",
      validateContextPack: async () => ({
        ok: true,
        result: { status: "pass", blocks_execution: false, failures: [] },
      }),
      execNode: (script, args) => {
        commands.push([script, args]);
        if (script === "learn.js") return { ok: true, stdout: "previous lesson" };
        return { ok: true, stdout: "PROMPT" };
      },
      captureBaselines: (args) => {
        baselineArgs = args;
        return [{ tool: "tsc", skipped: true }];
      },
      createWorktree: (taskId) => ({ path: `/tmp/${taskId}`, branch: `yolo/${taskId}` }),
      onWorktreeCreated: (wt) => {
        createdWorktree = wt;
      },
      computeTaskTimeout: (targets) => {
        assert.deepEqual(targets, [{ file: "src/a.ts" }]);
        return 12345;
      },
      spawnProviderInWorktree: async (prompt, wtPath, timeout) => ({
        provider: "codex",
        success: true,
        stdout: `${prompt}:${wtPath}:${timeout}`,
      }),
      logTaskBash: (...entry) => bashLogs.push(entry),
      logProgress: (...entry) => progressLogs.push(entry),
      logEvent: (...entry) => events.push(entry),
      nowMs: () => nowValues.shift() ?? 3500,
    });

    assert.equal(result.action, "continue");
    assert.equal(result.providerName, "codex");
    assert.equal(result.timeout, 12345);
    assert.equal(result.startedAtMs, 1000);
    assert.equal(result.providerRun.stdout, "PROMPT:/tmp/FIX-SESSION-ATTEMPT:12345");
    assert.deepEqual(createdWorktree, { path: "/tmp/FIX-SESSION-ATTEMPT", branch: "yolo/FIX-SESSION-ATTEMPT" });
    assert.equal(baselineArgs.rootDir, "/repo");
    assert.equal(baselineArgs.tscBaselinePath, "/repo/state/runtime/tsc-baseline.json");
    assert.ok(commands[1][1].includes("--cwd=/repo"));
    assert.ok(commands[1][1].includes("--session-id=FIX-SESSION-ATTEMPT-attempt-3"));
    assert.equal(commands[1][1][6], "--fix");
    assert.match(commands[1][1][7], /^--learnings=previous lesson\n/);
    assert.equal(result.sessionId, "FIX-SESSION-ATTEMPT-attempt-3");
    assert.equal(result.contextContract.fresh_session, true);
    assert.deepEqual(events[0][0], "task_session_start");
    assert.equal(events[0][1].fresh_session, true);
    assert.deepEqual(progressLogs.at(-1), ["", "├─", "codex ok (3s)"]);
    assert.equal(bashLogs.at(-1)[1], "codex spawn");
  });
});
