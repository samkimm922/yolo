// evaluators/runtime-check.js — evalTestsPass / evalBuildPass / evalBusinessCodeMin

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";

function runCommand(command, ROOT, timeout) {
  try {
    const out = execFileSync("sh", ["-c", command], {
      cwd: ROOT,
      encoding: "utf8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (error) {
    return {
      ok: false,
      out: (error.stdout || "") + (error.stderr || ""),
      message: error.message || "",
    };
  }
}

export function evalTestsPass(params = {}, _taskScope, ROOT) {
  const command = params.command || config.build?.test || "";
  if (command) {
    const file = params.file || params.test_file;
    const commandWithFile = file && command.includes("{file}") ? command.replaceAll("{file}", file) : command;
    const result = runCommand(commandWithFile, ROOT, params.timeout_ms || config.gate?.timeout?.test || 120000);
    return {
      passed: result.ok,
      detail: result.ok ? `测试命令通过: ${commandWithFile}` : `测试命令失败: ${result.message.slice(0, 200)}`,
      type: "tests_pass",
    };
  }

  try {
    const out = execFileSync("pnpm", ["exec", "vitest", "run", "--reporter", "json"], {
      cwd: ROOT, encoding: "utf8", timeout: 120000, stdio: ["pipe", "pipe", "pipe"],
    });
    const s = out.indexOf("{"); const data = s >= 0 ? JSON.parse(out.slice(s)) : {};
    if ((data.numFailedTests || 0) > 0) return { passed: false, detail: data.numFailedTests + " 个测试失败", found: data.numFailedTests };
    return { passed: true, detail: "全部测试通过" };
  } catch (e) {
    const s = (e.stdout || "") + (e.stderr || "");
    try {
      const start = s.indexOf("{");
      if (start >= 0) {
        const json = JSON.parse(s.slice(start));
        if (json && typeof json.numFailedTests === "number") {
          return {
            passed: json.numFailedTests === 0,
            detail: json.numFailedTests === 0 ? "所有测试通过" : `${json.numFailedTests} 个测试失败`,
            type: "tests_pass"
          };
        }
      }
    } catch {}
    return { passed: false, detail: `vitest 执行异常：${(e.message || e.stderr || "").slice(0, 200)}`, type: "tests_pass" };
  }
}

export function evalBuildPass(params = {}, _taskScope, ROOT) {
  const command = params.command || config.build?.build || "";
  if (command) {
    const result = runCommand(command, ROOT, params.timeout_ms || config.gate?.timeout?.build || 240000);
    return {
      passed: result.ok,
      detail: result.ok ? `构建命令通过: ${command}` : `构建命令失败: ${result.message.slice(0, 200)}`,
      type: "build_pass",
    };
  }

  try {
    execFileSync("pnpm", ["run", "build:weapp"], {
      cwd: ROOT, encoding: "utf8", timeout: 240000, stdio: ["pipe", "pipe", "pipe"],
    });
    return { passed: true, detail: "构建通过 (weapp)" };
  } catch (e) {
    return { passed: false, detail: "构建失败: " + e.message.slice(0, 80) };
  }
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");
}

function changedFilesFromFilesystemBaseline(ROOT, taskScope = {}) {
  const baselinePath = resolve(ROOT, ".yolo-worktree-baseline.json");
  if (!existsSync(baselinePath)) return [];
  let baseline = {};
  try {
    baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  } catch {
    return [];
  }
  const hashes = baseline.hashes || {};
  const scopedTargets = (taskScope.targets || []).map((target) => target.file).filter(Boolean);
  const candidates = scopedTargets.length > 0 ? scopedTargets : Object.keys(hashes);
  const changed = [];
  for (const file of candidates) {
    const absolute = resolve(ROOT, file);
    if (!existsSync(absolute)) continue;
    try {
      if (statSync(absolute).isDirectory()) continue;
      const currentHash = hashFile(absolute);
      if (!hashes[file] || hashes[file] !== currentHash) changed.push(file);
    } catch {}
  }
  return changed;
}

export function evalBusinessCodeMin(params, taskScope, ROOT, exec) {
  if (taskScope?.expected_zero_business_code === true) {
    return { passed: true, detail: "task 声明 expected_zero_business_code,跳过" };
  }
  const minFiles = params.min ?? 1;

  const diffOut = exec("git diff --name-only HEAD");
  const untrackedOut = exec("git ls-files --others --exclude-standard");
  const all = new Set();
  if (diffOut.ok) diffOut.out.split("\n").filter(Boolean).forEach((f) => all.add(f));
  if (untrackedOut.ok) untrackedOut.out.split("\n").filter(Boolean).forEach((f) => all.add(f));
  if (all.size === 0) {
    for (const file of changedFilesFromFilesystemBaseline(ROOT, taskScope)) all.add(file);
  }

  const isBusiness = (f) => {
    if (!f) return false;
    if (f.startsWith(".yolo/")) return false;
    if (f.startsWith(".yolo-backup/")) return false;
    if (f.startsWith(".claude/")) return false;
    if (f.startsWith("scripts/")) return false;
    if (f.startsWith("docs/")) return false;
    if (/\.md$/i.test(f)) return false;
    if (f.includes("/state/")) return false;
    if (f.startsWith("src/")) return true;
    if (f.startsWith("cloudfunctions/")) return true;
    if (f.startsWith("tests/")) return true;
    if (f.startsWith("__tests__/")) return true;
    if (f.includes("/__tests__/")) return true;
    return false;
  };

  const businessFiles = [...all].filter(isBusiness);
  const whitelistDesc = "src/**, cloudfunctions/**, __tests__/**, tests/**";
  if (businessFiles.length < minFiles) {
    return {
      passed: false,
      detail: `未检测到真业务代码改动 (白名单: ${whitelistDesc}; 检测到 ${businessFiles.length} < ${minFiles})`,
      found: businessFiles.length,
    };
  }
  return {
    passed: true,
    detail: `真业务代码改动 ${businessFiles.length} 个文件: ${businessFiles.slice(0, 5).join(", ")}${businessFiles.length > 5 ? "..." : ""}`,
    found: businessFiles.length,
  };
}
