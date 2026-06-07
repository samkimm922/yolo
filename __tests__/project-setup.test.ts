import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../src/core/bootstrap.js";
import {
  inspectProjectSetupTarget,
  setupProject,
  YOLO_SETUP_SCHEMA,
} from "../src/core/setup.js";
import { runYoloCli } from "../src/cli/yolo.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-project-setup-"));
}

function captureIo(cwd) {
  let stdoutText = "";
  let stderrText = "";
  return {
    cwd,
    stdout: {
      write: (chunk) => {
        stdoutText += String(chunk);
      },
    },
    stderr: {
      write: (chunk) => {
        stderrText += String(chunk);
      },
    },
    output: () => ({ stdout: stdoutText, stderr: stderrText }),
  };
}

describe("project setup orchestrator", () => {
  test("setupProject initializes a new project and installs project-scoped bridge artifacts", () => {
    const root = tempProject();
    try {
      const result = setupProject({
        projectRoot: root,
        yoloRoot: "/tmp/yolo",
        targets: "codex",
        now: "2026-05-31T00:00:00.000Z",
      });

      assert.equal(result.schema, YOLO_SETUP_SCHEMA);
      assert.equal(result.status, "success");
      assert.equal(result.setup_state, "new");
      assert.equal(result.final_state, "initialized");
      assert.deepEqual(result.scopes, ["project"]);
      assert.equal(result.force, false);
      assert.equal(result.guarantees.default_scope, "project");
      assert.equal(result.guarantees.writes_user_home, false);
      assert.equal(result.guarantees.onboarding_autofill, false);
      assert.equal(result.doctor.status, "pass");
      assert.equal(existsSync(join(root, ".yolo/config.json")), true);
      assert.equal(existsSync(join(root, "AGENTS.md")), true);
      assert.equal(existsSync(join(root, ".codex/skills/yolo/SKILL.md")), true);
      assert.equal(JSON.stringify(result).includes("Capture the first user problem"), false);
      assert.deepEqual(result.human_context_gaps, []);
      assert.equal(result.next_actions[0].verifies, "status == pass");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run classifies and plans setup without writing files", () => {
    const root = tempProject();
    try {
      const result = inspectProjectSetupTarget({
        projectRoot: root,
        yoloRoot: "/tmp/yolo",
        targets: "codex",
      });

      assert.equal(result.status, "planned");
      assert.equal(result.setup_state, "new");
      assert.equal(result.dry_run, true);
      assert.equal(result.init_result.dry_run, true);
      assert.equal(result.agent_bridge_result.dry_run, true);
      assert.equal(result.guarantees.writes_workspace, false);
      assert.equal(existsSync(join(root, ".yolo/config.json")), false);
      assert.equal(existsSync(join(root, "AGENTS.md")), false);
      assert.ok(result.gaps.some((gap) => gap.code === "YOLO_SETUP_BOOTSTRAP_MISSING"));
      assert.equal(result.next_actions[0].id, "apply_setup");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("partial project installs only missing bridge artifacts", () => {
    const root = tempProject();
    try {
      initProject({
        projectRoot: root,
        projectName: "partial-demo",
        now: "2026-05-31T00:00:00.000Z",
      });

      const result = setupProject({
        projectRoot: root,
        yoloRoot: "/tmp/yolo",
        targets: "codex",
      });

      assert.equal(result.setup_state, "partial");
      assert.equal(result.final_state, "initialized");
      assert.equal(result.status, "success");
      assert.equal(result.init_result, null);
      assert.equal(result.agent_bridge_result.written.includes("AGENTS.md"), true);
      assert.equal(result.agent_bridge_result.writes_workspace, true);
      assert.equal(result.doctor.status, "pass");
      assert.ok(result.gaps.some((gap) => gap.code === "YOLO_DOCTOR_AGENT_BRIDGE_INSTALLED"));
      assert.ok(result.human_context_gaps.some((gap) => gap.code === "YOLO_SETUP_BUSINESS_GOAL_UNVERIFIED"));
      assert.equal(JSON.stringify(result.next_actions).includes("interview"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unmanaged project instructions classify as risky and block default writes", () => {
    const root = tempProject();
    try {
      writeFileSync(join(root, "AGENTS.md"), "# Existing local agent rules\n", "utf8");

      const result = setupProject({
        projectRoot: root,
        yoloRoot: "/tmp/yolo",
        targets: "codex",
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.setup_state, "risky");
      assert.equal(result.final_state, "risky");
      assert.equal(result.init_result, null);
      assert.equal(result.agent_bridge_result, null);
      assert.equal(existsSync(join(root, ".yolo/config.json")), false);
      assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Existing local agent rules\n");
      assert.ok(result.risk_gaps.some((gap) => gap.code === "YOLO_SETUP_UNMANAGED_AGENT_INSTRUCTIONS"));
      assert.equal(result.next_actions[0].id, "resolve_risky_setup_gaps");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo setup CLI returns the orchestrator JSON", async () => {
    const root = tempProject();
    const io = captureIo(root);
    try {
      const code = await runYoloCli([
        "setup",
        "--cwd",
        root,
        "--target",
        "codex",
        "--json",
      ], io);
      const output = io.output();
      const payload = JSON.parse(output.stdout);

      assert.equal(output.stderr, "");
      assert.equal(code, 0);
      assert.equal(payload.schema, YOLO_SETUP_SCHEMA);
      assert.equal(payload.status, "success");
      assert.equal(payload.setup_state, "new");
      assert.deepEqual(payload.scopes, ["project"]);
      assert.equal(payload.doctor.status, "pass");
      assert.equal(existsSync(join(root, "AGENTS.md")), true);
      assert.deepEqual(payload.human_context_gaps, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
