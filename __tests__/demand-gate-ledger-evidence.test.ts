import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectDemandQuality, inspectDemandReadiness } from "../src/demand/gate.js";
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

  test("with unrelated valid ledger chain, evidence_grounded is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-ledger-"));
    try {
      const ledgerPath = join(dir, "evidence", "ledger.jsonl");
      appendJsonlRecord(ledgerPath, { event: "project_read", file: "src/foo.ts", ledger: "state" });
      const result = inspectDemandQuality({ tasks: [] }, { stateDir: dir });
      assert.ok(result !== null);
      const factDim = result.dimensions?.find((d) => d.code === "project_fact_grounding");
      assert.ok(factDim !== undefined);
      assert.equal(factDim.evidence_grounded, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with unsigned approved demand ledger chain, evidence_grounded is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-ledger-"));
    try {
      const ledgerPath = join(dir, "evidence", "ledger.jsonl");
      appendJsonlRecord(ledgerPath, { event: "demand.approved", demand_id: "DEMAND-1", ledger: "state" });
      const result = inspectDemandQuality({ id: "DEMAND-1", tasks: [] }, { stateDir: dir });
      assert.ok(result !== null);
      const factDim = result.dimensions?.find((d) => d.code === "project_fact_grounding");
      assert.ok(factDim !== undefined);
      assert.equal(factDim.evidence_grounded, false);
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

  test("R6 in deep mode, missing evidence_grounded becomes readiness blocker", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-ledger-"));
    try {
      // No ledger present — evidence_grounded is false
      const result = inspectDemandReadiness({
        playback: { confirmed: true, confirmed_by: "user" },
        approval: { approved: true },
        requirements: { active: [{ text: "User can do X." }] },
      }, { phase: "discuss", stateDir: dir });

      assert.ok(result.blockers.some((b) => b.code === "EVIDENCE_GROUNDED"),
        `Expected EVIDENCE_GROUNDED blocker, got: ${JSON.stringify(result.blockers.map(b => b.code))}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("R6 with valid ledger passes evidence_grounded readiness check", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-ledger-"));
    try {
      const ledgerPath = join(dir, "evidence", "ledger.jsonl");
      appendJsonlRecord(ledgerPath, { event: "demand.discuss", demand_id: "DEMAND-1", ledger: "state" });

      const result = inspectDemandReadiness({
        id: "DEMAND-1",
        playback: { confirmed: true, confirmed_by: "user" },
        approval: { approved: true },
        requirements: { active: [{ text: "User can do X." }] },
      }, { phase: "discuss", stateDir: dir });

      const blocker = result.blockers.find((b) => b.code === "EVIDENCE_GROUNDED");
      assert.equal(blocker, undefined, `EVIDENCE_GROUNDED should not block when ledger is valid, got blocker`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
