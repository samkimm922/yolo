/**
 * YOLO Demand — 需求 → 原子 findings JSON
 *
 * 输入需求描述，输出结构化 findings，直接喂给 audit-to-prd。
 * 从 src/pm/index.ts 迁移，demand 管道是唯一主线。
 */

import { createReadStream, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveClaudeSettings, YOLO_PACKAGE_ROOT } from "../runtime/execution/provider-adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");

// ── 加载项目上下文 ───────────────────────────────────────────────
export function loadProjectContext(projectRoot = PACKAGE_ROOT) {
  const context = [];
  const claudeMd = join(projectRoot, ".claude", "CLAUDE.md");
  if (existsSync(claudeMd)) {
    const md = readFileSync(claudeMd, "utf8");
    const techMatch = md.match(/## §8 技术栈[\s\S]*?(?=## §|$)/);
    if (techMatch) context.push(techMatch[0].slice(0, 500));
    const posMatch = md.match(/## §10 项目定位[\s\S]*?(?=## §|$)/);
    if (posMatch) context.push(posMatch[0].slice(0, 300));
  }
  const pkgJson = join(projectRoot, "package.json");
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      context.push(`框架: ${pkg.dependencies?.["@tarojs/taro"] ? "Taro (React)" : "Node.js"}`);
      context.push(`包管理: pnpm`);
    } catch {}
  }
  return context.join("\n");
}

// ── PM Prompt 模板 ────────────────────────────────────────────────
export function buildPmPrompt(requirement, projectContext) {
  return `你是一个产品经理。把下面的需求拆成原子开发任务，输出结构化 JSON。

## 项目背景
${projectContext || "通用 TypeScript/React 项目"}

## 用户需求
${requirement}

## 拆分规则

1. 每个 task 必须是一个**独立的、可单独验证的**工作单元
2. 有依赖关系的 task，depends_on 必须写明
3. 每个 task 的 scope 必须精确到文件路径（猜测合理的文件路径）
4. 类型定义 → service 层 → hook 层 → 页面/组件，按这个顺序
5. 涉及 UI 的 task 要写明 pre_conditions（设计 token、组件库等）
6. 涉及数据的 task 要写明 post_conditions（数据库变更、API 兼容等）
7. 每个 scope.targets 里的文件，post_conditions 必须至少有一个可执行 FAIL 条件点名覆盖它（例如 file_exists、target_file_modified、code_contains、code_not_contains）

## 输出格式

只输出 JSON，不要任何其他文字：

{
  "findings": [
    {
      "id": "DEV-001",
      "title": "功能简述",
      "severity": "HIGH",
      "dimension": "feature",
      "kind": "atomic_feature",
      "type": "new_page",
      "priority": "P1",
      "description": "详细描述：做什么、为什么、怎么做",
      "files": ["src/pages/xxx.tsx"],
      "suggestion": "实现建议",
      "depends_on": [],
      "scope": {
        "targets": [{"file": "src/pages/xxx.tsx"}],
        "max_files": 5,
        "max_lines_per_file": 150
      },
      "pre_conditions": [],
      "post_conditions": [
        {
          "id": "POST-FILE",
          "type": "file_exists",
          "severity": "FAIL",
          "params": { "file": "src/pages/xxx.tsx" }
        },
        {
          "id": "POST-TSC",
          "type": "no_new_type_errors",
          "severity": "FAIL",
          "params": { "command": "npm run typecheck" }
        }
      ]
    }
  ]
}

## severity 和 priority 对应关系
- CRITICAL / P0: 核心功能缺失，阻塞其他所有 task
- HIGH / P1: 主要功能，有依赖关系
- MEDIUM / P2: 辅助功能、优化
- LOW / P3: 锦上添花

pre_conditions/post_conditions 必须使用上面的对象格式，不能输出字符串数组。
不要只给 no_new_type_errors/tests_pass/build_pass 这类项目级 gate；它们不能替代目标文件级 gate。

现在开始拆分。只输出 JSON。`;
}

// ── 验证 findings 格式 ────────────────────────────────────────────
export function validateFindings(data) {
  if (!data || !Array.isArray(data.findings)) {
    return { ok: false, error: "缺少 findings 数组" };
  }
  for (const f of data.findings) {
    if (!f.id) return { ok: false, error: `finding 缺少 id: ${JSON.stringify(f).slice(0, 100)}` };
    if (!f.description) return { ok: false, error: `${f.id} 缺少 description` };
    if (!f.files || !Array.isArray(f.files)) return { ok: false, error: `${f.id} 缺少 files 数组` };
  }
  return { ok: true };
}

// ── 调模型生成 findings ──────────────────────────────────────────
export async function generateFindings(prompt, timeout = 300000, options = Object()) {
  const projectRoot = resolve(options.projectRoot || PACKAGE_ROOT);
  const tmpFile = join(projectRoot, "tmp", `yolo-pm-prompt-${Date.now()}.txt`);
  try { mkdirSync(dirname(tmpFile), { recursive: true }); } catch {}
  writeFileSync(tmpFile, prompt, "utf8");

  const settingsRaw = options.settings || "settings-minimal.json";
  const resolvedSettings = resolveClaudeSettings(projectRoot, settingsRaw, { packageRoot: YOLO_PACKAGE_ROOT });
  let settingsArg = resolvedSettings.value;
  let settingsTempFile = null;
  if (resolvedSettings.type === "inline") {
    settingsTempFile = join(projectRoot, "tmp", `yolo-pm-settings-${Date.now()}.json`);
    writeFileSync(settingsTempFile, settingsArg, "utf8");
    settingsArg = settingsTempFile;
  }

  return new Promise((res) => {
    let done = false;
    const child = spawn("claude", [
      "--model", options.model || "claude-sonnet-4-6",
      "--dangerously-skip-permissions",
      "--settings", settingsArg,
    ], { cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"] });

    let out = "", err = "";
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);

    // Stream prompt file to stdin
    const promptStream = createReadStream(tmpFile);
    promptStream.pipe(child.stdin);
    promptStream.on("error", e => {
      child.stdin.end();
      err += `\n[stdin error:${e.message}]`;
    });

    const timer = setTimeout(() => {
      if (!done) { done = true; child.kill("SIGKILL"); res({ ok: false, error: "timeout" }); }
    }, timeout);

    child.on("close", code => {
      clearTimeout(timer);
      try { unlinkSync(tmpFile); } catch {}
      try { if (settingsTempFile) unlinkSync(settingsTempFile); } catch {}
      if (done) return;
      done = true;

      const text = out.trim();
      const jsonMatch = text.match(/\{[\s\S]*?"findings"[\s\S]*?\}/);
      if (!jsonMatch) {
        res({ ok: false, error: "未找到有效 JSON 输出", raw: text.slice(0, 500) });
        return;
      }
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const validation = validateFindings(parsed);
        if (!validation.ok) {
          res({ ok: false, error: validation.error, raw: jsonMatch[0].slice(0, 500) });
          return;
        }
        res({ ok: true, data: parsed });
      } catch (e) {
        res({ ok: false, error: `JSON 解析失败: ${e.message}`, raw: jsonMatch[0].slice(0, 500) });
      }
    });

    child.on("error", e => {
      clearTimeout(timer);
      try { unlinkSync(tmpFile); } catch {}
      try { if (settingsTempFile) unlinkSync(settingsTempFile); } catch {}
      if (!done) { done = true; res({ ok: false, error: e.message }); }
    });
  });
}

export async function generateFindingsFromRequirement(input, options = Object()) {
  const requirement = typeof input === "string" ? input : input?.requirement;
  if (!requirement || !requirement.trim()) {
    return { ok: false, error: "缺少需求描述" };
  }

  const projectRoot = resolve(options.projectRoot || PACKAGE_ROOT);
  const projectContext = options.projectContext ?? loadProjectContext(projectRoot);
  const prompt = buildPmPrompt(requirement, projectContext);
  const result = Object.assign(Object(), await generateFindings(prompt, options.timeout_ms || options.timeout || 300000, {
    projectRoot,
    model: options.model,
    settings: options.settings,
  }));

  if (result.ok && options.outputFile) {
    mkdirSync(dirname(resolve(options.outputFile)), { recursive: true });
    writeFileSync(resolve(options.outputFile), JSON.stringify(result.data, null, 2), "utf8");
  }

  return result.ok
    ? { ...result, prompt, output_file: options.outputFile ? resolve(options.outputFile) : null }
    : result;
}
