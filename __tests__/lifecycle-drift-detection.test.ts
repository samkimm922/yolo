import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectLifecycleDrift } from "../src/lifecycle/guard.js";

describe("lifecycle drift detection", () => {
  test("no drift when status.json does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-drift-"));
    const result = inspectLifecycleDrift(root);
    assert.equal(result.has_drift, false);
    assert.equal(result.drift_records.length, 0);
  });

  test("no drift when no stages are completed", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-drift-"));
    mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
    writeFileSync(join(root, ".yolo/lifecycle/status.json"), JSON.stringify({
      stages: [{ id: "discovery", status: "pending" }],
    }));
    const result = inspectLifecycleDrift(root);
    assert.equal(result.has_drift, false);
    assert.equal(result.drift_records.length, 0);
  });

  test("no drift when completed stage has its artifact present", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-drift-"));
    mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
    writeFileSync(join(root, ".yolo/lifecycle/status.json"), JSON.stringify({
      stages: [{ id: "discovery", status: "completed" }],
    }));
    writeFileSync(join(root, ".yolo/lifecycle/discovery.json"), JSON.stringify({ status: "completed" }));
    const result = inspectLifecycleDrift(root);
    assert.equal(result.has_drift, false);
    assert.equal(result.drift_records.length, 0);
  });

  test("detects drift when stage declared completed but artifact missing", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-drift-"));
    mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
    writeFileSync(join(root, ".yolo/lifecycle/status.json"), JSON.stringify({
      stages: [{ id: "discovery", status: "completed" }],
    }));
    const result = inspectLifecycleDrift(root);
    assert.equal(result.has_drift, true);
    assert.ok(result.drift_records.length > 0);
    assert.equal(result.drift_records[0].stage, "discovery");
    assert.equal(result.drift_records[0].declared, "completed");
    assert.equal(result.drift_records[0].actual, "missing");
  });

  test("detects multiple drift records across stages", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-drift-"));
    mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
    writeFileSync(join(root, ".yolo/lifecycle/status.json"), JSON.stringify({
      stages: [
        { id: "discovery", status: "completed" },
        { id: "roadmap", status: "completed" },
        { id: "prd", status: "pending" },
      ],
    }));
    const result = inspectLifecycleDrift(root);
    assert.equal(result.has_drift, true);
    assert.equal(result.drift_records.length, 2);
    const stages = result.drift_records.map((r) => r.stage);
    assert.ok(stages.includes("discovery"));
    assert.ok(stages.includes("roadmap"));
  });

  test("no drift for unknown stage ids not in artifact map", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-drift-"));
    mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
    writeFileSync(join(root, ".yolo/lifecycle/status.json"), JSON.stringify({
      stages: [{ id: "unknown-custom-stage", status: "completed" }],
    }));
    const result = inspectLifecycleDrift(root);
    assert.equal(result.has_drift, false);
    assert.equal(result.drift_records.length, 0);
  });

  test("tolerates null / non-object entries inside stages array (corrupted status.json)", () => {
    // status.json may contain valid JSON with a null/non-object entry inside
    // the `stages` array (botched external write, partial flush, git merge).
    // Previously `entry.status` crashed with "Cannot read properties of null"
    // inside both the .filter and the for-loop, taking down the whole guard.
    // validateLifecycleState tolerated this via optional chaining; drift did not.
    const root = mkdtempSync(join(tmpdir(), "yolo-drift-"));
    mkdirSync(join(root, ".yolo/lifecycle"), { recursive: true });
    writeFileSync(join(root, ".yolo/lifecycle/status.json"), JSON.stringify({
      stages: [
        null,
        42,
        "idea",
        [1, 2, 3],
        { id: "discovery", status: "completed" },
        { id: "roadmap", status: "pending" },
      ],
    }));
    // Only discovery is declared completed; its artifact is missing, so drift
    // fires exactly once for discovery — without crashing on the null entries.
    const result = inspectLifecycleDrift(root);
    assert.equal(result.has_drift, true);
    assert.equal(result.drift_records.length, 1);
    assert.equal(result.drift_records[0].stage, "discovery");
    assert.equal(result.drift_records[0].code, "ARTIFACT_MISSING");
  });
});
