// Quality-score ship battery: delivery must not trust a fabricated acceptance
// report that only claims status=pass.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { initLifecycleState } from "../../src/lifecycle/state.js";
import { writeLifecycleStageReport } from "../../src/lifecycle/progress.js";
import { runPiRuntime } from "../../src/runtime/pi-runtimes.js";

type ShipBatteryCase = {
  id: string;
  category: "ship_gate_robustness";
  description: string;
  expect: "blocked";
};

type ShipBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function lifecycleOptions(root: string) {
  return {
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    source: "ship-battery",
    writeSessionMemory: false,
    skipSequenceCheck: true,
  };
}

function setupShipReadyLifecycle(root: string, prdPath: string) {
  initLifecycleState({ projectRoot: root });
  writeText(join(root, "state", "run", "run-evidence.json"), "{\"ok\":true}\n");
  writeText(join(root, "state", "review", "review-evidence.json"), "{\"ok\":true}\n");
  writeText(join(root, "state", "acceptance", "evidence.json"), "{\"ok\":true}\n");
  writeLifecycleStageReport("run", {
    status: "success",
    summary: "run passed",
    prd_path: prdPath,
    evidence: [{ path: "state/run/run-evidence.json" }],
  }, lifecycleOptions(root));
  writeLifecycleStageReport("review-fix", {
    status: "success",
    summary: "review passed",
    findings: [],
    prd_path: prdPath,
    evidence: [{ path: "state/review/review-evidence.json" }],
  }, lifecycleOptions(root));
  writeLifecycleStageReport("acceptance", {
    status: "pass",
    summary: "acceptance passed",
    prd_path: prdPath,
    evidence: [{ path: "state/acceptance/evidence.json" }],
  }, lifecycleOptions(root));
}

export const SHIP_BATTERY: ShipBatteryCase[] = [
  {
    id: "forged_acceptance_blocks_ship",
    category: "ship_gate_robustness",
    description: "Ship must block a status-only acceptance report even when lifecycle prerequisites pass.",
    expect: "blocked",
  },
];

export async function runShipBattery(): Promise<ShipBatteryResult[]> {
  const results: ShipBatteryResult[] = [];
  for (const testCase of SHIP_BATTERY) {
    const root = mkdtempSync(join(tmpdir(), "yolo-ship-battery-"));
    try {
      const prdPath = join(root, "specs", "prd.json");
      writeJson(prdPath, { version: "2.0", id: "PRD-SHIP-BATTERY", tasks: [] });
      setupShipReadyLifecycle(root, prdPath);
      const result = await runPiRuntime("ship", {
        prdPath,
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeLifecycle: false,
        acceptanceReport: {
          report: {
            status: "pass",
            prd_path: prdPath,
          },
        },
      }) as { status?: string };
      const status = result.status === "success" ? "pass" : "blocked";
      const correct = status === testCase.expect;
      results.push({
        id: testCase.id,
        category: testCase.category,
        expect: testCase.expect,
        actualExit: status === "pass" ? 0 : 1,
        actualStatus: status,
        correct,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  return results;
}
