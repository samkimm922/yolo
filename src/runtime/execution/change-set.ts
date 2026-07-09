import { execFileSync as defaultExecFileSync } from "node:child_process";
import {
  declaredBusinessFilePatterns,
  declaredConfigFilePatterns,
  matchesAnyFilePattern,
  normalizeRepoFilePath,
} from "../project-file-policy.js";

export const DEFAULT_COMMIT_EXCLUDE_FILES = ["docs/memory/SESSION.md", "docs/memory/SNAPSHOT.md", "docs/memory/DELIVERY_LOG.md"];
export const DEFAULT_FALLBACK_CHANGED_FILE_EXCLUDES = ["dist-h5/", ".gstack/", ".yolo-backup/"];
export const DEFAULT_BINARY_FILE_PATTERN = /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|mp4|webm|pdf|zip|gz|lock|jar)$/i;
export const DEFAULT_BUSINESS_SOURCE_EXTENSIONS = [];

const DEFAULT_BUSINESS_EXCLUDED_PREFIXES = [
  ".yolo/",
  ".yolo-backup/",
  ".gstack/",
  ".claude/",
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  ".next/",
  "coverage/",
  "docs/",
  "scripts/yolo/",
];

function splitGitFileList(output = "") {
  return String(output || "").trim().split("\n").map((file) => file.trim()).filter(Boolean);
}

function configuredBusinessGlobs(options = Object()) {
  return declaredBusinessFilePatterns(options);
}

function usesLegacyBusinessGlobs(options = Object()) {
  const config = options.config || options;
  return Array.isArray(options.businessGlobs)
    || Array.isArray(options.business_globs)
    || Array.isArray(config?.build?.business_globs)
    || Array.isArray(config?.build?.businessGlobs)
    || Array.isArray(config?.project?.business_globs)
    || Array.isArray(config?.project?.businessGlobs);
}

function isAlwaysNonBusinessFile(filePath) {
  if (!filePath) return true;
  if (DEFAULT_BUSINESS_EXCLUDED_PREFIXES.some((prefix) => filePath.startsWith(prefix))) return true;
  if (filePath.split("/").some((part) => part === "node_modules" || part === ".git")) return true;
  if (!filePath.includes("/") && /\.md$/i.test(filePath)) return true;
  return false;
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

export function businessFilePolicyDescription(options = Object()) {
  const businessPatterns = configuredBusinessGlobs(options);
  const configPatterns = declaredConfigFilePatterns(options);
  const label = usesLegacyBusinessGlobs(options) ? "business_globs" : "business_file_patterns";
  const prefix = businessPatterns.length > 0
    ? `${label}: ${businessPatterns.join(", ")}`
    : `${label}: <none declared; no business files inferred>`;
  const configDetail = configPatterns.length > 0 ? `; config_file_patterns: ${configPatterns.join(", ")}` : "";
  return `${prefix}${configDetail}; excludes: ${DEFAULT_BUSINESS_EXCLUDED_PREFIXES.join(", ")}`;
}

export function isBusinessFile(filePath, options = Object()) {
  const normalized = normalizeRepoFilePath(filePath);
  if (isAlwaysNonBusinessFile(normalized)) return false;
  const configPatterns = declaredConfigFilePatterns(options);
  if (configPatterns.length > 0 && matchesAnyFilePattern(normalized, configPatterns)) return false;
  const businessPatterns = configuredBusinessGlobs(options);
  if (businessPatterns.length === 0) return false;
  return matchesAnyFilePattern(normalized, businessPatterns);
}

export function businessGlobsFromConfig(config = Object()) {
  return configuredBusinessGlobs({ config });
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

export function classifyChangedFiles(files = [], options = Object()) {
  const business = [];
  const metadata = [];
  for (const file of files) {
    if (!file) continue;
    if (isBusinessFile(file, options)) business.push(file);
    else metadata.push(file);
  }
  return { business, metadata };
}

export function scopedOutOfScopeFiles(files = [], task = Object(), { isFileAllowedByScope } = Object()): { targetFiles: string[]; outOfScope: string[]; unscoped?: boolean } {
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
  config,
  businessGlobs,
} = Object()) {
  const allChanged = readTaskChangedFiles({
    rootDir,
    worktreeFiles,
    execFileSync,
    fallbackExcludes,
  });
  const code = filterCommittableFiles(allChanged, committableOptions);
  const { business: businessFiles, metadata: metadataFiles } = classifyChangedFiles(code, {
    config,
    businessGlobs,
  });
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
