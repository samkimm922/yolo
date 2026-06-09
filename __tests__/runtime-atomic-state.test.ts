import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
});
