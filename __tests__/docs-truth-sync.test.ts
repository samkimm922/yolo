import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildAgentBridgeInstallPlan } from "../tools/install-agent-bridge.js";
import { listYoloCommands } from "../src/workflows/command-registry.js";
import { refreshMemoryCenter } from "../src/runtime/memory/center.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");

function countFiles(root, predicate) {
  let count = 0;
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) count += countFiles(path, predicate);
    else if (predicate(path)) count += 1;
  }
  return count;
}

function countRootFiles(root, predicate) {
  return readdirSync(root)
    .map((entry) => join(root, entry))
    .filter((path) => statSync(path).isFile() && predicate(path))
    .length;
}

function lineCount(filePath) {
  return readFileSync(filePath, "utf8").split("\n").length - 1;
}

function repoTruth() {
  const packageJson = JSON.parse(readFileSync(join(YOLO_DIR, "package.json"), "utf8"));
  return {
    packageJson,
    srcModules: countFiles(join(YOLO_DIR, "src"), (path) => path.endsWith(".ts")),
    testFiles: countFiles(join(YOLO_DIR, "__tests__"), (path) => path.endsWith(".test.ts")),
    docsMarkdown: countFiles(join(YOLO_DIR, "docs"), (path) => path.endsWith(".md")),
    rootTs: countRootFiles(YOLO_DIR, (path) => path.endsWith(".ts")),
    rootJs: countRootFiles(YOLO_DIR, (path) => path.endsWith(".js")),
    runnerLines: lineCount(join(YOLO_DIR, "runner.ts")),
    runnerCoreLines: lineCount(join(YOLO_DIR, "src/runtime/runner-core.ts")),
    exportCount: Object.keys(packageJson.exports).length,
    binCount: Object.keys(packageJson.bin).length,
  };
}

function extractCodeBlockAfter(text, label) {
  const index = text.indexOf(label);
  assert.notEqual(index, -1, `missing label: ${label}`);
  const rest = text.slice(index);
  const match = rest.match(/```(?:text|bash)?\n([\s\S]*?)\n```/);
  assert.ok(match, `missing code block after: ${label}`);
  return match[1].trim();
}

describe("docs truth sync", () => {
  test("progress and gap docs track current structure numbers", () => {
    const truth = repoTruth();
    const progress = readFileSync(join(YOLO_DIR, "docs/yolo-public-sdk-progress.md"), "utf8");
    const gap = readFileSync(join(YOLO_DIR, "docs/sdk-gap-matrix.md"), "utf8");

    assert.match(progress, new RegExp(`\\| \`runner\\.ts\` 行数 \\| ${truth.runnerLines} \\|`));
    assert.match(progress, new RegExp(`\\| \`src/runtime/runner-core\\.ts\` 行数 \\| ${truth.runnerCoreLines} \\|`));
    assert.match(progress, new RegExp(`\\| 根目录 \`\\.ts\` 文件 \\| ${truth.rootTs} \\|`));
    assert.match(progress, new RegExp(`\\| \`src/\\*\\*/\\*\\.ts\` 文件 \\| ${truth.srcModules} \\|`));
    assert.match(progress, new RegExp(`\\| 测试文件 \\| ${truth.testFiles} \\|`));
    assert.match(progress, new RegExp(`\\| package exports \\| ${truth.exportCount} \\|`));
    assert.match(progress, new RegExp(`\\| package bins \\| ${truth.binCount} \\|`));
    assert.match(progress, new RegExp(`\\| \`docs/\\*\\*/\\*\\.md\` 文件 \\| ${truth.docsMarkdown} \\|`));
    assert.match(gap, new RegExp(`package\\.json\` 已有 ${truth.exportCount} 个 package exports、${truth.binCount} 个 bin`));
    assert.match(gap, new RegExp(`\`src/\\*\\*/\\*\\.ts\` ${truth.srcModules} 个`));
    assert.match(gap, new RegExp(`\`__tests__/\\*\\.test\\.ts\` ${truth.testFiles} 个`));
    assert.match(gap, new RegExp(`\`docs/\\*\\*/\\*\\.md\` ${truth.docsMarkdown} 个`));
    assert.match(gap, new RegExp(`根目录 \`\\.ts\` ${truth.rootTs} 个`));
  });

  test("docs/memory canonical status tracks current structure numbers", () => {
    const truth = repoTruth();

    assert.ok(truth.srcModules > 0, "src module count must be non-zero in this repository");
    assert.ok(truth.testFiles > 0, "test file count must be non-zero in this repository");
    assert.ok(truth.docsMarkdown > 0, "docs markdown count must be non-zero in this repository");
    assert.ok(truth.rootTs > 0, "root .ts count must be non-zero in this repository");

    refreshMemoryCenter({ projectRoot: YOLO_DIR, stateRoot: YOLO_DIR });

    const statusText = readFileSync(join(YOLO_DIR, "docs/memory/CURRENT_STATUS.md"), "utf8");
    assert.match(statusText, new RegExp(`SDK surface: ${truth.exportCount} package exports and ${truth.binCount} bins\\.`));
    assert.match(
      statusText,
      new RegExp(`Source/test/docs surface: ${truth.srcModules} src modules, ${truth.testFiles} test files, ${truth.docsMarkdown} docs markdown files, ${truth.rootTs} root \\.ts files\\.`),
    );
    assert.doesNotMatch(statusText, /0 src modules, 0 test files/);
    assert.match(statusText, /`private: true` blocks release/);
    assert.match(statusText, /billable execution, and public dogfood/);

    const treeText = readFileSync(join(YOLO_DIR, "docs/memory/PROJECT_TREE.md"), "utf8");
    assert.match(treeText, new RegExp(`package exports: ${truth.exportCount}`));
    assert.match(treeText, new RegExp(`package bins: ${truth.binCount}`));
    assert.match(treeText, new RegExp(`root \\.js files: ${truth.rootJs}`));
    assert.match(treeText, new RegExp(`root \\.ts files: ${truth.rootTs}`));
    assert.match(treeText, new RegExp(`src \\.ts files: ${truth.srcModules}`));
    assert.match(treeText, new RegExp(`test files: ${truth.testFiles}`));
    assert.match(treeText, new RegExp(`docs markdown files: ${truth.docsMarkdown}`));
    assert.doesNotMatch(treeText, /package exports: 50|src \.js files: 0|test files: 0/);
  });

  test("README references docs/quickstart.md at canonical path", () => {
    const readmePath = join(YOLO_DIR, "README.md");
    const quickstartPath = join(YOLO_DIR, "docs/quickstart.md");
    assert.equal(existsSync(quickstartPath), true, "docs/quickstart.md must exist as canonical quickstart");
    const readme = readFileSync(readmePath, "utf8");
    assert.ok(readme.includes("docs/quickstart.md"), "README must reference docs/quickstart.md");
  });

  test("README and quickstart track the registered 4-verb command surface and installer manifest", () => {
    const commands = listYoloCommands({ recommended: true });
    const commandNames = commands.map((command) => command.name);
    const slashCommands = commandNames.map((name) => `/yolo-${name}`);
    const readme = readFileSync(join(YOLO_DIR, "README.md"), "utf8");
    const quickstart = readFileSync(join(YOLO_DIR, "docs/quickstart.md"), "utf8");
    const docs = `${readme}\n${quickstart}`;

    assert.deepEqual(commandNames, ["demand", "auto", "ship", "status"]);
    assert.match(docs, /demand -> auto -> ship -> status/);
    assert.doesNotMatch(docs, /8 个稳定入口|8 个稳定 slash commands|8 stable/);
    for (const command of slashCommands) {
      assert.match(docs, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    const installPrompt = extractCodeBlockAfter(quickstart, "让 agent 安装 YOLO bridge 时");
    for (const command of slashCommands) {
      assert.ok(installPrompt.includes(command), `install prompt must include ${command}`);
    }
    for (const hidden of ["/yolo-spec", "/yolo-tasks", "/yolo-run", "/yolo-check", "/yolo-review", "/yolo-release"]) {
      assert.match(installPrompt, new RegExp(`不要生成[\\s\\S]*${hidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }

    const plan = buildAgentBridgeInstallPlan({
      projectRoot: "/tmp/yolo-docs-truth-project",
      homeDir: "/tmp/yolo-docs-truth-home",
      yoloRoot: YOLO_DIR,
      targets: "both",
      scope: "project",
    });
    assert.deepEqual(plan.commands.map((command) => command.name), commandNames);

    const installerManifest = [
      ...plan.files,
      ...plan.native_skill_files,
      ...plan.claude_slash_commands,
    ].map((file) => file.relative_path);
    const documentedManifest = extractCodeBlockAfter(quickstart, "安装器的 project scope 清单是")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    assert.deepEqual(documentedManifest, installerManifest);
    assert.deepEqual(
      plan.claude_slash_commands.map((file) => `/${file.command}`),
      slashCommands,
    );
  });

  test("init-to-first-prd smoke does not bypass lifecycle sequence check", () => {
    const initSmokePath = join(YOLO_DIR, "src/core/init-smoke.ts");
    const content = readFileSync(initSmokePath, "utf8");
    assert.ok(!content.includes("skipSequenceCheck"), "init-smoke must not use skipSequenceCheck bypass");
    assert.ok(!content.includes("skip_sequence_check"), "init-smoke must not use skip_sequence_check bypass");
  });

  test("demand doctrine documents the nontechnical-to-atomic-task flow", () => {
    const doctrinePath = join(YOLO_DIR, "docs/yolo-demand-doctrine.md");
    const planPath = join(YOLO_DIR, "docs/yolo-demand-implementation-plan.md");

    assert.equal(existsSync(doctrinePath), true);
    assert.equal(existsSync(planPath), true);

    const doctrine = readFileSync(doctrinePath, "utf8");
    const plan = readFileSync(planPath, "utf8");

    for (const keyword of [
      "一问一答",
      "先问题后方案",
      "现状",
      "痛点",
      "证明",
      "边界",
      "批准",
      "gstack / superpowers",
      "mattpocock skills",
      "Spec Kit / OpenSpec",
      "GSD / product-manager-skills",
      "intake -> scenario matrix -> surfaces -> one-session task -> handoff -> gates",
      "CURRENT_HANDOFF.md",
      "CURRENT_STATUS.md",
      "PROJECT_TREE.md",
      "questions.jsonl",
      "decisions.jsonl",
      "session-memory.jsonl",
    ]) {
      assert.match(doctrine, new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    const tasks = plan.match(/^- \[ \] Task \d{2}:/gm) || [];
    assert.equal(tasks.length, 32);
    assert.match(plan, /Intake 与一问一答/);
    assert.match(plan, /Scenario Matrix/);
    assert.match(plan, /Surfaces/);
    assert.match(plan, /One-session Atomic Tasks/);
    assert.match(plan, /Handoff/);
    assert.match(plan, /Gates 与批准/);
    assert.match(plan, /Memory 与文档验证/);
  });
});
