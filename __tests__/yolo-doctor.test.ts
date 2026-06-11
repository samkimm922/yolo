import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../src/core/bootstrap.js";
import {
  buildYoloDoctorReport,
  formatYoloDoctorText,
  runYoloDoctorCli,
} from "../src/runtime/devtools/doctor.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-doctor-"));
}

describe("YOLO doctor", () => {
  test("blocks uninitialized projects with a plain next action", () => {
    const root = tempProject();
    try {
      const report = buildYoloDoctorReport({
        projectRoot: root,
        yoloRoot: "/tmp/yolo",
        targets: "codex",
        scope: "project",
      });

      assert.equal(report.status, "blocked");
      assert.ok(report.blockers.some((blocker) => blocker.code === "YOLO_DOCTOR_CONFIG_EXISTS"));
      assert.match(report.next_actions[0], /yolo setup/);
      assert.equal(report.guarantees.provider_execution, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports initialized lifecycle and missing bridge artifacts as warning", () => {
    const root = tempProject();
    try {
      initProject({
        projectRoot: root,
        projectName: "doctor-demo",
        now: "2026-05-25T00:00:00.000Z",
      });
      const report = buildYoloDoctorReport({
        projectRoot: root,
        yoloRoot: "/tmp/yolo",
        targets: "codex",
        scope: "project",
      });

      assert.equal(report.status, "warning");
      assert.equal(report.lifecycle.current_stage, "idea");
      assert.deepEqual(report.commands.names, ["demand", "auto", "ship", "status"]);
      assert.equal(report.commands.names.includes("yolo-discover"), false);
      assert.equal(report.commands.names.includes("yolo-doctor"), false);
      assert.ok(report.warnings.some((warning) => warning.code === "YOLO_DOCTOR_AGENT_BRIDGE_INSTALLED"));
      assert.match(formatYoloDoctorText(report), /\[yolo doctor\] warning/);
      assert.equal(runYoloDoctorCli([root, "--target", "codex", "--scope", "project", "--json"], {
        stdout: { write() {} },
      }), 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
