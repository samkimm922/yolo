import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  fixtureEvidenceRecord,
  getFixtureDefinition,
  inspectFixtureDefinition,
  inspectFixtureRegistry,
  listFixtureDefinitions,
} from "../src/fixtures/registry.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");

describe("fixture registry", () => {
  test("listFixtureDefinitions reads fixture manifests without running projects", () => {
    const fixtures = listFixtureDefinitions({ yoloRoot: YOLO_DIR });
    const ids = fixtures.map((fixture) => fixture.id);

    assert.deepEqual(ids, [
      "backend-api",
      "dirty-tree",
      "failing-baseline",
      "frontend-vite",
      "monorepo",
      "no-tests",
      "node-basic",
      "python-basic",
      "python-service",
    ]);
    assert.ok(fixtures.every((fixture) => fixture.fixture_file.endsWith("fixture.json")));
  });

  test("getFixtureDefinition returns one fixture by id", () => {
    assert.equal(getFixtureDefinition("node-basic", { yoloRoot: YOLO_DIR }).type, "node-basic");
    assert.throws(() => getFixtureDefinition("missing", { yoloRoot: YOLO_DIR }), /Unknown YOLO fixture/);
  });

  test("inspectFixtureDefinition checks requirement, spec, task, run, evidence, and files", () => {
    const fixture = getFixtureDefinition("node-basic", { yoloRoot: YOLO_DIR });
    const inspection = inspectFixtureDefinition(fixture);

    assert.equal(inspection.status, "pass");
    assert.equal(inspection.blocks_execution, false);
    assert.deepEqual(inspection.checks.map((check) => check.code), [
      "HAS_REQUIREMENT",
      "HAS_SPEC_TRACE",
      "HAS_TASK",
      "HAS_RUN_MODE",
      "SUPPORTS_DRY_RUN",
      "HAS_EVIDENCE_CONTRACT",
      "FIXTURE_FILES_EXIST",
    ]);
  });

  test("inspectFixtureRegistry summarizes all local fixtures", () => {
    const result = inspectFixtureRegistry({ yoloRoot: YOLO_DIR });

    assert.equal(result.status, "pass");
    assert.equal(result.fixture_count, 9);
    assert.ok(result.fixtures.every((fixture) => fixture.status === "pass"));
  });

  test("fixtureEvidenceRecord produces machine-readable fixture evidence", () => {
    const fixture = getFixtureDefinition("no-tests", { yoloRoot: YOLO_DIR });
    const inspection = inspectFixtureDefinition(fixture);

    assert.deepEqual(fixtureEvidenceRecord(fixture, inspection), {
      event: "fixture.inspected",
      fixture_id: "no-tests",
      fixture_type: "no-tests",
      status: "pass",
      requirement_id: "REQ-NOTEST-001",
      spec_id: "SPEC-NOTEST-001",
      task_id: "FIX-NOTEST-001",
      evidence_expected: ["state/evidence/FIX-NOTEST-001/degraded-run.json"],
    });
  });
});
