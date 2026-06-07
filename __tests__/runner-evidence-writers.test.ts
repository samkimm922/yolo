import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { evidenceArtifactDigest } from "../src/runtime/evidence/ledger.js";
import {
  writeContractSuspectEvidence,
  writePrdContractDoctorEvidence,
  writeSplitAppliedEvidence,
} from "../src/runtime/evidence/writers.js";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

describe("runner evidence writers", () => {
  test("writes split-applied task evidence with repo-relative path", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "yolo-evidence-"));
    const yoloRoot = join(projectRoot, "scripts/yolo");
    try {
      const result = writeSplitAppliedEvidence({
        parentTask: { id: "FIX-EVIDENCE-001" },
        doctor: { evidence_file: "state/evidence/FIX-EVIDENCE-001/investigation.json" },
        childIds: ["FIX-EVIDENCE-0011"],
        children: [{ id: "FIX-EVIDENCE-0011", scope: { targets: [{ file: "src/a.ts" }] } }],
        now: "2026-05-24T00:00:00.000Z",
      }, { yoloRoot, projectRoot });

      assert.equal(result.evidence_file, "scripts/yolo/state/evidence/FIX-EVIDENCE-001/split-applied.json");
      assert.equal(existsSync(result.evidence_path), true);
      const evidence = readJson(result.evidence_path);
      assert.equal(evidence.artifact_digest, evidenceArtifactDigest(evidence));
      assert.deepEqual({ ...evidence, artifact_digest: "<digest>" }, {
        schema_version: "1.0",
        schema: "yolo.evidence.artifact.v1",
        artifact_type: "task.split_applied",
        generated_at: "2026-05-24T00:00:00.000Z",
        source: "runner",
        artifact_digest: "<digest>",
        task_id: "FIX-EVIDENCE-001",
        status: "split_applied",
        reason: "atomic_task_must_split",
        source_evidence: "state/evidence/FIX-EVIDENCE-001/investigation.json",
        split_into: ["FIX-EVIDENCE-0011"],
        children: [{ id: "FIX-EVIDENCE-0011", scope: { targets: [{ file: "src/a.ts" }] } }],
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("writes contract-suspect evidence with failure fingerprint and PRD reference", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "yolo-evidence-"));
    const yoloRoot = join(projectRoot, "scripts/yolo");
    try {
      const result = writeContractSuspectEvidence({
        task: {
          id: "FIX-EVIDENCE-002",
          status: "pending",
          scope: { targets: [{ file: "src/a.ts" }] },
          post_conditions: [{
            id: "POST-CODE",
            type: "code_contains",
            severity: "FAIL",
            params: { file: "src/a.ts", text: "fixed" },
          }],
        },
        prdPath: join(yoloRoot, "data/prd.json"),
        failures: [{ id: "POST-CODE", type: "code_contains", severity: "FAIL", detail: "missing fixed text" }],
        history: [
          { gate: 1, message: "old-1" },
          { gate: 1, message: "old-2" },
          { gate: 1, message: "old-3" },
          { gate: 1, message: "old-4" },
          { gate: 1, message: "old-5" },
          { gate: 1, message: "latest" },
        ],
        gateExitCode: 1,
        now: "2026-05-24T00:00:00.000Z",
      }, { yoloRoot, projectRoot });

      const evidence = readJson(result.evidence_path);
      assert.equal(result.evidence_file, "scripts/yolo/state/evidence/FIX-EVIDENCE-002/contract-suspect.json");
      assert.equal(evidence.schema_version, "1.0");
      assert.equal(evidence.schema, "yolo.evidence.artifact.v1");
      assert.equal(evidence.artifact_type, "task.contract_suspect");
      assert.equal(evidence.source, "runner");
      assert.equal(evidence.status, "needs_contract_review");
      assert.equal(evidence.current_prd, "data/prd.json");
      assert.equal(evidence.fingerprint, "POST-CODE:code_contains:missing fixed text");
      assert.equal(evidence.failed_conditions[0].severity, "FAIL");
      assert.deepEqual(evidence.history.map((entry) => entry.message), ["old-2", "old-3", "old-4", "old-5", "latest"]);
      assert.equal(evidence.contract_quality.blocks_execution, false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("writes PRD contract doctor evidence under state/evidence", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "yolo-evidence-"));
    const yoloRoot = join(projectRoot, "scripts/yolo");
    try {
      const result = writePrdContractDoctorEvidence({
        prd: { id: "PRD-EVIDENCE" },
        prdPath: join(yoloRoot, "data/prd.json"),
        result: { blocks_execution: false, warning_count: 1, failures: [] },
        now: "2026-05-24T00:00:00.000Z",
      }, { stateDir: join(yoloRoot, "state"), projectRoot });

      assert.match(result.evidence_file, /^scripts\/yolo\/state\/evidence\/prd-contract-doctor\/PRD-EVIDENCE-\d+\.json$/);
      const evidence = readJson(result.evidence_path);
      assert.equal(evidence.schema_version, "1.0");
      assert.equal(evidence.schema, "yolo.evidence.artifact.v1");
      assert.equal(evidence.artifact_type, "prd.contract_doctor");
      assert.equal(evidence.source, "runner");
      assert.equal(evidence.generated_at, "2026-05-24T00:00:00.000Z");
      assert.equal(evidence.prd, "data/prd.json");
      assert.equal(evidence.warning_count, 1);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
