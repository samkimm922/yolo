import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { listYoloCommands } from "../src/workflows/command-registry.js";

describe("compat command surface removed", () => {
  test("no compat commands remain after P1.11 surface collapse", () => {
    const commands = listYoloCommands({ compatibilityAliases: true });
    assert.equal(commands.length, 0, "all compat aliases deleted in P1.11");
  });
});
