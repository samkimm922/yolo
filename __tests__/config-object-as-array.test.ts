import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/lib/config.js";

describe("config deepMerge — object overrides array default", () => {
  test("nested mapping for array-typed field does not silently replace the array", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-config-obj-as-array-"));
    const configPath = join(root, "config.yaml");
    // Adversarial: project.source_roots defaults to an array, but the
    // user wrote a nested mapping. The YAML parser happily produces an
    // object, and deepMerge used to silently accept it, replacing the
    // array. Downstream consumers like scanner.ts then crashed with
    // `sourceRoots.some is not a function` or `new Set(...)` threw
    // because plain objects are not iterable.
    writeFileSync(
      configPath,
      ["project:", "  source_roots:", "    foo: bar", "    baz: qux"].join("\n") + "\n",
    );

    const warnings: string[] = [];
    const originalWarn = console.warn;
    try {
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
      const cfg = loadConfig({ path: configPath, forceReload: true });
      const value = cfg?.project?.source_roots;
      // Must remain an array — either the default or any previously-merged
      // array. A plain object is unacceptable because it crashes consumers.
      assert.equal(
        Array.isArray(value),
        true,
        `source_roots must stay an array, got: ${JSON.stringify(value)}`,
      );
      // The original default array must be preserved (not an empty array),
      // so config load stays recoverable.
      assert.ok(
        value.length > 0,
        `source_roots must keep default contents, got: ${JSON.stringify(value)}`,
      );
      assert.match(
        warnings.join("\n"),
        /类型不匹配.*source_roots|source_roots.*类型不匹配/,
        "deepMerge should warn about the array/object mismatch",
      );
      // Critical regression assertion: the downstream pattern that used to
      // crash must now execute without throwing.
      assert.doesNotThrow(() => {
        value.some((r: string) => r === "src");
        new Set(value);
      });
    } finally {
      console.warn = originalWarn;
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("object override of project.exclude keeps default array iterable", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-config-exclude-obj-"));
    const configPath = join(root, "config.yaml");
    writeFileSync(
      configPath,
      ["project:", "  exclude:", "    x: 1"].join("\n") + "\n",
    );

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const cfg = loadConfig({ path: configPath, forceReload: true });
      const value = cfg?.project?.exclude;
      assert.equal(Array.isArray(value), true, "exclude must stay an array");
      // `new Set(non-iterable)` is the second crash site in scanner.ts.
      assert.doesNotThrow(() => new Set(value));
    } finally {
      console.warn = originalWarn;
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("legitimate array override still replaces the default array", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-config-arr-override-"));
    const configPath = join(root, "config.yaml");
    writeFileSync(
      configPath,
      ["project:", '  source_roots: ["app", "lib"]'].join("\n") + "\n",
    );

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const cfg = loadConfig({ path: configPath, forceReload: true });
      assert.deepEqual(cfg?.project?.source_roots, ["app", "lib"]);
    } finally {
      console.warn = originalWarn;
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
