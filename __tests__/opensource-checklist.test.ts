import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const YOLO_DIR = resolve(import.meta.dirname, "..");

function inspectVerifyCoverage(packageText, ciText) {
  const findings = [];
  const packageJson = JSON.parse(packageText);
  const verifyScript = String(packageJson.scripts?.verify || "");
  if (verifyScript.includes("./dist/lib/config.js")) findings.push("VERIFY_STALE_CONFIG_PATH");
  if (!verifyScript.includes("./dist/src/lib/config.js")) findings.push("VERIFY_REAL_CONFIG_PATH_MISSING");
  if (!/\bnpm run verify\b/.test(ciText)) findings.push("CI_VERIFY_JOB_MISSING");
  return findings;
}

function inspectRepoHygiene({ gitLsFilesText = "", ciText = "", files = new Set() } = {}) {
  const findings = [];
  const trackedYolo = gitLsFilesText.split(/\r?\n/).filter((line) => line.startsWith(".yolo/"));
  if (trackedYolo.length > 0) findings.push("TRACKED_YOLO_RUNTIME_STATE");
  if (files.has("vitest.yolo.config.ts")) findings.push("DEAD_VITEST_YOLO_CONFIG");
  if (!/git ls-files ['"]?\.yolo\/\*\*['"]?/.test(ciText)) findings.push("CI_YOLO_TRACKING_GUARD_MISSING");
  if (!/vitest\.yolo\.config\.ts/.test(ciText)) findings.push("CI_DEAD_CONFIG_GUARD_MISSING");
  return findings;
}

describe("open source checklist", () => {
  test("CI workflow exists and references standard jobs", () => {
    const ciPath = join(YOLO_DIR, ".github/workflows/ci.yml");
    assert.equal(existsSync(ciPath), true, ".github/workflows/ci.yml must exist");
    const ci = readFileSync(ciPath, "utf8");
    assert.ok(ci.includes("jobs:"), "CI must define jobs");
    assert.ok(ci.includes("unit:"), "CI must include unit test job");
    assert.ok(ci.includes("typecheck:"), "CI must include typecheck job");
    assert.ok(ci.includes("build:"), "CI must include build job");
    assert.ok(ci.includes("verify:"), "CI must include verify job");
  });

  test("W2 verify script uses built config path and CI runs verify", () => {
    const packageText = readFileSync(join(YOLO_DIR, "package.json"), "utf8");
    const ciText = readFileSync(join(YOLO_DIR, ".github/workflows/ci.yml"), "utf8");
    assert.deepEqual(inspectVerifyCoverage(packageText, ciText), []);
  });

  test("W2 negative: stale dist/lib verify path or missing CI verify is blocked", () => {
    const stalePackage = JSON.stringify({
      scripts: {
        verify: "node -e \"import {config} from'./dist/lib/config.js';process.exit(config.version==='2.0'?0:1)\"",
      },
    });
    const findings = inspectVerifyCoverage(stalePackage, "jobs:\n  unit:\n    steps: []\n");
    assert.ok(findings.includes("VERIFY_STALE_CONFIG_PATH"));
    assert.ok(findings.includes("VERIFY_REAL_CONFIG_PATH_MISSING"));
    assert.ok(findings.includes("CI_VERIFY_JOB_MISSING"));
  });

  test("W6 repo hygiene blocks tracked .yolo state and dead vitest config", () => {
    const ciText = readFileSync(join(YOLO_DIR, ".github/workflows/ci.yml"), "utf8");
    const gitLsFilesText = execFileSync("git", ["ls-files", ".yolo/**"], { cwd: YOLO_DIR, encoding: "utf8" });
    const files = new Set();
    if (existsSync(join(YOLO_DIR, "vitest.yolo.config.ts"))) files.add("vitest.yolo.config.ts");
    assert.deepEqual(inspectRepoHygiene({ gitLsFilesText, ciText, files }), []);
  });

  test("W6 negative: fake tracked .yolo artifact or stale vitest config is blocked", () => {
    const findings = inspectRepoHygiene({
      gitLsFilesText: ".yolo/demand/session.json\nsrc/index.ts\n",
      ciText: "jobs:\n  unit:\n    steps: []\n",
      files: new Set(["vitest.yolo.config.ts"]),
    });
    assert.ok(findings.includes("TRACKED_YOLO_RUNTIME_STATE"));
    assert.ok(findings.includes("DEAD_VITEST_YOLO_CONFIG"));
    assert.ok(findings.includes("CI_YOLO_TRACKING_GUARD_MISSING"));
    assert.ok(findings.includes("CI_DEAD_CONFIG_GUARD_MISSING"));
  });

  test("CHANGELOG exists at root", () => {
    const path = join(YOLO_DIR, "CHANGELOG.md");
    assert.equal(existsSync(path), true, "CHANGELOG.md must exist at repository root");
  });

  test("issue templates exist", () => {
    const bugPath = join(YOLO_DIR, ".github/ISSUE_TEMPLATE/bug_report.md");
    const featPath = join(YOLO_DIR, ".github/ISSUE_TEMPLATE/feature_request.md");
    assert.equal(existsSync(bugPath), true, "bug_report.md issue template must exist");
    assert.equal(existsSync(featPath), true, "feature_request.md issue template must exist");
  });

  test("config.example.yaml schema matches runtime defaults", () => {
    const examplePath = join(YOLO_DIR, "config.example.yaml");
    assert.equal(existsSync(examplePath), true, "config.example.yaml must exist");
    const example = readFileSync(examplePath, "utf8");

    const requiredTopLevelKeys = [
      "version:",
      "project:",
      "build:",
      "ai:",
      "gate:",
      "runner:",
      "state:",
      "docs:",
      "learn:",
      "progress_server:",
    ];

    for (const key of requiredTopLevelKeys) {
      assert.ok(example.includes(key), `config.example.yaml must include top-level key ${key}`);
    }

    // Align with runtime defaults: no stale 'provider' key, executor/model are explicit
    assert.ok(!example.includes("provider:"), "config.example.yaml must not include stale ai.provider key");
    assert.ok(example.includes('executor: "claude"') || example.includes("executor: claude"), "config.example.yaml should use explicit executor default");
  });
});
