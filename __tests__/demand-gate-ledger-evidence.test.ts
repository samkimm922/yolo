import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectDemandQuality } from "../src/demand/gate.js";

describe("demand gate ledger evidence integration", () => {
  test("without stateDir, evidence_grounded is false or undefined", () => {
    const result = inspectDemandQuality({ tasks: [] });
    // gate still works without ledger
    assert.ok(result !== null);
    assert.ok(["pass", "warning", "blocked"].includes(result.status));
    const factDim = result.dimensions?.find((d) => d.code === "project_fact_grounding");
    assert.ok(factDim !== undefined, "project_fact_grounding dimension should be present");
    assert.equal(factDim.evidence_grounded, false);
  });

  test("with stateDir having no ledger file, evidence_grounded is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-ledger-"));
    const result = inspectDemandQuality({ tasks: [] }, { stateDir: dir });
    assert.ok(result !== null);
    // should not throw
    const factDim = result.dimensions?.find((d) => d.code === "project_fact_grounding");
    assert.ok(factDim !== undefined);
    assert.equal(factDim.evidence_grounded, false);
  });

  test("with stateDir having a ledger file, evidence_grounded can be detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-ledger-"));
    mkdirSync(join(dir, "evidence"), { recursive: true });
    writeFileSync(join(dir, "evidence/ledger.jsonl"), JSON.stringify({ type: "project_read", file: "src/foo.ts" }) + "\n");
    const result = inspectDemandQuality({ tasks: [] }, { stateDir: dir });
    assert.ok(result !== null);
    // gate processes without error when ledger exists
    const factDim = result.dimensions?.find((d) => d.code === "project_fact_grounding");
    assert.ok(factDim !== undefined);
    assert.equal(factDim.evidence_grounded, true);
  });
});
