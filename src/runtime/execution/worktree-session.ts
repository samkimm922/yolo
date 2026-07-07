import {
  cpSync as defaultCpSync,
  copyFileSync as defaultCopyFileSync,
  existsSync as defaultExistsSync,
  lstatSync as defaultLstatSync,
  mkdirSync as defaultMkdirSync,
  readFileSync as defaultReadFileSync,
  readdirSync as defaultReaddirSync,
  realpathSync as defaultRealpathSync,
  rmSync as defaultRmSync,
  statSync as defaultStatSync,
  unlinkSync as defaultUnlinkSync,
  writeFileSync as defaultWriteFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { isSafePathComponent, resolveWithinRoot } from "../../lib/security/path-guard.js";
import { safeExecFileSync as defaultExecFileSync, safeExecSync as defaultExecSync } from "../../lib/security/safe-exec.js";
import { parseCommandToArgv } from "../../lib/security/command-guard.js";
import { resolveBuildCommand, resolveGateTimeout } from "../../lib/toolchain.js";
import {
  buildBaselineArtifact,
  parseEslintBaselineKeys,
  parseTscBaselineKeys,
} from "./baselines.js";
import { isBusinessFile } from "./change-set.js";

const PACKAGE_MANAGER_LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
]);

export function isFileInScopeTargets(filePath, targets = []) {
  return (targets || []).some((target) => {
    const targetPath = typeof target === "string" ? target : target?.file;
    if (!targetPath) return false;
    const normalized = targetPath.endsWith("/") ? targetPath : `${targetPath}/`;
    return filePath === targetPath || filePath.startsWith(normalized) || targetPath.startsWith(`${filePath}/`);
  });
}

export function isFileAllowedByScope(filePath, scopeOrTargets = []) {
  const scope = Object.assign(Object(), Array.isArray(scopeOrTargets) ? { targets: scopeOrTargets } : (scopeOrTargets || {}));
  const targets = scope.targets || [];
  if (isFileInScopeTargets(filePath, targets)) return true;
  if (scope.allow_new_files !== true) return false;
  const targetDirs = targets
    .map((target) => typeof target === "string" ? target : target?.file)
    .filter(Boolean)
    .map((target) => target.endsWith("/") ? target : `${dirname(target)}/`);
  return targetDirs.some((dir) => filePath.startsWith(dir));
}

export function isBusinessLikeFile(filePath, options = Object()) {
  return isBusinessFile(filePath, options);
}

function isPackageManagerLockfile(filePath = "") {
  return PACKAGE_MANAGER_LOCKFILES.has(basename(String(filePath || "")));
}

function safeMergeRelativePath(filePath) {
  const normalized = String(filePath ?? "").replace(/\\/g, "/");
  if (!normalized || isAbsolute(normalized) || normalized.includes("\0")) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

function resolveMergeFilePaths({ wtPath, rootDir, filePath }) {
  const relativePath = safeMergeRelativePath(filePath);
  if (!relativePath) {
    throw new Error(`worktree merge unsafe file path: ${filePath || ""}`);
  }
  const src = resolveWithinRoot(wtPath, relativePath);
  if (!src.ok) {
    throw new Error(`worktree merge source escapes worktree: ${src.detail || relativePath}`);
  }
  const dst = resolveWithinRoot(rootDir, relativePath);
  if (!dst.ok) {
    throw new Error(`worktree merge target escapes project root: ${dst.detail || relativePath}`);
  }
  return { filePath: relativePath, srcPath: src.path, dstPath: dst.path };
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

function describeCommandFailure(error) {
  const stderr = String(error?.stderr || "").trim();
  const stdout = String(error?.stdout || "").trim();
  return stderr || stdout || error?.message || String(error);
}

export function gitLines(cwd, args, { execFileSync = defaultExecFileSync, strict = true } = Object()) {
  try {
    const output = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).replace(/\n+$/, "");
    return output ? output.split("\n").filter(Boolean) : [];
  } catch (error) {
    if (strict) {
      throw new Error(`git ${args.join(" ")} failed: ${describeCommandFailure(error)}`);
    }
    return [];
  }
}

function ensureWorktreeRoot(worktreeRoot, { existsSync, mkdirSync }) {
  if (!existsSync(worktreeRoot)) mkdirSync(worktreeRoot, { recursive: true });
}

function isInsideGitWorkTree(rootDir, { execSync = defaultExecSync } = Object()) {
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

function removePath(path, { existsSync, rmSync, execFileSync } = Object()) {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    execFileSync("rm", ["-rf", path], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  }
}

const NODE_MODULES_EXEC_MAX_BUFFER = 1024 * 1024;
const NODE_MODULES_PROVISION_TIMEOUT_MS = 300000;
const NODE_MODULES_CLEANUP_TIMEOUT_MS = 30000;

function execNodeModulesCommand(execFileSync, executable, args, timeout) {
  execFileSync(executable, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout,
    maxBuffer: NODE_MODULES_EXEC_MAX_BUFFER,
  });
}

function removePartialWorktreeNodeModules(wtNodeModules, {
  existsSync,
  rmSync = defaultRmSync,
  execFileSync,
} = Object()) {
  if (!existsSync(wtNodeModules)) return;
  try {
    rmSync(wtNodeModules, { recursive: true, force: true });
  } catch {
    execNodeModulesCommand(
      execFileSync,
      "rm",
      ["-rf", wtNodeModules],
      NODE_MODULES_CLEANUP_TIMEOUT_MS,
    );
  }
}

function shouldLogNodeModulesDiagnostics() {
  return process.env.YOLO_DEBUG_WORKTREE_NODE_MODULES === "1";
}

function describeWorktreeNodeModules(wtPath, {
  existsSync = defaultExistsSync,
  lstatSync = defaultLstatSync,
  realpathSync = defaultRealpathSync,
} = Object()) {
  const wtNodeModules = join(wtPath, "node_modules");
  const diagnostic = {
    worktree: wtPath,
    node_modules: wtNodeModules,
    exists: existsSync(wtNodeModules),
    is_directory: false,
    is_symlink: false,
    realpath: null,
    inside_worktree: false,
    has_bin_yolo: existsSync(join(wtNodeModules, ".bin", "yolo")),
    has_bin_tsc: existsSync(join(wtNodeModules, ".bin", "tsc")),
    has_package_yolo: existsSync(join(wtNodeModules, "yolo")),
    has_package_typescript: existsSync(join(wtNodeModules, "typescript")),
    error: null,
  };
  try {
    const stat = lstatSync(wtNodeModules);
    diagnostic.is_directory = stat.isDirectory();
    diagnostic.is_symlink = stat.isSymbolicLink();
  } catch (error) {
    diagnostic.error = error?.message || String(error);
    return diagnostic;
  }
  try {
    const wtReal = realpathSync(wtPath);
    const nmReal = realpathSync(wtNodeModules);
    const rel = relative(wtReal, nmReal);
    diagnostic.realpath = nmReal;
    diagnostic.inside_worktree = Boolean(rel && !rel.startsWith("..") && !isAbsolute(rel));
  } catch (error) {
    diagnostic.error = error?.message || String(error);
  }
  return diagnostic;
}

function validateWorktreeNodeModules(wtPath, {
  existsSync = defaultExistsSync,
  lstatSync = defaultLstatSync,
  realpathSync = defaultRealpathSync,
} = Object()) {
  const diagnostic = describeWorktreeNodeModules(wtPath, { existsSync, lstatSync, realpathSync });
  if (!diagnostic.exists) {
    return { ok: false, reason: "missing", diagnostic };
  }
  if (!diagnostic.is_directory || diagnostic.is_symlink) {
    return { ok: false, reason: "not_real_directory", diagnostic };
  }
  if (!diagnostic.inside_worktree) {
    return { ok: false, reason: "outside_worktree", diagnostic };
  }
  return { ok: true, reason: null, diagnostic };
}

function isRealPathInside(parentReal, childReal) {
  const rel = relative(parentReal, childReal);
  return rel === "" || Boolean(rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function collectPackageSymlinkEntries(rootNodeModules, {
  readdirSync = defaultReaddirSync,
  lstatSync = defaultLstatSync,
} = Object()) {
  const entries = [];
  let rootEntries = [];
  try {
    rootEntries = readdirSync(rootNodeModules, { withFileTypes: true });
  } catch {
    return entries;
  }
  const maybeAdd = (relativePath) => {
    const path = join(rootNodeModules, relativePath);
    try {
      if (lstatSync(path).isSymbolicLink()) entries.push({ relativePath, path });
    } catch {}
  };
  for (const entry of rootEntries) {
    if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      let scopedEntries = [];
      try {
        scopedEntries = readdirSync(join(rootNodeModules, entry.name), { withFileTypes: true });
      } catch {}
      for (const scopedEntry of scopedEntries) {
        maybeAdd(join(entry.name, scopedEntry.name));
      }
      continue;
    }
    maybeAdd(entry.name);
  }
  return entries;
}

function copyNodeModulesEntry(execFileSync, source, destination) {
  try {
    execNodeModulesCommand(execFileSync, "cp", ["-a", "--reflink=auto", source, destination], NODE_MODULES_PROVISION_TIMEOUT_MS);
  } catch {
    execNodeModulesCommand(execFileSync, "cp", ["-a", source, destination], NODE_MODULES_PROVISION_TIMEOUT_MS);
  }
}

function removeCopiedNodeModulesEntry(path, {
  lstatSync = defaultLstatSync,
  rmSync = defaultRmSync,
  unlinkSync = defaultUnlinkSync,
} = Object()) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    rmSync(path, { recursive: true, force: true });
    return;
  }
  unlinkSync(path);
}

function materializeExternalPackageSymlinks({
  rootNodeModules,
  wtNodeModules,
  execFileSync = defaultExecFileSync,
  readdirSync = defaultReaddirSync,
  lstatSync = defaultLstatSync,
  realpathSync = defaultRealpathSync,
  mkdirSync = defaultMkdirSync,
  rmSync = defaultRmSync,
} = Object()) {
  let rootNodeModulesReal;
  try {
    rootNodeModulesReal = realpathSync(rootNodeModules);
  } catch {
    return;
  }
  const symlinks = collectPackageSymlinkEntries(rootNodeModules, { readdirSync, lstatSync });
  for (const entry of symlinks) {
    let targetReal;
    try {
      targetReal = realpathSync(entry.path);
    } catch {
      continue;
    }
    if (isRealPathInside(rootNodeModulesReal, targetReal)) continue;
    const destination = join(wtNodeModules, entry.relativePath);
    try {
      mkdirSync(dirname(destination), { recursive: true });
      removeCopiedNodeModulesEntry(destination, { lstatSync, rmSync });
      copyNodeModulesEntry(execFileSync, targetReal, destination);
    } catch (error) {
      removeCopiedNodeModulesEntry(destination, { lstatSync, rmSync });
      throw error;
    }
  }
}

export function provisionWorktreeNodeModules({
  wtPath,
  rootDir,
  execFileSync = defaultExecFileSync,
  existsSync = defaultExistsSync,
  lstatSync = defaultLstatSync,
  realpathSync = defaultRealpathSync,
  readdirSync = defaultReaddirSync,
  mkdirSync = defaultMkdirSync,
  rmSync = defaultRmSync,
  platform = process.platform,
} = Object()) {
  const wtNodeModules = join(wtPath, "node_modules");
  const rootNodeModules = join(rootDir, "node_modules");
  if (existsSync(wtNodeModules) || !existsSync(rootNodeModules)) return false;

  const cloneArgs = platform === "darwin"
    ? ["-cR", rootNodeModules, wtNodeModules]
    : ["-a", "--reflink=auto", rootNodeModules, wtNodeModules];
  const copyArgs = platform === "darwin"
    ? ["-pR", rootNodeModules, wtNodeModules]
    : ["-a", rootNodeModules, wtNodeModules];
  const attempts = [
    { executable: "cp", args: cloneArgs, timeout: NODE_MODULES_PROVISION_TIMEOUT_MS },
    { executable: "cp", args: copyArgs, timeout: NODE_MODULES_PROVISION_TIMEOUT_MS },
  ];
  for (const [index, attempt] of attempts.entries()) {
    try {
      execNodeModulesCommand(execFileSync, attempt.executable, attempt.args, attempt.timeout);
      materializeExternalPackageSymlinks({
        rootNodeModules,
        wtNodeModules,
        execFileSync,
        readdirSync,
        lstatSync,
        realpathSync,
        mkdirSync,
        rmSync,
      });
      const validation = validateWorktreeNodeModules(wtPath, { existsSync, lstatSync, realpathSync });
      if (!validation.ok) {
        throw new Error(`node_modules provisioning produced unusable worktree dependency tree: ${validation.reason} ${JSON.stringify(validation.diagnostic)}`);
      }
      return true;
    } catch (error) {
      removePartialWorktreeNodeModules(wtNodeModules, { existsSync, rmSync, execFileSync });
      if (index === attempts.length - 1) throw error;
    }
  }
  return false;
}

export function persistWorktreeNodeModulesToRoot({
  wtPath,
  rootDir,
  execFileSync = defaultExecFileSync,
  existsSync = defaultExistsSync,
  lstatSync = defaultLstatSync,
  realpathSync = defaultRealpathSync,
  readdirSync = defaultReaddirSync,
  mkdirSync = defaultMkdirSync,
  rmSync = defaultRmSync,
  platform = process.platform,
} = Object()) {
  const wtNodeModules = join(wtPath, "node_modules");
  const rootNodeModules = join(rootDir, "node_modules");
  if (existsSync(rootNodeModules) || !existsSync(wtNodeModules)) return false;

  const sourceValidation = validateWorktreeNodeModules(wtPath, { existsSync, lstatSync, realpathSync });
  if (!sourceValidation.ok) {
    throw new Error(`worktree node_modules cannot be persisted: ${sourceValidation.reason} ${JSON.stringify(sourceValidation.diagnostic)}`);
  }

  const cloneArgs = platform === "darwin"
    ? ["-cR", wtNodeModules, rootNodeModules]
    : ["-a", "--reflink=auto", wtNodeModules, rootNodeModules];
  const copyArgs = platform === "darwin"
    ? ["-pR", wtNodeModules, rootNodeModules]
    : ["-a", wtNodeModules, rootNodeModules];
  const attempts = [
    { executable: "cp", args: cloneArgs, timeout: NODE_MODULES_PROVISION_TIMEOUT_MS },
    { executable: "cp", args: copyArgs, timeout: NODE_MODULES_PROVISION_TIMEOUT_MS },
  ];

  for (const [index, attempt] of attempts.entries()) {
    try {
      execNodeModulesCommand(execFileSync, attempt.executable, attempt.args, attempt.timeout);
      materializeExternalPackageSymlinks({
        rootNodeModules: wtNodeModules,
        wtNodeModules: rootNodeModules,
        execFileSync,
        readdirSync,
        lstatSync,
        realpathSync,
        mkdirSync,
        rmSync,
      });
      const validation = validateWorktreeNodeModules(rootDir, { existsSync, lstatSync, realpathSync });
      if (!validation.ok) {
        throw new Error(`persisted node_modules is unusable: ${validation.reason} ${JSON.stringify(validation.diagnostic)}`);
      }
      return true;
    } catch (error) {
      removePartialWorktreeNodeModules(rootNodeModules, { existsSync, rmSync, execFileSync });
      if (index === attempts.length - 1) throw error;
    }
  }
  return false;
}

function normalizedFsPath(path) {
  return resolve(path).replaceAll("\\", "/");
}

function pathContains(parent, child) {
  const normalizedParent = normalizedFsPath(parent);
  const normalizedChild = normalizedFsPath(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function shouldCopyProjectEntry(src, { wtPath = null } = Object()) {
  if (wtPath && (pathContains(src, wtPath) || pathContains(wtPath, src))) return false;
  const name = src.split("/").pop();
  if ([".git", "node_modules", ".yolo-worktrees", ".yolo-backup"].includes(name)) return false;
  if (name === ".DS_Store") return false;
  if (src.includes("/.yolo/state/runtime/")) return false;
  return true;
}

function copyProjectToFilesystemWorktree({ rootDir, wtPath, cpSync, readdirSync } = Object()) {
  const targetInsideRoot = pathContains(rootDir, wtPath);
  const filter = (src) => shouldCopyProjectEntry(src, { wtPath: targetInsideRoot ? wtPath : null });
  if (!targetInsideRoot) {
    cpSync(rootDir, wtPath, {
      recursive: true,
      dereference: false,
      filter,
    });
    return;
  }

  for (const entry of readdirSync(rootDir)) {
    const src = join(rootDir, entry);
    if (!filter(src)) continue;
    cpSync(src, join(wtPath, entry), {
      recursive: true,
      dereference: false,
      filter,
    });
  }
}

function writeFilesystemLineBaseline({
  wtPath,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} = Object()) {
  const lineCounts = Object();
  const hashes = Object();
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
  // M11: a baseline write failure must NOT be swallowed. The baseline is the
  // tamper-audit contract for the worktree; losing it silently means merge-time
  // verification can't detect source mutation. Fail the worktree creation so
  // the task blocks rather than proceeding with an unverifiable baseline.
  try {
    writeFileSync(join(wtPath, ".yolo-worktree-baseline.json"), JSON.stringify({
      line_counts: lineCounts,
      hashes,
    }, null, 2), "utf8");
  } catch (error) {
    throw new Error(`worktree baseline write failed (${wtPath}): ${error instanceof Error ? error.message : String(error)}; cannot proceed without a tamper-audit baseline`);
  }
}

function gitHeadCommit(rootDir, { execSync = defaultExecSync } = Object()) {
  try {
    return {
      ok: true,
      commit: execSync("git rev-parse --verify HEAD", {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      commit: null,
      reason: "unborn_head",
      detail: describeCommandFailure(error),
    };
  }
}

function createFilesystemTaskWorktree({
  wtPath,
  wtBranch,
  rootDir,
  baseCommit,
  config,
  reason = "not_git_worktree",
  detail = "",
  mkdirSync,
  cpSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  execFileSync,
  existsSync,
} = Object()) {
  mkdirSync(wtPath, { recursive: true });
  copyProjectToFilesystemWorktree({ rootDir, wtPath, cpSync, readdirSync });
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
  return {
    branch: wtBranch,
    path: wtPath,
    base: baseCommit,
    mode: "filesystem",
    reason,
    detail,
  };
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
    const safePath = safeMergeRelativePath(filePath);
    if (!safePath) throw new Error(`worktree merge unsafe file path: ${filePath || ""}`);
    if (seen.has(safePath)) return;
    const resolved = resolveWithinRoot(wtPath, safePath);
    if (!resolved.ok) throw new Error(`worktree merge source escapes worktree: ${resolved.detail || safePath}`);
    const absolute = resolved.path;
    try {
      if (statSync(absolute).isDirectory()) return;
    } catch {
      return;
    }
    seen.add(safePath);
    files.push(safePath);
  };
  const walk = (relativeDir) => {
    const safeDir = safeMergeRelativePath(relativeDir === "." ? "" : relativeDir);
    if (relativeDir && relativeDir !== "." && !safeDir) {
      throw new Error(`worktree merge unsafe directory path: ${relativeDir}`);
    }
    const resolvedDir = resolveWithinRoot(wtPath, safeDir || ".");
    if (!resolvedDir.ok) throw new Error(`worktree merge source escapes worktree: ${resolvedDir.detail || relativeDir}`);
    const absoluteDir = resolvedDir.path;
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
    const safeTarget = safeMergeRelativePath(targetPath);
    if (!safeTarget) throw new Error(`worktree merge unsafe file path: ${targetPath}`);
    const targetResolved = resolveWithinRoot(wtPath, safeTarget);
    if (!targetResolved.ok) throw new Error(`worktree merge source escapes worktree: ${targetResolved.detail || safeTarget}`);
    if (existsSync(targetResolved.path)) {
      addFile(safeTarget);
      if (allowNewFiles) {
        const dir = dirname(safeTarget);
        if (dir && dir !== ".") walk(dir);
      }
      continue;
    }
    if (allowNewFiles) walk(dirname(safeTarget));
  }
  return files;
}

function writeWorktreeBaselines({
  wtPath,
  config,
  execFileSync = defaultExecFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
}) {
  const wtBaselineDir = join(wtPath, "scripts", "yolo", "state", "runtime");
  if (!existsSync(wtBaselineDir)) mkdirSync(wtBaselineDir, { recursive: true });
  const baselineEnv = {
    ...process.env,
    PATH: [join(wtPath, "node_modules", ".bin"), process.env.PATH || ""].filter(Boolean).join(delimiter),
  };
  // P12.I1: route config-supplied command through safe-exec with cwd=wtPath.
  // argv parse rejects metacharacters; execFileSync DI defaults to safeExecFileSync.
  const run = (command, timeout) => {
    const rawCommand = String(command || "").trim();
    if (!rawCommand) {
      return {
        output: "",
        stderr: "",
        exitCode: 0,
        status: "skipped",
        reason: "baseline_command_not_configured",
      };
    }
    const parsed = parseCommandToArgv(rawCommand);
    if (!parsed.ok) {
      return {
        output: `command rejected: ${parsed.detail}`,
        stderr: `command rejected: ${parsed.detail}`,
        exitCode: 127,
        status: "blocked",
        reason: "baseline_command_rejected",
      };
    }
    const argv = parsed.argv ?? [];
    try {
      const stdout = execFileSync(argv[0], argv.slice(1), {
        cwd: wtPath,
        encoding: "utf8",
        timeout,
        env: baselineEnv,
      });
      return {
        output: String(stdout || ""),
        stderr: "",
        exitCode: 0,
        status: "pass",
        reason: null,
      };
    } catch (error) {
      const stdout = String(error?.stdout || "");
      const stderr = String(error?.stderr || error?.message || "");
      const output = `${stdout}${stderr}`;
      const exitCode = Number.isInteger(error?.status) ? error.status : (Number.isInteger(error?.code) ? error.code : 1);
      const blocked = Boolean(error?.signal) ||
        exitCode === 127 ||
        /\bnot found\b|is not recognized|command not found/i.test(output) ||
        !output.trim();
      return {
        output,
        stderr,
        exitCode,
        status: blocked ? "blocked" : "pass",
        reason: blocked ? (error?.signal ? "baseline_command_timeout_or_signal" : "baseline_command_unavailable") : null,
      };
    }
  };
  try {
    const command = resolveBuildCommand("type_check", config, wtPath);
    const result = run(command, resolveGateTimeout("type_check", config));
    const keys = parseTscBaselineKeys(result.output);
    writeFileSync(join(wtBaselineDir, "tsc-baseline.json"), JSON.stringify(buildBaselineArtifact({
      tool: "tsc",
      keys,
      command,
      exitCode: result.exitCode,
      stdout: result.output,
      stderr: result.stderr,
      commit: null,
      status: result.status,
      reason: result.reason,
    }), null, 2), "utf8");
  } catch {}
  try {
    const command = resolveBuildCommand("lint", config, wtPath);
    const result = run(command, resolveGateTimeout("lint", config));
    writeFileSync(join(wtBaselineDir, "eslint-baseline.json"), JSON.stringify({
      ...buildBaselineArtifact({
        tool: "eslint",
        keys: parseEslintBaselineKeys(result.output, wtPath),
        command,
        exitCode: result.exitCode,
        stdout: result.output,
        stderr: result.stderr,
        commit: null,
        status: result.status,
        reason: result.reason,
      }),
    }, null, 2), "utf8");
  } catch {}
}

const SAFE_WORKTREE_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeWorktreeTaskId(taskId) {
  const id = String(taskId ?? "");
  if (!isSafePathComponent(id) || !SAFE_WORKTREE_TASK_ID_RE.test(id)) {
    throw new Error("createWorktree: unsafe taskId path component");
  }
  return id;
}

function assertSafeWorktreeTimestamp(value) {
  const timestamp = String(value ?? "");
  if (!/^\d+$/.test(timestamp)) {
    throw new Error("createWorktree: unsafe worktree timestamp component");
  }
  return timestamp;
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
} = Object()) {
  const safeTaskId = assertSafeWorktreeTaskId(taskId);
  const wtBranch = `yolo-${safeTaskId}-${assertSafeWorktreeTimestamp(now())}`;
  const wtPath = join(worktreeRoot, safeTaskId);
  const insideGitWorkTree = isInsideGitWorkTree(rootDir, { execSync });
  let baseCommit = "filesystem";
  const head = insideGitWorkTree ? gitHeadCommit(rootDir, { execSync }) : { ok: false, commit: null, reason: "not_git_worktree", detail: "" };
  if (head.ok) baseCommit = head.commit;

  ensureWorktreeRoot(worktreeRoot, { existsSync, mkdirSync });

  try {
    execFileSync("git", ["worktree", "remove", wtPath, "--force"], {
      cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {}
  try {
    execFileSync("git", ["branch", "-D", wtBranch], {
      cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {}
  removePath(wtPath, { existsSync, rmSync, execFileSync });

  if (!insideGitWorkTree) {
    return createFilesystemTaskWorktree({
      wtPath,
      wtBranch,
      rootDir,
      baseCommit,
      config,
      reason: "not_git_worktree",
      mkdirSync,
      cpSync,
      readFileSync,
      readdirSync,
      statSync,
      writeFileSync,
      execFileSync,
      existsSync,
    });
  }

  if (!head.ok) {
    throw new Error(`createWorktree: git HEAD unavailable in git repository (${head.reason}${head.detail ? `: ${head.detail}` : ""}); yolo run startup must create an initial commit baseline before task worktrees`);
  }

  try {
    execFileSync("git", ["worktree", "add", "--detach", wtPath, "HEAD"], {
      cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`createWorktree: git worktree add failed: ${error.message}`);
  }

  try {
    execFileSync("git", ["-C", wtPath, "checkout", "-b", wtBranch], {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    try { execFileSync("git", ["worktree", "remove", wtPath, "--force"], { cwd: rootDir, stdio: ["pipe", "pipe", "pipe"] }); } catch {}
    throw new Error(`createWorktree: git checkout -b failed: ${error.message}`);
  }

  provisionWorktreeNodeModules({ wtPath, rootDir, execFileSync, existsSync });

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
  config,
  execSync = defaultExecSync,
  execFileSync = defaultExecFileSync,
  existsSync = defaultExistsSync,
  readdirSync = defaultReaddirSync,
  rmSync = defaultRmSync,
  statSync = defaultStatSync,
  mkdirSync = defaultMkdirSync,
  copyFileSync = defaultCopyFileSync,
  log = (..._args) => {},
} = Object()) {
  const copiedFiles = [];
  const outOfScopeSkipped = [];
  const allowedTargets = Array.isArray(allowedScope) ? allowedScope : (allowedScope?.targets || []);
  const insideGitWorkTree = isInsideGitWorkTree(wtPath, { execSync });
  const rootInsideGitWorkTree = isInsideGitWorkTree(rootDir, { execSync });
  if (mergeToMain) {
    const seen = new Set();
    const deletedSet = new Set();
    let allFilePaths = [];

    if (insideGitWorkTree) {
      const dirtyEntries = parseGitStatusEntries(gitLines(wtPath, ["status", "--porcelain"], { execFileSync, strict: true }).join("\n"));
      const committedEntries = baseRef
        ? parseGitNameStatusEntries(gitLines(wtPath, ["diff", "--name-status", baseRef, "HEAD"], { execFileSync, strict: true }).join("\n"))
        : [];
      const untrackedEntries = gitLines(wtPath, ["ls-files", "--others", "--exclude-standard"], { execFileSync, strict: true })
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
        const resolved = resolveMergeFilePaths({ wtPath, rootDir, filePath });
        const safeFilePath = resolved.filePath;
        if (deletedSet.has(filePath)) continue;
        if (safeFilePath.startsWith("node_modules") || safeFilePath.startsWith(".git") || safeFilePath.startsWith("dist")) continue;
        if (skipPrefixes.some((prefix) => safeFilePath.startsWith(prefix)) && !isFileAllowedByScope(safeFilePath, allowedScope)) {
          filteredCount++;
          continue;
        }
        if (isPackageManagerLockfile(safeFilePath) && !isFileAllowedByScope(safeFilePath, allowedScope)) {
          filteredCount++;
          log("SKIP", `跳过未入 scope 的包管理锁文件: ${safeFilePath}`);
          continue;
        }
        if (isBusinessLikeFile(safeFilePath, { config }) && !isFileAllowedByScope(safeFilePath, allowedScope)) {
          outOfScopeSkippedCount++;
          outOfScopeSkipped.push(safeFilePath);
          log("BLOCK", `跳过越界文件: ${safeFilePath}`);
          continue;
        }

        const srcPath = resolved.srcPath;
        const dstPath = resolved.dstPath;
        try { if (statSync(srcPath).isDirectory()) continue; } catch { continue; }

        if (existsSync(dstPath)) {
          const backupDir = join(rootDir, ".yolo-backup");
          if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
          const safeName = safeFilePath.replace(/\//g, "_");
          const backupPath = join(backupDir, safeName.replace(/(\.\w+)$/, `_${Date.now()}$1`));
          copyFileSync(dstPath, backupPath);
          log("BACKUP", `备份: ${safeFilePath} -> .yolo-backup/`);
        }

        const dstDir = dirname(dstPath);
        if (!existsSync(dstDir)) mkdirSync(dstDir, { recursive: true });
        copyFileSync(srcPath, dstPath);
        copiedFiles.push(safeFilePath);
        log("MERGE", `合并: ${safeFilePath}`);
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
          throw new Error(`worktree merge verification failed: ${describeCommandFailure(error)}`);
        }
      }
      if (copiedFiles.length > 0) {
        const persisted = persistWorktreeNodeModulesToRoot({
          wtPath,
          rootDir,
          execFileSync,
          existsSync,
          lstatSync: defaultLstatSync,
          realpathSync: defaultRealpathSync,
          readdirSync,
          mkdirSync,
          rmSync,
        });
        if (persisted) log("MERGE", "持久化 node_modules 工具链缓存");
      }
    }
  }

  if (insideGitWorkTree) {
    if (shouldLogNodeModulesDiagnostics()) {
      log("!!", `worktree node_modules diagnostic: ${JSON.stringify(describeWorktreeNodeModules(wtPath, {
        existsSync,
        lstatSync: defaultLstatSync,
        realpathSync: defaultRealpathSync,
      }))}`);
    }
    try {
      execFileSync("git", ["worktree", "remove", wtPath, "--force"], {
        cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {}
    try {
      execFileSync("git", ["branch", "-D", wtBranch], {
        cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {}
  }
  removePath(wtPath, { existsSync, rmSync, execFileSync });

  Object.defineProperty(copiedFiles, "outOfScopeSkipped", {
    value: outOfScopeSkipped,
    enumerable: false,
  });
  Object.defineProperty(copiedFiles, "fromWorktreeMerge", {
    value: Boolean(mergeToMain),
    enumerable: false,
  });
  return copiedFiles;
}
