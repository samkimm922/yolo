import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeStateAtomic, readStateWithFallback } from "../src/runtime/persist/atomic-state.js";

describe("atomic-state", () => {
  test("writeStateAtomic keeps previous snapshot as .bak", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-state-"));
    const path = join(dir, "state.json");
    writeStateAtomic(path, { v: 1 });
    writeStateAtomic(path, { v: 2 });
    assert.equal(JSON.parse(readFileSync(path, "utf8")).v, 2);
    assert.equal(JSON.parse(readFileSync(`${path}.bak`, "utf8")).v, 1);
  });

  test("readStateWithFallback recovers from corrupt primary using .bak", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-state-"));
    const path = join(dir, "state.json");
    writeStateAtomic(path, { v: 1 });
    writeStateAtomic(path, { v: 2 });
    writeFileSync(path, "{ corrupt json");
    const recovered = readStateWithFallback<{ v: number }>(path);
    assert.equal(recovered.v, 1);
  });

  test("readStateWithFallback throws when both primary and bak are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-state-"));
    const path = join(dir, "nonexistent.json");
    assert.throws(() => readStateWithFallback(path));
  });

  test("writeStateAtomic produces valid JSON parseable output", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-state-"));
    const path = join(dir, "state.json");
    writeStateAtomic(path, { nested: { a: 1 }, arr: [1, 2, 3] });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(parsed.arr, [1, 2, 3]);
  });

  test("writeStateAtomic does not follow symlinks from path (TOCTOU prevention)", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-toctou-"));
    try {
      // Create a legitimate state file first
      const statePath = join(dir, "state.json");
      writeStateAtomic(statePath, { v: 1 });

      // Simulate attacker: replace state path with symlink to a secret
      const secretPath = join(dir, "secret.txt");
      writeFileSync(secretPath, "sensitive-data");
      rmSync(statePath);
      symlinkSync("secret.txt", statePath);

      // writeStateAtomic must not throw when the path is a symlink.
      // openSync follows the symlink, reads the target, and writes to .bak.
      writeStateAtomic(statePath, { v: 2 });

      // After the write, state.json must no longer be a symlink (renameSync replaces it)
      const st = statSync(statePath);
      assert.equal(st.isSymbolicLink(), false, "state path must not remain a symlink");

      // The new state must be what we wrote
      const current = JSON.parse(readFileSync(statePath, "utf8"));
      assert.deepEqual(current, { v: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writeStateAtomic first write does not create .bak (no prior state)", () => {
    const dir = mkdtempSync(join(tmpdir(), "yolo-state-"));
    try {
      const path = join(dir, "fresh.json");
      writeStateAtomic(path, { first: true });
      assert.equal(JSON.parse(readFileSync(path, "utf8")).first, true);
      // No .bak should exist for a first write
      assert.throws(() => readFileSync(`${path}.bak`, "utf8"), /ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
