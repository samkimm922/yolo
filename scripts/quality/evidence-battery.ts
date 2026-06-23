// Quality-score evidence battery: demand evidence must be event-specific and
// tied to the current demand handoff, not merely any valid ledger record.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectDemandReadiness } from "../../src/demand/gate.js";
import { appendJsonlRecord } from "../../src/runtime/evidence/ledger.js";

type EvidenceBatteryCase = {
  id: string;
  category: "evidence_gate_robustness";
  description: string;
  expect: "blocked";
  seed: (stateDir: string) => void;
  session: Record<string, unknown>;
  phase: string;
};

type EvidenceBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

function demandSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "DEMAND-CURRENT",
    playback: { confirmed: true, confirmed_by: "user" },
    approval: { approved: true },
    requirements: { active: [{ text: "User can see the shortage list before acting." }] },
    ...overrides,
  };
}

export const EVIDENCE_BATTERY: EvidenceBatteryCase[] = [
  {
    id: "demand_event_specificity",
    category: "evidence_gate_robustness",
    description: "An unrelated project_read record must not satisfy the demand evidence gate.",
    expect: "blocked",
    phase: "discuss",
    session: demandSession(),
    seed: (stateDir) => {
      appendJsonlRecord(join(stateDir, "evidence", "ledger.jsonl"), {
        event: "project_read",
        file: "src/foo.ts",
        ledger: "state",
      });
    },
  },
  {
    id: "demand_approved_write_failure_fail_closed",
    category: "evidence_gate_robustness",
    description: "Approved-demand readiness must not reuse a stale discuss ledger when the approved event is missing.",
    expect: "blocked",
    phase: "prd_intake",
    session: demandSession(),
    seed: (stateDir) => {
      appendJsonlRecord(join(stateDir, "evidence", "ledger.jsonl"), {
        event: "demand.discuss",
        demand_id: "DEMAND-CURRENT",
        phase: "discuss",
        ledger: "state",
      });
    },
  },
];

export function runEvidenceBattery(): EvidenceBatteryResult[] {
  return EVIDENCE_BATTERY.map((testCase) => {
    const stateDir = mkdtempSync(join(tmpdir(), "yolo-evidence-battery-"));
    try {
      testCase.seed(stateDir);
      const result = inspectDemandReadiness(testCase.session, { phase: testCase.phase, stateDir }) as { blockers?: Array<Record<string, unknown>> };
      const hasEvidenceBlocker = result.blockers?.some((blocker) => blocker.code === "EVIDENCE_GROUNDED") === true;
      const status = hasEvidenceBlocker ? "blocked" : "pass";
      const correct = status === testCase.expect;
      return {
        id: testCase.id,
        category: testCase.category,
        expect: testCase.expect,
        actualExit: status === "pass" ? 0 : 1,
        actualStatus: status,
        correct,
      };
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}
