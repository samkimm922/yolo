import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildYoloCommandRegistry,
  getYoloCommand,
  listYoloBridgeWorkflowIds,
  listYoloCommandNames,
  listYoloCommands,
  renderYoloCommandUsage,
} from "../src/workflows/command-registry.js";

describe("YOLO command registry", () => {
  test("lists the full lifecycle command set from one source of truth", () => {
    assert.deepEqual(listYoloCommandNames(), [
      "yolo",
      "yolo-brainstorm",
      "yolo-discover",
      "yolo-discuss",
      "yolo-init",
      "yolo-plan",
      "yolo-prd",
      "yolo-check",
      "yolo-run",
      "yolo-review",
      "yolo-fix",
      "yolo-accept",
      "yolo-ui-review",
      "yolo-eval",
      "yolo-ship",
      "yolo-learn",
      "yolo-doctor",
      "yolo-install",
    ]);
  });

  test("classifies no-code and code-writing commands", () => {
    assert.deepEqual(listYoloCommands({ writesCode: true }).map((command) => command.name), [
      "yolo-run",
      "yolo-fix",
    ]);
    assert.equal(listYoloCommands({ noCode: true }).some((command) => command.name === "yolo-doctor"), true);
    assert.equal(getYoloCommand("/yolo-prd").lifecycle_stage, "prd");
    assert.throws(() => getYoloCommand("wat"), /Unknown YOLO command/);
  });

  test("registry includes bridge workflows and command usage examples", () => {
    const registry = buildYoloCommandRegistry();

    assert.equal(registry.schema, "yolo.workflow.command_registry.v1");
    assert.deepEqual(listYoloBridgeWorkflowIds(), [
      "brainstorm",
      "discover",
      "discuss",
      "plan",
      "prd",
      "check",
      "pi",
      "review",
      "fix",
      "accept",
      "eval",
      "ship",
      "learn",
      "doctor",
    ]);
    assert.match(renderYoloCommandUsage("yolo-doctor"), /\/yolo-doctor/);
  });
});
