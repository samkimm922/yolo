// Quality-score provider-preflight battery (v1): spawnProviderPrompt must fail closed
// on invalid timeouts instead of hanging or silently disabling the kill timer.
//
// Category: provider_preflight_robustness — a config boundary that disables
// provider lifecycle control must be rejected before any process is spawned.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { parseCommandToArgv } from "../../src/lib/security/command-guard.js";
import { spawnProviderPrompt } from "../../src/runtime/execution/provider-adapter.js";
import { createGracefulShutdownHandler } from "../../src/runtime/run-lifecycle/shutdown.js";

export type ProviderBatteryExpectation = "blocked" | "hung";

export type ProviderBatteryCase = {
  id: string;
  category: "provider_preflight_robustness";
  description: string;
  expect: ProviderBatteryExpectation;
  timeoutValue: number;
};

type ShellInterpreterBatteryCase = {
  id: string;
  category: "provider_preflight_robustness";
  description: string;
  expect: "blocked";
  command: string;
};

type SourceFlagBatteryCase = {
  id: string;
  category: "provider_preflight_robustness";
  description: string;
  expect: "blocked";
  file: string;
};

type ProviderShutdownBatteryCase = {
  id: string;
  category: "provider_preflight_robustness";
  description: string;
  expect: "killed_before_worktree_cleanup";
};

type ProviderBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

function fakeSpawnThatNeverCloses() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  return child;
}

function runProviderCase(testCase: ProviderBatteryCase): Promise<ProviderBatteryResult> {
  const run = spawnProviderPrompt("do nothing", {
    config: { ai: { model: "claude-sonnet-4" } },
    rootDir: "/repo",
    runtimeDir: "/repo/.yolo/state/runtime",
    commandExists: () => true,
    spawnImpl: fakeSpawnThatNeverCloses,
    timeout: testCase.timeoutValue,
  });

  return Promise.race([
    run.then((result) => {
      const status = result.blocked ? "blocked" : "resolved";
      return {
        id: testCase.id,
        category: testCase.category,
        expect: testCase.expect,
        actualExit: status === testCase.expect ? 0 : 1,
        actualStatus: status,
        correct: status === testCase.expect,
      };
    }),
    new Promise<ProviderBatteryResult>((resolve) => {
      setTimeout(() => {
        resolve({
          id: testCase.id,
          category: testCase.category,
          expect: testCase.expect,
          actualExit: 1,
          actualStatus: "hung",
          correct: testCase.expect === "hung",
        });
      }, 500);
    }),
  ]);
}

export const PROVIDER_BATTERY: ProviderBatteryCase[] = [
  {
    id: "bad-provider-timeout-zero",
    category: "provider_preflight_robustness",
    description: "timeout: 0 must be blocked before spawning, not disable the kill timer and hang.",
    expect: "blocked",
    timeoutValue: 0,
  },
  {
    id: "bad-provider-timeout-infinity",
    category: "provider_preflight_robustness",
    description: "timeout: Infinity must be blocked before spawning.",
    expect: "blocked",
    timeoutValue: Infinity,
  },
  {
    id: "bad-provider-timeout-negative",
    category: "provider_preflight_robustness",
    description: "timeout: -1 must be blocked before spawning.",
    expect: "blocked",
    timeoutValue: -1,
  },
];

const SHELL_INTERPRETER_BATTERY: ShellInterpreterBatteryCase[] = [
  {
    id: "shell_interpreter_argv_rejected_sh_c",
    category: "provider_preflight_robustness",
    description: "sh -c must be rejected on argv-only provider paths unless shell execution was explicitly allowed.",
    expect: "blocked",
    command: "sh -c 'echo unsafe'",
  },
  {
    id: "shell_interpreter_argv_rejected_bash_lc",
    category: "provider_preflight_robustness",
    description: "bash -lc must be rejected on argv-only provider paths unless shell execution was explicitly allowed.",
    expect: "blocked",
    command: "bash -lc 'echo unsafe'",
  },
  {
    id: "shell_interpreter_argv_rejected_zsh_c",
    category: "provider_preflight_robustness",
    description: "zsh -c must be rejected on argv-only provider paths unless shell execution was explicitly allowed.",
    expect: "blocked",
    command: "zsh -c 'echo unsafe'",
  },
];

const SOURCE_FLAG_BATTERY: SourceFlagBatteryCase[] = [
  {
    id: "legacy_review_no_claude_permission_bypass",
    category: "provider_preflight_robustness",
    description: "legacy review must not pass Claude's permission bypass flag directly.",
    expect: "blocked",
    file: "src/cli/review.ts",
  },
];

const PROVIDER_SHUTDOWN_BATTERY: ProviderShutdownBatteryCase[] = [
  {
    id: "provider_child_killed_on_graceful_shutdown",
    category: "provider_preflight_robustness",
    description: "SIGINT/SIGTERM cleanup must kill active provider children before force-removing worktrees.",
    expect: "killed_before_worktree_cleanup",
  },
];

function runShellInterpreterCase(testCase: ShellInterpreterBatteryCase): ProviderBatteryResult {
  const parsed = parseCommandToArgv(testCase.command);
  const status = parsed.ok ? "resolved" : "blocked";
  const correct = status === testCase.expect;
  return {
    id: testCase.id,
    category: testCase.category,
    expect: testCase.expect,
    actualExit: correct ? 0 : 1,
    actualStatus: status,
    correct,
  };
}

function runSourceFlagCase(testCase: SourceFlagBatteryCase): ProviderBatteryResult {
  const source = readFileSync(testCase.file, "utf8");
  const forbiddenFlag = ["--dangerously", "skip", "permissions"].join("-");
  const status = source.includes(forbiddenFlag) ? "resolved" : "blocked";
  const correct = status === testCase.expect;
  return {
    id: testCase.id,
    category: testCase.category,
    expect: testCase.expect,
    actualExit: correct ? 0 : 1,
    actualStatus: status,
    correct,
  };
}

async function runProviderShutdownCase(testCase: ProviderShutdownBatteryCase): Promise<ProviderBatteryResult> {
  const calls: string[] = [];
  const shutdown = createGracefulShutdownHandler({
    progress: { done: 0, failed: 0 },
    runResultsTracker: { completed: new Set(), failed: [] },
    state: {
      stateDir: () => "/tmp/.yolo/state",
      currentRunFile: () => "/tmp/.yolo/state/runtime/current-run.json",
      rootDir: () => "/repo",
      activeGitSession: () => ({ activeWorktree: "/tmp/wt", activeBranch: "yolo/FIX" }),
      progressServerProc: () => null,
    },
    startTimeMs: 0,
    logRun: () => {},
    writeProgressSnapshot: () => {},
    archiveCurrentRunFile: () => {},
    cleanupRuntimeStateFiles: () => {},
    execFileSync: (bin: string) => {
      if (bin === "git") calls.push("worktree_cleanup");
    },
    log: () => {},
    exit: () => {},
    killActiveProviderProcesses: () => calls.push("provider_kill"),
  });

  await shutdown("SIGINT");

  const killIndex = calls.indexOf("provider_kill");
  const worktreeIndex = calls.indexOf("worktree_cleanup");
  const status = killIndex >= 0 && (worktreeIndex < 0 || killIndex < worktreeIndex)
    ? "killed_before_worktree_cleanup"
    : "not_killed_before_worktree_cleanup";
  const correct = status === testCase.expect;
  return {
    id: testCase.id,
    category: testCase.category,
    expect: testCase.expect,
    actualExit: correct ? 0 : 1,
    actualStatus: status,
    correct,
  };
}

export async function runProviderBattery(): Promise<ProviderBatteryResult[]> {
  const providerResults = await Promise.all(PROVIDER_BATTERY.map(runProviderCase));
  const shutdownResults = await Promise.all(PROVIDER_SHUTDOWN_BATTERY.map(runProviderShutdownCase));
  return [
    ...providerResults,
    ...SHELL_INTERPRETER_BATTERY.map(runShellInterpreterCase),
    ...SOURCE_FLAG_BATTERY.map(runSourceFlagCase),
    ...shutdownResults,
  ];
}
