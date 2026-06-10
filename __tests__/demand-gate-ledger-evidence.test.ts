import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectDemandQuality } from "../src/demand/gate.js";
import { appendJsonlRecord } from "../src/runtime/evidence/ledger.js";

describe("demand gate ledger evidence integration", () => {
  test("without stateDir, evidence_grounded is false", () => {
    const result = inspectDemandQuality({ tasks: [] });
    assert.ok(result !== null);
    assert.ok(["pass", "warning", "blocked"].includes(result.status));
    const factDim = result.dimensions?.find((d) => d.code === "project_fact_grounding");
    assert.ok(factDim !== undefined, "project_fact_grounding dimension should be present");
    assert.equal(factDim.evidence_grounded, false);
  });

  test("with stateDir having no ledger file, evidence_grounded is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-ledger-"));
    try {
      const result = inspectDemandQuality({ tasks: [] }, { stateDir: dir });
      assert.ok(result !== null);
      const factDim = result.dimensions?.find((d) => d.code === "project_fact_grounding");
      assert.ok(factDim !== undefined);
      assert.equal(factDim.evidence_grounded, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with valid ledger chain, evidence_grounded is true", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-ledger-"));
    try {
      const ledgerPath = join(dir, "evidence", "ledger.jsonl");
      appendJsonlRecord(ledgerPath, { event: "project_read", file: "src/foo.ts", ledger: "state" });
      const result = inspectDemandQuality({ tasks: [] }, { stateDir: dir });
      assert.ok(result !== null);
      const factDim = result.dimensions?.find((d) => d.code === "project_fact_grounding");
      assert.ok(factDim !== undefined);
      assert.equal(factDim.evidence_grounded, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with broken ledger chain, evidence_grounded is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-ledger-"));
    try {
      mkdirSync(join(dir, "evidence"), { recursive: true });
      // Write a malformed record that won't pass validateLedgerChain
      writeFileSync(
        join(dir, "evidence", "ledger.jsonl"),
        JSON.stringify({ type: "project_read", file: "src/foo.ts", prev_hash: "bogus", record_hash: "invalid" }) + "\n",
      );
      const result = inspectDemandQuality({ tasks: [] }, { stateDir: dir });
      assert.ok(result !== null);
      const factDim = result.dimensions?.find((d) => d.code === "project_fact_grounding");
      assert.ok(factDim !== undefined);
      assert.equal(factDim.evidence_grounded, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
