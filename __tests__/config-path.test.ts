import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
});
