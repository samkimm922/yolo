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
      assert.equal(Array.isArray(result.next_question), false);
      assert.equal(result.coverage.answered, 0);
      assert.equal(result.coverage.missing.length >= 1, true);
      assert.equal(result.next_actions.length <= 2, true);
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
      const result = await answer(
        root,
        started.session_path,
        "target_users",
        "Store managers check inventory every morning and are responsible for reordering before shelves run out.",
      );

      assert.equal(result.coverage.answered, 1);
      assert.equal(result.next_question.id, "status_quo");

      const saved = JSON.parse(readFileSync(started.session_path, "utf8"));
      assert.equal(saved.answers.target_users.answer, "Store managers check inventory every morning and are responsible for reordering before shelves run out.");
      assert.equal(saved.next_question.id, "status_quo");
      assert.equal(existsSync(join(root, ".yolo", "state", "questions.jsonl")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("weak answers keep next question on the same slot follow-up", async () => {
    const root = tempProject();
    try {
      const started = await startInterview(root);
      const result = await answer(root, started.session_path, "target_users", "用户");

      assert.equal(result.coverage.answered, 1);
      assert.equal(result.coverage.ready_for_prd_intake, false);
      assert.equal(result.coverage_detail.readiness.status, "needs_follow_up");
      assert.equal(result.next_question.id, "target_users");
      assert.equal(result.next_question.follow_up, true);
      assert.match(result.next_question.text, /角色|频率|负责/);
      assert.equal(result.coverage_detail.follow_up_questions[0].slot, "target_users");
      assert.equal(result.next_actions.length <= 2, true);
      assert.match(result.next_actions[0], /--question target_users/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("vague outcome words require a business follow-up", async () => {
    const root = tempProject();
    try {
      const started = await startInterview(root);
      await answer(
        root,
        started.session_path,
        "target_users",
        "Store managers check inventory every morning and are responsible for reordering before shelves run out.",
      );
      await answer(
        root,
        started.session_path,
        "status_quo",
        "Currently managers export an inventory spreadsheet each morning and manually check low quantities.",
      );
      await answer(
        root,
        started.session_path,
        "pain_points",
        "Manual checks are too slow because managers discover stockouts after customers complain.",
      );

      const result = await answer(root, started.session_path, "desired_outcome", "优化体验，更智能");

      assert.equal(result.coverage_detail.readiness.status, "needs_follow_up");
      assert.equal(result.next_question.id, "desired_outcome");
      assert.equal(result.next_question.follow_up, true);
      assert.match(result.next_question.text, /用户|业务|能做什么/);
      assert.equal(result.coverage_detail.follow_up_questions[0].slot, "desired_outcome");
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
      await answer(
        root,
        started.session_path,
        "target_users",
        "Store managers check inventory every morning and are responsible for reordering before shelves run out.",
      );

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
        ["target_users", "Store managers check inventory every morning and are responsible for reordering before shelves run out."],
        ["status_quo", "Currently managers export an inventory spreadsheet each morning and manually check low quantities."],
        ["pain_points", "Stockouts are discovered too late."],
        ["desired_outcome", "Managers see low-stock risks before the item sells out."],
        ["success_criteria", "Show a low-stock badge before quantity reaches zero."],
        ["success_proof", "A manager can see the badge on a SKU with low quantity."],
        ["scope_boundaries", "Do not build supplier ordering."],
        ["exceptions", "Hidden or discontinued SKUs should not show noisy alerts."],
        ["mvp_priority", "MVP is threshold alert plus inventory badge; forecasting can come later."],
      ];
      for (const [question, value] of answers) await answer(root, started.session_path, question, value);
      // P0.3: approval must come from real interview answer, not --approve flag
      await answer(root, started.session_path, "execution_approval", "Approved, proceed to PRD.");

      // Simulate playback confirmation (P0.3: playback must be confirmed before to-demand)
      const sessionData = JSON.parse(readFileSync(started.session_path, "utf8"));
      sessionData.playback = { confirmed: true, confirmed_by: "test", items: [] };
      writeFileSync(started.session_path, JSON.stringify(sessionData), "utf8");

      const out = capture();
      const exitCode = await runYoloCli([
        "interview",
        "to-demand",
        "--session",
        dirname(started.session_path),
        "--json",
      ], { cwd: root, stdout: out.stream });

      const result = out.json();
      assert.equal(exitCode, 1);
      assert.equal(result.status, "blocked");
      assert.equal(result.code, "INTERVIEW_DEMAND_BLOCKED");
      assert.equal(result.demand_result.demand_id, "DEMAND-STOCK-ALERTS");
      assert.equal(existsSync(join(result.demand_dir, "session.json")), true);
      assert.equal(result.demand_result.status, "blocked");
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

  test("to-demand exits 2 when approved interview has no execution scope", async () => {
    const root = tempProject();
    try {
      const started = await startInterview(root, "private-notes");
      const answers = [
        ["target_users", "Support editors who review customer records every day and need internal context before replying."],
        ["status_quo", "Editors keep private notes in an external spreadsheet and switch tabs during support work."],
        ["pain_points", "Spreadsheet notes are missed during replies and cause repeated context gathering."],
        ["desired_outcome", "Editors see the saved private note while reviewing the same customer record."],
        ["success_criteria", "Show a saved private note on the customer record detail view."],
        ["success_proof", "During acceptance, save a private note and verify it appears on that customer record."],
        ["scope_boundaries", "Do not send notes to customers or expose them in public messages."],
        ["exceptions", "Empty notes should not create a visible saved item."],
        ["mvp_priority", "MVP is creating and showing one private note on the customer record."],
      ];
      for (const [question, value] of answers) await answer(root, started.session_path, question, value);
      // P0.3: approval must come from real interview answer, not --approve flag
      await answer(root, started.session_path, "execution_approval", "Approved, proceed to PRD.");

      // Simulate playback confirmation (P0.3)
      const sessionData2 = JSON.parse(readFileSync(started.session_path, "utf8"));
      sessionData2.playback = { confirmed: true, confirmed_by: "test", items: [] };
      writeFileSync(started.session_path, JSON.stringify(sessionData2), "utf8");

      const out = capture();
      const exitCode = await runYoloCli([
        "interview",
        "to-demand",
        "--session",
        dirname(started.session_path),
        "--json",
      ], { cwd: root, stdout: out.stream });

      const result = out.json();
      assert.equal(exitCode, 2);
      assert.equal(result.status, "warning");
      assert.equal(result.code, "INTERVIEW_DEMAND_WARNING");
      assert.equal(result.demand_result.status, "warning");
      assert.ok(result.demand_result.warnings.some((warning) => warning.code === "EXECUTION_SCOPE_PRESENT"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("to-demand does not mark PRD intake ready while follow-up is unresolved", async () => {
    const root = tempProject();
    try {
      mkdirSync(join(root, "src", "services"), { recursive: true });
      writeFileSync(join(root, "src", "services", "inventory-alerts.ts"), "export const threshold = 3;\n", "utf8");
      const started = await startInterview(root);
      const answers = [
        ["target_users", "用户"],
        ["status_quo", "Currently managers export an inventory spreadsheet each morning and manually check low quantities."],
        ["pain_points", "Stockouts are discovered too late and cause customer complaints after shelves are empty."],
        ["desired_outcome", "Managers see low-stock risks before the item sells out."],
        ["success_criteria", "Show a low-stock badge before quantity reaches zero."],
        ["success_proof", "During acceptance, create a low quantity SKU and verify the manager sees the badge."],
        ["scope_boundaries", "Do not build supplier ordering."],
        ["exceptions", "Hidden or discontinued SKUs should not show noisy alerts."],
        ["mvp_priority", "MVP is threshold alert plus inventory badge; forecasting can come later."],
      ];
      for (const [question, value] of answers) await answer(root, started.session_path, question, value);

      // Simulate playback confirmation (P0.3)
      const sessionData3 = JSON.parse(readFileSync(started.session_path, "utf8"));
      sessionData3.playback = { confirmed: true, confirmed_by: "test", items: [] };
      writeFileSync(started.session_path, JSON.stringify(sessionData3), "utf8");

      const out = capture();
      const exitCode = await runYoloCli([
        "interview",
        "to-demand",
        "--session",
        dirname(started.session_path),
        "--json",
      ], { cwd: root, stdout: out.stream });

      const result = out.json();
      assert.equal(exitCode, 1);
      assert.equal(result.status, "blocked");
      assert.equal(result.coverage.ready_for_prd_intake, false);
      assert.equal(result.coverage_detail.readiness.status, "needs_follow_up");
      assert.equal(result.next_question.id, "target_users");
      assert.equal(result.next_question.follow_up, true);
      assert.match(result.next_question.text, /角色|频率|负责/);

      const saved = JSON.parse(readFileSync(started.session_path, "utf8"));
      assert.equal(saved.coverage.ready_for_prd_intake, false);
      assert.equal(saved.next_question.id, "target_users");
      assert.equal(saved.next_question.follow_up, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("demand office-hours profile produces only a one-question draft brief", async () => {
    const root = tempProject();
    try {
      const out = capture();
      const exitCode = await runYoloCli([
        "demand",
        "office-hours",
        "Launch a lightweight inventory planning assistant for small shops.",
        "--cwd",
        root,
        "--mode",
        "builder",
        "--json",
      ], { cwd: root, stdout: out.stream });

      const result = out.json();
      assert.equal(exitCode, 1);
      assert.equal(result.status, "blocked");
      assert.equal(result.profile, "lean_office_hours");
      assert.equal(result.mode, "builder");
      assert.equal(result.next_question.one_question_only, true);
      assert.equal(result.alternatives.length, 3);
      assert.equal(result.draft_brief.handoff.prd_execution, false);
      assert.equal(result.guarantees.produces_executable_prd, false);

      const chosenOut = capture();
      const chosenExit = await runYoloCli([
        "demand",
        "--profile",
        "startup",
        "--choice",
        "A",
        "Launch a lightweight inventory planning assistant for small shops.",
        "--cwd",
        root,
        "--json",
        "--no-write",
      ], { cwd: root, stdout: chosenOut.stream });
      const chosen = chosenOut.json();
      assert.equal(chosenExit, 0);
      assert.equal(chosen.status, "success");
      assert.equal(chosen.selected_alternative.id, "A");
      assert.equal(chosen.prd, undefined);
      assert.equal(chosen.guarantees.prd_execution, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
