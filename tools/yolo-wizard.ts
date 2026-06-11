#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { initProject } from "../src/core/bootstrap.js";
import { runPiAgent } from "../src/agents/pi.js";
import { formatLifecycleGuardText, inspectLifecycleGuard } from "../src/lifecycle/guard.js";
import { formatYoloCheckText, inspectYoloCheck } from "../src/runtime/gates/check-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOLO_ROOT = resolve(__dirname, "..");

function timestamp() {
  return new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
}

function defaultProjectRoot() {
  return resolve(YOLO_ROOT, "../..");
}

function stateRootFor(projectRoot) {
  return join(resolve(projectRoot), ".yolo");
}

export function inspectWizardRunGuard(projectRoot, prdPath) {
  const resolvedProjectRoot = resolve(projectRoot);
  return inspectLifecycleGuard({
    command: "yolo-run",
    projectRoot: resolvedProjectRoot,
    stateRoot: stateRootFor(resolvedProjectRoot),
    prdPath,
  });
}

export function inspectWizardCheck(projectRoot, prdPath) {
  const resolvedProjectRoot = resolve(projectRoot);
  return inspectYoloCheck({
    prdPath,
    projectRoot: resolvedProjectRoot,
    stateRoot: stateRootFor(resolvedProjectRoot),
    writeLifecycle: true,
  }, { learnFailures: true });
}

function print(lines = []) {
  for (const line of lines) output.write(`${line}\n`);
}

function artifactLines(artifacts) {
  if (Array.isArray(artifacts)) return artifacts.filter(Boolean);
  return Object.entries(artifacts || {})
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `${key}: ${value}`);
}

function trimAnswer(value = "") {
  return String(value || "").trim();
}

export function normalizeMenuChoice(value = "") {
  const text = trimAnswer(value);
  if (["1", "init", "初始化"].includes(text)) return "init";
  if (["2", "plan", "计划"].includes(text)) return "plan";
  if (["3", "check", "检查"].includes(text)) return "check";
  if (["4", "run", "执行"].includes(text)) return "run";
  if (["5", "q", "quit", "exit", "退出"].includes(text.toLowerCase())) return "quit";
  return "unknown";
}

export function planToMarkdown(result = Object()) {
  const actions = result.plan?.actions || [];
  const artifacts = result.artifacts || result.plan?.artifacts || {};
  const lines = [
    "# YOLO Plan",
    "",
    `Status: ${result.status || "unknown"}`,
    `Summary: ${result.summary || ""}`,
    "",
    "## Artifacts",
    "",
  ];

  for (const [key, value] of Object.entries(artifacts)) {
    if (value) lines.push(`- ${key}: ${value}`);
  }

  lines.push("", "## Steps", "");
  for (const action of actions) {
    lines.push(`- ${action.id}: ${action.summary}`);
  }

  if (result.next_actions?.length) {
    lines.push("", "## Next", "");
    for (const action of result.next_actions) lines.push(`- ${action}`);
  }

  lines.push("");
  return lines.join("\n");
}

export function friendlyPreflightSummary(result = Object()) {
  if (result.runner_readiness?.can_execute) {
    return {
      ok: true,
      title: "PRD 检查通过，可以进入执行前确认。",
      next: result.runner_readiness.next_actions || [],
    };
  }

  return {
    ok: false,
    title: `PRD 还不能执行，发现 ${result.blocked_count || 0} 个阻断项。`,
    next: result.runner_readiness?.next_actions || ["先修 PRD，再重新检查。"],
  };
}

async function askRequired(rl, question) {
  while (true) {
    const answer = trimAnswer(await rl.question(question));
    if (answer) return answer;
    print(["这个不能为空，请再填一次。"]);
  }
}

async function askProjectRoot(rl) {
  const answer = trimAnswer(await rl.question(`项目文件夹路径（直接回车 = ${defaultProjectRoot()}）：`));
  return resolve(answer || defaultProjectRoot());
}

async function confirmDanger(rl, message) {
  print([
    "",
    "这一步会真的运行 YOLO 执行链路，可能修改项目文件。",
    "建议你已经在测试分支，或者项目有备份。",
    message,
  ]);
  const answer = trimAnswer(await rl.question("确认继续请输入：我确认\n> "));
  return answer === "我确认";
}

async function handleInit(rl) {
  const projectRoot = await askProjectRoot(rl);
  const projectName = trimAnswer(await rl.question("项目名称（直接回车 = demo）：")) || "demo";
  const result = initProject({ projectRoot, projectName });
  print([
    "",
    result.status === "success" ? "初始化完成。" : "初始化没有完成。",
    `项目：${result.project_root}`,
    result.created?.length ? `新建了 ${result.created.length} 个文件/目录。` : "没有新建文件，可能之前已经初始化过。",
  ]);
  if (result.next_actions?.length) {
    print(["下一步：", ...result.next_actions.map((item) => `- ${item}`)]);
  }
}

async function handlePlan(rl) {
  const projectRoot = await askProjectRoot(rl);
  const requirement = await askRequired(rl, "用大白话描述你想让 YOLO 做什么：");
  const title = trimAnswer(await rl.question("给这个任务起个名字（直接回车 = YOLO 任务）：")) || "YOLO 任务";
  const projectStateRoot = stateRootFor(projectRoot);
  const outputDir = join(projectStateRoot, "plans", `pi-${timestamp()}`);
  const result = await runPiAgent(
    { requirement, title, outputDir },
    { projectRoot, stateRoot: projectStateRoot, execute: false },
  );

  mkdirSync(outputDir, { recursive: true });
  const planPath = join(outputDir, "plan.md");
  writeFileSync(planPath, planToMarkdown(result), "utf8");

  print([
    "",
    result.status === "success" ? "计划已生成，没有改代码。" : "计划生成失败。",
    `计划文件：${planPath}`,
  ]);
  const dynamicResult = Object.assign(Object(), result);
  if (dynamicResult.plan?.actions?.length) {
    print(["YOLO 打算做这些事：", ...dynamicResult.plan.actions.map((action) => `- ${action.summary}`)]);
  }
}

async function handleCheck(rl) {
  const projectRoot = await askProjectRoot(rl);
  const prdInput = await askRequired(rl, "把 PRD JSON 文件路径粘贴到这里：");
  const prdPath = resolve(projectRoot, prdInput);
  if (!existsSync(prdPath)) {
    print(["找不到这个 PRD 文件。"]);
    return;
  }

  const result = inspectWizardCheck(projectRoot, prdPath);
  print(["", formatYoloCheckText(result)]);
}

async function handleRun(rl) {
  const projectRoot = await askProjectRoot(rl);
  const prdInput = await askRequired(rl, "把已经检查过的 PRD JSON 文件路径粘贴到这里：");
  const prdPath = resolve(projectRoot, prdInput);
  if (!existsSync(prdPath)) {
    print(["找不到这个 PRD 文件。"]);
    return;
  }

  const confirmed = await confirmDanger(rl, "如果不确定，请先选菜单 3 检查 PRD。");
  if (!confirmed) {
    print(["已取消，没有执行。"]);
    return;
  }

  const projectStateRoot = stateRootFor(projectRoot);
  const guard = inspectWizardRunGuard(projectRoot, prdPath);
  if (guard.status !== "pass") {
    print([
      "",
      "生命周期检查没有通过，已停止执行。",
      formatLifecycleGuardText(guard),
    ]);
    return;
  }
  const result = await runPiAgent({
    prdPath,
    mode: "fix",
  }, {
    projectRoot,
    stateRoot: projectStateRoot,
    execute: true,
  });
  print([
    "",
    `执行结果：${result.status || "unknown"}`,
    result.summary || "",
  ]);
  const artifacts = artifactLines(result.artifacts);
  if (artifacts.length) {
    print(["报告文件：", ...artifacts.map((item) => `- ${item}`)]);
  }
  if (result.next_actions?.length) {
    print(["下一步：", ...result.next_actions.map((item) => `- ${item}`)]);
  }
}

function showMenu() {
  print([
    "",
    "==============================",
    "YOLO 傻瓜菜单",
    "==============================",
    "1. 第一次接入项目：初始化",
    "2. 我有一个想法：只生成计划，不改代码",
    "3. 我有 PRD：先检查能不能执行",
    "4. 我有检查通过的 PRD：开始执行",
    "5. 退出",
    "",
  ]);
}

export async function runWizard() {
  print([
    "YOLO 会按“先检查，再执行”的方式工作。",
    "默认最安全的是菜单 2：只生成计划，不改代码。",
  ]);
  const rl = createInterface({ input, output });
  try {
    while (true) {
      showMenu();
      const choice = normalizeMenuChoice(await rl.question("请选择 1-5："));
      if (choice === "quit") break;
      if (choice === "init") await handleInit(rl);
      else if (choice === "plan") await handlePlan(rl);
      else if (choice === "check") await handleCheck(rl);
      else if (choice === "run") await handleRun(rl);
      else print(["没看懂，请输入 1、2、3、4 或 5。"]);
    }
  } finally {
    rl.close();
  }
  print(["已退出。"]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runWizard().catch((error) => {
    output.write(`\n出错了：${error.message}\n`);
    process.exitCode = 1;
  });
}
