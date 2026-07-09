import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isPureConfigTarget,
  shouldInspectAtomicity,
} from "../src/runtime/gates/readiness-policy.js";

describe("readiness project file policy", () => {
  test("pure config detection is conservative without declared project config patterns", () => {
    assert.equal(isPureConfigTarget("package.json"), false);
    assert.equal(isPureConfigTarget("tsconfig.json"), false);
  });

  test("pure config detection uses declared non-JS config_file_patterns", () => {
    const config = {
      project: {
        language: "rust",
        business_file_patterns: ["src/**/*.rs", "tests/**/*.rs"],
        config_file_patterns: ["Cargo.toml", ".cargo/**/*.toml"],
      },
    };

    assert.equal(isPureConfigTarget("Cargo.toml", { config }), true);
    assert.equal(isPureConfigTarget(".cargo/config.toml", { config }), true);
    assert.equal(isPureConfigTarget("package.json", { config }), false);
  });

  test("atomicity pure-config exemption uses project-declared config_file_patterns", () => {
    const task = {
      status: "pending",
      type: "cleanup",
      scope: { targets: [{ file: "pyproject.toml" }] },
    };
    const config = {
      project: {
        language: "python",
        business_file_patterns: ["src/**/*.py"],
        config_file_patterns: ["pyproject.toml"],
      },
    };

    assert.equal(shouldInspectAtomicity(task, "check", { config }), false);
    assert.equal(shouldInspectAtomicity(task, "check"), true);
  });
});
