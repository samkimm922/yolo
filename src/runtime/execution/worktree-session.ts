import {
  cpSync as defaultCpSync,
  copyFileSync as defaultCopyFileSync,
  existsSync as defaultExistsSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  readdirSync as defaultReaddirSync,
  rmSync as defaultRmSync,
  statSync as defaultStatSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import {
  execFileSync as defaultExecFileSync,
  execSync as defaultExecSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import {
  parseEslintBaselineKeys,
  parseTscBaselineKeys,
} from "./baselines.js";

export function isFileInScopeTargets(filePath, targets = []) {
  return (targets || []).some((target) => {
    const targetPath = typeof target === "string" ? target : target?.file;
    if (!targetPath) return false;
    const normalized = targetPath.endsWith("/") ? targetPath : `${targetPath}/`;
    return filePath === targetPath || filePath.startsWith(normalized) || targetPath.startsWith(`${filePath}/`);
  });
}

export function isFileAllowedByScope(filePath, scopeOrTargets = []) {
  const scope = Array.isArray(scopeOrTargets) ? { targets: scopeOrTargets } : (scopeOrTargets || {});
  const targets = scope.targets || [];
  if (isFileInScopeTargets(filePath, targets)) return true;
  if (scope.allow_new_files !== true) return false;
  const targetDirs = targets
    .map((target) => typeof target === "string" ? target : target?.file)
    .filter(Boolean)
    .map((target) => target.endsWith("/") ? target : `${dirname(target)}/`);
  return targetDirs.some((dir) => filePath.startsWith(dir));
}

export function isBusinessLikeFile(filePath) {
  return filePath.startsWith("src/") || filePath.startsWith("cloudfunctions/") || filePath.startsWith("config/");
}

export function parseGitStatusEntries(output = "") {
  return String(output).split("\n").filter(Boolean).map((line) => {
    const status = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const path = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop().trim() : rawPath;
    return { path, isDeleted: status.includes("D") };
  }).filter((entry) => entry.path);
}

export function parseGitNameStatusEntries(output = "") {
  return String(output).split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    const status = parts[0] || "";
    const path = parts.length > 2 ? parts[2] : parts[1];
    return { path, isDeleted: status.startsWith("D") };
  }).filter((entry) => entry.path);
}

export function gitLines(cwd, args, { execFileSync = defaultExecFileSync } = {}) {
  try {
    const output = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).replace(/\n+$/, "");
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function ensureWorktreeRoot(worktreeRoot, { existsSync, mkdirSync }) {
  if (!existsSync(worktreeRoot)) mkdirSync(worktreeRoot, { recursive: true });
}

function isInsideGitWorkTree(rootDir, { execSync = defaultExecSync } = {}) {
  try {
    return execSync("git rev-parse --is-inside-work-tree", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() === "true";
  } catch {
    return false;
  }
}

function removePath(path, { existsSync, rmSync, execSync } = {}) {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    execSync(`rm -rf ${shellQuote(path)}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  }
}

function shouldCopyProjectEntry(src) {
  const name = src.split("/").pop();
  if ([".git", "node_modules", ".yolo-worktrees", ".yolo-backup"].includes(name)) return false;
  if (name === ".DS_Store") return false;
  if (src.includes("/.yolo/state/runtime/")) return false;
  return true;
}

function writeFilesystemLineBaseline({
  wtPath,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} = {}) {
  const lineCounts = {};
  const hashes = {};
  const sourceExt = /\.(mjs|cjs|js|jsx|ts|tsx|css|scss|html)$/i;
  const walk = (relativeDir = "") => {
    const absoluteDir = join(wtPath, relativeDir);
    let entries = [];
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if ([".git", "node_modules", ".yolo-worktrees", ".yolo-backup"].includes(entry.name)) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (relativePath.startsWith(".yolo/state/")) continue;
      if (entry.isDirectory()) {
        walk(relativePath);
        continue;
      }
      if (!sourceExt.test(entry.name)) continue;
      const absolutePath = join(wtPath, relativePath);
      try {
        if (statSync(absolutePath).isDirectory()) continue;
        const content = readFileSync(absolutePath, "utf8");
        lineCounts[relativePath] = content.split("\n").length;
        hashes[relativePath] = createHash("sha256").update(content).digest("hex");
      } catch {}
    }
  };
  walk("");
  try {
    writeFileSync(join(wtPath, ".yolo-worktree-baseline.json"), JSON.stringify({
      line_counts: lineCounts,
      hashes,
    }, null, 2), "utf8");
  } catch {}
}

function collectAllowedFilesystemPaths({
  wtPath,
  allowedScope,
  existsSync,
  statSync,
  readdirSync,
}) {
  const allowedTargets = Array.isArray(allowedScope) ? allowedScope : (allowedScope?.targets || []);
  const allowNewFiles = !Array.isArray(allowedScope) && allowedScope?.allow_new_files === true;
  const seen = new Set();
  const files = [];
  const addFile = (filePath) => {
    if (!filePath || seen.has(filePath)) return;
    const absolute = join(wtPath, filePath);
    try {
      if (statSync(absolute).isDirectory()) return;
    } catch {
      return;
    }
    seen.add(filePath);
    files.push(filePath);
  };
  const walk = (relativeDir) => {
    const absoluteDir = join(wtPath, relativeDir);
    let entries = [];
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relativePath);
      else addFile(relativePath);
    }
  };

  for (const target of allowedTargets || []) {
    const targetPath = typeof target === "string" ? target : target?.file;
    if (!targetPath) continue;
    if (existsSync(join(wtPath, targetPath))) {
      addFile(targetPath);
      if (allowNewFiles) {
        const dir = dirname(targetPath);
        if (dir && dir !== ".") walk(dir);
      }
      continue;
    }
    if (allowNewFiles) walk(dirname(targetPath));
  }
  return files;
}

function writeWorktreeBaselines({
  wtPath,
  config,
  execFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
}) {
  const wtBaselineDir = join(wtPath, "scripts", "yolo", "state", "runtime");
  if (!existsSync(wtBaselineDir)) mkdirSync(wtBaselineDir, { recursive: true });
  try {
    const tscResult = execFileSync("sh", ["-c", `cd ${shellQuote(wtPath)} && ${config.build.type_check} 2>&1 || true`], {
      encoding: "utf8",
      timeout: 120000,
    });
    writeFileSync(join(wtBaselineDir, "tsc-baseline.json"), JSON.stringify({ keys: parseTscBaselineKeys(tscResult) }, null, 2), "utf8");
  } catch {}
  try {
    const eslintResult = execFileSync("sh", ["-c", `cd ${shellQuote(wtPath)} && ${config.build.lint} 2>&1 || true`], {
      encoding: "utf8",
      timeout: 90000,
    });
    writeFileSync(join(wtBaselineDir, "eslint-baseline.json"), JSON.stringify({
      keys: parseEslintBaselineKeys(eslintResult, wtPath),
    }, null, 2), "utf8");
  } catch {}
}

export function createTaskWorktree({
  taskId,
  rootDir,
  worktreeRoot,
  config,
  now = Date.now,
  execSync = defaultExecSync,
  execFileSync = defaultExecFileSync,
  existsSync = defaultExistsSync,
  mkdirSync = defaultMkdirSync,
  readFileSync = defaultReadFileSync,
  readdirSync = defaultReaddirSync,
  rmSync = defaultRmSync,
  statSync = defaultStatSync,
  cpSync = defaultCpSync,
  writeFileSync = defaultWriteFileSync,
} = {}) {
  const wtBranch = `yolo-${taskId}-${now()}`;
  const wtPath = join(worktreeRoot, taskId);
  const insideGitWorkTree = isInsideGitWorkTree(rootDir, { execSync });
  let baseCommit = "filesystem";
  try {
    baseCommit = execSync("git rev-parse HEAD", {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {}

  ensureWorktreeRoot(worktreeRoot, { existsSync, mkdirSync });

  try {
    execSync(`git worktree remove ${shellQuote(wtPath)} --force 2>/dev/null || true`, {
      cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {}
  try {
    execSync(`git branch -D ${shellQuote(wtBranch)} 2>/dev/null || true`, {
      cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {}
  removePath(wtPath, { existsSync, rmSync, execSync });

  if (!insideGitWorkTree) {
    mkdirSync(wtPath, { recursive: true });
    cpSync(rootDir, wtPath, {
      recursive: true,
      dereference: false,
      filter: shouldCopyProjectEntry,
    });
    writeFilesystemLineBaseline({
      wtPath,
      readFileSync,
      readdirSync,
      statSync,
      writeFileSync,
    });
    writeWorktreeBaselines({
      wtPath,
      config,
      execFileSync,
      existsSync,
      mkdirSync,
      writeFileSync,
    });
    return { branch: wtBranch, path: wtPath, base: baseCommit, mode: "filesystem" };
  }

  try {
    execSync(`git worktree add --detach ${shellQuote(wtPath)} HEAD`, {
      cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`createWorktree: git worktree add failed: ${error.message}`);
  }

  try {
    execSync(`git -C ${shellQuote(wtPath)} checkout -b ${shellQuote(wtBranch)}`, {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    try { execSync(`git worktree remove ${shellQuote(wtPath)} --force 2>/dev/null`, { cwd: rootDir, stdio: ["pipe", "pipe", "pipe"] }); } catch {}
    throw new Error(`createWorktree: git checkout -b failed: ${error.message}`);
  }

  const wtNodeModules = join(wtPath, "node_modules");
  const rootNodeModules = join(rootDir, "node_modules");
  if (!existsSync(wtNodeModules) && existsSync(rootNodeModules)) {
    try {
      execSync(`ln -s ${shellQuote(rootNodeModules)} ${shellQuote(wtNodeModules)}`, {
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      execSync(`cp -r ${shellQuote(rootNodeModules)} ${shellQuote(wtNodeModules)}`, {
        encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      });
    }
  }

  writeWorktreeBaselines({
    wtPath,
    config,
    execFileSync,
    existsSync,
    mkdirSync,
    writeFileSync,
  });

  return { branch: wtBranch, path: wtPath, base: baseCommit, mode: "git" };
}

export function cleanupTaskWorktree({
  wtPath,
  wtBranch,
  rootDir,
  mergeToMain = false,
  allowedScope = [],
  baseRef = null,
  execSync = defaultExecSync,
  execFileSync = defaultExecFileSync,
  existsSync = defaultExistsSync,
  readdirSync = defaultReaddirSync,
  rmSync = defaultRmSync,
  statSync = defaultStatSync,
  mkdirSync = defaultMkdirSync,
  copyFileSync = defaultCopyFileSync,
  log = () => {},
} = {}) {
  const copiedFiles = [];
  const allowedTargets = Array.isArray(allowedScope) ? allowedScope : (allowedScope?.targets || []);
  const insideGitWorkTree = isInsideGitWorkTree(wtPath, { execSync });
  const rootInsideGitWorkTree = isInsideGitWorkTree(rootDir, { execSync });
  if (mergeToMain) {
    const seen = new Set();
    const deletedSet = new Set();
    let allFilePaths = [];

    if (insideGitWorkTree) {
      const dirtyEntries = parseGitStatusEntries(gitLines(wtPath, ["status", "--porcelain"], { execFileSync }).join("\n"));
      const committedEntries = baseRef
        ? parseGitNameStatusEntries(gitLines(wtPath, ["diff", "--name-status", baseRef, "HEAD"], { execFileSync }).join("\n"))
        : [];
      const untrackedEntries = gitLines(wtPath, ["ls-files", "--others", "--exclude-standard"], { execFileSync })
        .map((path) => ({ path, isDeleted: false }));

      for (const { path, isDeleted } of [...dirtyEntries, ...committedEntries, ...untrackedEntries]) {
        if (!seen.has(path)) {
          seen.add(path);
          if (isDeleted) deletedSet.add(path);
          allFilePaths.push(path);
        }
      }
      for (const target of allowedTargets || []) {
        const targetPath = typeof target === "string" ? target : target?.file;
        if (!targetPath || seen.has(targetPath)) continue;
        if (existsSync(join(wtPath, targetPath))) {
          seen.add(targetPath);
          allFilePaths.push(targetPath);
        }
      }
    } else {
      allFilePaths = collectAllowedFilesystemPaths({
        wtPath,
        allowedScope,
        existsSync,
        statSync,
        readdirSync,
      });
    }

    if (allFilePaths.length === 0) {
      log("WARN", "worktree 中无改动，跳过合并");
    } else {
      const skipPrefixes = ["scripts/yolo/", "scripts/yolo-loop/", ".yolo/", ".claude/"];
      let filteredCount = 0;
      let outOfScopeSkippedCount = 0;

      for (const filePath of allFilePaths) {
        if (deletedSet.has(filePath)) continue;
        if (filePath.startsWith("node_modules") || filePath.startsWith(".git") || filePath.startsWith("dist")) continue;
        if (skipPrefixes.some((prefix) => filePath.startsWith(prefix)) && !isFileAllowedByScope(filePath, allowedScope)) {
          filteredCount++;
          continue;
        }
        if (isBusinessLikeFile(filePath) && !isFileAllowedByScope(filePath, allowedScope)) {
          outOfScopeSkippedCount++;
          log("BLOCK", `跳过越界文件: ${filePath}`);
          continue;
        }

        const srcPath = join(wtPath, filePath);
        const dstPath = join(rootDir, filePath);
        try { if (statSync(srcPath).isDirectory()) continue; } catch { continue; }

        if (existsSync(dstPath)) {
          const backupDir = join(rootDir, ".yolo-backup");
          if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
          const safeName = filePath.replace(/\//g, "_");
          const backupPath = join(backupDir, safeName.replace(/(\.\w+)$/, `_${Date.now()}$1`));
          copyFileSync(dstPath, backupPath);
          log("BACKUP", `备份: ${filePath} -> .yolo-backup/`);
        }

        const dstDir = dirname(dstPath);
        if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
        copyFileSync(srcPath, dstPath);
        copiedFiles.push(filePath);
        log("MERGE", `合并: ${filePath}`);
      }

      const skippedParts = [];
      if (filteredCount > 0) skippedParts.push(`跳过 ${filteredCount} 个运行时文件`);
      if (outOfScopeSkippedCount > 0) skippedParts.push(`跳过 ${outOfScopeSkippedCount} 个越界业务文件`);
      log("MERGED", `从 worktree 复制 ${copiedFiles.length} 个文件${skippedParts.length > 0 ? `（${skippedParts.join("，")}）` : ""}`);

      if (copiedFiles.length > 0 && rootInsideGitWorkTree) {
        try {
          const diffNames = execFileSync("git", ["diff", "--name-only", "--", ...copiedFiles], {
            cwd: rootDir,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();
          const untrackedNames = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...copiedFiles], {
            cwd: rootDir,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
          }).trim();
          const changedCopied = new Set([...diffNames.split("\n"), ...untrackedNames.split("\n")].map((file) => file.trim()).filter(Boolean));
          if (changedCopied.size === 0) {
            throw new Error("worktree merge produced no diff for copied files");
          }
          log("VERIFY", `合并验证通过: ${changedCopied.size}/${copiedFiles.length} 个本次复制文件有改动`);
        } catch (error) {
          if (error.message.includes("worktree merge produced no diff")) throw error;
          log("WARN", `合并验证: git diff 命令执行异常 (${error.message})`);
        }
      }
    }
  }

  if (insideGitWorkTree) {
    try {
      execSync(`git worktree remove ${shellQuote(wtPath)} --force`, {
        cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {}
    try {
      execSync(`git branch -D ${shellQuote(wtBranch)}`, {
        cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {}
  }
  removePath(wtPath, { existsSync, rmSync, execSync });

  return copiedFiles;
}
