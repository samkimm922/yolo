import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  copyFixtureToWorkspace,
  runFixtureHarness,
} from "../src/fixtures/harness.js";
import { getFixtureDefinition } from "../src/fixtures/registry.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");

describe("fixture execution harness", () => {
  test("copyFixtureToWorkspace copies a fixture into an isolated workspace", () => {
    const fixture = getFixtureDefinition("node-basic", { yoloRoot: YOLO_DIR });
    const workspace = copyFixtureToWorkspace(fixture, { tmpRoot: tmpdir() });
    try {
      assert.equal(existsSync(join(workspace, "package.json")), true);
      assert.equal(existsSync(join(workspace, "src", "index.ts")), true);
      assert.notEqual(workspace, fixture.fixture_dir);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("runFixtureHarness executes node-basic smoke and writes evidence", () => {
    const result = runFixtureHarness("node-basic", {
      yoloRoot: YOLO_DIR,
      keepWorkspace: true,
    });
    try {
      assert.equal(result.status, "pass");
      assert.equal(result.commands.length, 1);
      assert.equal(result.commands[0].command, "npm test");
      assert.equal(result.commands[0].exit_code, 0);
      assert.equal(existsSync(join(result.workspace, result.evidence_file)), true);
      assert.equal(result.evidence.schema_version, "1.0");
      assert.equal(result.evidence.schema, "yolo.evidence.artifact.v1");
      assert.equal(result.evidence.artifact_type, "fixture.run");
      assert.equal(result.evidence.source, "fixture-harness");
      assert.equal(result.evidence.fixture.fixture_id, "node-basic");
      assert.equal(result.evidence.schema_check.ok, true);
      assert.deepEqual(result.evidence.missing_expected_artifacts, []);
      assert.ok(result.evidence.expected_artifacts.includes("state/evidence/FIX-NODE-001/run.json"));
    } finally {
      rmSync(result.workspace, { recursive: true, force: true });
    }
  });

  test("runFixtureHarness supports no-tests degraded smoke command", () => {
    const result = runFixtureHarness("no-tests", {
      yoloRoot: YOLO_DIR,
      keepWorkspace: true,
    });
    try {
      assert.equal(result.status, "pass");
      assert.equal(result.commands[0].command, "node src/index.ts");
      assert.match(result.commands[0].stdout_tail, /ok/);
      assert.equal(result.evidence.fixture.fixture_type, "no-tests");
    } finally {
      rmSync(result.workspace, { recursive: true, force: true });
    }
  });

  test("runFixtureHarness fails when additional expected evidence is missing", () => {
    const fixture = {
      ...getFixtureDefinition("node-basic", { yoloRoot: YOLO_DIR }),
      evidence: {
        expected: [
          "state/evidence/FIX-NODE-001/run.json",
          "state/evidence/FIX-NODE-001/extra-required.json",
        ],
      },
    };
    const result = runFixtureHarness(fixture, { keepWorkspace: true });
    try {
      assert.equal(result.status, "fail");
      assert.deepEqual(result.evidence.missing_expected_artifacts, ["state/evidence/FIX-NODE-001/extra-required.json"]);
      assert.equal(result.evidence.schema_check.ok, true);
    } finally {
      rmSync(result.workspace, { recursive: true, force: true });
    }
  });

  for (const [fixtureId, expectedCommand] of [
    ["backend-api", "npm test"],
    ["python-basic", "python3 -m unittest discover -s tests -p 'test_*.py'"],
    ["python-service", "python3 -m unittest discover -s tests -p 'test_*.py'"],
    ["frontend-vite", "npm test"],
    ["monorepo", "node --test packages/app/test.ts"],
    ["dirty-tree", "node scripts/check-dirty-marker.ts"],
    ["failing-baseline", "node scripts/check-baseline.ts"],
  ]) {
    test(`runFixtureHarness executes ${fixtureId}`, () => {
      const result = runFixtureHarness(fixtureId, {
        yoloRoot: YOLO_DIR,
        keepWorkspace: true,
      });
      try {
        assert.equal(result.status, "pass");
        assert.equal(result.commands[0].command, expectedCommand);
        assert.equal(result.commands[0].exit_code, 0);
        assert.equal(existsSync(join(result.workspace, result.evidence_file)), true);
        assert.equal(result.evidence.fixture.fixture_id, fixtureId);
      } finally {
        rmSync(result.workspace, { recursive: true, force: true });
      }
    });
  }
});
