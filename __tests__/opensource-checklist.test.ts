import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const YOLO_DIR = resolve(import.meta.dirname, "..");

describe("open source checklist", () => {
  test("CI workflow exists and references standard jobs", () => {
    const ciPath = join(YOLO_DIR, ".github/workflows/ci.yml");
    assert.equal(existsSync(ciPath), true, ".github/workflows/ci.yml must exist");
    const ci = readFileSync(ciPath, "utf8");
    assert.ok(ci.includes("jobs:"), "CI must define jobs");
    assert.ok(ci.includes("unit:"), "CI must include unit test job");
    assert.ok(ci.includes("typecheck:"), "CI must include typecheck job");
    assert.ok(ci.includes("build:"), "CI must include build job");
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
