import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { inspectLifecycleGuard } from "../../src/lifecycle/guard.js";
import { initLifecycleState } from "../../src/lifecycle/state.js";
import { writeLifecycleStageReport } from "../../src/lifecycle/progress.js";

type LifecycleBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

function writeText(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function lifecycleOptions(root: string) {
  return {
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    source: "lifecycle-battery",
    writeSessionMemory: false,
    skipSequenceCheck: true,
  };
}

function setupReadyForDelivery(root: string) {
  initLifecycleState({ projectRoot: root });
  writeText(join(root, "state", "run", "run-evidence.json"), "{\"ok\":true}\n");
  writeText(join(root, "state", "review", "review-evidence.json"), "{\"ok\":true}\n");
  writeText(join(root, "state", "acceptance", "evidence.json"), "{\"ok\":true}\n");
  writeLifecycleStageReport("run", {
    status: "success",
    evidence: [{ path: "state/run/run-evidence.json" }],
  }, lifecycleOptions(root));
  writeLifecycleStageReport("review-fix", {
    status: "success",
    findings: [],
    evidence: [{ path: "state/review/review-evidence.json" }],
  }, lifecycleOptions(root));
}

export function runLifecycleBattery(): LifecycleBatteryResult[] {
  const root = mkdtempSync(join(tmpdir(), "yolo-lifecycle-battery-"));
  try {
    setupReadyForDelivery(root);
    writeLifecycleStageReport("acceptance", {
      status: "pass",
      summary: "forged manual acceptance should not satisfy delivery",
      evidence: [
        { path: "state/acceptance/evidence.json" },
        {
          type: "manual_acceptance",
          task_id: "T1",
          condition_id: "AC-1",
          path: "state/acceptance/evidence.json",
        },
      ],
      manual_criteria: [{ task_id: "T1", condition_id: "AC-1", text: "Product owner signs off." }],
    }, lifecycleOptions(root));

    const result = inspectLifecycleGuard({
      command: "yolo-ship",
      projectRoot: root,
      stateRoot: join(root, ".yolo"),
    }) as { status?: string };
    const status = result.status === "pass" ? "pass" : "blocked";
    return [{
      id: "manual_acceptance_requires_signature_fields",
      category: "lifecycle_manual_acceptance_safety",
      expect: "blocked",
      actualExit: status === "pass" ? 0 : 1,
      actualStatus: status,
      correct: status === "blocked",
    }];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
