import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseYoloInterviewArgs,
  runYoloCli,
  runYoloInterviewCli,
} from "../src/cli/yolo.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-interview-cli-"));
}

function capture() {
  let value = "";
  return {
    stream: { write: (chunk) => { value += String(chunk); } },
    text: () => value,
    json: () => JSON.parse(value),
  };
}

async function startInterview(root, id = "stock-alerts") {
  const out = capture();
  const exitCode = await runYoloInterviewCli([
    "start",
    "Show store managers low stock alerts before items run out.",
    "--cwd",
    root,
    "--id",
    id,
    "--title",
    "Low stock alerts",
    "--json",
  ], { cwd: root, stdout: out.stream });
  assert.equal(exitCode, 0);
  return out.json();
}

async function answer(root, sessionPath, question, value) {
  const out = capture();
  const exitCode = await runYoloInterviewCli([
    "answer",
    "--session",
    sessionPath,
    "--question",
    question,
    "--answer",
    value,
    "--json",
  ], { cwd: root, stdout: out.stream });
  assert.equal(exitCode, 0);
  return out.json();
}

describe("yolo interview CLI", () => {
  test("parses supported interview subcommands", () => {
    const start = parseYoloInterviewArgs(["start", "inventory alerts", "--cwd", "/tmp/project", "--id", "inv", "--title", "Inventory", "--json", "--no-write"]);
    assert.equal(start.input.command, "start");
    assert.equal(start.input.idea, "inventory alerts");
    assert.equal(start.input.cwd, "/tmp/project");
    assert.equal(start.input.id, "inv");
    assert.equal(start.input.title, "Inventory");
    assert.equal(start.options.json, true);
    assert.equal(start.options.writeArtifacts, false);

    const toDemand = parseYoloInterviewArgs(["to-demand", "--session", ".yolo/demand-interviews/inv", "--approve", "--json"]);
    assert.equal(toDemand.input.command, "to-demand");
    assert.equal(toDemand.input.sessionPath, ".yolo/demand-interviews/inv");
    assert.equal(toDemand.input.approve, true);
  });

  test("start writes the default interview state file", async () => {
    const root = tempProject();
    try {
      const result = await startInterview(root);
      const statePath = join(root, ".yolo", "demand-interviews", "stock-alerts", "interview.json");

      assert.equal(result.session_path, statePath);
      assert.equal(existsSync(statePath), true);
      assert.equal(result.next_question.id, "target_users");
      assert.equal(result.coverage.answered, 0);
      assert.equal(result.coverage.missing.length >= 1, true);
      assert.match(result.next_actions[0], /yolo interview answer/);

      const saved = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(saved.schema, "yolo.demand.interview.v1");
      assert.equal(saved.next_question.id, "target_users");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("answer updates the next question in the persisted state", async () => {
    const root = tempProject();
    try {
      const started = await startInterview(root);
      const result = await answer(root, started.session_path, "target_users", "Store managers");

      assert.equal(result.coverage.answered, 1);
      assert.equal(result.next_question.id, "status_quo");

      const saved = JSON.parse(readFileSync(started.session_path, "utf8"));
      assert.equal(saved.answers.target_users.answer, "Store managers");
      assert.equal(saved.next_question.id, "status_quo");
      assert.equal(existsSync(join(root, ".yolo", "state", "questions.jsonl")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("text output shows follow-up prompts for weak answers", async () => {
    const root = tempProject();
    try {
      const started = await startInterview(root);
      const out = capture();
      const exitCode = await runYoloInterviewCli([
        "answer",
        "--session",
        started.session_path,
        "--question",
        "target_users",
        "--answer",
        "API",
      ], { cwd: root, stdout: out.stream });

      assert.equal(exitCode, 0);
      assert.match(out.text(), /answer_quality:/);
      assert.match(out.text(), /follow_up:/);
      assert.match(out.text(), /角色|频率|负责/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("status reads an existing session directory", async () => {
    const root = tempProject();
    try {
      const started = await startInterview(root);
      await answer(root, started.session_path, "target_users", "Store managers");

      const out = capture();
      const exitCode = await runYoloInterviewCli([
        "status",
        "--session",
        dirname(started.session_path),
        "--json",
      ], { cwd: root, stdout: out.stream });

      const result = out.json();
      assert.equal(exitCode, 0);
      assert.equal(result.session_path, started.session_path);
      assert.equal(result.coverage.answered, 1);
      assert.equal(result.next_question.id, "status_quo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("to-demand generates demand artifacts through the top-level CLI", async () => {
    const root = tempProject();
    try {
      mkdirSync(join(root, "src", "services"), { recursive: true });
      writeFileSync(join(root, "src", "services", "inventory-alerts.ts"), "export const threshold = 3;\n", "utf8");
      const started = await startInterview(root);
      const answers = [
        ["target_users", "Store managers"],
        ["status_quo", "They find stockouts after customers complain."],
        ["pain_points", "Stockouts are discovered too late."],
        ["desired_outcome", "Managers see low-stock risks before the item sells out."],
        ["success_criteria", "Show a low-stock badge before quantity reaches zero."],
        ["success_proof", "A manager can see the badge on a SKU with low quantity."],
        ["scope_boundaries", "Do not build supplier ordering."],
        ["exceptions", "Hidden or discontinued SKUs should not show noisy alerts."],
        ["mvp_priority", "MVP is threshold alert plus inventory badge; forecasting can come later."],
      ];
      for (const [question, value] of answers) await answer(root, started.session_path, question, value);

      const out = capture();
      const exitCode = await runYoloCli([
        "interview",
        "to-demand",
        "--session",
        dirname(started.session_path),
        "--approve",
        "--json",
      ], { cwd: root, stdout: out.stream });

      const result = out.json();
      assert.equal(exitCode, 0);
      assert.equal(result.demand_result.demand_id, "DEMAND-STOCK-ALERTS");
      assert.equal(existsSync(join(result.demand_dir, "session.json")), true);
      assert.equal(result.demand_result.session.approval.approved, true);
      assert.equal(result.coverage.ready_for_prd_intake, true);

      const saved = JSON.parse(readFileSync(started.session_path, "utf8"));
      assert.equal(saved.demand.demand_id, "DEMAND-STOCK-ALERTS");
      assert.equal(saved.answers.execution_approval.normalized.approved, true);
      assert.equal(saved.demand.artifacts.some((path) => path.endsWith("session.json")), true);
      assert.equal(existsSync(join(root, ".yolo", "state", "decisions.jsonl")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
