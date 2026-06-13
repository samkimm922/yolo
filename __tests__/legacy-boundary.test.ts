import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const boundary = JSON.parse(readFileSync(resolve(YOLO_DIR, "docs/legacy-boundary.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(resolve(YOLO_DIR, "package.json"), "utf8"));

function listFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) result.push(...listFiles(full));
    else result.push(full);
  }
  return result;
}

function rel(file) {
  return relative(YOLO_DIR, file).replaceAll("\\", "/");
}

function sourceFiles() {
  const roots = ["src", "scripts"]
    .map((dir) => resolve(YOLO_DIR, dir))
    .flatMap((dir) => listFiles(dir));
  const rootTs = readdirSync(YOLO_DIR)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => resolve(YOLO_DIR, file));
  return [...roots, ...rootTs]
    .map(rel)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !file.startsWith("closed-loop/"))
    .sort();
}

function fileText(file) {
  return readFileSync(resolve(YOLO_DIR, file), "utf8");
}

describe("legacy closed-loop boundary", () => {
  test("legacy boundary file count matches the archived closed-loop directory", () => {
    const closedLoop = boundary.legacy_dirs.find((entry) => entry.dir === "closed-loop");
    assert.ok(closedLoop, "closed-loop must be listed as a legacy directory");
    assert.equal(closedLoop.status, "archived_readonly");
    assert.equal(listFiles(resolve(YOLO_DIR, closedLoop.archive_dir)).length, closedLoop.file_count);
  });

  test("package exports and bins do not expose closed-loop files", () => {
    const targets = [
      ...Object.values(packageJson.exports || {}),
      ...Object.values(packageJson.bin || {}),
    ].map(String);

    for (const target of targets) {
      assert.equal(target.includes("closed-loop"), false, `${target} must not expose closed-loop`);
    }
  });

  test("closed-loop references outside docs are explicitly allowed", () => {
    const allowed = new Set(boundary.allowed_references.map((entry) => entry.file));
    const references = sourceFiles()
      .filter((file) => /closed-loop|closed_loop|closedLoop/.test(fileText(file)))
      .sort();

    assert.deepEqual(references, [...allowed].sort());
  });

  test("public SDK facade does not import legacy closed-loop modules", () => {
    const sdk = fileText("sdk.ts");
    assert.doesNotMatch(sdk, /from\s+["'][^"']*closed-loop/);
    assert.doesNotMatch(sdk, /import\([^)]*closed-loop/);
  });

  test("src modules do not import or execute closed-loop modules", () => {
    const forbidden = /(from\s+["'][^"']*closed-loop|import\([^)]*closed-loop|(?:spawn|exec)(?:File)?(?:Sync)?\([^)]*closed-loop)/;
    for (const file of sourceFiles().filter((item) => item.startsWith("src/"))) {
      assert.doesNotMatch(fileText(file), forbidden, `${file} must not import or execute closed-loop modules`);
    }
  });
});
