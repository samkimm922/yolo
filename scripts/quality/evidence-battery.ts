// Quality-score evidence battery: demand evidence must be event-specific and
// tied to the current demand handoff, not merely any valid ledger record.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectDemandReadiness } from "../../src/demand/gate.js";
import { appendJsonlRecord, readLedgerJsonl, validateLedgerChain } from "../../src/runtime/evidence/ledger.js";

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
  const demandResults: EvidenceBatteryResult[] = EVIDENCE_BATTERY.map((testCase) => {
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
  const ledgerRoot = mkdtempSync(join(tmpdir(), "yolo-evidence-ledger-battery-"));
  try {
    const ledgerPath = join(ledgerRoot, "evidence", "ledger.jsonl");
    appendJsonlRecord(ledgerPath, { event: "first", ledger: "state" });
    writeFileSync(ledgerPath, "{malformed jsonl line\n", { flag: "a" });
    appendJsonlRecord(ledgerPath, { event: "second", ledger: "state" });

    const validation = validateLedgerChain(readLedgerJsonl(ledgerPath));
    const status = validation.status === "fail" ? "blocked" : "pass";
    demandResults.push({
      id: "jsonl_malformed_line_blocks_integrity_pass",
      category: "evidence_gate_robustness",
      expect: "blocked",
      actualExit: status === "pass" ? 0 : 1,
      actualStatus: status,
      correct: status === "blocked",
    });
  } finally {
    rmSync(ledgerRoot, { recursive: true, force: true });
  }
  const ledgerSource = readFileSync("src/runtime/evidence/ledger.ts", "utf8");
  const hasOwnerNonce = /LEDGER_LOCK_OWNER_PREFIX/.test(ledgerSource) && /ownerToken/.test(ledgerSource);
  const recursivelyRemovesSharedLock = /rmSync\(lockPath,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/.test(ledgerSource);
  const status = hasOwnerNonce && !recursivelyRemovesSharedLock ? "blocked" : "pass";
  demandResults.push({
    id: "ledger_stale_lock_owner_token_required",
    category: "evidence_gate_robustness",
    expect: "blocked",
    actualExit: status === "pass" ? 0 : 1,
    actualStatus: status,
    correct: status === "blocked",
  });
  const lockRoot = mkdtempSync(join(tmpdir(), "yolo-ledger-lock-battery-"));
  try {
    const ledgerPath = join(lockRoot, "events.jsonl");
    mkdirSync(`${ledgerPath}.lock`, { recursive: true });
    const startMs = Date.now();
    let errorCode = "";
    try {
      appendJsonlRecord(ledgerPath, { event: "busy", ledger: "state" }, {
        lockTimeoutMs: 120,
        lockRetryMs: 120,
        lockStaleMs: 60_000,
      });
    } catch (error) {
      errorCode = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code || "")
        : "";
    }
    const elapsedMs = Date.now() - startMs;
    const hasBlockingWaitPrimitive = /SharedArrayBuffer/.test(ledgerSource) || /Atomics\.wait/.test(ledgerSource);
    const lockStatus = !hasBlockingWaitPrimitive && errorCode === "LEDGER_APPEND_LOCK_BUSY" && elapsedMs < 80
      ? "blocked"
      : "pass";
    demandResults.push({
      id: "ledger_lock_contention_fails_fast_without_event_loop_wait",
      category: "evidence_gate_robustness",
      expect: "blocked",
      actualExit: lockStatus === "pass" ? 0 : 1,
      actualStatus: lockStatus,
      correct: lockStatus === "blocked",
    });
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
  // H3: HMAC-signed ledger chain. A forged record_sig (an attacker who can
  // appendFileSync but lacks the project HMAC key) must fail chain validation.
  const hmacRoot = mkdtempSync(join(tmpdir(), "yolo-ledger-hmac-battery-"));
  try {
    const stateDir = hmacRoot;
    mkdirSync(join(stateDir, "keys"), { recursive: true });
    writeFileSync(join(stateDir, "keys", "ledger.hmac"), "battery-hmac-key", "utf8");
    const ledgerPath = join(stateDir, "events.jsonl");
    appendJsonlRecord(ledgerPath, { event: "signed-1", ledger: "state" }, { stateRoot: stateDir });
    const records = readLedgerJsonl(ledgerPath);
    // Positive: forged sig (valid hash, bogus sig) -> blocked.
    const forged = [{ ...records[0], record_sig: "f".repeat(64) }];
    const forgedResult = validateLedgerChain(forged, { hmacKey: "battery-hmac-key" });
    const forgedStatus = forgedResult.status === "fail" ? "blocked" : "pass";
    demandResults.push({
      id: "unsigned_appended_record_blocks_chain_validation",
      category: "evidence_gate_robustness",
      expect: "blocked",
      actualExit: forgedStatus === "pass" ? 0 : 1,
      actualStatus: forgedStatus,
      correct: forgedStatus === "blocked",
    });
    // Negative: the legitimately-signed chain validates.
    const validResult = validateLedgerChain(records, { hmacKey: "battery-hmac-key" });
    const validStatus = validResult.status === "pass" ? "pass" : "blocked";
    demandResults.push({
      id: "hmac_signed_chain_validates",
      category: "evidence_gate_robustness",
      expect: "pass",
      actualExit: validStatus === "pass" ? 0 : 1,
      actualStatus: validStatus,
      correct: validStatus === "pass",
    });
  } finally {
    rmSync(hmacRoot, { recursive: true, force: true });
  }
  return demandResults;
}
