import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Spawn the BUILT hook (.js via node) instead of `npx tsx <.ts>`: npx + tsx
// cold-start ran 8–28s per case, near the timeout and flaky under load.
// `npm test` builds dist first; mirrors provider-adapter.test.ts R4 hook test.
const HOOK = join(process.cwd(), "dist", "hooks", "pre-tool-lifecycle-gate.js");

function writeStatus(root, stages) {
  const dir = join(root, ".yolo/lifecycle");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), JSON.stringify({
    schema_version: "1.0",
    schema: "yolo.lifecycle.state.v1",
    project: { name: "test" },
    current_stage: "check",
    stages,
  }), "utf8");
}

function runHook(root, payload) {
  const result = spawnSync("node", [HOOK], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(payload),
    timeout: 15000,
  });
  return { exitCode: result.status, stderr: result.stderr || "", stdout: result.stdout || "" };
}

function makeSourceTree(root) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/app.ts"), "export const x = 1;\n", "utf8");
}

function checkStages(status) {
  return [
    { id: "idea", sequence: 1, status: "completed", artifact: "idea.json", writes_code: false },
    { id: "discovery", sequence: 2, status: "completed", artifact: "discovery.json", writes_code: false },
    { id: "check", sequence: 6, status, artifact: "check-report.json", writes_code: false },
  ];
}

describe("pre-tool-lifecycle-gate hook", () => {
  test("blocks Write to source when check stage is blocked", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-gate-blocked-"));
    try {
      makeSourceTree(root);
      writeStatus(root, checkStages("blocked"));
      const result = runHook(root, {
        tool_name: "Write",
        tool_input: { file_path: join(root, "src/new.ts") },
      });
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /LIFECYCLE_WRITE_NOT_AUTHORIZED/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows Write to source when check stage is completed", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-gate-pass-"));
    try {
      makeSourceTree(root);
      writeStatus(root, checkStages("completed"));
      const result = runHook(root, {
        tool_name: "Write",
        tool_input: { file_path: join(root, "src/new.ts") },
      });
      assert.equal(result.exitCode, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows Write to source when check stage is warning (non-fatal)", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-gate-warning-"));
    try {
      makeSourceTree(root);
      writeStatus(root, checkStages("warning"));
      const result = runHook(root, {
        tool_name: "Write",
        tool_input: { file_path: join(root, "src/new.ts") },
      });
      assert.equal(result.exitCode, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fail-closed: blocks Write when status.json is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-gate-missing-"));
    try {
      makeSourceTree(root);
      // No status.json written.
      const result = runHook(root, {
        tool_name: "Write",
        tool_input: { file_path: join(root, "src/new.ts") },
      });
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /LIFECYCLE_WRITE_NOT_AUTHORIZED/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows Write to .claude/ (install self-deadlock prevention)", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-gate-claude-"));
    try {
      makeSourceTree(root);
      writeStatus(root, checkStages("blocked"));
      const result = runHook(root, {
        tool_name: "Write",
        tool_input: { file_path: join(root, ".claude/settings.json") },
      });
      assert.equal(result.exitCode, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows Write to .yolo/ (handled by the other hook)", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-gate-yolo-"));
    try {
      makeSourceTree(root);
      writeStatus(root, checkStages("blocked"));
      const result = runHook(root, {
        tool_name: "Write",
        tool_input: { file_path: join(root, ".yolo/lifecycle/status.json") },
      });
      assert.equal(result.exitCode, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks Edit to source when check is pending", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-gate-pending-"));
    try {
      makeSourceTree(root);
      writeStatus(root, checkStages("pending"));
      const result = runHook(root, {
        tool_name: "Edit",
        tool_input: { file_path: join(root, "src/app.ts") },
      });
      assert.equal(result.exitCode, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks Bash redirect to source when check is blocked", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-gate-bash-"));
    try {
      makeSourceTree(root);
      writeStatus(root, checkStages("blocked"));
      const result = runHook(root, {
        tool_name: "Bash",
        tool_input: { command: `echo "x" > ${join(root, "src/hack.ts")}` },
      });
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /LIFECYCLE_WRITE_NOT_AUTHORIZED/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows Bash yolo CLI call even when check is blocked", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-gate-bash-yolo-"));
    try {
      makeSourceTree(root);
      writeStatus(root, checkStages("blocked"));
      const result = runHook(root, {
        tool_name: "Bash",
        tool_input: { command: "yolo check" },
      });
      assert.equal(result.exitCode, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-write tools are allowed regardless of lifecycle state", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-gate-read-"));
    try {
      makeSourceTree(root);
      writeStatus(root, checkStages("blocked"));
      const result = runHook(root, {
        tool_name: "Read",
        tool_input: { file_path: join(root, "src/app.ts") },
      });
      assert.equal(result.exitCode, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("symlinked source path is still gated", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-gate-symlink-"));
    try {
      makeSourceTree(root);
      writeStatus(root, checkStages("blocked"));
      // Symlink inside src pointing to the real source file.
      const link = join(root, "src/link.ts");
      if (!existsSync(link)) symlinkSync(join(root, "src/app.ts"), link);
      const result = runHook(root, {
        tool_name: "Write",
        tool_input: { file_path: link },
      });
      assert.equal(result.exitCode, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
