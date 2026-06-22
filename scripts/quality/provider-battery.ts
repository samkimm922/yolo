// Quality-score provider-preflight battery (v1): spawnProviderPrompt must fail closed
// on invalid timeouts instead of hanging or silently disabling the kill timer.
//
// Category: provider_preflight_robustness — a config boundary that disables
// provider lifecycle control must be rejected before any process is spawned.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnProviderPrompt } from "../../src/runtime/execution/provider-adapter.js";

export type ProviderBatteryExpectation = "blocked" | "hung";

export type ProviderBatteryCase = {
  id: string;
  category: "provider_preflight_robustness";
  description: string;
  expect: ProviderBatteryExpectation;
  timeoutValue: number;
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

export async function runProviderBattery(): Promise<ProviderBatteryResult[]> {
  return Promise.all(PROVIDER_BATTERY.map(runProviderCase));
}
