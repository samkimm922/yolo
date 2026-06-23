// Quality-score config battery: malformed-but-parseable config files must keep
// object-typed defaults intact instead of poisoning runtime config.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../../src/lib/config.js";

export type ConfigBatteryExpectation = "fallback_defaults";

export type ConfigBatteryCase = {
  id: string;
  category: "config_preflight_robustness";
  description: string;
  expect: ConfigBatteryExpectation;
  config: unknown;
};

type ConfigBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

export const CONFIG_BATTERY: ConfigBatteryCase[] = [
  {
    id: "bad-project-section-array",
    category: "config_preflight_robustness",
    description: "project: [] must preserve the default project object so runner imports do not crash.",
    expect: "fallback_defaults",
    config: { version: "2.0", project: [] },
  },
];

function runConfigCase(testCase: ConfigBatteryCase): ConfigBatteryResult {
  const root = mkdtempSync(join(tmpdir(), "yolo-quality-config-"));
  const configPath = join(root, "config.json");
  const originalWarn = console.warn;
  try {
    writeFileSync(configPath, JSON.stringify(testCase.config, null, 2), "utf8");
    console.warn = () => {};
    const cfg = loadConfig({ path: configPath, forceReload: true });
    const project = cfg?.project;
    const status = project && typeof project === "object" && !Array.isArray(project) && typeof project.root === "string"
      ? "fallback_defaults"
      : "corrupt_config";
    const correct = status === testCase.expect;
    return {
      id: testCase.id,
      category: testCase.category,
      expect: testCase.expect,
      actualExit: correct ? 0 : 1,
      actualStatus: status,
      correct,
    };
  } finally {
    console.warn = originalWarn;
    loadConfig({ path: DEFAULT_CONFIG_PATH, forceReload: true });
    rmSync(root, { recursive: true, force: true });
  }
}

export function runConfigBattery(): ConfigBatteryResult[] {
  return CONFIG_BATTERY.map(runConfigCase);
}
