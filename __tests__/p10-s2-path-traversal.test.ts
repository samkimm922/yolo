// P10.S2 adversarial tests — path traversal containment
// Asserts that externally-controlled paths (file_exists, evidence_path, taskId)
// cannot escape the project/state root via ../, absolute paths, or / injection.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isWithin, isSafePathComponent } from "../src/lib/security/path-guard.js";

// ── path-guard unit tests ──────────────────────────────────────

describe("P10.S2 path-guard", () => {
  test("isWithin: relative path inside root", () => {
    assert.equal(isWithin("/project/src/file.ts", "/project"), true);
  });

  test("isWithin: ../../ escape rejected", () => {
    assert.equal(isWithin("/project/../../../etc/hosts", "/project"), false);
  });

  test("isWithin: absolute path outside root rejected", () => {
    assert.equal(isWithin("/etc/hosts", "/project"), false);
  });

  test("isWithin: root itself is within", () => {
    assert.equal(isWithin("/project", "/project"), true);
  });

  test("isSafePathComponent: rejects /", () => {
    assert.equal(isSafePathComponent("../escape"), false);
  });

  test("isSafePathComponent: rejects absolute", () => {
    assert.equal(isSafePathComponent("/etc/hosts"), false);
  });

  test("isSafePathComponent: rejects backslash", () => {
    assert.equal(isSafePathComponent("foo\\bar"), false);
  });

  test("isSafePathComponent: accepts normal id", () => {
    assert.equal(isSafePathComponent("TASK-001"), true);
  });
});

// ── file-check path traversal ──────────────────────────────────

describe("P10.S2 file-check path traversal", () => {
  let mod: any;
  let tmpRoot: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "yolo-p10-s2-filecheck-"));
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    writeFileSync(join(tmpRoot, "src", "real.ts"), "export const x = 1;\n", "utf8");
  });

  after(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  test.before(async () => {
    mod = await import("../src/lib/evaluators/file-check.js");
  });

  test("happy path: file_exists inside root passes", () => {
    const r = mod.evalFileExists({ file: "src/real.ts" }, {}, tmpRoot);
    assert.equal(r.passed, true);
  });

  test("rejects ../../etc/hosts traversal", () => {
    const r = mod.evalFileExists({ file: "../../../etc/hosts" }, {}, tmpRoot);
    assert.equal(r.passed, false);
    assert.ok(r.detail.includes("越界") || r.detail.includes("escape"));
  });

  test("rejects absolute path outside root", () => {
    const r = mod.evalFileExists({ file: "/etc/hosts" }, {}, tmpRoot);
    assert.equal(r.passed, false);
    assert.ok(r.detail.includes("越界") || r.detail.includes("escape"));
  });

  test("dir_exists rejects traversal", () => {
    const r = mod.evalDirExists({ path: "../../../etc" }, {}, tmpRoot);
    assert.equal(r.passed, false);
  });
});

// ── code-check path traversal ──────────────────────────────────

describe("P10.S2 code-check path traversal", () => {
  let mod: any;
  let tmpRoot: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "yolo-p10-s2-codecheck-"));
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    writeFileSync(join(tmpRoot, "src", "real.ts"), "const x = 1;\n", "utf8");
  });

  after(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  test.before(async () => {
    mod = await import("../src/lib/evaluators/code-check.js");
  });

  test("happy path: code_contains on in-root file", () => {
    const r = mod.evalCodeContains({ file: "src/real.ts", text: "const x" }, {}, tmpRoot);
    assert.equal(r.passed, true);
  });

  test("rejects traversal path (returns not found, no read)", () => {
    const r = mod.evalCodeContains({ file: "../../../etc/hosts", text: "localhost" }, {}, tmpRoot);
    assert.equal(r.passed, false);
  });
});

// ── task-logger taskId sanitization ────────────────────────────

describe("P10.S2 task-logger taskId sanitization", () => {
  let mod: any;
  let tmpRoot: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "yolo-p10-s2-tasklog-"));
  });

  after(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  test.before(async () => {
    mod = await import("../src/runtime/logging/task-logger.js");
    mod.setTaskLogsDir(tmpRoot);
  });

  test("happy path: normal taskId writes log", () => {
    mod.writeTaskLog("TASK-001", { type: "TEST" });
    assert.ok(existsSync(join(tmpRoot, "TASK-001.jsonl")));
  });

  test("rejects taskId with ../", () => {
    mod.writeTaskLog("../escape", { type: "BAD" });
    assert.ok(!existsSync(join(tmpRoot, "escape.jsonl")));
    // Ensure no file was created outside tmpRoot
    assert.ok(!existsSync(join(tmpRoot, "..", "escape.jsonl")) ||
      !existsSync(join(resolve(tmpRoot, ".."), "escape.jsonl")));
  });

  test("rejects taskId with /", () => {
    mod.writeTaskLog("foo/bar", { type: "BAD" });
    assert.ok(!existsSync(join(tmpRoot, "foo", "bar.jsonl")));
  });
});

// ── evidence writers taskId sanitization ───────────────────────

describe("P10.S2 evidence writers taskId sanitization", () => {
  let mod: any;
  let tmpRoot: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "yolo-p10-s2-writers-"));
  });

  after(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  test.before(async () => {
    mod = await import("../src/runtime/evidence/writers.js");
  });

  test("happy path: normal taskId creates evidence dir", () => {
    const dir = mod.taskEvidenceDir("TASK-001", { yoloRoot: tmpRoot });
    assert.ok(dir.includes("TASK-001"));
  });

  test("rejects taskId with ../ (throws)", () => {
    assert.throws(() => {
      mod.taskEvidenceDir("../escape", { yoloRoot: tmpRoot });
    }, /unsafe taskId/);
  });

  test("rejects taskId with / (throws)", () => {
    assert.throws(() => {
      mod.taskEvidenceDir("foo/bar", { yoloRoot: tmpRoot });
    }, /unsafe taskId/);
  });
});
