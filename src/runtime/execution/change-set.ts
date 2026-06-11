import { execFileSync as defaultExecFileSync } from "node:child_process";

export const DEFAULT_COMMIT_EXCLUDE_FILES = ["docs/memory/SESSION.md", "docs/memory/SNAPSHOT.md", "docs/memory/DELIVERY_LOG.md"];
export const DEFAULT_FALLBACK_CHANGED_FILE_EXCLUDES = ["dist-h5/", ".gstack/", ".yolo-backup/"];
export const DEFAULT_BINARY_FILE_PATTERN = /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|mp4|webm|pdf|zip|gz|lock|jar)$/i;

function splitGitFileList(output = "") {
  return String(output || "").trim().split("\n").map((file) => file.trim()).filter(Boolean);
}

export function readTaskChangedFiles({
  rootDir,
  worktreeFiles = null,
  execFileSync = defaultExecFileSync,
  fallbackExcludes = DEFAULT_FALLBACK_CHANGED_FILE_EXCLUDES,
} = Object()) {
  if (worktreeFiles?.length > 0) return worktreeFiles;

  const diff = execFileSync("git", ["diff", "--name-only"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  return [...splitGitFileList(diff), ...splitGitFileList(untracked)]
    .filter((file) => !fallbackExcludes.some((prefix) => file.startsWith(prefix)));
}

export function isBusinessFile(filePath) {
  if (!filePath) return false;
  if (filePath.startsWith(".yolo/")) return false;
  if (filePath.startsWith("scripts/yolo/")) return false;
  if (filePath.startsWith("docs/")) return false;
  if (!filePath.includes("/") && /\.md$/i.test(filePath)) return false;
  if (filePath.startsWith("src/")) return true;
  if (filePath.startsWith("cloudfunctions/")) return true;
  if (filePath.startsWith("tests/")) return true;
  if (filePath.startsWith("__tests__/")) return true;
  if (filePath.includes("/__tests__/")) return true;
  return false;
}

export function filterCommittableFiles(
  files = [],
  {
    excludeFiles = DEFAULT_COMMIT_EXCLUDE_FILES,
    binaryFilePattern = DEFAULT_BINARY_FILE_PATTERN,
  } = Object(),
) {
  return files.filter(
    (file) => file && !excludeFiles.includes(file) && !binaryFilePattern.test(file),
  );
}

export function classifyChangedFiles(files = []) {
  const business = [];
  const metadata = [];
  for (const file of files) {
    if (!file) continue;
    if (isBusinessFile(file)) business.push(file);
    else metadata.push(file);
  }
  return { business, metadata };
}

export function scopedOutOfScopeFiles(files = [], task = Object(), { isFileAllowedByScope } = Object()) {
  const targetFiles = (task.scope?.targets || []).map((target) => target.file).filter(Boolean);
  if (targetFiles.length === 0 || files.length === 0) {
    const unscoped = targetFiles.length === 0;
    return { targetFiles, outOfScope: [], ...(unscoped ? { unscoped: true } : {}) };
  }
  const scope = task.scope || { targets: targetFiles };
  return {
    targetFiles,
    outOfScope: files.filter((file) => !isFileAllowedByScope(file, scope)),
  };
}

export function buildCommitChangeContext({
  rootDir,
  task = Object(),
  worktreeFiles = null,
  execFileSync = defaultExecFileSync,
  isFileAllowedByScope,
  fallbackExcludes,
  committableOptions,
} = Object()) {
  const allChanged = readTaskChangedFiles({
    rootDir,
    worktreeFiles,
    execFileSync,
    fallbackExcludes,
  });
  const code = filterCommittableFiles(allChanged, committableOptions);
  const { business: businessFiles, metadata: metadataFiles } = classifyChangedFiles(code);
  const hasRealCode = task.scope?.expected_zero_business_code === true
    ? true
    : businessFiles.length > 0;
  const { targetFiles: auditTargets, outOfScope } = scopedOutOfScopeFiles(code, task, {
    isFileAllowedByScope,
  });
  const worktreeSkipped = worktreeFiles?.outOfScopeSkipped || [];
  return {
    allChanged,
    code,
    businessFiles,
    metadataFiles,
    hasRealCode,
    auditTargets,
    outOfScope: [...outOfScope, ...worktreeSkipped],
  };
}
