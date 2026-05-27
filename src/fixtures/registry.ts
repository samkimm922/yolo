import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_YOLO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function fixtureRoot(options = {}) {
  return resolve(options.fixturesRoot || join(options.yoloRoot || DEFAULT_YOLO_ROOT, "fixtures"));
}

export function listFixtureDefinitions(options = {}) {
  const root = fixtureRoot(options);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, "fixture.json"))
    .filter((filePath) => existsSync(filePath))
    .map((filePath) => ({
      ...readJson(filePath),
      fixture_file: filePath,
      fixture_dir: dirname(filePath),
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function getFixtureDefinition(id, options = {}) {
  const fixture = listFixtureDefinitions(options).find((item) => item.id === id);
  if (!fixture) {
    throw new Error(`Unknown YOLO fixture "${id}"`);
  }
  return fixture;
}

export function inspectFixtureDefinition(fixture = {}) {
  const checks = [
    ["HAS_REQUIREMENT", Boolean(fixture.requirement?.id && fixture.requirement?.text)],
    ["HAS_SPEC_TRACE", Boolean(fixture.spec?.requirement_id && fixture.spec?.design_id && fixture.spec?.task_id)],
    ["HAS_TASK", Boolean(fixture.task?.id && fixture.task?.prd)],
    ["HAS_RUN_MODE", Boolean(fixture.run?.mode)],
    ["SUPPORTS_DRY_RUN", fixture.run?.supports_dry_run === true],
    ["HAS_EVIDENCE_CONTRACT", Array.isArray(fixture.evidence?.expected) && fixture.evidence.expected.length > 0],
  ].map(([code, passed]) => ({ code, passed }));

  const missingFiles = [];
  for (const relativePath of fixture.files || []) {
    if (!fixture.fixture_dir || !existsSync(join(fixture.fixture_dir, relativePath))) {
      missingFiles.push(relativePath);
    }
  }

  if (missingFiles.length > 0) {
    checks.push({ code: "MISSING_FIXTURE_FILES", passed: false, files: missingFiles });
  } else {
    checks.push({ code: "FIXTURE_FILES_EXIST", passed: true });
  }

  const blockers = checks.filter((check) => check.passed !== true);
  return {
    fixture_id: fixture.id || null,
    status: blockers.length > 0 ? "blocked" : "pass",
    blocks_execution: blockers.length > 0,
    checks,
    blockers,
  };
}

export function inspectFixtureRegistry(options = {}) {
  const fixtures = listFixtureDefinitions(options);
  const inspections = fixtures.map((fixture) => inspectFixtureDefinition(fixture));
  return {
    status: inspections.every((inspection) => inspection.status === "pass") ? "pass" : "blocked",
    fixture_count: fixtures.length,
    fixtures: inspections,
  };
}

export function fixtureEvidenceRecord(fixture, inspection = inspectFixtureDefinition(fixture)) {
  return {
    event: "fixture.inspected",
    fixture_id: fixture.id || null,
    fixture_type: fixture.type || null,
    status: inspection.status,
    requirement_id: fixture.requirement?.id || null,
    spec_id: fixture.spec?.id || null,
    task_id: fixture.task?.id || null,
    evidence_expected: fixture.evidence?.expected || [],
  };
}
