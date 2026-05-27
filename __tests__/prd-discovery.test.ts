import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findLatestPrd,
  resolveRunnerCliArgs,
} from "../src/runtime/run-lifecycle/prd-discovery.js";

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

describe("runner PRD discovery", () => {
  test("findLatestPrd returns the newest JSON file with PRD task shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-prd-discovery-"));
    const searchDir = join(dir, "data");
    mkdirSync(searchDir);
    writeJson(join(searchDir, "package.json"), { tasks: [{ id: "BAD", priority: "P0" }] });
    writeJson(join(searchDir, "not-prd.json"), { hello: true });
    const older = join(searchDir, "older.json");
    const newer = join(searchDir, "newer.json");
    writeJson(older, { tasks: [{ id: "OLD", priority: "P1" }] });
    writeJson(newer, { tasks: [{ id: "NEW", priority: "P0" }] });
    utimesSync(older, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    utimesSync(newer, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));

    assert.equal(findLatestPrd({ searchDirs: [searchDir] }), newer);
  });

  test("findLatestPrd ignores retry files and unreadable JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-prd-discovery-"));
    writeFileSync(join(dir, "broken.json"), "{", "utf8");
    writeJson(join(dir, "retry-round1.json"), { tasks: [{ id: "RETRY", priority: "P0" }] });

    assert.equal(findLatestPrd({ searchDirs: [dir] }), null);
  });

  test("resolveRunnerCliArgs supports --prd=value, --prd value, positional PRD, and latest fallback", () => {
    const resolvePrdPathFn = (prd, root) => `${root}/${prd}`;
    assert.deepEqual(resolveRunnerCliArgs({
      argv: ["node", "runner.js", "--prd=data/a.json", "--mode=dev"],
      yoloRoot: "/yolo",
      resolvePrdPathFn,
    }), { prdArg: "/yolo/data/a.json", mode: "dev" });

    assert.deepEqual(resolveRunnerCliArgs({
      argv: ["node", "runner.js", "--prd", "data/b.json"],
      yoloRoot: "/yolo",
      resolvePrdPathFn,
    }), { prdArg: "/yolo/data/b.json", mode: "fix" });

    assert.deepEqual(resolveRunnerCliArgs({
      argv: ["node", "runner.js", "data/c.json"],
      yoloRoot: "/yolo",
      resolvePrdPathFn,
    }), { prdArg: "/yolo/data/c.json", mode: "fix" });

    assert.deepEqual(resolveRunnerCliArgs({
      argv: ["node", "runner.js"],
      yoloRoot: "/yolo",
      resolvePrdPathFn,
      findLatestPrdFn: () => "data/latest.json",
    }), { prdArg: "/yolo/data/latest.json", mode: "fix" });
  });
});
