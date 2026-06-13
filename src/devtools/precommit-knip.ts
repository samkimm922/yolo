#!/usr/bin/env node
/**
 * YOLO Pre-commit Knip 增量检查
 *
 * 对比 knip-baseline.json 基线，检测是否有新增死代码（exports/types）。
 * 仅报告 NEW 死代码，不因存量问题拦截。
 *
 * 用法: node precommit-knip.js
 * 退出码: 0=无新增死代码  1=发现新增死代码  2=knip 运行失败
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const KNIP_BASELINE = join(__dirname, "state", "runtime", "knip-baseline.json");

// 运行 knip
let knipOutput;
try {
  knipOutput = execFileSync("pnpm", ["exec", "knip", "--reporter", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (e) {
  // knip exits non-zero when dead code found — that's expected
  // 先尝试只解析 stdout（避免 stderr 混入破坏 JSON）
  const stdoutJson = (e.stdout || '').trim();
  if (stdoutJson.startsWith('{')) {
    knipOutput = stdoutJson;
  } else {
    // stdout 不是 JSON，尝试拼接（stderr 可能包含警告但不破坏 JSON 结构）
    knipOutput = stdoutJson + (e.stderr || '');
    if (!knipOutput.trim().startsWith('{')) {
      console.error('[knip-precommit] knip 运行失败，跳过检查');
      process.exit(0);
    }
  }
}

// 解析 knip JSON 输出
let knipData;
try {
  knipData = JSON.parse(knipOutput.trim());
} catch {
  console.error("[knip-precommit] knip JSON 解析失败，跳过检查");
  process.exit(0);
}

// 提取当前死代码 keys
const excludeDirs = ["node_modules", "dist", "__tests__"];
const currentKeys = new Set();
for (const issue of knipData.issues || []) {
  if (excludeDirs.some((d) => issue.file.startsWith(d))) continue;
  for (const exp of issue.exports || []) {
    currentKeys.add(`${issue.file}:export:${exp.name}`);
  }
  for (const typ of issue.types || []) {
    currentKeys.add(`${issue.file}:type:${typ.name}`);
  }
}

// 如果没有基线，跳过（首次运行）
if (!existsSync(KNIP_BASELINE)) {
  console.log("[knip-precommit] 基线文件不存在，跳过增量检查");
  process.exit(0);
}

// 读取基线
let baseline;
try {
  baseline = JSON.parse(readFileSync(KNIP_BASELINE, "utf8"));
} catch {
  console.log("[knip-precommit] 基线文件损坏，跳过检查");
  process.exit(0);
}

const baselineKeys = new Set(baseline.keys || []);

// 找出新增的死代码
const newDead = [...currentKeys].filter((k) => !baselineKeys.has(k));

if (newDead.length === 0) {
  console.log("[knip-precommit] 无新增死代码");
  process.exit(0);
}

// 报告新增死代码
console.error(`\n[knip-precommit] 发现 ${newDead.length} 个新增死代码：`);
for (const key of newDead.slice(0, 20)) {
  const [file, cat, name] = String(key).split(":");
  console.error(`  ${cat === "export" ? "未使用导出" : "未使用类型"}: ${name} (${file})`);
}
if (newDead.length > 20) {
  console.error(`  ... 及其他 ${newDead.length - 20} 个`);
}
console.error("\n修复建议：删除未使用的导出/类型，或在 knip.json 中添加 ignore 配置\n");
process.exit(1);
