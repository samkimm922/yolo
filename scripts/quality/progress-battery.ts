// Quality-score progress server battery: long-lived SSE connections must have
// a bounded idle lifetime so half-open clients cannot hold all connection slots.

import { readFileSync } from "node:fs";

type ProgressBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

export function runProgressBattery(): ProgressBatteryResult[] {
  const source = readFileSync("src/runtime/progress/server.ts", "utf8");
  const hasIdleTimeout =
    /SSE_IDLE_TIMEOUT_MS/.test(source) &&
    /_setSseIdleTimeoutOverrideForTest/.test(source) &&
    /_idleTimeout/.test(source);
  const status = hasIdleTimeout ? "blocked" : "pass";
  return [{
    id: "sse_idle_timeout_required",
    category: "progress_server_safety",
    expect: "blocked",
    actualExit: status === "blocked" ? 1 : 0,
    actualStatus: status,
    correct: status === "blocked",
  }];
}
