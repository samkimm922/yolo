import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { initProject } from "../src/core/bootstrap.js";
import { writeLifecycleStageReport } from "../src/lifecycle/progress.js";
import { writeSourceSnapshot } from "../src/lifecycle/source-snapshot.js";
import {
  buildYoloDoctorReport,
  formatYoloDoctorText,
  runYoloDoctorCli,
} from "../src/devtools/doctor.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-doctor-"));
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

function initGitProject(root) {
  for (const args of [["init"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "YOLO Test"]]) git(root, args);
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
      assert.equal((report.findings || []).some((finding) => finding.code === "YOLO_DOCTOR_WORKTREE_DRIFT"), false);
      assert.ok(report.warnings.some((warning) => warning.code === "YOLO_DOCTOR_AGENT_BRIDGE_INSTALLED"));
      assert.match(formatYoloDoctorText(report), /\[yolo doctor\] warning/);
      assert.equal(runYoloDoctorCli([root, "--target", "codex", "--scope", "project", "--json"], {
        stdout: { write() {} },
      }), 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports source drift with captured_at, difference count, and yolo check fix command", () => {
    const root = tempProject();
    try {
      initProject({ projectRoot: root, projectName: "doctor-drift-demo", now: "2026-05-25T00:00:00.000Z" });
      const prdPath = join(root, "specs", "prd.json");
      const targetPath = join(root, "src", "a.js");
      mkdirSync(dirname(prdPath), { recursive: true });
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(prdPath, JSON.stringify({ version: "2.0", tasks: [] }, null, 2), "utf8");
      writeFileSync(targetPath, "export const value = 1;\n", "utf8");
      writeLifecycleStageReport("check", { status: "pass", summary: "check passed", prd_path: prdPath }, {
        projectRoot: root, stateRoot: join(root, ".yolo"), writeSessionMemory: false, skipSequenceCheck: true,
      });
      initGitProject(root);
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "initial fixture"]);
      const snapshot = writeSourceSnapshot({ projectRoot: root, stateRoot: join(root, ".yolo"), now: "2026-05-25T01:00:00.000Z" });

      writeFileSync(targetPath, "export const value = 2;\n", "utf8");
      const report = buildYoloDoctorReport({ projectRoot: root, yoloRoot: "/tmp/yolo", targets: "codex", scope: "project" });
      const finding = (report.findings || []).find((item) => item.code === "YOLO_DOCTOR_WORKTREE_DRIFT");

      assert.equal(report.status, "blocked");
      assert.ok(finding);
      assert.equal(finding.captured_at, snapshot.payload.captured_at);
      assert.equal(finding.current_difference_file_count, 1);
      assert.equal(finding.fix_command, `yolo check ${prdPath}`);
      assert.ok(report.next_actions.includes(`Run yolo check ${prdPath} to revalidate the drifted worktree and refresh the lifecycle snapshot.`));
      assert.match(formatYoloDoctorText(report), /fix_command: yolo check /);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
