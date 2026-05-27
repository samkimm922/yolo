import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildMemoryAudit,
  refreshMemoryCenter,
} from "../src/runtime/memory/center.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const FIXED_NOW = new Date("2026-05-25T00:00:00.000Z");

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-memory-center-"));
}

function write(file, content) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, content, "utf8");
}

describe("memory center", () => {
  test("audits memory-related markdown and jsonl without deleting files", () => {
    const root = tempProject();
    try {
      write(join(root, "package.json"), JSON.stringify({
        name: "demo",
        version: "0.0.0",
        type: "module",
      }), "utf8");
      write(join(root, "PROJECT_TREE.md"), "# old\n\ngenerate-tree.js\n");
      write(join(root, "state/changes.jsonl"), "{\"status\":\"IN_PROGRESS\",\"ts\":\"2026-05-25T00:00:00.000Z\"}\n");
      write(join(root, ".yolo/state/events.jsonl"), "{\"event\":\"demo\",\"ts\":\"2026-05-25T00:00:00.000Z\"}\n");
      write(join(root, "state/archive/PROJECT_TREE_2026-05-08_16-44.md"), "# archive\n");
      write(join(root, "closed-loop/knowledge-base.jsonl"), "{\"note\":\"legacy\"}\n");
      write(join(root, "tmp/review-root-cause-analysis.md"), "# scratch\n");

      const audit = buildMemoryAudit({ projectRoot: root, stateRoot: root });

      assert.equal(audit.summary.deletion_candidate_count, 1);
      assert.equal(audit.summary.stale_mirror_count, 1);
      assert.ok(audit.documents.some((doc) => doc.path === "state/changes.jsonl" && doc.action === "keep_active"));
      assert.ok(audit.documents.some((doc) => doc.path === ".yolo/state/events.jsonl" && doc.action === "keep_active"));
      assert.ok(audit.documents.some((doc) => doc.path === "closed-loop/knowledge-base.jsonl" && doc.action === "keep_legacy_readonly"));
      assert.ok(audit.documents.some((doc) => doc.path === "state/archive/PROJECT_TREE_2026-05-08_16-44.md" && doc.action === "keep_archive_only"));
      assert.ok(existsSync(join(root, "tmp/review-root-cause-analysis.md")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refreshes canonical docs and compatibility mirrors", () => {
    const root = tempProject();
    try {
      write(join(root, "package.json"), JSON.stringify({
        name: "yolo",
        version: "0.1.0",
        private: true,
        type: "module",
        exports: { ".": "./sdk.js" },
        bin: { yolo: "./bin/yolo.js" },
      }), "utf8");
      write(join(root, "src/runtime/runner-core.ts"), "export function run() {}\n");
      write(join(root, "__tests__/sample.test.ts"), "import { test } from 'node:test';\n");
      write(join(root, "state/changes.jsonl"), "{\"status\":\"COMPLETED\",\"ts\":\"2026-05-25T00:00:00.000Z\"}\n");

      const result = refreshMemoryCenter({
        projectRoot: root,
        stateRoot: root,
        memoryDir: join(root, "docs/memory"),
        writeLegacyPointers: true,
        now: FIXED_NOW,
      });

      assert.equal(result.status, "ok");
      assert.equal(existsSync(join(root, "docs/memory/MEMORY_INDEX.md")), true);
      assert.equal(existsSync(join(root, "docs/memory/DOCUMENT_GOVERNANCE.md")), true);
      assert.equal(existsSync(join(root, "docs/memory/LEARNING_INDEX.md")), true);
      assert.equal(existsSync(join(root, "docs/memory/LESSONS_PLAYBOOK.md")), true);
      assert.match(readFileSync(join(root, "docs/memory/PROJECT_TREE.md"), "utf8"), /src\/runtime\/runner-core\.ts/);
      assert.match(readFileSync(join(root, "docs/memory/LEARNING_INDEX.md"), "utf8"), /Records: 0/);
      assert.match(readFileSync(join(root, "docs/memory/DOCUMENT_GOVERNANCE.md"), "utf8"), /one canonical home/);
      assert.match(readFileSync(join(root, "PROJECT_TREE.md"), "utf8"), /Canonical memory dir: `docs\/memory`/);
      assert.match(readFileSync(join(root, "SYSTEM_STATE.md"), "utf8"), /Public package state: `private: true` blocks release/);
      assert.match(readFileSync(join(root, "ROADMAP.md"), "utf8"), /docs\/yolo-public-sdk-progress\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("archives overflowing ledgers and prunes generated doc snapshots", () => {
    const root = tempProject();
    try {
      write(join(root, "package.json"), JSON.stringify({
        name: "yolo",
        version: "0.1.0",
        private: true,
        type: "module",
      }), "utf8");
      write(join(root, "src/runtime/runner-core.ts"), "export function run() {}\n");
      write(join(root, "state/events.jsonl"), [
        "{\"event\":\"one\",\"ts\":\"2026-05-25T00:00:01.000Z\"}",
        "{\"event\":\"two\",\"ts\":\"2026-05-25T00:00:02.000Z\"}",
        "{\"event\":\"three\",\"ts\":\"2026-05-25T00:00:03.000Z\"}",
        "{\"event\":\"four\",\"ts\":\"2026-05-25T00:00:04.000Z\"}",
        "",
      ].join("\n"));
      write(join(root, "state/archive/PROJECT_TREE_2026-05-08_16-44.md"), "# stale generated snapshot\n");

      const result = refreshMemoryCenter({
        projectRoot: root,
        stateRoot: root,
        memoryDir: join(root, "docs/memory"),
        maxEvents: 2,
        now: FIXED_NOW,
      });

      assert.equal(result.retention.archived_record_count, 2);
      assert.equal(result.retention.pruned_generated_archives.deleted_count, 1);
      assert.equal(existsSync(join(root, "state/archive/PROJECT_TREE_2026-05-08_16-44.md")), false);
      assert.match(readFileSync(join(root, "state/events.jsonl"), "utf8"), /three/);
      assert.doesNotMatch(readFileSync(join(root, "state/events.jsonl"), "utf8"), /one/);
      const archiveMonthDir = join(root, "state/archive/jsonl/2026-05");
      const archiveFiles = readdirSync(archiveMonthDir).filter((file) => file.startsWith("events.") && file.endsWith(".jsonl"));
      assert.equal(archiveFiles.length, 1);
      assert.match(readFileSync(join(archiveMonthDir, archiveFiles[0]), "utf8"), /one/);
      assert.match(readFileSync(join(root, "docs/memory/CURRENT_STATUS.md"), "utf8"), /Archived ledger files: 1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hooks point at relocated memory and change log implementations", () => {
    const preToolLog = readFileSync(join(YOLO_DIR, "hooks/pre-tool-log.ts"), "utf8");
    const preToolTaskLog = readFileSync(join(YOLO_DIR, "hooks/pre-tool-task-log.ts"), "utf8");
    const stopHook = readFileSync(join(YOLO_DIR, "hooks/stop-update-docs.ts"), "utf8");

    assert.match(preToolLog, /src\/runtime\/evidence\/log-change\.js/);
    assert.match(preToolLog, /src\/runtime\/devtools\/memory-center\.js/);
    assert.match(preToolTaskLog, /src\/runtime\/evidence\/log-change\.js/);
    assert.match(stopHook, /src\/runtime\/devtools\/memory-center\.js/);
    assert.doesNotMatch(preToolLog, /\.\.', 'log-change\.js'/);
    assert.doesNotMatch(stopHook, /generate-tree\.js'\)/);
  });

  test("log-change writes under the caller supplied state root", () => {
    const root = tempProject();
    try {
      execFileSync(process.execPath, [
        join(YOLO_DIR, "dist/src/runtime/evidence/log-change.js"),
        "auto",
        "--file=/tmp/example.js",
        "--tool=Write",
        `--state-root=${root}`,
      ], { cwd: YOLO_DIR, encoding: "utf8" });

      const lines = readFileSync(join(root, "state/changes.jsonl"), "utf8").trim().split("\n");
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.status, "AUTO_LOGGED");
      assert.equal(entry.file, "/tmp/example.js");
      assert.equal(existsSync(join(YOLO_DIR, "src/runtime/evidence/state/changes.jsonl")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
