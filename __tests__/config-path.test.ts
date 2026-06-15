import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../src/lib/config.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const EXPECTED_CONFIG = resolve(YOLO_DIR, "config.yaml");

describe("CONFIG_PATH resolution", () => {
  test("source mode (tsx) resolves CONFIG_PATH to repo root config.yaml", () => {
    const stdout = execSync(
      `node --import tsx -e "import { CONFIG_PATH } from './src/lib/config.ts'; console.log(CONFIG_PATH)"`,
      { cwd: YOLO_DIR, encoding: "utf8" },
    );
    const configPath = stdout.trim();
    assert.equal(configPath, EXPECTED_CONFIG);
    assert.equal(existsSync(configPath), true);
  });

  test("dist mode resolves CONFIG_PATH to repo root config.yaml", () => {
    const stdout = execSync(
      `node -e "import('./dist/src/lib/config.js').then(m => console.log(m.CONFIG_PATH))"`,
      { cwd: YOLO_DIR, encoding: "utf8" },
    );
    const configPath = stdout.trim();
    assert.equal(configPath, EXPECTED_CONFIG);
    assert.equal(existsSync(configPath), true);
  });

  test("loadConfig parses JSON config files with JSON.parse", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-config-json-"));
    const configPath = join(root, "config.json");
    try {
      writeFileSync(configPath, JSON.stringify({
        version: "2.0",
        project: { name: "JsonProject" },
        build: { type_check: "echo json-typecheck", lint: "echo json-lint" },
      }, null, 2), "utf8");

      const cfg = loadConfig({ path: configPath, forceReload: true });

      assert.equal(cfg.project.name, "JsonProject");
      assert.equal(cfg.build.type_check, "echo json-typecheck");
      assert.equal(cfg.build.lint, "echo json-lint");
    } finally {
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadConfig default claude permission mode allows autonomous edits", () => {
    const cfg = loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });

    assert.equal(cfg.ai.claude_permission_mode, "acceptEdits");
    assert.notEqual(cfg.ai.claude_permission_mode, "default");
  });

  test("loadConfig keeps YAML config parsing behavior", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-config-yaml-"));
    const configPath = join(root, "config.yaml");
    try {
      writeFileSync(configPath, [
        'version: "2.0"',
        "project:",
        '  name: "YamlProject"',
        "build:",
        '  type_check: "echo yaml-typecheck"',
        '  lint: "echo yaml-lint"',
        "",
      ].join("\n"), "utf8");

      const cfg = loadConfig({ path: configPath, forceReload: true });

      assert.equal(cfg.project.name, "YamlProject");
      assert.equal(cfg.build.type_check, "echo yaml-typecheck");
      assert.equal(cfg.build.lint, "echo yaml-lint");
    } finally {
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadConfig warns when an existing config cannot be parsed", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-config-bad-"));
    const configPath = join(root, "config.json");
    const warnings = [];
    const originalWarn = console.warn;
    try {
      writeFileSync(configPath, "{ invalid json", "utf8");
      console.warn = (...args) => warnings.push(args.join(" "));

      const cfg = loadConfig({ path: configPath, forceReload: true });

      assert.equal(cfg.build.type_check, "npx tsc --noEmit");
      assert.match(warnings.join("\n"), /配置解析失败\/为空/);
      assert.match(warnings.join("\n"), /回退默认/);
    } finally {
      console.warn = originalWarn;
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadConfig warns when an existing config is structurally empty", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-config-empty-"));
    const configPath = join(root, "config.json");
    const warnings = [];
    const originalWarn = console.warn;
    try {
      writeFileSync(configPath, "{}\n", "utf8");
      console.warn = (...args) => warnings.push(args.join(" "));

      loadConfig({ path: configPath, forceReload: true });

      assert.match(warnings.join("\n"), /配置为空/);
      assert.match(warnings.join("\n"), /可能导致命令不可用/);
    } finally {
      console.warn = originalWarn;
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loadConfig keeps the existing missing-file warning", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-config-missing-"));
    const configPath = join(root, "missing.yaml");
    const warnings = [];
    const originalWarn = console.warn;
    try {
      console.warn = (...args) => warnings.push(args.join(" "));

      loadConfig({ path: configPath, forceReload: true });

      assert.match(warnings.join("\n"), /不存在，使用默认配置/);
    } finally {
      console.warn = originalWarn;
      loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
