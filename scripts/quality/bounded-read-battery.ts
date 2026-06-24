// Quality-score bounded-read battery: ledger reads must fail closed on oversized
// inputs instead of loading the whole file into memory.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLedgerJsonl } from "../../src/runtime/evidence/ledger.js";
import { loadResumeCompletedFromPrd } from "../../src/runtime/run-lifecycle/startup.js";

type BoundedReadBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

export function runBoundedReadBattery(): BoundedReadBatteryResult[] {
  const root = mkdtempSync(join(tmpdir(), "yolo-bounded-read-battery-"));
  try {
    const results: BoundedReadBatteryResult[] = [];
    const ledgerDir = join(root, "evidence");
    mkdirSync(ledgerDir, { recursive: true });
    const ledgerPath = join(ledgerDir, "ledger.jsonl");
    const oversizedPayload = "x".repeat(9 * 1024 * 1024);
    writeFileSync(ledgerPath, `${JSON.stringify({ event: "oversized", payload: oversizedPayload })}\n`, "utf8");

    const records = readLedgerJsonl(ledgerPath) as Array<Record<string, unknown>>;
    const hasStructuredSizeError = records.some((record) => record?.code === "LEDGER_READ_SIZE_LIMIT_EXCEEDED");
    const ledgerStatus = hasStructuredSizeError ? "blocked" : "pass";
    results.push({
      id: "bounded_ledger_read_no_oom",
      category: "bounded_read_robustness",
      expect: "blocked",
      actualExit: ledgerStatus === "blocked" ? 1 : 0,
      actualStatus: ledgerStatus,
      correct: ledgerStatus === "blocked",
    });

    const prdPath = join(root, "oversized-prd.json");
    writeFileSync(prdPath, JSON.stringify({
      tasks: [{
        id: "DONE",
        status: "completed",
        padding: "x".repeat(9 * 1024 * 1024),
      }],
    }), "utf8");

    let prdStatus = "pass";
    try {
      loadResumeCompletedFromPrd({
        prdPath,
        taskCountsAsCompleted: (task: { status?: string }) => task.status === "completed",
        consoleLog: () => {},
      });
    } catch (error) {
      prdStatus = typeof (error as { code?: unknown })?.code === "string"
        && String((error as { code?: unknown }).code).includes("SIZE_LIMIT")
        ? "blocked"
        : "error";
    }
    results.push({
      id: "bounded_prd_resume_read_no_oom",
      category: "bounded_read_robustness",
      expect: "blocked",
      actualExit: prdStatus === "blocked" ? 1 : 0,
      actualStatus: prdStatus,
      correct: prdStatus === "blocked",
    });

    return results;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
