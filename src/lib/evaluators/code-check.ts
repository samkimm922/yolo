// evaluators/code-check.js — evalCodeContains / evalCodeNotContains

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { isWithin } from "../security/path-guard.js";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readExistingFile(ROOT, file) {
  const absPath = resolve(ROOT, file || "");
  if (!file || !isWithin(absPath, ROOT) || !existsSync(absPath) || statSync(absPath).isDirectory()) return null;
  return readFileSync(absPath, "utf8");
}

function findMatchingBrace(content, openIndex) {
  let depth = 0;
  let stringQuote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = openIndex; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];
    const prev = content[i - 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (stringQuote) {
      if (ch === stringQuote && prev !== "\\") stringQuote = null;
      continue;
    }

    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      stringQuote = ch;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractFunctionBody(content, functionName) {
  if (!functionName) return null;
  const name = escapeRegExp(functionName);
  const patterns = [
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`, "m"),
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[^=()]+)\\s*=>\\s*\\{`, "m"),
    new RegExp(`\\b${name}\\s*[:=]\\s*(?:async\\s*)?(?:\\([^)]*\\)|[^=()]+)\\s*=>\\s*\\{`, "m"),
    new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*\\{`, "m"),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (!match) continue;
    const openIndex = content.indexOf("{", match.index);
    if (openIndex === -1) continue;
    const closeIndex = findMatchingBrace(content, openIndex);
    if (closeIndex === -1) continue;
    return content.slice(openIndex + 1, closeIndex);
  }

  return null;
}

export function evalCodeContains(params, taskScope, ROOT) {
  // 兼容 pattern/files（PRD 写法）和 text/file（旧写法）
  const text = params.text || params.pattern;
  const targetFiles = params.files || (params.file ? [params.file] : []);
  const count = params.count || {};
  const isRegex = params.is_regex !== undefined ? params.is_regex : !!params.pattern;
  const lineConstraint = params.line || null;

  if (!text) return { passed: false, detail: "缺少 text/pattern 参数" };
  if (!targetFiles.length) {
    return {
      passed: false,
      status: "not_run",
      detail: `无文件指定，无法验证: "${text.slice(0, 60)}"`,
    };
  }

  let allPassed = true;
  const details = [];
  let totalMatches = 0;
  let filesChecked = 0;

  for (const file of targetFiles) {
    const absPath = resolve(ROOT, file);
    if (!isWithin(absPath, ROOT) || !existsSync(absPath) || statSync(absPath).isDirectory()) continue;
    filesChecked++;

    const content = readFileSync(absPath, "utf8");

    let searchContent = content;
    let lineInfo = "";
    if (lineConstraint !== null) {
      const allLines = content.split("\n");
      let targetLines;
      if (Array.isArray(lineConstraint)) {
        const start = Math.max(1, lineConstraint[0]);
        const end = Math.min(allLines.length, lineConstraint[1]);
        targetLines = allLines.slice(start - 1, end);
        lineInfo = ` (行 ${start}-${end})`;
      } else {
        const lineNum = Math.max(1, Math.min(allLines.length, lineConstraint));
        targetLines = [allLines[lineNum - 1]];
        lineInfo = ` (行 ${lineNum})`;
      }
      searchContent = targetLines.join("\n");
    }

    let matches;

    if (isRegex) {
      const re = new RegExp(text, "g");
      matches = (searchContent.match(re) || []).length;
    } else {
      const normalizeWS = (s) => s.replace(/\s+/g, ' ');
      const normContent = normalizeWS(searchContent);
      const normText = normalizeWS(text);

      matches = normContent.split(normText).length - 1;

      if (matches === 0 && /['"],\s*\(\)/.test(normText)) {
        const asyncText = normText.replace(/(['"]),\s*\(\)/, '$1, async ()');
        matches = normContent.split(asyncText).length - 1;
      }
    }

    totalMatches += matches;

    const min = count.min ?? 1;
    const max = count.max ?? Infinity;
    const exact = count.exact;

    if (exact !== undefined && matches !== exact) {
      allPassed = false;
      details.push(`${file}${lineInfo}: 期望精确 ${exact} 处匹配 "${text.slice(0, 40)}"，实际 ${matches} 处`);
      continue;
    }

    if (matches < min || matches > max) {
      allPassed = false;
      const rangeDesc =
        min === max ? `恰好 ${min}` : `${min}~${max === Infinity ? "∞" : max}`;
      details.push(`${file}${lineInfo}: 期望 ${rangeDesc} 处匹配 "${text.slice(0, 40)}"，实际 ${matches} 处`);
      continue;
    }

    details.push(`${file}${lineInfo}: 找到 ${matches} 处匹配 "${text.slice(0, 40)}"`);
  }

  if (filesChecked === 0) {
    return { passed: false, detail: `指定文件均不存在: ${targetFiles.join(", ")}` };
  }

  return {
    passed: allPassed,
    detail: details.join("; "),
    found: totalMatches,
  };
}

export function evalFunctionContainsText(params, _taskScope, ROOT) {
  const file = params.file;
  const functionName = params.function || params.function_name || params.name;
  const text = params.text || params.pattern;
  if (!file || !functionName || !text) {
    return { passed: false, detail: "缺少 file/function/text 参数" };
  }

  const content = readExistingFile(ROOT, file);
  if (content === null) return { passed: false, detail: `${file} 不存在` };

  const body = extractFunctionBody(content, functionName);
  if (body === null) return { passed: false, detail: `${file} 未找到函数 ${functionName}` };

  const matched = params.is_regex || params.pattern
    ? new RegExp(text, "m").test(body)
    : body.includes(text);
  return {
    passed: matched,
    detail: matched
      ? `${functionName} 包含 ${String(text).slice(0, 60)}`
      : `${functionName} 不包含 ${String(text).slice(0, 60)}`,
    found: matched ? 1 : 0,
  };
}

export function evalFunctionContainsCall(params, taskScope, ROOT) {
  const callee = params.callee || params.call || params.text;
  if (!callee) return { passed: false, detail: "缺少 callee 参数" };
  return evalFunctionContainsText(
    {
      ...params,
      text: `${escapeRegExp(callee)}\\s*\\(`,
      is_regex: true,
    },
    taskScope,
    ROOT,
  );
}

export function evalAstCallbackUsesParam(params, _taskScope, ROOT) {
  const file = params.file;
  const param = params.param || params.parameter;
  const callbackName = params.callback || params.function || params.function_name;
  if (!file || !param) return { passed: false, detail: "缺少 file/param 参数" };

  const content = readExistingFile(ROOT, file);
  if (content === null) return { passed: false, detail: `${file} 不存在` };
  const scope = callbackName ? extractFunctionBody(content, callbackName) : content;
  if (callbackName && scope === null) return { passed: false, detail: `${file} 未找到回调 ${callbackName}` };

  const matched = new RegExp(`\\b${escapeRegExp(param)}\\b`).test(scope || "");
  return {
    passed: matched,
    detail: matched ? `${callbackName || file} 使用参数 ${param}` : `${callbackName || file} 未使用参数 ${param}`,
    found: matched ? 1 : 0,
  };
}

export function evalAstFindByProperty(params, _taskScope, ROOT) {
  const files = params.files || (params.file ? [params.file] : []);
  const property = params.property || params.key;
  const value = params.value;
  if (!files.length || !property) return { passed: false, detail: "缺少 file(s)/property 参数" };

  const propertyPattern = escapeRegExp(property);
  const valuePattern = value === undefined ? null : escapeRegExp(String(value));
  const matcher = valuePattern
    ? new RegExp(`(?:\\b${propertyPattern}\\b\\s*[:=]\\s*['"]?${valuePattern}['"]?|\\.\\s*${propertyPattern}\\b[^\\n]*['"]?${valuePattern}['"]?)`, "m")
    : new RegExp(`(?:\\b${propertyPattern}\\b\\s*[:=]|\\.\\s*${propertyPattern}\\b)`, "m");

  const checked = [];
  for (const file of files) {
    const content = readExistingFile(ROOT, file);
    if (content === null) continue;
    checked.push(file);
    if (matcher.test(content)) {
      return {
        passed: true,
        detail: `${file} 找到属性 ${property}${value === undefined ? "" : `=${value}`}`,
        found: 1,
      };
    }
  }

  if (!checked.length) return { passed: false, detail: `指定文件均不存在: ${files.join(", ")}` };
  return {
    passed: false,
    detail: `${checked.join(", ")} 未找到属性 ${property}${value === undefined ? "" : `=${value}`}`,
    found: 0,
  };
}

export function evalCodeNotContains(params, taskScope, ROOT) {
  const text = params.text || params.pattern;
  const targetFiles = params.files || (params.file ? [params.file] : []);
  if (!text) return { passed: false, detail: "缺少 text/pattern 参数" };
  if (!targetFiles.length) {
    return {
      passed: false,
      status: "not_run",
      detail: "无文件指定，无法验证 code_not_contains",
      found: 0,
    };
  }

  const existingFiles = targetFiles.filter((file) => {
    const absPath = resolve(ROOT, file);
    return isWithin(absPath, ROOT) && existsSync(absPath) && !statSync(absPath).isDirectory();
  });

  if (existingFiles.length === 0) {
    return {
      passed: false,
      status: "indeterminate",
      detail: `指定文件均不存在，无法验证 code_not_contains: ${targetFiles.join(", ")}`,
      found: 0,
    };
  }

  const result = evalCodeContains(
    { ...params, text, files: existingFiles, count: { min: 0, max: 0 } },
    taskScope,
    ROOT,
  );
  if (result.passed) {
    return { passed: true, detail: `未找到 "${text?.slice(0, 40) || '?'}"`, found: 0 };
  }
  return {
    passed: false,
    detail: `${existingFiles.join(", ")}: 仍包含 "${(text || '?').slice(0, 40)}"（${result.found} 处）`,
    found: result.found,
  };
}
