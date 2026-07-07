import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scanProject } from "../src/review/scanner.js";

function scanSource(source: string, file = "src/app.ts") {
  const root = mkdtempSync(join(tmpdir(), "yolo-review-while-cursor-"));
  try {
    const absFile = join(root, file);
    mkdirSync(dirname(absFile), { recursive: true });
    writeFileSync(absFile, source, "utf8");
    return scanProject({
      root,
      files: [file],
      includeExternalChecks: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("review scanner while-no-cursor", () => {
  test("does not report the dogfood final 3 git weekly CLI fixture", () => {
    const fixture = readFileSync(
      resolve(import.meta.dirname, "fixtures/dogfood-final-3-cli-git-weekly.ts"),
      "utf8",
    );

    const result = scanSource(fixture, "src/cli-git-weekly.ts");

    assert.equal(result.total_findings, 0);
    assert.deepEqual(result.findings, []);
  });

  test("accepts cursor advancement on while condition variables", () => {
    const result = scanSource(`
      export function ok(lines: string[], queue: string[], iter: Iterator<string>, step: number) {
        let i = 0;
        while (i < lines.length) { i++; }
        while (i < lines.length) { ++i; }
        while (i < lines.length) { i = i + step; }
        while (i < lines.length) { i += computeStep(step); }
        while (i < lines.length) { i -= -step; }
        while (queue.length > 0) { queue.shift(); }
        while (queue.length > 0) { queue.pop(); }
        while (queue.length > 0) { queue.splice(0, step); }
        while (!iter.next().done) { i += 1; }
      }
      function computeStep(value: number) { return Math.max(1, value); }
    `);

    assert.equal(result.findings.some((finding) => finding.scanner_id === "while-no-cursor"), false);
  });

  test("still reports a real loop whose condition variable never changes", () => {
    const result = scanSource(`
      export function stuck() {
        let x = 0;
        let y = 0;
        while (x < 10) {
          y++;
        }
        return y;
      }
    `);

    const whileFindings = result.findings.filter((finding) => finding.scanner_id === "while-no-cursor");
    assert.equal(whileFindings.length, 1);
    assert.equal(whileFindings[0].line, 5);
  });
});
