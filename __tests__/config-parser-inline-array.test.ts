import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/lib/config.js";

describe("config parser — malformed inline array", () => {
  test("unclosed inline array does not silently become a string", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-config-bad-array-"));
    const configPath = join(root, "config.yaml");
    // Malformed: source_roots opens '[' but never closes ']'. Before the
    // guard this fell through to parseScalar and silently produced the
    // string "[src, test", which then crashed scanner.ts (.some() on a
    // string) when source_roots was consumed.
    writeFileSync(
      configPath,
      ["project:", "  source_roots: [src, test"].join("\n") + "\n",
    );

    const warnings: string[] = [];
    const originalWarn = console.warn;
    try {
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
      const cfg = loadConfig({ path: configPath, forceReload: true });
      const value = cfg?.project?.source_roots;
      // Must NOT be a string — either the default array is preserved or
      // the key is dropped entirely. Both are acceptable; a string is not.
      assert.equal(
        typeof value === "string",
        false,
        `source_roots must not be a string, got: ${JSON.stringify(value)}`,
      );
      assert.match(
        warnings.join("\n"),
        /格式错误的内联数组/,
        "parser should warn about the malformed inline array",
      );
    } finally {
      console.warn = originalWarn;
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("well-formed inline array still parses as an array", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-config-good-array-"));
    const configPath = join(root, "config.yaml");
    writeFileSync(
      configPath,
      ['project:', '  source_roots: ["src", "lib"]'].join("\n") + "\n",
    );

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const cfg = loadConfig({ path: configPath, forceReload: true });
      assert.deepEqual(cfg?.project?.source_roots, ["src", "lib"]);
    } finally {
      console.warn = originalWarn;
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
