#!/usr/bin/env node
// review-scanner.js — 确定性全量代码扫描器
// 覆盖 5 个维度，grep 所有 src/ 文件，100% 不漏检
// 输出 JSON 数组，每项包含 dimension/file/line/match/description

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { extname, resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../lib/config.js";
import { buildReviewOutput, normalizeReviewFindings } from "./findings.js";
import type { NormalizedReviewFinding, ReviewFindingInput, ReviewFixType, ReviewSeverity } from "./findings.js";
import { redact } from "../lib/security/redact.js";
import { execCommand } from "../lib/security/safe-exec.js";
import type { ExecCommandResult } from "../lib/security/safe-exec.js";
import { resolveGateTimeout } from "../lib/toolchain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const REVIEW_SCANNER_VERSION = "review-scanner@1";

type ScannerProjectConfig = {
  root?: string;
  src?: string;
  source_roots?: string[];
  source_extensions?: string[];
  framework?: string;
  exclude?: string[];
};

type ScannerConfig = {
  [key: string]: unknown;
  project: ScannerProjectConfig;
  build: {
    type_check?: string;
    lint?: string;
  };
  gate: {
    max_lines_per_file?: number;
    timeout?: {
      type_check?: number;
      lint?: number;
    };
  };
};

type ScannerOptions = {
  [key: string]: unknown;
  config?: ScannerConfig;
  root?: string;
  source_roots?: string[];
  sourceRoots?: string[];
  source_extensions?: Iterable<string>;
  sourceExtensions?: Iterable<string>;
  exclude?: Iterable<string>;
  files?: string[];
  scopeFiles?: string[];
  scope_files?: string[];
  framework?: string;
  max_file_lines?: number;
  maxFileLines?: number;
  enforceFileLength?: boolean;
  includeExternalChecks?: boolean;
};

type ScannerSettings = {
  config: ScannerConfig;
  root: string;
  sourceRoots: string[];
  sourceExtensions: Set<string>;
  excludeDirs: Set<string>;
  files: string[];
  framework: string;
  enableMiniprogramRules: boolean;
  maxFileLines: number;
  enforceFileLength: boolean;
  includeExternalChecks: boolean;
};

type ScannerRule = {
  id: string;
  dimension: string;
  severity: ReviewSeverity;
  fix_type: ReviewFixType;
  pattern: RegExp;
  description: string;
  platform?: "miniprogram";
  extraCheck?: (line: string) => boolean;
  exclude?: (file: string) => boolean;
};

type ScannerRawFinding = ReviewFindingInput & {
  scanner_id: string;
  dimension: string;
  severity: ReviewSeverity;
  file: string | null;
  line: number;
  fix_type: ReviewFixType;
  match: string;
  description: string;
  context?: string;
};

type CoverageArtifact = {
  scanner_version: string;
  scanned_files: string[];
  rules: string[];
  expected_scope: string[];
  coverage_status: "complete" | "incomplete";
  missing_expected_files: string[];
};

export type ReviewScannerResult = {
  schema_version: ReturnType<typeof buildReviewOutput>["schema_version"];
  schema: ReturnType<typeof buildReviewOutput>["schema"];
  timestamp: string;
  generated_at: string;
  source: string;
  scanned_files: number;
  coverage_artifact: CoverageArtifact;
  total_findings: number;
  by_dimension: Record<string, number>;
  by_severity: Record<string, number>;
  summary: ReturnType<typeof buildReviewOutput>["summary"];
  findings: NormalizedReviewFinding[];
};

type EslintMessage = {
  severity?: number;
  fix?: unknown;
  ruleId?: string | null;
  line?: number;
  message?: string;
  source?: string;
};

type EslintResult = {
  filePath?: string;
  messages?: EslintMessage[];
};

function requiredConfigRoot(root: string | undefined): string {
  if (typeof root === "string") return root;
  throw new TypeError("config.project.root must be a string");
}

function errorOutput(error: unknown): { stdout?: unknown; stderr?: unknown } | null {
  return typeof error === "object" && error !== null ? error : null;
}

function scannerSettings(options: ScannerOptions = Object()): ScannerSettings {
  const cfg: ScannerConfig = options.config || config;
  const root = resolve(options.root || resolve(PACKAGE_ROOT, requiredConfigRoot(cfg.project.root)));
  const sourceRoots: string[] = options.source_roots || options.sourceRoots || cfg.project.source_roots || [cfg.project.src || "src"];
  const sourceExtensions: Set<string> = new Set(options.source_extensions || options.sourceExtensions || cfg.project.source_extensions || [".ts", ".tsx", ".js", ".jsx"]);
  const excludeDirs: Set<string> = new Set(options.exclude || cfg.project.exclude || ["node_modules", "dist", ".git"]);
  const framework = String(options.framework || cfg.project.framework || "generic").toLowerCase();
  const files: string[] = (options.files || options.scopeFiles || options.scope_files || [])
    .map((file) => String(file || "").trim())
    .filter(Boolean);
  const hasExplicitFileLengthPolicy = Object.prototype.hasOwnProperty.call(options, "enforceFileLength");
  return {
    config: cfg,
    root,
    sourceRoots,
    sourceExtensions,
    excludeDirs,
    files,
    framework,
    enableMiniprogramRules: /(taro|mini|weapp|wechat)/i.test(framework),
    maxFileLines: options.max_file_lines || options.maxFileLines || cfg.gate.max_lines_per_file || 150,
    enforceFileLength: hasExplicitFileLengthPolicy ? options.enforceFileLength === true : files.length === 0,
    includeExternalChecks: files.length > 0 ? options.includeExternalChecks === true : options.includeExternalChecks !== false,
  };
}

function isSourceFile(file: string, settings: ScannerSettings): boolean {
  return settings.sourceRoots.some((root) => file === root || file.startsWith(`${root}/`));
}

function isTestFile(file: string): boolean {
  return file.includes("__tests__/") || file.includes(".test.") || file.includes(".spec.");
}

function isScannerDefinitionFile(file: string): boolean {
  return file === "src/review/scanner.ts" || file.endsWith("/src/review/scanner.ts");
}

function isLikelyCliStdoutConsoleLog(line: string): boolean {
  const trimmed = line.trim();
  return /^console\.log\(\s*(markdown|report|output|result|stdout|json|JSON\.stringify\()/i.test(trimmed);
}

// ── 扫描规则定义 ──────────────────────────────────────────────

const RULES: ScannerRule[] = [
  // === 1. Code（代码质量）===
  {
    id: "R6-as-any",
    dimension: "code",
    severity: "MEDIUM",
    fix_type: "CLAUDE_FIX",
    pattern: /\bas\s+any\b/g,
    description: '违反 R6 规则：使用 "as any" 类型断言',
  },
  {
    id: "R6-as-unknown-as",
    dimension: "code",
    severity: "MEDIUM",
    fix_type: "CLAUDE_FIX",
    pattern: /\bas\s+unknown\s+as\s+/g,
    description: '违反 R6 规则：使用 "as unknown as" 双重类型断言',
  },
  {
    id: "debug-console-log",
    dimension: "code",
    severity: "LOW",
    fix_type: "AUTO_FIX",
    pattern: /\bconsole\.log\(/g,
    description: "调试残留：console.log",
    // 排除测试文件和脚本
    exclude: (file) => isTestFile(file),
    extraCheck: (line) => !isLikelyCliStdoutConsoleLog(line),
  },
  {
    id: "debug-debugger",
    dimension: "code",
    severity: "MEDIUM",
    fix_type: "AUTO_FIX",
    pattern: /\bdebugger\b/g,
    description: "调试残留：debugger 语句",
  },
  {
    id: "todo-fixme",
    dimension: "code",
    severity: "LOW",
    fix_type: "INFO",
    pattern: /\b(TODO|FIXME|HACK|XXX)\b/g,
    description: "遗留标记：TODO/FIXME/HACK",
  },
  {
    id: "window-document",
    dimension: "code",
    severity: "HIGH",
    fix_type: "CLAUDE_FIX",
    pattern: /\b(window\.\w+|document\.\w+)\b/g,
    description: "违反 R4 规则：小程序禁止使用 window/document",
    platform: "miniprogram",
    exclude: (file) => isTestFile(file) || file.includes(".d.ts"),
  },

  // === 2. Security（安全）===
  {
    id: "hardcoded-credentials",
    dimension: "security",
    severity: "CRITICAL",
    fix_type: "CLAUDE_FIX",
    pattern: /(?:api[_-]?key|password|secret|Bearer\s+\S{10,}|sk-[a-zA-Z0-9]{20,})/gi,
    description: "硬编码凭证",
    exclude: (file) => isTestFile(file) || isScannerDefinitionFile(file) || file.includes(".d.ts") || file.includes("global.d.ts"),
  },
  {
    id: "xss-innerHTML",
    dimension: "security",
    severity: "HIGH",
    fix_type: "CLAUDE_FIX",
    pattern: /(?:innerHTML|dangerouslySetInnerHTML)/g,
    description: "XSS 风险：innerHTML / dangerouslySetInnerHTML",
    exclude: (file) => isTestFile(file) || isScannerDefinitionFile(file) || file.includes(".d.ts"),
  },
  {
    id: "code-injection",
    dimension: "security",
    severity: "HIGH",
    fix_type: "CLAUDE_FIX",
    pattern: /(?:\beval\s*\(|new\s+Function\s*\()/g,
    description: "代码注入风险：eval / Function 构造器",
    exclude: (file) => isTestFile(file) || isScannerDefinitionFile(file),
  },

  // === 3. Service（服务层）===
  {
    id: "raw-collection",
    dimension: "service",
    severity: "MEDIUM",
    fix_type: "AUTO_FIX",
    pattern: /db\.collection\s*\(\s*['"][^'"]+['"]\s*\)/g,
    description: "未使用 COLLECTIONS 常量，直接字符串调用 db.collection()",
    platform: "miniprogram",
    exclude: (file) => isTestFile(file),
  },
  {
    id: "update-no-version",
    dimension: "service",
    severity: "MEDIUM",
    fix_type: "CLAUDE_FIX",
    // 匹配 .doc(xxx).update( 但同一行不包含 version
    pattern: /\.doc\s*\(.*?\)\s*\.update\s*\(/g,
    description: ".doc().update() 缺少乐观锁（version 字段）",
    platform: "miniprogram",
    // 额外检查：同一行是否包含 version
    extraCheck: (line) => !/version/i.test(line),
    exclude: (file) => isTestFile(file),
  },

  // === 4. Performance（性能）===
  {
    id: "while-no-cursor",
    dimension: "perf",
    severity: "MEDIUM",
    fix_type: "CLAUDE_FIX",
    pattern: /\bwhile\s*\(/g,
    description: "while 循环缺少游标推进机制",
    // 不用 extraCheck，改为跨行上下文检查（检查整个循环体）
    exclude: (file) => isTestFile(file),
  },

  // === 5. API（接口）===
  {
    id: "cloud-function-no-try",
    dimension: "api",
    severity: "MEDIUM",
    fix_type: "CLAUDE_FIX",
    pattern: /wx\.cloud\.callFunction/g,
    description: "云函数调用：需确认有 try/catch 包裹",
    platform: "miniprogram",
    exclude: (file) => isTestFile(file),
  },
  {
    id: "usedidshow-no-refetch",
    dimension: "api",
    severity: "MEDIUM",
    fix_type: "CLAUDE_FIX",
    pattern: /\buseDidShow\b/g,
    description: "useDidShow：需确认有数据刷新调用",
    platform: "miniprogram",
    exclude: (file) => isTestFile(file),
  },
];

// ── 文件遍历 ──────────────────────────────────────────────────

function ruleEnabled(rule: ScannerRule, settings: ScannerSettings): boolean {
  if (rule.platform === "miniprogram") return settings.enableMiniprogramRules;
  return true;
}

function repoRelativePath(absPath: string, settings: ScannerSettings): string {
  return absPath
    .replace(settings.root + "/", "")
    .replace(settings.root + "\\", "")
    .replace(/\\/g, "/");
}

function enabledRuleIds(settings: ScannerSettings): string[] {
  return RULES.filter((rule) => ruleEnabled(rule, settings)).map((rule) => rule.id);
}

function buildCoverageArtifact({ settings, files }: { settings: ScannerSettings; files: string[] }): CoverageArtifact {
  const scannedFiles = files.map((file) => repoRelativePath(file, settings)).sort();
  const expectedScope = settings.files.length > 0 ? settings.files : settings.sourceRoots;
  const missingExpectedFiles = settings.files.filter((file) => !scannedFiles.includes(file));
  return {
    scanner_version: REVIEW_SCANNER_VERSION,
    scanned_files: scannedFiles,
    rules: enabledRuleIds(settings),
    expected_scope: expectedScope,
    coverage_status: missingExpectedFiles.length === 0 ? "complete" : "incomplete",
    missing_expected_files: missingExpectedFiles,
  };
}

function typecheckToolUnavailableFinding(result: ExecCommandResult, output: string): ScannerRawFinding {
  const reason = result.rejected
    ? `command rejected: ${result.reject_detail || result.reject_reason || "unsafe command"}`
    : result.command_not_found
      ? "command not found"
      : result.timed_out
        ? "type_check timed out"
        : `type_check exited ${result.exit_code ?? "unknown"} without parseable TypeScript errors`;
  return {
    scanner_id: "typecheck-tool-unavailable",
    dimension: "code",
    severity: "HIGH",
    file: null,
    line: 0,
    fix_type: "MANUAL_REVIEW",
    match: reason,
    description: `Type check tool unavailable or unverifiable: ${reason}`,
    context: redact(String(output || result.error || "").trim().slice(0, 120)),
  };
}

function getAllSourceFiles(dir: string, settings: ScannerSettings): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (settings.excludeDirs.has(entry.name)) continue;
        files.push(...getAllSourceFiles(full, settings));
      } else if (settings.sourceExtensions.has(extname(entry.name))) {
        files.push(full);
      }
    }
  } catch { /* permission error, skip */ }
  return files;
}

// ── 扫描单个文件 ──────────────────────────────────────────────

export function scanFile(absPath: string, options: ScannerOptions = Object()): NormalizedReviewFinding[] {
  const settings = scannerSettings(options);
  const relPath = absPath.replace(settings.root + "/", "");
  const findings: ScannerRawFinding[] = [];

  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split("\n");
  const lineCount = lines.length;

  // R9: 文件行数检查
  if (settings.enforceFileLength && lineCount > settings.maxFileLines) {
    findings.push({
      scanner_id: "R9-file-length",
      dimension: "code",
      severity: "MEDIUM",
      file: relPath,
      line: 0,
      fix_type: "CLAUDE_FIX",
      match: `${lineCount} 行`,
      description: `文件 ${lineCount} 行，超过 ${settings.maxFileLines} 行限制（R9 规则），必须拆分`,
    });
  }

  // 逐行扫描规则
  for (let i = 0; i < lineCount; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    for (const rule of RULES) {
      if (!ruleEnabled(rule, settings)) continue;
      // 排除规则
      if (rule.exclude && rule.exclude(relPath)) continue;
      // while-no-cursor 走跨行上下文检查，跳过逐行扫描
      if (rule.id === "while-no-cursor") continue;
      // usedidshow-no-refetch 走跨行上下文检查，跳过逐行扫描
      if (rule.id === "usedidshow-no-refetch") continue;

      // 重置正则 lastIndex
      rule.pattern.lastIndex = 0;
      const matches = line.match(rule.pattern);
      if (!matches) continue;

      // 额外检查
      if (rule.extraCheck && !rule.extraCheck(line)) continue;

      findings.push({
        scanner_id: rule.id,
        dimension: rule.dimension,
        severity: rule.severity,
        fix_type: rule.fix_type,
        file: relPath,
        line: lineNum,
        match: redact(matches[0]),
        description: rule.description,
        context: redact(line.trim().slice(0, 120)),
      });
    }
  }

  // ── 上下文检查（跨行模式）──────────────────────────

  // update-no-version: 检查 .doc().update( 前后 5 行是否有 version
  const updateRule = RULES.find(r => r.id === "update-no-version")!;
  if (ruleEnabled(updateRule, settings) && !updateRule.exclude?.(relPath)) {
    for (let i = 0; i < lineCount; i++) {
      updateRule.pattern.lastIndex = 0;
      if (!updateRule.pattern.test(lines[i])) continue;
      if (/version/i.test(lines[i])) continue;
      // 检查前后 5 行是否有 version
      const context = lines.slice(Math.max(0, i - 5), Math.min(lineCount, i + 6)).join("\n");
      if (!/version/i.test(context)) {
        findings.push({
          scanner_id: updateRule.id,
          dimension: updateRule.dimension,
          severity: updateRule.severity,
          fix_type: updateRule.fix_type,
          file: relPath,
          line: i + 1,
          match: lines[i].trim().slice(0, 60),
          description: updateRule.description,
          context: lines[i].trim().slice(0, 120),
        });
      }
    }
  }

  // while-no-cursor: 检查 while 循环体是否有游标推进（匹配花括号找到完整循环体）
  const whileRule = RULES.find(r => r.id === "while-no-cursor")!;
  if (ruleEnabled(whileRule, settings) && !whileRule.exclude?.(relPath)) {
    for (let i = 0; i < lineCount; i++) {
      whileRule.pattern.lastIndex = 0;
      if (!whileRule.pattern.test(lines[i])) continue;
      // 提取 while 循环体：从 while 行开始，匹配花括号找到循环结束
      // 跳过字符串/模板字面量/正则以面量内的花括号
      let braceCount = 0;
      let loopBody = "";
      let started = false;
      for (let j = i; j < Math.min(lineCount, i + 50); j++) {
        const line = lines[j];
        let inString: string | null = null; // '"' | "'" | '`'  | null
        let inComment = false;
        for (let ci = 0; ci < line.length; ci++) {
          const ch = line[ci];
          const prev = ci > 0 ? line[ci - 1] : '';
          // 跳过注释
          if (!inString && ch === '/' && line[ci + 1] === '/') break; // 行注释
          if (!inString && ch === '/' && line[ci + 1] === '*') { inComment = true; ci++; continue; }
          if (inComment && ch === '*' && line[ci + 1] === '/') { inComment = false; ci++; continue; }
          if (inComment) continue;
          // 字符串/模板字面量
          if (prev !== '\\' && (ch === '"' || ch === "'" || ch === '`')) {
            if (!inString) { inString = ch; continue; }
            else if (inString === ch) { inString = null; continue; }
          }
          if (inString) continue;
          // 只计数代码中的花括号
          if (ch === '{') { braceCount++; started = true; }
          if (ch === '}') { braceCount--; if (started && braceCount <= 0) break; }
        }
        loopBody += line + "\n";
        if (started && braceCount <= 0) break;
      }
      // 检查循环体内是否有游标推进模式
      const hasCursorAdvance = /(\+\=\s*\d+|cursor|\.skip\(|\.next\(|offset|processed|last(Id|SaleId|Cursor|_id)|push\()/i.test(loopBody);
      if (!hasCursorAdvance) {
        const already = findings.some(f => f.scanner_id === whileRule.id && f.line === i + 1);
        if (!already) {
          findings.push({
            scanner_id: whileRule.id,
            dimension: whileRule.dimension,
            severity: whileRule.severity,
            fix_type: whileRule.fix_type,
            file: relPath,
            line: i + 1,
            match: lines[i].trim().slice(0, 60),
            description: whileRule.description + "（循环体内未检测到游标推进模式）",
            context: lines[i].trim().slice(0, 120),
          });
        }
      }
    }
  }

  // cloud-function-no-try: 检查 wx.cloud.callFunction 是否在 try 块内
  const cloudRule = RULES.find(r => r.id === "cloud-function-no-try")!;
  if (ruleEnabled(cloudRule, settings) && !cloudRule.exclude?.(relPath)) {
    for (let i = 0; i < lineCount; i++) {
      cloudRule.pattern.lastIndex = 0;
      if (!cloudRule.pattern.test(lines[i])) continue;
      // 向上查找最近的 try（最多 20 行）
      let hasTry = false;
      for (let j = Math.max(0, i - 20); j < i; j++) {
        if (/\btry\s*\{/.test(lines[j])) { hasTry = true; break; }
      }
      if (!hasTry) {
        // 避免重复报告
        const already = findings.some(f => f.scanner_id === cloudRule.id && f.line === i + 1);
        if (!already) {
          findings.push({
            scanner_id: cloudRule.id,
            dimension: cloudRule.dimension,
            severity: cloudRule.severity,
            fix_type: cloudRule.fix_type,
            file: relPath,
            line: i + 1,
            match: "wx.cloud.callFunction",
            description: cloudRule.description + "（未检测到 try/catch 包裹）",
            context: lines[i].trim().slice(0, 120),
          });
        }
      }
    }
  }

  // usedidshow-no-refetch: 检查 useDidShow 回调内是否有 refetch/invalidate 等刷新调用
  const didShowRule = RULES.find(r => r.id === "usedidshow-no-refetch")!;
  if (ruleEnabled(didShowRule, settings) && !didShowRule.exclude?.(relPath)) {
    for (let i = 0; i < lineCount; i++) {
      didShowRule.pattern.lastIndex = 0;
      if (!didShowRule.pattern.test(lines[i])) continue;
      // 跳过 import 行
      if (/^\s*import\s/.test(lines[i])) continue;
      // 向下查找回调体内（最多 15 行）是否有 refetch/invalidate/queryClient/mutate
      let hasRefresh = false;
      for (let j = i; j < Math.min(lineCount, i + 15); j++) {
        if (/(?:refetch|invalidate|queryClient\.|mutate|useQuery|useMutation)/.test(lines[j])) {
          hasRefresh = true;
          break;
        }
      }
      if (!hasRefresh) {
        // 检查是否是纯 UI 操作（getTabBar/setData/setCurrentIndex 等），不算缺数据刷新
        let callbackBody = "";
        for (let j = i; j < Math.min(lineCount, i + 15); j++) callbackBody += lines[j] + "\n";
        const isUIOnly = /(?:getTabBar|setData\(|setCurrent|setActive|setIndex)/i.test(callbackBody)
          && !/(?:refetch|invalidate|queryClient|fetch|load|get\(|find\(|query)/i.test(callbackBody);
        if (isUIOnly) continue;

        const already = findings.some(f => f.scanner_id === didShowRule.id && f.line === i + 1);
        if (!already) {
          findings.push({
            scanner_id: didShowRule.id,
            dimension: didShowRule.dimension,
            severity: didShowRule.severity,
            fix_type: didShowRule.fix_type,
            file: relPath,
            line: i + 1,
            match: "useDidShow",
            description: didShowRule.description + "（未检测到 refetch/invalidate 调用）",
            context: lines[i].trim().slice(0, 120),
          });
        }
      }
    }
  }

  return normalizeReviewFindings(findings, { source: "review-scanner" });
}

// ── 主入口 ────────────────────────────────────────────────────

export function scanProject(options: ScannerOptions = Object()): ReviewScannerResult {
  const settings = scannerSettings(options);
  const files = settings.files.length > 0
    ? settings.files
        .map((file) => resolve(settings.root, file))
        .filter((file) => existsSync(file))
    : settings.sourceRoots
        .map((sourceRoot) => join(settings.root, sourceRoot))
        .filter((dir) => existsSync(dir))
        .flatMap((dir) => getAllSourceFiles(dir, settings));
  const allFindings: ReviewFindingInput[] = [];

  for (const file of files) {
    allFindings.push(...scanFile(file, settings));
  }

  // ── TSC 编译错误扫描 ──
  if (settings.includeExternalChecks && settings.config.build.type_check) {
    // P12.I1: route config-supplied type_check through safe-exec.
    const tscResult: ExecCommandResult = execCommand(settings.config.build.type_check, {
      cwd: settings.root, timeout: resolveGateTimeout("type_check", settings.config),
    });
    if (!tscResult.ok) {
      const tscOutput = `${tscResult.stdout || ""}${tscResult.stderr || ""}`;
      const tscLines = tscOutput.split('\n').filter((line) => /error TS\d+:/.test(line));
      const seenFiles = new Set<string>();
      let parsedTypeErrors = 0;
      for (const line of tscLines) {
        const m = line.match(/^(.+?)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)$/);
        if (!m) continue;
        const [, rawFile, lineNum, code, message] = m;
        const file = rawFile.replace(/^\.\//, "");
        if (!isSourceFile(file, settings)) continue;
        const dedupKey = `${file}:${code}`;
        if (seenFiles.has(dedupKey)) continue;
        seenFiles.add(dedupKey);
        parsedTypeErrors += 1;
        allFindings.push({
          scanner_id: `tsc-${code.toLowerCase()}`,
          dimension: "code",
          severity: code === 'TS2307' || code === 'TS2305' ? 'HIGH' : 'MEDIUM',
          file,
          line: parseInt(lineNum, 10),
          fix_type: "CLAUDE_FIX",
          match: `${code}: ${message.slice(0, 80)}`,
          description: `TypeScript 编译错误 ${code}: ${message}`,
          context: line.trim().slice(0, 120),
        });
      }
      if (parsedTypeErrors === 0) {
        allFindings.push(typecheckToolUnavailableFinding(tscResult, tscOutput));
      }
    }
  }

  // ── ESLint 错误扫描（仅 error 级别，不报 warning）──
  if (settings.includeExternalChecks) try {
    const lintCommand = settings.config.build.lint || "";
    // P12.I1: route config-supplied lint through safe-exec with --quiet appended.
    // parseCommandToArgv handles the appended flag; shell metacharacters rejected.
    const eslintOut = lintCommand
      ? (() => {
          const r: ExecCommandResult = execCommand(`${lintCommand} --quiet`, {
            cwd: settings.root, timeout: settings.config.gate?.timeout?.lint || 90000,
          });
          return r.rejected ? "" : `${r.stdout || ""}${r.stderr || ""}`;
        })()
      : "";
    const jsonStart = eslintOut.indexOf('[');
    if (jsonStart >= 0) {
      const results: EslintResult[] = JSON.parse(eslintOut.slice(jsonStart));
      for (const r of results) {
        const file = (r.filePath || '').replace(settings.root + '/', '').replace(settings.root + '\\', '');
        if (!isSourceFile(file, settings)) continue;
        for (const msg of (r.messages || [])) {
          if (msg.severity !== 2) continue; // 只报 error
          const fixType = msg.fix ? "AUTO_FIX" : "CLAUDE_FIX";
          allFindings.push({
            scanner_id: `eslint-${msg.ruleId || 'unknown'}`,
            dimension: "code",
            severity: "MEDIUM",
            file: file,
            line: msg.line || 0,
            fix_type: fixType,
            match: msg.ruleId || 'unknown',
            description: `ESLint error: ${msg.message}`,
            context: (msg.source || '').trim().slice(0, 120),
          });
        }
      }
    }
  } catch (e) {
    // eslint 退出非 0 时输出在 stdout
    try {
      const output = errorOutput(e);
      const out = String(output?.stdout || '') + String(output?.stderr || '');
      const jsonStart = out.indexOf('[');
      if (jsonStart >= 0) {
        const results: EslintResult[] = JSON.parse(out.slice(jsonStart));
        for (const r of results) {
          const file = (r.filePath || '').replace(settings.root + '/', '').replace(settings.root + '\\', '');
          if (!isSourceFile(file, settings)) continue;
          for (const msg of (r.messages || [])) {
            if (msg.severity !== 2) continue;
            const fixType = msg.fix ? "AUTO_FIX" : "CLAUDE_FIX";
            allFindings.push({
              scanner_id: `eslint-${msg.ruleId || 'unknown'}`,
              dimension: "code",
              severity: "MEDIUM",
              file: file,
              line: msg.line || 0,
              fix_type: fixType,
              match: msg.ruleId || 'unknown',
              description: `ESLint error: ${msg.message}`,
              context: (msg.source || '').trim().slice(0, 120),
            });
          }
        }
      }
    } catch {}
  }

  const reviewOutput = buildReviewOutput(allFindings, { source: "review-scanner" });
  const normalizedFindings = reviewOutput.findings;

  // 统计
  const byDimension: Record<string, number> = Object();
  const bySeverity: Record<string, number> = Object();
  const fileCount = files.length;
  const coverageArtifact = buildCoverageArtifact({ settings, files });

  for (const f of normalizedFindings) {
    byDimension[f.dimension] = (byDimension[f.dimension] || 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }

  return {
    schema_version: reviewOutput.schema_version,
    schema: reviewOutput.schema,
    timestamp: new Date().toISOString(),
    generated_at: reviewOutput.generated_at,
    source: reviewOutput.source,
    scanned_files: fileCount,
    coverage_artifact: coverageArtifact,
    total_findings: normalizedFindings.length,
    by_dimension: byDimension,
    by_severity: bySeverity,
    summary: reviewOutput.summary,
    findings: normalizedFindings,
  };
}

export function runReviewScannerCli() {
  const args = process.argv.slice(2);
  const valueOf = (name: string): string | null => {
    const arg = args.find((item) => item === name || item.startsWith(`${name}=`));
    if (!arg) return null;
    if (arg.includes("=")) return arg.split("=").slice(1).join("=");
    const index = args.indexOf(arg);
    return args[index + 1] || null;
  };
  const filesArg = valueOf("--files");
  const rootArg = valueOf("--root") || process.cwd();
  const files = filesArg ? filesArg.split(",").map((file) => file.trim()).filter(Boolean) : [];
  // 输出到 stdout
  process.stdout.write(`${JSON.stringify(scanProject({ root: rootArg, files, enforceFileLength: args.includes("--enforce-file-length") }), null, 2)}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) runReviewScannerCli();
