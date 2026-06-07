import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const inventory = JSON.parse(readFileSync(resolve(YOLO_DIR, "docs/root-entrypoint-inventory.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(resolve(YOLO_DIR, "package.json"), "utf8"));

const ALLOWED_ROLES = new Set([
  "compat_cli",
  "dev_tool",
  "legacy_tool",
  "public_export",
  "runner_entry",
  "runtime_adapter_tool",
  "runtime_gate_tool",
  "runtime_state_tool",
  "runtime_support_module",
  "runtime_support_tool",
  "runtime_ui_tool",
]);

const ALLOWED_STATUSES = new Set([
  "keep_root",
  "shim_to_src",
  "migrate_to_src",
  "legacy_pending",
]);

function rootTsFiles() {
  return readdirSync(YOLO_DIR)
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !file.endsWith(".config.ts"))
    .sort();
}

function rootExportFiles() {
  return Object.values(packageJson.exports || {})
    .filter((target) => typeof target === "string" && target.startsWith("./dist/") && !target.startsWith("./dist/src/"))
    .map((target) => target.replace(/^\.\//, ""))
    .filter((target) => target.endsWith(".js"))
    .map((target) => target.replace(/^dist\//, "").replace(/\.js$/, ".ts"))
    .sort();
}

function packageScriptRootTsFiles() {
  return Object.values(packageJson.scripts || {})
    .map((script) => String(script).match(/^tsx \.\/([^ ]+\.ts)(?:\s|$)/)?.[1])
    .filter(Boolean)
    .sort();
}

describe("root entrypoint inventory", () => {
  test("every root .ts file is classified exactly once", () => {
    const inventoryFiles = inventory.entries.map((entry) => entry.file).sort();
    assert.deepEqual(inventoryFiles, rootTsFiles());
    assert.equal(new Set(inventoryFiles).size, inventoryFiles.length);
  });

  test("inventory entries use approved role and status values", () => {
    assert.equal(inventory.schema_version, 1);
    assert.equal(inventory.policy.new_root_ts_allowed, false);
    for (const entry of inventory.entries) {
      assert.ok(ALLOWED_ROLES.has(entry.role), `${entry.file} has unknown role ${entry.role}`);
      assert.ok(ALLOWED_STATUSES.has(entry.status), `${entry.file} has unknown status ${entry.status}`);
      assert.equal(typeof entry.reason, "string", `${entry.file} missing reason`);
      assert.ok(entry.reason.length >= 20, `${entry.file} reason is too thin`);
      assert.equal(typeof entry.target, "string", `${entry.file} missing target`);
      if (entry.status !== "keep_root") {
        assert.match(entry.target, /^(src|bin)\//, `${entry.file} target must point outside root`);
      }
    }
  });

  test("root package exports are marked public_export", () => {
    const byFile = new Map(inventory.entries.map((entry) => [entry.file, entry]));
    for (const file of rootExportFiles()) {
      const entry = byFile.get(file);
      assert.ok(entry, `${file} missing inventory entry`);
      assert.equal(entry.public_export, true, `${file} must be marked public_export`);
    }
  });

  test("package scripts that run root .ts files are marked package_script", () => {
    const byFile = new Map(inventory.entries.map((entry) => [entry.file, entry]));
    for (const file of packageScriptRootTsFiles()) {
      const entry = byFile.get(file);
      assert.ok(entry, `${file} missing inventory entry`);
      assert.equal(entry.package_script, true, `${file} must be marked package_script`);
    }
  });

  test("only sdk.ts is allowed to stay as a root implementation", () => {
    const keepRoot = inventory.entries.filter((entry) => entry.status === "keep_root").map((entry) => entry.file);
    assert.deepEqual(keepRoot, ["sdk.ts"]);
  });

  test("shim_to_src entries point at existing src or bin targets", () => {
    for (const entry of inventory.entries.filter((item) => item.status === "shim_to_src")) {
      assert.equal(existsSync(resolve(YOLO_DIR, entry.target)), true, `${entry.file} shim target is missing: ${entry.target}`);
    }
  });

  test("root shell launchers point at current yolo CLI instead of stale .mjs targets", () => {
    const start = readFileSync(resolve(YOLO_DIR, "start.sh"), "utf8");
    const startHere = readFileSync(resolve(YOLO_DIR, "START_HERE.command"), "utf8");

    assert.doesNotMatch(start, /runner\.mjs|server\.mjs/);
    assert.doesNotMatch(startHere, /runner\.mjs|server\.mjs|yolo-wizard/);
    assert.match(start, /dist\/bin\/yolo\.js/);
    assert.match(startHere, /dist\/bin\/yolo\.js/);
    assert.match(startHere, /status \| demand \| spec \| tasks \| run \| check \| review \| release/);
  });
});
