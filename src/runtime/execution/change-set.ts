import { execFileSync as defaultExecFileSync } from "node:child_process";

export const DEFAULT_COMMIT_EXCLUDE_FILES = ["docs/memory/SESSION.md", "docs/memory/SNAPSHOT.md", "docs/memory/DELIVERY_LOG.md"];
export const DEFAULT_FALLBACK_CHANGED_FILE_EXCLUDES = ["dist-h5/", ".gstack/", ".yolo-backup/"];
export const DEFAULT_BINARY_FILE_PATTERN = /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|mp4|webm|pdf|zip|gz|lock|jar)$/i;
export const DEFAULT_BUSINESS_SOURCE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts", ".rb", ".php",
  ".cs", ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".swift",
  ".scala", ".dart", ".ex", ".exs", ".erl", ".hrl", ".clj", ".cljs",
  ".fs", ".fsx", ".vb", ".r", ".lua", ".sh", ".bash", ".zsh", ".fish",
  ".sql", ".graphql", ".gql", ".css", ".scss", ".sass", ".less",
  ".html", ".vue", ".svelte", ".astro",
];

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

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "Pipfile.lock",
]);

const ROOT_CONFIG_FILE_PATTERN = /^(?:[^/]+\.config\.(?:cjs|cts|js|mjs|mts|ts)|(?:babel|eslint|jest|next|nuxt|playwright|postcss|prettier|rollup|svelte|tailwind|vite|vitest)\.config\.(?:cjs|cts|js|mjs|mts|ts))$/i;

function splitGitFileList(output = "") {
  return String(output || "").trim().split("\n").map((file) => file.trim()).filter(Boolean);
}

function normalizeRepoFilePath(filePath) {
  return String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function configuredBusinessGlobs(options = Object()) {
  if (Array.isArray(options)) return options.map(String).map((glob) => glob.trim()).filter(Boolean);
  const direct = options.businessGlobs || options.business_globs;
  const config = options.config || options;
  const candidates = [
    direct,
    config?.build?.business_globs,
    config?.build?.businessGlobs,
    config?.project?.business_globs,
    config?.project?.businessGlobs,
  ];
  const globs = candidates.find((value) => Array.isArray(value) && value.length > 0) ||
    candidates.find((value) => Array.isArray(value));
  return Array.isArray(globs) ? globs.map(String).map((glob) => glob.trim()).filter(Boolean) : [];
}

function escapeRegexChar(char) {
  return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(glob) {
  const normalized = normalizeRepoFilePath(glob).replace(/^\/+/, "");
  const pattern = normalized.endsWith("/") ? `${normalized}**` : normalized;
  let source = "^";
  for (let i = 0; i < pattern.length;) {
    if (pattern.slice(i, i + 3) === "**/") {
      source += "(?:.*/)?";
      i += 3;
      continue;
    }
    if (pattern.slice(i, i + 2) === "**") {
      source += ".*";
      i += 2;
      continue;
    }
    const char = pattern[i];
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += escapeRegexChar(char);
    i++;
  }
  return new RegExp(`${source}$`);
}

function matchesAnyGlob(filePath, globs = []) {
  return globs.some((glob) => globToRegExp(glob).test(filePath));
}

function hasBusinessSourceExtension(filePath) {
  const lower = filePath.toLowerCase();
  return DEFAULT_BUSINESS_SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function isAlwaysNonBusinessFile(filePath) {
  if (!filePath) return true;
  if (DEFAULT_BUSINESS_EXCLUDED_PREFIXES.some((prefix) => filePath.startsWith(prefix))) return true;
  if (filePath.split("/").some((part) => part === "node_modules" || part === ".git")) return true;
  const basename = filePath.split("/").pop() || filePath;
  if (LOCKFILE_NAMES.has(basename)) return true;
  if (!filePath.includes("/") && /\.md$/i.test(filePath)) return true;
  if (!filePath.includes("/") && ROOT_CONFIG_FILE_PATTERN.test(filePath)) return true;
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
  const globs = configuredBusinessGlobs(options);
  if (globs.length > 0) return `business_globs: ${globs.join(", ")}`;
  return `source extensions: ${DEFAULT_BUSINESS_SOURCE_EXTENSIONS.join(", ")}; excludes: ${DEFAULT_BUSINESS_EXCLUDED_PREFIXES.join(", ")}`;
}

export function isBusinessFile(filePath, options = Object()) {
  const normalized = normalizeRepoFilePath(filePath);
  if (isAlwaysNonBusinessFile(normalized)) return false;
  const businessGlobs = configuredBusinessGlobs(options);
  if (businessGlobs.length > 0) return matchesAnyGlob(normalized, businessGlobs);
  return hasBusinessSourceExtension(normalized);
}

export function businessGlobsFromConfig(config = Object()) {
  return configuredBusinessGlobs({ config });
}

export function isBusinessFileLegacyDirectoryOnly(filePath) {
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
