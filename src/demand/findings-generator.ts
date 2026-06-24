/**
 * YOLO Demand — 需求 → 原子 findings JSON
 *
 * 输入需求描述，输出结构化 findings，直接喂给 audit-to-prd。
 * 从 src/pm/index.ts 迁移，demand 管道是唯一主线。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProviderPrompt as defaultSpawnProviderPrompt, YOLO_PACKAGE_ROOT } from "../runtime/execution/provider-adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");

// ── 输入/输出结构 ────────────────────────────────────────────────
// findings 来源于 provider 的 JSON 输出；这里只描述 validateFindings 实际消费
// 的字段（id/description/files）。其余字段（scope、conditions 等）原样透传给
// audit-to-prd，不强加窄类型，避免与下游真实结构冲突。
export interface ParsedFinding {
  id?: unknown;
  description?: unknown;
  files?: unknown;
  [key: string]: unknown;
}

export interface ParsedFindings {
  findings?: ParsedFinding[];
}

export interface FindingsValidation {
  ok: boolean;
  error?: string;
}

// generateFindings / generateFindingsFromRequirement return a heterogeneous
// result: success carries data (+ prompt/output_file for the from-requirement
// variant), failure carries an error and (sometimes) raw/partial output. The
// fields below are the union of everything callers (incl. src/runtime) read, all
// optional except `ok`, so the public boundary keeps its original dynamic-access
// shape without `any` (the N7 pitfall: narrowing the return broke callers that
// read .raw/.data/.output_file across branches).
export interface GenerateFindingsResult {
  ok: boolean;
  data?: ParsedFindings;
  error?: string;
  raw?: string;
  json?: string;
  prompt?: string;
  output_file?: string | null;
  provider_run?: unknown;
}

export interface FindingsParseResult {
  ok: boolean;
  data?: ParsedFindings;
  json?: string;
  error?: string;
  raw?: string;
}

// provider 运行结果由 provider-adapter 产生（该模块目前签名是隐式的，没有导出
// 类型）；这里只描述 generateFindings 实际读取的字段。
interface ProviderRun {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  reason?: string;
  [key: string]: unknown;
}

// generateFindings / generateFindingsFromRequirement 的调用选项。config 字段
// 透传给 findingsProviderConfig 再喂给 provider-adapter，这里保持宽松。
export interface GenerateFindingsOptions {
  config?: Record<string, unknown>;
  provider?: string;
  model?: string;
  settings?: string;
  claudePermissionMode?: string;
  claude_permission_mode?: string;
  projectRoot?: string;
  runtimeDir?: string;
  runtime_dir?: string;
  timeout_ms?: number;
  timeout?: number;
  outputFile?: string;
  spawnProviderPrompt?: (prompt: string, options: Record<string, unknown>) => Promise<ProviderRun>;
  detectModelProvider?: () => unknown;
  killTree?: unknown;
  spawnImpl?: unknown;
  commandExists?: unknown;
  existsSync?: unknown;
  readFileSync?: unknown;
  packageRoot?: string;
  projectContext?: string;
}

// ── 加载项目上下文 ───────────────────────────────────────────────
export function loadProjectContext(projectRoot: string = PACKAGE_ROOT) {
  const context: string[] = [];
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
export function buildPmPrompt(requirement: string, projectContext: string): string {
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
export function validateFindings(data: ParsedFindings | null | undefined): FindingsValidation {
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

function stripJsonCodeFences(text = "") {
  return text
    .replace(/```(?:json|JSON)?\s*/g, "")
    .replace(/```/g, "");
}

function extractBalancedJsonObject(text = "") {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }

  return null;
}

export function parseFindingsJsonOutput(text: string = ""): FindingsParseResult {
  const trimmed = stripJsonCodeFences(text).trim();
  try {
    return { ok: true, data: JSON.parse(trimmed), json: trimmed };
  } catch {
    const balanced = extractBalancedJsonObject(trimmed);
    if (!balanced) {
      return { ok: false, error: "未找到有效 JSON 输出", raw: trimmed.slice(0, 500) };
    }
    try {
      return { ok: true, data: JSON.parse(balanced), json: balanced };
    } catch (balancedError) {
      return { ok: false, error: `JSON 解析失败: ${(balancedError as Error).message}`, raw: balanced.slice(0, 500) };
    }
  }
}

// ── 调模型生成 findings ──────────────────────────────────────────
function findingsProviderConfig(options: GenerateFindingsOptions = Object()): Record<string, unknown> {
  const config = options.config || {};
  const ai = (config.ai as Record<string, unknown>) || {};
  const provider = options.provider || ai.provider || ai.executor || "claude";
  return {
    ...config,
    ai: {
      ...ai,
      provider,
      executor: ai.executor || provider,
      model: options.model || ai.model || "claude-sonnet-4-6",
      settings: options.settings ?? ai.settings ?? "settings-minimal.json",
      claude_permission_mode: options.claudePermissionMode || options.claude_permission_mode || ai.claude_permission_mode || "acceptEdits",
    },
  };
}

export async function generateFindings(prompt: string, timeout: number = 300000, options: GenerateFindingsOptions = Object()): Promise<GenerateFindingsResult> {
  const projectRoot = resolve(options.projectRoot || PACKAGE_ROOT);
  const runtimeDir = resolve(options.runtimeDir || options.runtime_dir || join(projectRoot, "tmp"));
  try { mkdirSync(runtimeDir, { recursive: true }); } catch {}
  const spawnProviderPrompt = options.spawnProviderPrompt || defaultSpawnProviderPrompt;
  let providerRun: ProviderRun | undefined;
  try {
    providerRun = await spawnProviderPrompt(prompt, {
      timeout,
      cwd: projectRoot,
      rootDir: projectRoot,
      runtimeDir,
      config: findingsProviderConfig(options),
      detectModelProvider: options.detectModelProvider,
      killTree: options.killTree,
      spawnImpl: options.spawnImpl,
      commandExists: options.commandExists,
      existsSync: options.existsSync,
      readFileSync: options.readFileSync,
      packageRoot: options.packageRoot || YOLO_PACKAGE_ROOT,
    });
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  if (providerRun && providerRun.success === false) {
    return {
      ok: false,
      error: providerRun.reason || providerRun.stderr || "provider failed",
      provider_run: providerRun,
    };
  }

  const parsed = parseFindingsJsonOutput(providerRun?.stdout || "");
  if (!parsed.ok) return parsed;
  const validation = validateFindings(parsed.data!);
  if (!validation.ok) {
    return { ok: false, error: validation.error, raw: parsed.json!.slice(0, 500) };
  }
  return { ok: true, data: parsed.data };
}

export async function generateFindingsFromRequirement(input: string | { requirement?: unknown; [key: string]: unknown }, options: GenerateFindingsOptions = Object()): Promise<GenerateFindingsResult> {
  const requirement = typeof input === "string" ? input : (input?.requirement as string);
  if (!requirement || !requirement.trim()) {
    return { ok: false, error: "缺少需求描述" };
  }

  const projectRoot = resolve(options.projectRoot || PACKAGE_ROOT);
  const projectContext = options.projectContext ?? loadProjectContext(projectRoot);
  const prompt = buildPmPrompt(requirement, projectContext);
  const result: GenerateFindingsResult = await generateFindings(prompt, options.timeout_ms || options.timeout || 300000, {
    projectRoot,
    model: options.model,
    settings: options.settings,
  });

  if (result.ok && options.outputFile) {
    mkdirSync(dirname(resolve(options.outputFile)), { recursive: true });
    writeFileSync(resolve(options.outputFile), JSON.stringify(result.data, null, 2), "utf8");
  }

  return result.ok
    ? { ...result, prompt, output_file: options.outputFile ? resolve(options.outputFile) : null }
    : result;
}
