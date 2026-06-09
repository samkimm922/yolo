import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { listYoloCommands } from "../src/workflows/command-registry.js";

describe("compat command deprecation_target", () => {
  test("every compat command must have a deprecation_target field", () => {
    const commands = listYoloCommands({ compatibilityAliases: true });
    const compat = commands.filter((c: any) => c.stability === "compat");
    assert.ok(compat.length > 0, "must have compat commands");
    const missing = compat.filter((c: any) => !c.deprecation_target);
    assert.equal(
      missing.length,
      0,
      `compat commands missing deprecation_target: ${missing.map((c: any) => c.name).join(", ")}`,
    );
  });

  test("deprecation_target must match the alias_for stable command name", () => {
    const commands = listYoloCommands({ compatibilityAliases: true });
    const compat = commands.filter((c: any) => c.stability === "compat");
    for (const cmd of compat) {
      if (cmd.alias_for && cmd.deprecation_target) {
        assert.equal(
          cmd.deprecation_target,
          cmd.alias_for,
          `${cmd.name}: deprecation_target should equal alias_for`,
        );
      }
    }
  });
});
