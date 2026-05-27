import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalFileLinesMax, evalFilesModifiedMax } from "../lib/evaluators/file-check.js";
import { evalBusinessCodeMin } from "../lib/evaluators/runtime-check.js";

function fakeExec(outputs) {
  return (cmd) => ({ ok: true, out: outputs[cmd] || "" });
}

describe("files_modified_max scope filtering", () => {
  test("counts only explicit targets when task scope declares targets", () => {
    const result = evalFilesModifiedMax(
      { max: 1 },
      { targets: [{ file: "scripts/yolo/state/dry-run/p3/00-runbook.md" }] },
      "/repo",
      fakeExec({
        "git diff --name-only": [
          "src/a.ts",
          "src/b.ts",
          "scripts/yolo/state/dry-run/p3/00-runbook.md",
        ].join("\n"),
        "git ls-files --others --exclude-standard": "docs/out-of-band.md",
      }),
    );
    assert.equal(result.passed, true);
    assert.equal(result.found, 1);
  });
});

describe("file_lines_max target existence", () => {
  test("fails when an explicit target file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-file-lines-"));
    try {
      const result = evalFileLinesMax({ file: "src/missing.ts", max: 150 }, {}, root);
      assert.equal(result.passed, false);
      assert.match(result.detail, /文件不存在/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows a small bounded delta on legacy files already over the line limit", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-file-lines-"));
    try {
      mkdirSync(join(root, "src/runtime/progress"), { recursive: true });
      writeFileSync(join(root, "src/runtime/progress/server.js"), Array.from({ length: 156 }, (_, i) => `line${i}`).join("\n"), "utf8");
      writeFileSync(join(root, ".yolo-worktree-baseline.json"), JSON.stringify({
        line_counts: { "src/runtime/progress/server.js": 151 },
      }), "utf8");
      const result = evalFileLinesMax({ file: "src/runtime/progress/server.js", max: 150, legacy_delta_max: 10 }, {}, root);
      assert.equal(result.passed, true);
      assert.match(result.detail, /遗留超长文件未显著恶化/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails legacy files when the delta exceeds the bounded grace", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-file-lines-"));
    try {
      mkdirSync(join(root, "src/runtime/progress"), { recursive: true });
      writeFileSync(join(root, "src/runtime/progress/server.js"), Array.from({ length: 170 }, (_, i) => `line${i}`).join("\n"), "utf8");
      writeFileSync(join(root, ".yolo-worktree-baseline.json"), JSON.stringify({
        line_counts: { "src/runtime/progress/server.js": 151 },
      }), "utf8");
      const result = evalFileLinesMax({ file: "src/runtime/progress/server.js", max: 150, legacy_delta_max: 10 }, {}, root);
      assert.equal(result.passed, false);
      assert.match(result.detail, /限制 150 行/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("business_code_min scope classification", () => {
  test("counts src/runtime files as project code instead of PM/UI hardcoded noise", () => {
    const result = evalBusinessCodeMin(
      { min: 1 },
      {},
      "/repo",
      fakeExec({
        "git diff --name-only HEAD": "src/runtime/progress/server.js\n",
        "git ls-files --others --exclude-standard": "",
      }),
    );
    assert.equal(result.passed, true);
    assert.equal(result.found, 1);
  });

  test("uses filesystem worktree baseline hashes when git diff is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-business-code-"));
    try {
      mkdirSync(join(root, "src/runtime/progress"), { recursive: true });
      writeFileSync(join(root, "src/runtime/progress/server.js"), "export const changed = true;\n", "utf8");
      writeFileSync(join(root, ".yolo-worktree-baseline.json"), JSON.stringify({
        hashes: {
          "src/runtime/progress/server.js": "different-baseline-hash",
        },
      }), "utf8");
      const result = evalBusinessCodeMin(
        { min: 1 },
        { targets: [{ file: "src/runtime/progress/server.js" }] },
        root,
        fakeExec({
          "git diff --name-only HEAD": "",
          "git ls-files --others --exclude-standard": "",
        }),
      );
      assert.equal(result.passed, true);
      assert.equal(result.found, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
