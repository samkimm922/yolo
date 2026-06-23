// Quality-score provider-preflight battery (v1): spawnProviderPrompt must fail closed
// on invalid timeouts instead of hanging or silently disabling the kill timer.
//
// Category: provider_preflight_robustness — a config boundary that disables
// provider lifecycle control must be rejected before any process is spawned.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { parseCommandToArgv } from "../../src/lib/security/command-guard.js";
import { spawnProviderPrompt } from "../../src/runtime/execution/provider-adapter.js";

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

export async function runProviderBattery(): Promise<ProviderBatteryResult[]> {
  const providerResults = await Promise.all(PROVIDER_BATTERY.map(runProviderCase));
  return [
    ...providerResults,
    ...SHELL_INTERPRETER_BATTERY.map(runShellInterpreterCase),
  ];
}
