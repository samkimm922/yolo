// Quality-score ship battery: delivery must not trust a fabricated acceptance
// report that only claims status=pass.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { initLifecycleState } from "../../src/lifecycle/state.js";
import { writeLifecycleStageReport } from "../../src/lifecycle/progress.js";
import { runPiRuntime } from "../../src/runtime/pi-runtimes.js";
import { computeSourceFingerprint } from "../../src/runtime/evidence/source-fingerprint.js";

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
  // CR5 part (b): source mutation between acceptance-freeze and ship must block.
  results.push(await runStaleSourceMutationCase());
  return results;
}

// CR5 part (b): freeze an acceptance report whose source_fingerprint covers a
// real tracked source file, then mutate that file, then ship. The ship gate must
// recompute the fingerprint, detect the mutation, and block.
async function runStaleSourceMutationCase(): Promise<ShipBatteryResult> {
  const root = mkdtempSync(join(tmpdir(), "yolo-ship-stale-"));
  try {
    // A real git repo so gitTrackedSourceFiles resolves the source set.
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "ship-battery@test"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "ship-battery"], { cwd: root, stdio: "ignore" });
    // A tracked source file that the fingerprint will cover.
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "service.ts"), "export const x = 1;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "baseline", "--no-gpg-sign"], { cwd: root, stdio: "ignore" });

    const prdPath = join(root, "specs", "prd.json");
    writeJson(prdPath, { version: "2.0", id: "PRD-SHIP-STALE", tasks: [] });
    setupShipReadyLifecycle(root, prdPath);
    // Freeze acceptance WITH a real source fingerprint over the current source.
    const fingerprint = computeSourceFingerprint(root);
    writeLifecycleStageReport("acceptance", {
      status: "pass",
      summary: "acceptance frozen with source fingerprint",
      prd_path: prdPath,
      evidence: [{ path: "state/acceptance/evidence.json" }],
      source_fingerprint: fingerprint,
    }, lifecycleOptions(root));

    // Mutate the tracked source AFTER acceptance-freeze.
    writeFileSync(join(root, "src", "service.ts"), "export const x = 2; // TAMPERED\n", "utf8");

    const result = await runPiRuntime("ship", {
      prdPath,
      projectRoot: root,
      stateRoot: join(root, ".yolo"),
      writeLifecycle: false,
    }) as { status?: string };
    const status = result.status === "success" ? "pass" : "blocked";
    return {
      id: "stale_acceptance_after_source_mutation_blocks_ship",
      category: "ship_gate_robustness",
      expect: "blocked",
      actualExit: status === "pass" ? 0 : 1,
      actualStatus: status,
      correct: status === "blocked",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
