// Quality-score bounded-read battery: ledger reads must fail closed on oversized
// inputs instead of loading the whole file into memory.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLedgerJsonl } from "../../src/runtime/evidence/ledger.js";

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
    const ledgerDir = join(root, "evidence");
    mkdirSync(ledgerDir, { recursive: true });
    const ledgerPath = join(ledgerDir, "ledger.jsonl");
    const oversizedPayload = "x".repeat(9 * 1024 * 1024);
    writeFileSync(ledgerPath, `${JSON.stringify({ event: "oversized", payload: oversizedPayload })}\n`, "utf8");

    const records = readLedgerJsonl(ledgerPath) as Array<Record<string, unknown>>;
    const hasStructuredSizeError = records.some((record) => record?.code === "LEDGER_READ_SIZE_LIMIT_EXCEEDED");
    const status = hasStructuredSizeError ? "blocked" : "pass";
    const correct = status === "blocked";
    return [{
      id: "bounded_ledger_read_no_oom",
      category: "bounded_read_robustness",
      expect: "blocked",
      actualExit: status === "blocked" ? 1 : 0,
      actualStatus: status,
      correct,
    }];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
