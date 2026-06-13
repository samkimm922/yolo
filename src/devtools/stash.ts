#!/usr/bin/env node
/**
 * YOLO Stash 管理工具
 *
 * 用法:
 *   node stash.js --list      列出所有 yolo 相关 stash
 *   node stash.js --clean     清除所有 yolo stash（需确认）
 */

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const args = process.argv.slice(2);
const cmd = args[0];

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

let stashListRaw;
try {
  stashListRaw = git(["stash", "list"]);
} catch {
  console.log("无法读取 git stash（可能不在 git 仓库中）。");
  process.exit(0);
}

if (!stashListRaw) {
  console.log("当前无任何 stash。");
  process.exit(0);
}

const yoloStashes = stashListRaw
  .split("\n")
  .filter((line) => line.includes("temp-stash-for-"));

if (cmd === "--list") {
  if (yoloStashes.length === 0) {
    console.log("无 yolo 相关 stash。");
    console.log(`全部 stash (${stashListRaw.split("\n").length}):`);
    console.log(stashListRaw);
  } else {
    console.log(`yolo stash (${yoloStashes.length} / ${stashListRaw.split("\n").length}):\n`);
    for (const s of yoloStashes) {
      console.log(`  ${s}`);
    }
    console.log("\n查看改动: git stash show -p stash@{N}");
  }
} else if (cmd === "--clean") {
  if (yoloStashes.length === 0) {
    console.log("无 yolo stash，无需清理。");
    process.exit(0);
  }
  console.log(`将删除 ${yoloStashes.length} 个 yolo stash:\n`);
  for (const s of yoloStashes) {
    console.log(`  ${s}`);
  }
  console.log("\n手动执行清理:");
  console.log("  git stash list | grep temp-stash-for | cut -d: -f1 | while read ref; do git stash drop \"$ref\"; done");
} else {
  console.log("用法: node stash.js --list | --clean");
  console.log("");
  console.log("  --list    列出所有 yolo 相关 stash");
  console.log("  --clean   显示清除命令（需手动执行）");
  process.exit(1);
}
