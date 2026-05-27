#!/usr/bin/env node
/**
 * YOLO Precheck v2 — 评估 pre_conditions（修前验证）
 *
 * 用法: node precheck.js --task=<id> --prd=<path> [--cwd=<project-root>]
 * 退出码: 0=通过/需要修复, 1=参数错误/文件不存在, 2=已跳过(无需处理)
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { evaluatePreConditions, setContractRoot } from "../../prd/contract.js";
import { getArg } from "../../../lib/cli-utils.js";

const taskId = getArg("--task=");
const prdPath = getArg("--prd=");
const ROOT = resolve(getArg("--cwd=") || process.cwd());
setContractRoot(ROOT);

if (!taskId || !prdPath) {
  console.error("用法: node precheck.js --task=<id> --prd=<path> [--cwd=<project-root>]");
  process.exit(1);
}

let prd;
try {
  prd = JSON.parse(readFileSync(resolve(prdPath), "utf-8"));
} catch (e) {
  console.error(`无法加载 PRD 文件: ${prdPath}`);
  console.error(e.message);
  process.exit(1);
}
const task = (prd.tasks || []).find((t) => t.id === taskId)
  // splitTask 子任务回退：AUDIT-004-F1-A → AUDIT-004-F1, AUDIT-002-F1-P1 → AUDIT-002-F1
  || (() => {
    const parentId = taskId.replace(/(-[A-Z]-\d+)$/, '').replace(/(-[A-Z])$/, '').replace(/(-P\d+)$/, '');
    return parentId !== taskId ? (prd.tasks || []).find((t) => t.id === parentId) : null;
  })();

if (!task) {
  console.error(`任务 ${taskId} 不在 PRD 中`);
  process.exit(1);
}

// ── v2: 评估 pre_conditions ──────────────────────────────────────
const preConditions = task.pre_conditions || [];

if (preConditions.length === 0) {
  console.log(`PRE-CHECK: ${taskId} — 无 pre_conditions，继续执行`);
  process.exit(0);
}

const result = evaluatePreConditions(task, prd);

for (const r of result.results) {
  const icon = r.passed ? "✓" : "✗";
  console.log(`  ${icon} ${r.id}: ${r.detail}`);
}

if (!result.allPass) {
  const failIds = result.failConditions.map((r) => r.id).join(", ");
  console.log(`PRE-CHECK SKIP: ${taskId} — 所有 pre_conditions 已不再满足 (${failIds})`);
  process.exit(2);
}

  // ── v2: tsc 兜底验证——前置任务可能已修复了根因 ──────────────────
  // pre_conditions 检查的是代码模式（如调用 getCardById），而根因可能
  // 在另一个文件（如 card.service.ts 新增了导出）。
  // 验证 tsc 是否仍对目标文件报错，若无错则跳过（无需重复修复）。
  const targets = (task.scope?.targets || []).map(t => t.file).filter(Boolean);
  if (targets.length > 0) {
    const TSC_TIMEOUT = 30000;
    try {
      const tscOut = execFileSync("sh", ["-c", "pnpm exec tsc --noEmit 2>&1"], {
        cwd: ROOT,
        timeout: TSC_TIMEOUT,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const hasTargetErrors = targets.some(t => tscOut.includes(t));
      if (!hasTargetErrors) {
        console.log(`PRE-CHECK SKIP: ${taskId} — tsc 无目标文件错误（可能已被前置任务修复），跳过修复`);
        process.exit(0);
      }
    } catch (e) {
      // tsc 非零退出 → 存在类型错误。检查错误是否涉及目标文件。
      const tscOut = (e.stdout || "").trim();
      if (tscOut) {
        const hasTargetErrors = targets.some(t => tscOut.includes(t));
        if (!hasTargetErrors) {
          console.log(`PRE-CHECK SKIP: ${taskId} — tsc 无目标文件错误（可能已被前置任务修复），跳过修复`);
          process.exit(0);
        }
      }
      // tsc 失败且目标文件仍有错误 → 继续正常流程（不输出额外消息以避免干扰）
    }
  }

  console.log(`PRE-CHECK: ${taskId} — ${preConditions.length} 个 pre_conditions 全部通过，需要修复`);
  process.exit(0);
