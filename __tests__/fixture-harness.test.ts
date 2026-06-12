import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
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

  test("runFixtureHarness reports no-tests smoke as degraded instead of pass", () => {
    const result = runFixtureHarness("no-tests", {
      yoloRoot: YOLO_DIR,
      keepWorkspace: true,
    });
    try {
      assert.equal(result.status, "degraded");
      assert.equal(result.commands[0].command, "node src/index.ts");
      assert.match(result.commands[0].stdout_tail, /ok/);
      assert.equal(result.evidence.fixture.fixture_type, "no-tests");
      assert.equal(result.evidence.degraded_reason, "project_has_no_test_script");
    } finally {
      rmSync(result.workspace, { recursive: true, force: true });
    }
  });

  test("runFixtureHarness blocks no-tests for release gates", () => {
    const result = runFixtureHarness("no-tests", {
      yoloRoot: YOLO_DIR,
      keepWorkspace: true,
      mode: "release",
    });
    try {
      assert.equal(result.status, "blocked");
      assert.ok(result.blocking_failures.some((failure) => failure.failure_type === "degraded_fixture_not_release_eligible"));
      assert.equal(result.evidence.status, "blocked");
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

  test("runFixtureHarness returns structured command-not-found failures", () => {
    const fixture = {
      ...getFixtureDefinition("node-basic", { yoloRoot: YOLO_DIR }),
      run: {
        mode: "dry-run",
        supports_dry_run: true,
        commands: ["definitely-not-a-yolo-command"],
      },
    };
    const result = runFixtureHarness(fixture, { keepWorkspace: true });
    try {
      assert.equal(result.status, "blocked");
      assert.equal(result.commands[0].failure.failure_type, "command_not_found");
      assert.ok(result.blocking_failures.some((failure) => failure.code === "FIXTURE_COMMAND_NOT_FOUND"));
    } finally {
      rmSync(result.workspace, { recursive: true, force: true });
    }
  });

  test("runFixtureHarness returns structured timeout failures", () => {
    const fixture = {
      ...getFixtureDefinition("node-basic", { yoloRoot: YOLO_DIR }),
      run: {
        mode: "dry-run",
        supports_dry_run: true,
        commands: ["node -e \"setTimeout(() => {}, 1000)\""],
      },
    };
    const result = runFixtureHarness(fixture, { keepWorkspace: true, timeout_ms: 20 });
    try {
      assert.equal(result.status, "blocked");
      assert.equal(result.commands[0].failure.failure_type, "timeout");
      assert.ok(result.blocking_failures.some((failure) => failure.code === "FIXTURE_COMMAND_TIMEOUT"));
    } finally {
      rmSync(result.workspace, { recursive: true, force: true });
    }
  });

  test("runFixtureHarness returns structured nonzero exit failures", () => {
    const fixture = {
      ...getFixtureDefinition("node-basic", { yoloRoot: YOLO_DIR }),
      run: {
        mode: "dry-run",
        supports_dry_run: true,
        commands: ["node -e \"process.exit(7)\""],
      },
    };
    const result = runFixtureHarness(fixture, { keepWorkspace: true });
    try {
      assert.equal(result.status, "blocked");
      assert.equal(result.commands[0].failure.failure_type, "nonzero_exit");
      assert.equal(result.commands[0].exit_code, 7);
      assert.ok(result.blocking_failures.some((failure) => failure.code === "FIXTURE_COMMAND_NONZERO_EXIT"));
    } finally {
      rmSync(result.workspace, { recursive: true, force: true });
    }
  });

  test("runFixtureHarness returns structured external dependency failures", () => {
    const fixture = {
      ...getFixtureDefinition("node-basic", { yoloRoot: YOLO_DIR }),
      run: {
        mode: "dry-run",
        supports_dry_run: true,
        external_dependencies: ["definitely-missing-yolo-tool"],
        commands: ["node -e \"process.exit(0)\""],
      },
    };
    const result = runFixtureHarness(fixture, { keepWorkspace: true });
    try {
      assert.equal(result.status, "blocked");
      assert.equal(result.commands[0].status, "pass");
      assert.ok(result.blocking_failures.some((failure) => failure.failure_type === "external_dependency_unavailable"));
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
    ["typescript-enum-probe", "node src/index.ts"],
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

  // Version-independence proof. The typescript-enum-probe fixture ships a
  // source file that uses `export enum`. node 20 has no native TS support
  // (.ts → ERR_UNKNOWN_FILE_EXTENSION). node 22+ runs
  // --experimental-strip-types by default, which rejects enum with
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. The only way `node src/index.ts` can
  // return exit 0 here is if a real TypeScript transpiler (tsx/esbuild,
  // resolved from yolo's own devDependencies) is on the loader path.
  //
  // If anyone later "simplifies" the harness by removing the tsx loader
  // injection, this test will fail on the host that loses TS support.
  // It is the lock against node-version regression.
  test("typescript-enum-probe proves fixtures execute full TypeScript via tsx, not native strip", () => {
    const fixtureId = "typescript-enum-probe";
    const fixture = getFixtureDefinition(fixtureId, { yoloRoot: YOLO_DIR });
    const sourcePath = join(fixture.fixture_dir, "src", "index.ts");
    const source = readFileSync(sourcePath, "utf8");
    assert.match(
      source,
      /export\s+enum\b/,
      "probe source must contain `export enum` to fail under node native strip-types"
    );

    const result = runFixtureHarness(fixtureId, {
      yoloRoot: YOLO_DIR,
      keepWorkspace: true,
    });
    try {
      assert.equal(result.status, "pass", `expected pass, got ${result.status}`);
      assert.equal(result.commands[0].command, "node src/index.ts");
      assert.equal(result.commands[0].exit_code, 0);
      assert.match(result.commands[0].stdout_tail, /pass/);
      assert.equal(
        result.commands[0].failure,
        undefined,
        "command must not be classified as failed/blocked"
      );
    } finally {
      rmSync(result.workspace, { recursive: true, force: true });
    }
  });
});
