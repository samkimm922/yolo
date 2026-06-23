import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const REVIEW_SCRIPT = resolve(YOLO_DIR, "dist/src/cli/review.js");
const REVIEW_LOG_DIR = resolve(YOLO_DIR, "dist/src/cli/logs");

function runReviewWithFakeClaude(fakeClaudeCode: string, args: string[] = []) {
  const tmpDir = mkdtempSync(join(tmpdir(), "yolo-review-exit-"));
  const fakeClaudePath = join(tmpDir, "claude");
  writeFileSync(fakeClaudePath, fakeClaudeCode, { mode: 0o755 });
  chmodSync(fakeClaudePath, 0o755);

  const result = spawnSync(process.execPath, [REVIEW_SCRIPT, ...args], {
    cwd: YOLO_DIR,
    encoding: "utf8",
    env: { ...process.env, PATH: `${tmpDir}:${process.env.PATH}` },
  });

  rmSync(tmpDir, { recursive: true, force: true });
  return result;
}

function latestReviewLog(round: number) {
  if (!existsSync(REVIEW_LOG_DIR)) return null;
  const prefix = `review-round${round}-`;
  const files = readdirSync(REVIEW_LOG_DIR)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".json"))
    .sort()
    .reverse();
  return files.length > 0 ? join(REVIEW_LOG_DIR, files[0]) : null;
}

describe("review CLI exit code propagation", () => {
  test("exits non-zero when inner claude exits with code 1", () => {
    const fake = `#!/usr/bin/env node\nprocess.stderr.write("claude failed\\n");\nprocess.exit(1);\n`;
    const result = runReviewWithFakeClaude(fake, ["--round=1"]);
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
  });

  test("exits non-zero when inner claude is killed by signal", () => {
    const fake = `#!/usr/bin/env node\nprocess.kill(process.pid, "SIGTERM");\n`;
    const result = runReviewWithFakeClaude(fake, ["--round=1"]);
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
  });

  test("exits zero when inner claude returns an empty JSON array", () => {
    const fake = `#!/usr/bin/env node\nprocess.stdout.write("[]");\nprocess.exit(0);\n`;
    const result = runReviewWithFakeClaude(fake, ["--round=1"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "[]");
  });

  test("exits non-zero when inner claude returns non-JSON garbage (P7.H5)", () => {
    const fake = `#!/usr/bin/env node\nprocess.stdout.write("not json");\nprocess.exit(0);\n`;
    const result = runReviewWithFakeClaude(fake, ["--round=1"]);
    assert.notEqual(result.status, 0, `expected non-zero exit, got ${result.status}`);
    assert.notEqual(result.stdout.trim(), "[]", "must not emit [] on unparseable output");
  });

  test("exits zero when inner claude returns valid findings array (P7.H5 happy)", () => {
    const fake = `#!/usr/bin/env node\nprocess.stdout.write('[{"id":"BUG-1","severity":"HIGH","file":"src/a.ts","line":1,"category":"runtime","description":"x","suggestion":"y"}]');\nprocess.exit(0);\n`;
    const result = runReviewWithFakeClaude(fake, ["--round=1"]);
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(Array.isArray(parsed), true);
    assert.equal(parsed.length, 1);
  });

  test("redacts provider secrets before review logs, stdout, and output file", () => {
    const round = 991;
    const secret = "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD";
    const outputRoot = mkdtempSync(join(tmpdir(), "yolo-review-redact-"));
    const outputPath = join(outputRoot, "bugs.json");
    try {
      const payload = JSON.stringify([{
        id: "BUG-R991-001",
        severity: "HIGH",
        file: "src/secrets.ts",
        line: 1,
        category: "security",
        description: `leaked ${secret}`,
        suggestion: `remove ${secret}`,
      }]);
      const fake = `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(payload)});\nprocess.exit(0);\n`;
      const result = runReviewWithFakeClaude(fake, [`--round=${round}`, `--output=${outputPath}`]);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes(secret), false, "stdout findings must not leak provider secrets");
      assert.equal(readFileSync(outputPath, "utf8").includes(secret), false, "--output findings must not leak provider secrets");

      const logFile = latestReviewLog(round);
      assert.ok(logFile, "review debug log should be written");
      const logContent = readFileSync(logFile, "utf8");
      assert.equal(logContent.includes(secret), false, "review debug log must not leak provider secrets");
      assert.match(logContent, /REDACTED:gh-token/);
      rmSync(logFile, { force: true });
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  });
});
