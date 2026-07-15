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
import { runDemandPrdRuntime } from "../src/demand/runtime.js";

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "yolo-interview-cli-"));
  mkdirSync(join(root, ".yolo", "keys"), { recursive: true });
  writeFileSync(join(root, ".yolo", "keys", "ledger.hmac"), "interview-cli-test-ledger-key", "utf8");
  return root;
}

function capture() {
  let value = "";
  return {
    stream: { write: (chunk) => { value += String(chunk); } },
    text: () => value,
    json: () => JSON.parse(value),
  };
}

async function startInterview(
  root,
  id = "stock-alerts",
  idea = "Show store managers low stock alerts before items run out.",
  title = "Low stock alerts",
) {
  const out = capture();
  const exitCode = await runYoloInterviewCli([
    "start",
    idea,
    "--cwd",
    root,
    "--id",
    id,
    "--title",
    title,
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

async function generatePlayback(root, sessionPath) {
  const out = capture();
  const exitCode = await runYoloInterviewCli([
    "playback",
    "--session",
    sessionPath,
    "--json",
  ], { cwd: root, stdout: out.stream });
  assert.equal(exitCode, 0);
  return out.json();
}

async function confirmCurrentPlayback(root, sessionPath) {
  const generated = await generatePlayback(root, sessionPath);
  const playback = generated.outputs[0].playback;
  const contentHash = playback.content_hash || "legacy-red-current-snapshot";
  const out = capture();
  const exitCode = await runYoloInterviewCli([
    "playback",
    "--session",
    sessionPath,
    "--confirm",
    contentHash,
    "--json",
  ], { cwd: root, stdout: out.stream });
  assert.equal(exitCode, 0);
  const result = out.json();
  assert.equal(result.code, "PLAYBACK_CONFIRMED");
  return result;
}

async function startLayerOneInterview(root, id = "stock-alerts") {
  const started = await startInterview(root, id);
  await answer(root, started.session_path, "premise_consequence", "Without a change, managers miss at least two stockout risks each week and spend an hour recovering.");
  await answer(root, started.session_path, "premise_minimum", "The minimum useful version must show a low-stock signal in the current inventory workflow.");
  await answer(root, started.session_path, "premise_decision", "继续");
  await confirmCurrentPlayback(root, started.session_path);
  return started;
}

async function openLayerFourInterview(root, id = "stock-alerts") {
  const started = await startLayerOneInterview(root, id);
  await answer(root, started.session_path, "target_users", "Store managers check inventory every morning and are responsible for reordering before shelves run out.");
  await answer(root, started.session_path, "status_quo", "Managers export an inventory spreadsheet each morning and manually check low quantities.");
  await answer(root, started.session_path, "pain_points", "Manual checks are slow and managers discover stockouts after customers complain at least twice each week.");
  await answer(root, started.session_path, "layer_1_confirmation", "确认，这一层理解无误。");
  await answer(root, started.session_path, "day_in_life", "Every morning the manager opens inventory, checks low-stock items, and schedules replenishment before the store opens.");
  await answer(root, started.session_path, "desired_outcome", "Managers see low-stock risks before each item sells out and can prioritize replenishment.");
  await answer(root, started.session_path, "layer_2_confirmation", "确认，这就是完整的一天。");
  await answer(root, started.session_path, "exceptions", "Hidden or discontinued SKUs should not show alerts, and empty inventory should show a clear empty state.");
  await answer(root, started.session_path, "scope_boundaries", "Do not build supplier ordering or change the existing order import workflow.");
  await answer(root, started.session_path, "layer_3_confirmation", "确认，例外和边界都完整。");
  return started;
}

async function completeInterview(root, id = "stock-alerts") {
  const started = await openLayerFourInterview(root, id);
  await answer(root, started.session_path, "success_criteria", "A low-stock SKU shows a clear badge before quantity reaches zero.");
  await answer(root, started.session_path, "layer_4_confirmation", "确认，每项能力都有可见证据。");
  await answer(root, started.session_path, "requirements_confirmation", "确认，R-001 清单准确且没有遗漏。");
  await answer(root, started.session_path, "execution_approval", "批准，按确认后的需求清单进入 PRD。");
  return started;
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

    const toDemand = parseYoloInterviewArgs(["to-demand", "--session", ".yolo/demand-interviews/inv", "--json"]);
    assert.equal(toDemand.input.command, "to-demand");
    assert.equal(toDemand.input.sessionPath, ".yolo/demand-interviews/inv");
    assert.equal(toDemand.input.approve, undefined);

    const playbackConfirm = parseYoloInterviewArgs(["playback", "--session", ".yolo/demand-interviews/inv", "--confirm", "--json"]);
    assert.equal(playbackConfirm.input.command, "playback");
    assert.equal(playbackConfirm.input.confirm, "true");

    const playbackText = parseYoloInterviewArgs(["playback", "--session", ".yolo/demand-interviews/inv", "--confirm", "Looks right", "--json"]);
    assert.equal(playbackText.input.confirm, "Looks right");
  });

  test("cannot bypass a protocol gate by naming a future question explicitly", async () => {
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
        "Store managers review the todo list every morning.",
        "--json",
      ], { cwd: root, stdout: out.stream });

      assert.equal(exitCode, 2);
      const result = out.json();
      assert.equal(result.code, "INTERVIEW_STAGE_GATE_BLOCKED");
      assert.equal(result.next_question.id, "premise_consequence");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("playback rejects a value-less --confirm that is not bound to the current content", async () => {
    const root = tempProject();
    try {
      const started = await startLayerOneInterview(root);
      await answer(
        root,
        started.session_path,
        "target_users",
        "Store managers check inventory every morning and are responsible for reordering before shelves run out.",
      );
      const out = capture();
      const exitCode = await runYoloInterviewCli([
        "playback",
        "--session",
        started.session_path,
        "--confirm",
        "--json",
      ], { cwd: root, stdout: out.stream });

      assert.equal(exitCode, 2);
      const result = out.json();
      assert.equal(result.status, "error");
      assert.equal(result.code, "PLAYBACK_CONFIRMATION_MISMATCH");

      const saved = JSON.parse(readFileSync(started.session_path, "utf8"));
      assert.notEqual(saved.playback?.confirmed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("playback rejects arbitrary confirmation text that does not identify the current snapshot", async () => {
    const root = tempProject();
    try {
      const started = await startLayerOneInterview(root);
      await answer(
        root,
        started.session_path,
        "target_users",
        "Store managers check inventory every morning and are responsible for reordering before shelves run out.",
      );
      const out = capture();
      const exitCode = await runYoloInterviewCli([
        "playback",
        "--session",
        started.session_path,
        "--confirm",
        "Confirmed after review",
        "--json",
      ], { cwd: root, stdout: out.stream });

      assert.equal(exitCode, 2);
      const result = out.json();
      assert.equal(result.code, "PLAYBACK_CONFIRMATION_MISMATCH");

      const saved = JSON.parse(readFileSync(started.session_path, "utf8"));
      assert.notEqual(saved.playback?.confirmed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("answer changes automatically invalidate confirmation for the previous snapshot", async () => {
    const root = tempProject();
    try {
      const started = await startLayerOneInterview(root);
      await answer(
        root,
        started.session_path,
        "target_users",
        "Store managers check inventory every morning and are responsible for reordering before shelves run out.",
      );
      await confirmCurrentPlayback(root, started.session_path);

      await answer(
        root,
        started.session_path,
        "target_users",
        "Warehouse supervisors review inventory every afternoon and decide which locations receive replenishment.",
      );

      const saved = JSON.parse(readFileSync(started.session_path, "utf8"));
      assert.equal(saved.playback.confirmed, false);
      assert.equal(saved.playback.invalidation_reason, "interview_answer_changed");
      assert.equal(typeof saved.playback.invalidated_at, "string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("to-demand rejects a persisted confirmation when answers no longer match its snapshot", async () => {
    const root = tempProject();
    try {
      const started = await startLayerOneInterview(root);
      await answer(
        root,
        started.session_path,
        "target_users",
        "Store managers check inventory every morning and are responsible for reordering before shelves run out.",
      );
      await confirmCurrentPlayback(root, started.session_path);

      const tampered = JSON.parse(readFileSync(started.session_path, "utf8"));
      tampered.answers.target_users.answer = "Warehouse supervisors review a different replenishment workflow.";
      tampered.answers.target_users.normalized.text = tampered.answers.target_users.answer;
      writeFileSync(started.session_path, JSON.stringify(tampered), "utf8");

      const out = capture();
      const exitCode = await runYoloInterviewCli([
        "to-demand",
        "--session",
        started.session_path,
        "--json",
      ], { cwd: root, stdout: out.stream });

      assert.equal(exitCode, 2);
      assert.equal(out.json().code, "PLAYBACK_CONFIRMATION_STALE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("start writes the default interview state file", async () => {
    const root = tempProject();
    try {
      const result = await startInterview(root);
      const statePath = join(root, ".yolo", "demand-interviews", "stock-alerts", "interview.json");

      assert.equal(result.session_path, statePath);
      assert.equal(existsSync(statePath), true);
      assert.equal(result.next_question.id, "premise_consequence");
      assert.equal(result.next_question.recommended_answer.length > 0, true);
      assert.equal(Array.isArray(result.next_question), false);
      assert.equal(result.coverage.answered, 0);
      assert.equal(result.coverage.missing.length >= 1, true);
      assert.equal(result.next_actions.length <= 2, true);
      assert.match(result.next_actions[0], /yolo interview answer/);

      const saved = JSON.parse(readFileSync(statePath, "utf8"));
      assert.equal(saved.schema, "yolo.demand.interview.v2");
      assert.equal(saved.next_question.id, "premise_consequence");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("answer updates the next question in the persisted state", async () => {
    const root = tempProject();
    try {
      const started = await startLayerOneInterview(root);
      const result = await answer(
        root,
        started.session_path,
        "target_users",
        "Store managers check inventory every morning and are responsible for reordering before shelves run out.",
      );

      assert.equal(result.coverage.answered, 4);
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
      const started = await startLayerOneInterview(root);
      const result = await answer(root, started.session_path, "target_users", "用户");

      assert.equal(result.coverage.answered, 4);
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
      const started = await startLayerOneInterview(root);
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
      await answer(root, started.session_path, "layer_1_confirmation", "确认，这一层理解无误。");
      await answer(root, started.session_path, "day_in_life", "Every morning the manager opens inventory, checks risky rows, and decides what to replenish before the store opens.");

      const result = await answer(root, started.session_path, "desired_outcome", "优化体验，更智能");

      assert.equal(result.coverage_detail.readiness.status, "needs_follow_up");
      assert.equal(result.next_question.id, "desired_outcome");
      assert.equal(result.next_question.follow_up, true);
      assert.match(result.next_question.text, /具体数量\/日期/);
      assert.match(result.next_question.text, /当…时…/);
      assert.equal(result.coverage_detail.follow_up_questions[0].slot, "desired_outcome");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("text output shows follow-up prompts for weak answers", async () => {
    const root = tempProject();
    try {
      const started = await startLayerOneInterview(root);
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

  test("text output shows fail-closed guidance after repeated vague answers", async () => {
    const root = tempProject();
    try {
      const started = await openLayerFourInterview(root);
      await answer(root, started.session_path, "success_criteria", "做好一点");
      await answer(root, started.session_path, "success_criteria", "做好一点");

      const out = capture();
      const exitCode = await runYoloInterviewCli([
        "answer",
        "--session",
        started.session_path,
        "--question",
        "success_criteria",
        "--answer",
        "做好一点",
      ], { cwd: root, stdout: out.stream });

      assert.equal(exitCode, 0);
      assert.match(out.text(), /follow_up:/);
      assert.match(out.text(), /人工澄清/);

      const saved = JSON.parse(readFileSync(started.session_path, "utf8"));
      assert.equal(saved.answers.success_criteria.quality.level, "blocked_needs_clarification");
      assert.equal(saved.follow_up_counts.success_criteria.count, 3);
      assert.equal(saved.accepted_assumptions.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("status reads an existing session directory", async () => {
    const root = tempProject();
    try {
      const started = await startLayerOneInterview(root);
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
      assert.equal(result.coverage.answered, 4);
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
      const started = await completeInterview(root);

      await confirmCurrentPlayback(root, started.session_path);

      const out = capture();
      const exitCode = await runYoloCli([
        "interview",
        "to-demand",
        "--session",
        dirname(started.session_path),
        "--json",
      ], { cwd: root, stdout: out.stream });

      const result = out.json();
      assert.equal(exitCode, 0);
      assert.equal(result.status, "success");
      assert.equal(result.code, "INTERVIEW_DEMAND_CREATED");
      assert.equal(result.demand_result.demand_id, "DEMAND-STOCK-ALERTS");
      assert.equal(existsSync(join(result.demand_dir, "session.json")), true);
      assert.equal(result.demand_result.status, "success");
      assert.equal(result.demand_result.session.approval.approved, true);
      assert.equal(result.demand_result.guarantees.produces_executable_prd, false);
      assert.equal(result.coverage.ready_for_prd_intake, true);
      assert.equal(result.next_action, `yolo spec --demand ${result.demand_path}`);
      assert.deepEqual(result.next_actions, [result.next_action]);

      const statusOut = capture();
      const statusExit = await runYoloCli(["status", "--cwd", root, "--json"], { cwd: root, stdout: statusOut.stream });
      const status = statusOut.json();
      assert.equal(statusExit, 0);
      assert.equal(status.recommended_command, result.next_action);
      assert.ok(status.allowed_commands.includes(result.next_action));

      const saved = JSON.parse(readFileSync(started.session_path, "utf8"));
      assert.equal(saved.demand.demand_id, "DEMAND-STOCK-ALERTS");
      assert.equal(saved.answers.execution_approval.normalized.approved, true);
      assert.equal(saved.demand.artifacts.some((path) => path.endsWith("session.json")), true);
      assert.equal(existsSync(join(root, ".yolo", "state", "decisions.jsonl")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("to-demand still creates approved demand when executable scope is not ready yet", async () => {
    const root = tempProject();
    try {
      const started = await completeInterview(root, "private-notes");

      await confirmCurrentPlayback(root, started.session_path);

      const out = capture();
      const exitCode = await runYoloCli([
        "interview",
        "to-demand",
        "--session",
        dirname(started.session_path),
        "--json",
      ], { cwd: root, stdout: out.stream });

      const result = out.json();
      assert.equal(exitCode, 0);
      assert.equal(result.status, "success");
      assert.equal(result.code, "INTERVIEW_DEMAND_CREATED");
      assert.equal(result.demand_result.status, "success");
      assert.ok(result.demand_result.warnings.some((warning) => warning.code === "EXECUTION_SCOPE_PRESENT"));
      assert.equal(result.demand_result.readiness.executable_prd_ready, false);
      assert.equal(result.next_action, `yolo spec --demand ${result.demand_path}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("to-demand does not mark PRD intake ready while follow-up is unresolved", async () => {
    const root = tempProject();
    try {
      mkdirSync(join(root, "src", "services"), { recursive: true });
      writeFileSync(join(root, "src", "services", "inventory-alerts.ts"), "export const threshold = 3;\n", "utf8");
      const started = await startLayerOneInterview(root);
      await answer(root, started.session_path, "target_users", "用户");

      await confirmCurrentPlayback(root, started.session_path);

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
      assert.ok(result.blockers.some((blocker) => blocker.slot === "target_users"));
      assert.match(result.next_actions.join("\n"), /Missing demand fields\/approvals:/);
      assert.match(result.next_actions.join("\n"), /yolo interview answer/);
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

  test("tag classification and due reminders stay four domain capabilities through interview to PRD", async () => {
    const root = tempProject();
    try {
      const projectFiles = [
        "src/domain/tag.ts",
        "src/features/todo-filter.ts",
        "src/domain/todo.ts",
        "src/services/reminder-scheduler.ts",
      ];
      for (const file of projectFiles) {
        const path = join(root, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `export const existingDomainSurface = ${JSON.stringify(file)};\n`, "utf8");
      }

      const started = await startInterview(
        root,
        "tag-due",
        "让团队成员给待办分类，并在到期前收到提醒。",
        "待办标签分类和到期提醒",
      );
      const sessionPath = started.session_path;
      await answer(root, sessionPath, "premise_consequence", "不做会每周漏掉至少两次到期任务，项目负责人需要临时追赶和补救。");
      await answer(root, sessionPath, "premise_minimum", "最小版本必须包含标签管理、标签筛选、到期时间和到期前站内提醒。");
      await answer(root, sessionPath, "premise_decision", "继续");
      await confirmCurrentPlayback(root, sessionPath);

      await answer(root, sessionPath, "target_users", "每天维护待办并负责按时交付的团队成员，以及每天查看延期风险的项目负责人。");
      await answer(root, sessionPath, "status_quo", "成员用标题前缀分类待办，负责人每天下班前人工翻看所有任务日期。");
      await answer(root, sessionPath, "pain_points", "标签写法不一致导致筛选困难，人工查看日期每周至少漏掉两次到期任务。");
      await answer(root, sessionPath, "layer_1_confirmation", "确认，这一层理解无误。");

      await answer(root, sessionPath, "day_in_life", "每天早上成员创建标签并整理待办，工作中按标签筛选，下午更新到期时间，负责人下班前查看到期提醒。");
      await answer(root, sessionPath, "desired_outcome", [
        "1. 团队成员可以创建和管理待办标签。",
        "2. 团队成员可以按标签筛选待办列表。",
        "3. 团队成员可以为待办设置和修改到期时间。",
        "4. 团队成员会在待办到期前收到站内提醒。",
      ].join("\n"));
      await answer(root, sessionPath, "layer_2_confirmation", "确认，这就是完整的一天。");

      await answer(root, sessionPath, "exceptions", "没有到期时间的待办不提醒，已完成待办取消提醒，重复修改日期只保留最新提醒。");
      await answer(root, sessionPath, "scope_boundaries", "保留现有待办创建和完成流程；本次不做邮件、短信和移动推送。");
      await answer(root, sessionPath, "layer_3_confirmation", "确认，例外和边界都完整。");

      await answer(root, sessionPath, "success_criteria", [
        "创建标签后能在待办上选择并重新编辑。",
        "选择一个标签后列表只显示匹配待办。",
        "把待办设为明天到期后详情显示新日期。",
        "到期前负责人能看到包含任务名称的站内提醒。",
      ].join("\n"));
      await answer(root, sessionPath, "layer_4_confirmation", "确认，每项能力都有可见证据。");
      await answer(root, sessionPath, "requirements_confirmation", "确认，R-001 到 R-004 准确且没有遗漏。");
      await answer(root, sessionPath, "execution_approval", "批准，按确认后的四项需求进入 PRD。");
      await confirmCurrentPlayback(root, sessionPath);

      const saved = JSON.parse(readFileSync(sessionPath, "utf8"));
      assert.equal(saved.initial_playback.confirmed, true);
      assert.equal((Object.values(saved.coverage.layer_gates) as Array<{ confirmed?: boolean }>).every((gate) => gate.confirmed === true), true);
      assert.equal(saved.coverage.requirement_checklist.length, 4, JSON.stringify(saved.coverage.requirement_checklist, null, 2));

      const toDemandOut = capture();
      const toDemandExit = await runYoloCli([
        "interview",
        "to-demand",
        "--session",
        sessionPath,
        "--json",
      ], { cwd: root, stdout: toDemandOut.stream });
      assert.equal(toDemandExit, 0, toDemandOut.text());
      const demand = toDemandOut.json();

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: demand.demand_path,
        writeArtifacts: false,
      });
      assert.equal(prd.status, "success", JSON.stringify({ status: prd.status, blockers: prd.blockers }, null, 2));
      const tasks = prd.prd.tasks.filter((task) => task.task_kind === "demand_atomic_task");
      assert.equal(tasks.length, 4, JSON.stringify(tasks.map((task) => ({ title: task.title, scope: task.scope })), null, 2));
      assert.equal(new Set(tasks.map((task) => task.title)).size, 4);
      assert.deepEqual(new Set(tasks.flatMap((task) => task.scope.targets.map((target) => target.file))), new Set(projectFiles));
      assert.equal(JSON.stringify(prd.prd).includes("feature-"), false);
      assert.equal(JSON.stringify(prd.prd).includes("现在用标题前缀写标签，每天下班前由负责人逐条翻看日期"), false);
      const serializedDemand = JSON.stringify(prd.prd.demand);
      const serializedPrd = JSON.stringify(prd.prd);
      assert.equal(serializedDemand.length < serializedPrd.length * 0.30, true, `demand=${serializedDemand.length} prd=${serializedPrd.length}`);
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
