import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const YOLO_DIR = resolve(import.meta.dirname, "..");

function countFiles(root, predicate) {
  let count = 0;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) count += countFiles(path, predicate);
    else if (predicate(path)) count += 1;
  }
  return count;
}

function lineCount(filePath) {
  return readFileSync(filePath, "utf8").split("\n").length - 1;
}

describe("docs truth sync", () => {
  test("progress and gap docs track current structure numbers", () => {
    const packageJson = JSON.parse(readFileSync(join(YOLO_DIR, "package.json"), "utf8"));
    const progress = readFileSync(join(YOLO_DIR, "docs/yolo-public-sdk-progress.md"), "utf8");
    const gap = readFileSync(join(YOLO_DIR, "docs/sdk-gap-matrix.md"), "utf8");
    const srcModules = countFiles(join(YOLO_DIR, "src"), (path) => path.endsWith(".ts"));
    const testFiles = countFiles(join(YOLO_DIR, "__tests__"), (path) => path.endsWith(".test.ts"));
    const rootTs = countFiles(YOLO_DIR, (path) => path.endsWith(".ts") && !path.slice(YOLO_DIR.length + 1).includes("/"));
    const runnerLines = lineCount(join(YOLO_DIR, "runner.ts"));
    const runnerCoreLines = lineCount(join(YOLO_DIR, "src/runtime/runner-core.ts"));
    const exportCount = Object.keys(packageJson.exports).length;
    const binCount = Object.keys(packageJson.bin).length;

    assert.match(progress, new RegExp(`\\| \`runner\\.ts\` 行数 \\| ${runnerLines} \\|`));
    assert.match(progress, new RegExp(`\\| \`src/runtime/runner-core\\.ts\` 行数 \\| ${runnerCoreLines} \\|`));
    assert.match(progress, new RegExp(`\\| 根目录 \`\\.ts\` 文件 \\| ${rootTs} \\|`));
    assert.match(progress, new RegExp(`\\| \`src/\\*\\*/\\*\\.ts\` 文件 \\| ${srcModules} \\|`));
    assert.match(progress, new RegExp(`\\| 测试文件 \\| ${testFiles} \\|`));
    assert.match(progress, new RegExp(`\\| package exports \\| ${exportCount} \\|`));
    assert.match(gap, new RegExp(`package\\.json\` 已有 ${exportCount} 个 package exports、${binCount} 个 bin`));
    assert.match(gap, new RegExp(`\`src/\\*\\*/\\*\\.ts\` ${srcModules} 个`));
  });
});
