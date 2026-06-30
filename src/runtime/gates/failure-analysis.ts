import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// M3: distinguish "no failures" from "couldn't read/parse". Previously every
// error path returned null, which callers treated as "no historical failures" —
// masking unreadable or corrupt gate logs.
export type FailureAnalysisResult = {
  /** null = genuinely no failures; the array = the failed gates. */
  failures: unknown[] | null;
  /** true when the analysis could not be completed (unreadable/corrupt log). */
  unreadable: boolean;
  reason?: string;
};

export function analyzeFailureFromGateLog(taskId, logDir): FailureAnalysisResult {
  if (!taskId || !logDir || !existsSync(logDir)) {
    return { failures: null, unreadable: false };
  }
  try {
    const files = readdirSync(logDir)
      .filter((file) => file.startsWith(`gate-${taskId}-`) && file.endsWith(".json"))
      .sort();
    if (!files.length) return { failures: null, unreadable: false };

    const latest = files[files.length - 1];
    const data = JSON.parse(readFileSync(join(logDir, latest), "utf8"));
    if (!Array.isArray(data.gates)) {
      // Parsed but no gates array — corrupt log; surface as unreadable.
      return { failures: null, unreadable: true, reason: "gate log has no gates array" };
    }

    const failedGates = data.gates.filter((gate) => gate.passed === false);
    if (!failedGates.length) return { failures: null, unreadable: false };

    return {
      failures: failedGates.map((gate) => ({
        id: gate.id || gate.name,
        type: gate.type || gate.name,
        detail: gate.detail || gate.message || `${gate.name} 失败`,
        severity: gate.severity,
        rules: [gate.type || gate.name],
      })),
      unreadable: false,
    };
  } catch (error) {
    // Read/parse failure — surface as unreadable rather than "no failures".
    return { failures: null, unreadable: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function gateFailureFingerprint(failures = []) {
  return failures
    .map((failure) => [failure.id, failure.type, failure.detail].filter(Boolean).join(":"))
    .join(" | ")
    .slice(0, 500);
}

export function isContractConditionFailure(failures = []) {
  return failures.some((failure) => {
    const text = `${failure.id || ""} ${failure.type || ""} ${failure.detail || ""}`;
    return /code_matches|code_contains|code_not_contains|POST-|语义审查/.test(text);
  });
}

export function analyzeFailureOutput(gateOutput) {
  // eslint-disable-next-line no-control-regex
  const cleanOutput = (gateOutput || "").replace(/\x1b\[[0-9;]*m/g, "");
  const failures = [];

  if (/no_new_type_errors|tsc.*错误|新增.*tsc|error TS\d+/.test(cleanOutput)) {
    const detail = (cleanOutput.match(/no_new_type_errors[^)]*:\s*([^\n]+)/) || [])[1] ||
      cleanOutput.split("\n").filter((line) => /新增.*tsc|TS\d+/.test(line)).join("; ") ||
      "类型错误";
    failures.push({ type: "tsc", detail: detail.slice(0, 200), rules: ["tsc"] });
  }

  if (/no_new_lint_errors|eslint|@typescript-eslint|no-unused-vars|no-constant-condition/.test(cleanOutput)) {
    const detail = (cleanOutput.match(/no_new_lint_errors[^)]*:\s*([^\n]+)/) || [])[1] ||
      (cleanOutput.match(/新增 \d+ 个 eslint[^\n]+/) || [])[0] ||
      "eslint 错误";
    failures.push({ type: "eslint", detail: detail.slice(0, 200), rules: ["eslint"] });
  }

  if (/code_not_contains.*仍包含|code_contains.*期望/.test(cleanOutput)) {
    failures.push({ type: "语义审查", detail: "code 模式匹配失败", rules: ["语义审查"] });
  }

  if (/files_modified_max|file_lines_max|文件数|文件行数|行.*限制/.test(cleanOutput)) {
    failures.push({ type: "file_scope", detail: "文件范围超标", rules: ["file_scope"] });
  }

  if (/no_forbidden_patterns.*\[WARN\]|as any|console\.log/.test(cleanOutput)) {
    const patterns = [];
    if (/as any/.test(cleanOutput)) patterns.push("as any");
    if (/console\.log/.test(cleanOutput)) patterns.push("console.log");
    if (patterns.length) failures.push({ type: "代码安全", detail: patterns.join(", "), rules: patterns });
  }

  if (/api_key|secret|password|innerHTML/i.test(cleanOutput)) {
    failures.push({ type: "dangerous", detail: "硬编码密钥/不安全API", rules: ["dangerous"] });
  }

  if (!failures.length) {
    if (/error TS\d+|tsc.*fail/i.test(cleanOutput)) {
      failures.push({ type: "tsc", detail: "类型错误", rules: ["tsc"] });
    }
    if (/FAIL|×|test.*fail|assert/i.test(cleanOutput)) {
      failures.push({ type: "vitest", detail: "测试失败", rules: ["vitest"] });
    }
    if (/文件数|净增|文件范围/.test(cleanOutput)) {
      failures.push({ type: "file_scope", detail: "文件范围超标", rules: ["file_scope"] });
    }
  }

  if (!failures.length) {
    failures.push({ type: "unknown", detail: cleanOutput.slice(0, 150), rules: ["unknown"] });
  }
  return failures;
}

export function buildFailureHint(rawError, targetFile) {
  const lines = rawError.split("\n");
  const relevant = lines.filter((line) => {
    if (!line.trim()) return false;
    if (line.includes("error TS") || line.includes("eslint")) return true;
    if (/改动范围|语义审查|代码安全|must_use|must_not_use/.test(line)) return true;
    if (targetFile && line.includes(targetFile)) return true;
    if ((line.includes("FAIL") || line.includes("×") || line.includes("✗")) && targetFile) {
      const testDir = dirname(targetFile);
      if (line.includes(testDir)) return true;
    }
    return false;
  });
  const filtered = relevant.join("\n").slice(0, 2500);

  let specificHint = "";
  if (rawError.includes("eslint") && rawError.includes("unused")) {
    specificHint = `
### eslint unused 根因分析：
eslint 说某个变量"defined but never used"，说明你的上一次修改删掉了使用该变量的代码，但忘了删变量声明/import。
修复方法：找到报错行号的变量声明或 import，删除它。`;
  } else if (rawError.includes("改动范围") && rawError.includes("150")) {
    specificHint = `
### 文件超 150 行根因分析：
文件改动后超过 150 行限制。你不能只加代码，必须先拆分：
1. 把与本次修复无关的一个函数/逻辑块提取到同目录的新文件
2. 确认主文件降到 150 行以下
3. 再应用你的修复`;
  } else if (rawError.includes("语义审查") && rawError.includes("acceptance")) {
    specificHint = `
### 语义审查失败根因分析：
你的修改没有满足 acceptance 条件。仔细读验收标准，
对比 acceptance 列出的每一条，找出哪条没做到，只补那一条。`;
  } else if (rawError.includes("TS") || rawError.includes("tsc")) {
    specificHint = `
### TypeScript 类型错误根因分析：
你引入了类型不匹配。上面已经给了目标文件和类型定义的完整代码，
回去看类型定义，确保你的修改与类型签名一致。`;
  } else if (rawError.includes("vitest") || rawError.includes("FAIL")) {
    specificHint = `
### 测试失败根因分析：
你的修改导致已有测试失败。可能原因：
1. 改了函数签名但测试还在用旧的调用方式
2. 改了返回值格式但测试还在断言旧格式
3. 改代码时顺手改了不该改的逻辑
修复：git diff 看你的改动，对比测试文件里的断言，只修代码侧的 bug，不动测试。`;
  }

  return `## 上次修复失败

以下是与当前任务相关的 gate 错误（不相关错误已过滤）：

${filtered || "(无相关错误详情，见原始 gate 输出)"}

### 【强制】先做因果分析，再动手：
1. 上面已经给了目标文件的完整代码，不需要再读
2. 找到报错提到的具体行号和变量/函数名
3. 分析：你的上次修改改了什么 → 为什么导致了这个报错 → 具体要改哪一行
4. 改完后检查：类型对不对、import 有没有多余、行数有没有超标

${specificHint}

${rawError && (rawError.includes("未被修改") || rawError.includes("目标文件")) ? "【重要】上一轮你没有实际修改目标文件。你必须使用 Edit 工具修改代码文件，仅输出分析文字而不执行 Edit 操作 = 任务失败。" : ""}`;
}
