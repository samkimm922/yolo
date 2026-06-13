import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectLifecycleGuard } from "../src/lifecycle/guard.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("WARNING_READY_STAGES must remain empty (fail-closed gate policy)", () => {
  test("warning-status stages must not satisfy gate for yolo-run", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-wrs-"));
    const stateDir = join(root, ".yolo/lifecycle");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "status.json"),
      JSON.stringify({
        current_stage: "check",
        stages: [
          { id: "discovery", status: "warning" },
          { id: "roadmap", status: "warning" },
          { id: "prd", status: "warning" },
          { id: "check", status: "warning" },
        ],
      })
    );
    const result = inspectLifecycleGuard({ command: "yolo-run", projectRoot: root });
    assert.notEqual(result.status, "pass", "warning-state stages must not satisfy gate for yolo-run");
  });

  test("check stage with warning status does not allow yolo-run to pass", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-wrs-"));
    const stateDir = join(root, ".yolo/lifecycle");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "status.json"),
      JSON.stringify({
        current_stage: "run",
        stages: [
          { id: "prd", status: "completed" },
          { id: "check", status: "warning" },
        ],
      })
    );
    const result = inspectLifecycleGuard({ command: "yolo-run", projectRoot: root });
    assert.notEqual(result.status, "pass", "check=warning must not allow yolo-run");
  });
});
