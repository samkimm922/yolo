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
import {
  execSync as defaultExecSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { safeExecFileSync as defaultExecFileSync } from "../../lib/security/safe-exec.js";
import { parseCommandToArgv } from "../../lib/security/command-guard.js";
import {
  buildBaselineArtifact,
  parseEslintBaselineKeys,
  parseTscBaselineKeys,
} from "./baselines.js";
import { isBusinessFile } from "./change-set.js";

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

function shellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
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

function removePath(path, { existsSync, rmSync, execSync } = Object()) {
  if (!existsSync(path)) return;
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    execSync(`rm -rf ${shellQuote(path)}`, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  }
}

const NODE_MODULES_EXEC_MAX_BUFFER = 1024 * 1024;
const NODE_MODULES_PROVISION_TIMEOUT_MS = 300000;
const NODE_MODULES_CLEANUP_TIMEOUT_MS = 30000;

function execNodeModulesCommand(execSync, command, timeout) {
  execSync(command, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout,
    maxBuffer: NODE_MODULES_EXEC_MAX_BUFFER,
  });
}

function removePartialWorktreeNodeModules(wtNodeModules, {
  existsSync,
  rmSync = defaultRmSync,
  execSync,
} = Object()) {
  if (!existsSync(wtNodeModules)) return;
  try {
    rmSync(wtNodeModules, { recursive: true, force: true });
  } catch {
    execNodeModulesCommand(
      execSync,
      `rm -rf ${shellQuote(wtNodeModules)}`,
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

function copyNodeModulesEntry(execSync, source, destination) {
  const cloneCommand = `cp -a --reflink=auto ${shellQuote(source)} ${shellQuote(destination)}`;
  const copyCommand = `cp -a ${shellQuote(source)} ${shellQuote(destination)}`;
  try {
    execNodeModulesCommand(execSync, cloneCommand, NODE_MODULES_PROVISION_TIMEOUT_MS);
  } catch {
    execNodeModulesCommand(execSync, copyCommand, NODE_MODULES_PROVISION_TIMEOUT_MS);
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
  execSync = defaultExecSync,
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
      copyNodeModulesEntry(execSync, targetReal, destination);
    } catch (error) {
      removeCopiedNodeModulesEntry(destination, { lstatSync, rmSync });
      throw error;
    }
  }
}

export function provisionWorktreeNodeModules({
  wtPath,
  rootDir,
  execSync = defaultExecSync,
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

  const cloneCommand = platform === "darwin"
    ? `cp -cR ${shellQuote(rootNodeModules)} ${shellQuote(wtNodeModules)}`
    : `cp -a --reflink=auto ${shellQuote(rootNodeModules)} ${shellQuote(wtNodeModules)}`;
  const copyCommand = platform === "darwin"
    ? `cp -pR ${shellQuote(rootNodeModules)} ${shellQuote(wtNodeModules)}`
    : `cp -a ${shellQuote(rootNodeModules)} ${shellQuote(wtNodeModules)}`;
  const attempts = [
    { command: cloneCommand, timeout: NODE_MODULES_PROVISION_TIMEOUT_MS },
    { command: copyCommand, timeout: NODE_MODULES_PROVISION_TIMEOUT_MS },
  ];
  for (const [index, attempt] of attempts.entries()) {
    try {
      execNodeModulesCommand(execSync, attempt.command, attempt.timeout);
      materializeExternalPackageSymlinks({
        rootNodeModules,
        wtNodeModules,
        execSync,
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
      removePartialWorktreeNodeModules(wtNodeModules, { existsSync, rmSync, execSync });
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
  try {
    writeFileSync(join(wtPath, ".yolo-worktree-baseline.json"), JSON.stringify({
      line_counts: lineCounts,
      hashes,
    }, null, 2), "utf8");
  } catch {}
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
    const result = run(config.build?.type_check || "", 120000);
    const keys = parseTscBaselineKeys(result.output);
    writeFileSync(join(wtBaselineDir, "tsc-baseline.json"), JSON.stringify(buildBaselineArtifact({
      tool: "tsc",
      keys,
      command: config.build?.type_check || "",
      exitCode: result.exitCode,
      stdout: result.output,
      stderr: result.stderr,
      commit: null,
      status: result.status,
      reason: result.reason,
    }), null, 2), "utf8");
  } catch {}
  try {
    const result = run(config.build?.lint || "", 90000);
    writeFileSync(join(wtBaselineDir, "eslint-baseline.json"), JSON.stringify({
      ...buildBaselineArtifact({
        tool: "eslint",
        keys: parseEslintBaselineKeys(result.output, wtPath),
        command: config.build?.lint || "",
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
  const wtBranch = `yolo-${taskId}-${now()}`;
  const wtPath = join(worktreeRoot, taskId);
  const insideGitWorkTree = isInsideGitWorkTree(rootDir, { execSync });
  let baseCommit = "filesystem";
  const head = insideGitWorkTree ? gitHeadCommit(rootDir, { execSync }) : { ok: false, commit: null, reason: "not_git_worktree", detail: "" };
  if (head.ok) baseCommit = head.commit;

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
    return createFilesystemTaskWorktree({
      wtPath,
      wtBranch,
      rootDir,
      baseCommit,
      config,
      reason: head.reason,
      detail: head.detail,
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

  provisionWorktreeNodeModules({ wtPath, rootDir, execSync, existsSync });

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
        if (deletedSet.has(filePath)) continue;
        if (filePath.startsWith("node_modules") || filePath.startsWith(".git") || filePath.startsWith("dist")) continue;
        if (skipPrefixes.some((prefix) => filePath.startsWith(prefix)) && !isFileAllowedByScope(filePath, allowedScope)) {
          filteredCount++;
          continue;
        }
        if (isBusinessLikeFile(filePath, { config }) && !isFileAllowedByScope(filePath, allowedScope)) {
          outOfScopeSkippedCount++;
          outOfScopeSkipped.push(filePath);
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
          throw new Error(`worktree merge verification failed: ${describeCommandFailure(error)}`);
        }
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

  Object.defineProperty(copiedFiles, "outOfScopeSkipped", {
    value: outOfScopeSkipped,
    enumerable: false,
  });
  return copiedFiles;
}
