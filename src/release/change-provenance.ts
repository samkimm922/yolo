import { execFileSync as defaultExecFileSync } from "node:child_process";
import { resolve } from "node:path";

export const RELEASE_CHANGE_DOMAINS = Object.freeze([
  "runner/finalize",
  "review-loop",
  "acceptance-warning",
  "prd-preflight/check",
  "worktree-commit",
  "ci-meta-package",
  "docs-data",
  "unknown",
]);

const RISK_ORDER = Object.freeze(["none", "low", "medium", "high", "critical"]);
const SOURCE_OR_TEST_RE = /^(src|bin|lib|tools|__tests__|tests|hooks|scripts|fixtures)\//;
const CODE_FILE_RE = /\.(cjs|cts|js|jsx|mjs|mts|ts|tsx|json|yaml|yml)$/i;

const DOMAIN_RULES = [
  {
    domain: "runner/finalize",
    patterns: [
      /^runner\.ts$/,
      /^src\/runtime\/runner-/,
      /^src\/runtime\/run-lifecycle\//,
      /^src\/runtime\/task-loop\//,
      /^src\/runtime\/task-state\//,
      /^__tests__\/(?:run-lifecycle|runner-|task-loop|runner-state|runner-task-state)/,
    ],
  },
  {
    domain: "review-loop",
    patterns: [
      /^src\/runtime\/review-loop\//,
      /^src\/review\//,
      /^__tests__\/review-/,
      /^__tests__\/runner-review-flow\.test\.ts$/,
    ],
  },
  {
    domain: "acceptance-warning",
    patterns: [
      /^src\/runtime\/acceptance\//,
      /^__tests__\/acceptance-/,
      /^__tests__\/warning-inventory\.test\.ts$/,
    ],
  },
  {
    domain: "prd-preflight/check",
    patterns: [
      /^src\/prd\/(?:preflight|check|contract|validate)\.ts$/,
      /^src\/cli\/prd-preflight\.ts$/,
      /^src\/runtime\/gates\/(?:check-report|pre-execution-gates|prd-contract-doctor)/,
      /^__tests__\/(?:prd-|check-report|pre-execution-gates|spec-governance-gate)/,
    ],
  },
  {
    domain: "worktree-commit",
    patterns: [
      /^src\/runtime\/execution\/(?:worktree-session|commit-flow|post-commit-outcome|change-set|merge-result|baselines)\.ts$/,
      /^__tests__\/(?:worktree-session|commit-flow|post-commit-outcome|change-set|merge-result|execution-baselines)\.test\.ts$/,
    ],
  },
  {
    domain: "ci-meta-package",
    patterns: [
      /^package\.json$/,
      /^pnpm-lock\.yaml$/,
      /^tsconfig(?:\.[^.]+)?\.json$/,
      /^vitest\.[^.]+\.config\.ts$/,
      /^\.github\//,
      /^bin\//,
      /^__tests__\/(?:public-entrypoints|package-install-smoke|root-entrypoint-inventory|public-sdk-boundary|sdk)\.test\.ts$/,
    ],
  },
  {
    domain: "docs-data",
    patterns: [
      /^docs\//,
      /^data\//,
      /^README\.md$/,
      /^CHANGELOG\.md$/,
      /^ROADMAP\.md$/,
      /^PROJECT_TREE\.md$/,
      /^SYSTEM_STATE\.md$/,
      /^SESSION\.md$/,
      /^SNAPSHOT\.md$/,
      /^DELIVERY_LOG\.md$/,
    ],
  },
];

function splitNul(output = "") {
  return String(output || "").split("\0").filter((part) => part.length > 0);
}

function normalizePath(filePath = "") {
  return String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function highestRisk(risks = []) {
  return risks.reduce((current, risk) =>
    RISK_ORDER.indexOf(risk) > RISK_ORDER.indexOf(current) ? risk : current
  , "none");
}

function commandErrorMessage(error) {
  const output = `${error?.stdout || ""}${error?.stderr || ""}`.trim();
  return output || error?.message || String(error || "unknown git error");
}

export function classifyReleaseChangeDomain(filePath = "") {
  const normalized = normalizePath(filePath);
  for (const rule of DOMAIN_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      return rule.domain;
    }
  }
  return "unknown";
}

export function isSourceOrTestFile(filePath = "") {
  const normalized = normalizePath(filePath);
  return SOURCE_OR_TEST_RE.test(normalized) && CODE_FILE_RE.test(normalized);
}

export function parseGitStatusPorcelainZ(output = "") {
  const tokens = splitNul(output);
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    const indexStatus = token[0];
    const worktreeStatus = token[1];
    const status = `${indexStatus}${worktreeStatus}`;
    const file = normalizePath(token.slice(3));
    const renamedOrCopied = status.includes("R") || status.includes("C");
    const oldPath = renamedOrCopied ? normalizePath(tokens[index + 1] || "") : null;
    if (renamedOrCopied) index += 1;

    let kind = "tracked_modified";
    if (status === "??") kind = "untracked";
    else if (status.includes("D")) kind = "deleted";
    else if (status.includes("R")) kind = "renamed";

    entries.push({
      path: file,
      old_path: oldPath,
      status,
      index_status: indexStatus,
      worktree_status: worktreeStatus,
      kind,
    });
  }
  return entries;
}

export function parseGitDiffNameStatusZ(output = "") {
  const tokens = splitNul(output);
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index] || "";
    if (!status) continue;
    const path = normalizePath(tokens[index + 1] || "");
    index += 1;
    if (/^[RC]/.test(status)) {
      const newPath = normalizePath(tokens[index + 1] || "");
      entries.push({ status, path: newPath, old_path: path });
      index += 1;
    } else {
      entries.push({ status, path, old_path: null });
    }
  }
  return entries;
}

function isUntrackedFailClosedReleaseFile(entry, allowUntracked) {
  return entry.kind === "untracked"
    && !allowUntracked
    && (isSourceOrTestFile(entry.path) || entry.domain === "ci-meta-package");
}

function riskForEntry(entry, { allowUntracked = false, allowUnknown = false } = Object()) {
  if (entry.domain === "unknown" && !allowUnknown) return "critical";
  if (entry.kind === "deleted") return "critical";
  if (isUntrackedFailClosedReleaseFile(entry, allowUntracked)) return "critical";
  if (entry.kind === "renamed") return "high";
  if (entry.domain === "ci-meta-package") return "high";
  if (isSourceOrTestFile(entry.path)) return "medium";
  if (entry.domain === "docs-data") return "low";
  return "medium";
}

function blockersForEntry(entry, { allowUntracked = false, allowUnknown = false } = Object()) {
  const blockers = [];
  if (entry.domain === "unknown" && !allowUnknown) {
    blockers.push({
      code: "UNKNOWN_CHANGE_DOMAIN",
      file: entry.path,
      message: "Change does not match a release responsibility domain and must be reviewed before publishing.",
    });
  }
  if (entry.kind === "deleted") {
    blockers.push({
      code: "DELETED_CHANGE_FAIL_CLOSED",
      file: entry.path,
      message: "Deleted files block release candidate publication until explicitly reviewed.",
    });
  }
  if (entry.kind === "untracked" && !allowUntracked) {
    if (isSourceOrTestFile(entry.path)) {
      blockers.push({
        code: "UNTRACKED_SOURCE_OR_TEST_FAIL_CLOSED",
        file: entry.path,
        message: "Untracked source or test files block release candidate publication unless allowUntracked is explicit.",
      });
    } else if (entry.domain === "ci-meta-package") {
      blockers.push({
        code: "UNTRACKED_CI_META_PACKAGE_FAIL_CLOSED",
        file: entry.path,
        message: "Untracked CI, package, or release metadata files block release candidate publication unless allowUntracked is explicit.",
      });
    }
  }
  return blockers;
}

function emptyGroups() {
  return Object.fromEntries(RELEASE_CHANGE_DOMAINS.map((domain) => [
    domain,
    {
      domain,
      files: [],
      tracked_modified: [],
      untracked: [],
      deleted_or_renamed: [],
      risk_level: "none",
      recommendation: domain === "unknown"
        ? "assign owner before release"
        : `route to ${domain} owner`,
    },
  ]));
}

function errorManifest({ rootDir, command, error }) {
  const message = commandErrorMessage(error);
  const blocker = {
    code: "GIT_CHANGE_PROVENANCE_UNAVAILABLE",
    command,
    message: `Unable to read git change provenance: ${message}`,
  };
  return {
    schema: "yolo.release_change_provenance.v1",
    status: "blocked",
    blocks_release: true,
    root_dir: rootDir ? resolve(rootDir) : null,
    generated_from: {
      status_command: "git status --porcelain=v1 -z",
      diff_command: "git diff --name-status -z --find-renames HEAD --",
    },
    clean: false,
    error: blocker,
    tracked_modified: [],
    untracked: [],
    deleted_or_renamed: [],
    groups: emptyGroups(),
    group_suggestions: [],
    risk_level: "critical",
    contains_possible_non_round_changes: true,
    blockers: [blocker],
  };
}

export function buildReleaseCandidateChangeManifest({
  rootDir = process.cwd(),
  statusOutput = "",
  diffNameStatusOutput = "",
  allowUntracked = false,
  allow_untracked = false,
  allowUnknown = false,
  currentRoundFiles = null,
} = Object()) {
  const effectiveAllowUntracked = allowUntracked === true || allow_untracked === true;
  const diffByPath = new Map(parseGitDiffNameStatusZ(diffNameStatusOutput).map((entry) => [entry.path, entry]));
  const currentRoundSet = Array.isArray(currentRoundFiles)
    ? new Set(currentRoundFiles.map((file) => normalizePath(file)))
    : null;
  const entries = parseGitStatusPorcelainZ(statusOutput)
    .filter((entry) => entry.path)
    .map((entry) => {
      const domain = classifyReleaseChangeDomain(entry.path);
      const diffEntry = diffByPath.get(entry.path) || null;
      const possiblyNotCurrentRound = currentRoundSet
        ? !currentRoundSet.has(entry.path) && !(entry.old_path && currentRoundSet.has(entry.old_path))
        : true;
      const enriched = {
        ...entry,
        domain,
        diff_status: diffEntry?.status || null,
        possibly_not_current_round: possiblyNotCurrentRound,
      };
      return {
        ...enriched,
        risk_level: riskForEntry(enriched, { allowUntracked: effectiveAllowUntracked, allowUnknown }),
      };
    });

  const trackedModified = entries.filter((entry) => entry.kind === "tracked_modified");
  const untracked = entries.filter((entry) => entry.kind === "untracked");
  const deletedOrRenamed = entries.filter((entry) => entry.kind === "deleted" || entry.kind === "renamed");
  const groups = emptyGroups();
  for (const entry of entries) {
    const group = groups[entry.domain] || groups.unknown;
    group.files.push(entry.path);
    if (entry.kind === "tracked_modified") group.tracked_modified.push(entry.path);
    if (entry.kind === "untracked") group.untracked.push(entry.path);
    if (entry.kind === "deleted" || entry.kind === "renamed") group.deleted_or_renamed.push(entry.path);
    group.risk_level = highestRisk([group.risk_level, entry.risk_level]);
  }

  const blockers = entries.flatMap((entry) => blockersForEntry(entry, { allowUntracked: effectiveAllowUntracked, allowUnknown }));
  const riskLevel = highestRisk(entries.map((entry) => entry.risk_level));
  const groupSuggestions = RELEASE_CHANGE_DOMAINS
    .map((domain) => groups[domain])
    .filter((group) => group.files.length > 0)
    .map((group) => ({
      domain: group.domain,
      files: [...group.files],
      risk_level: group.risk_level,
      recommendation: group.recommendation,
    }));

  return {
    schema: "yolo.release_change_provenance.v1",
    status: blockers.length > 0 ? "blocked" : "pass",
    blocks_release: blockers.length > 0,
    root_dir: resolve(rootDir),
    generated_from: {
      status_command: "git status --porcelain=v1 -z",
      diff_command: "git diff --name-status -z --find-renames HEAD --",
    },
    clean: entries.length === 0,
    tracked_modified: trackedModified,
    untracked,
    deleted_or_renamed: deletedOrRenamed,
    groups,
    group_suggestions: groupSuggestions,
    risk_level: riskLevel,
    contains_possible_non_round_changes: entries.some((entry) => entry.possibly_not_current_round),
    blockers,
  };
}

export function readReleaseCandidateChangeManifest({
  rootDir = process.cwd(),
  execFileSync = defaultExecFileSync,
  allowUntracked = false,
  allow_untracked = false,
  allowUnknown = false,
  currentRoundFiles = null,
} = Object()) {
  const effectiveAllowUntracked = allowUntracked === true || allow_untracked === true;
  const resolvedRoot = resolve(rootDir);
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: resolvedRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const statusOutput = execFileSync("git", ["status", "--porcelain=v1", "-z"], {
      cwd: resolvedRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const diffNameStatusOutput = execFileSync("git", ["diff", "--name-status", "-z", "--find-renames", "HEAD", "--"], {
      cwd: resolvedRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return buildReleaseCandidateChangeManifest({
      rootDir: resolvedRoot,
      statusOutput,
      diffNameStatusOutput,
      allowUntracked: effectiveAllowUntracked,
      allowUnknown,
      currentRoundFiles,
    });
  } catch (error) {
    return errorManifest({
      rootDir: resolvedRoot,
      command: "git status/diff provenance",
      error,
    });
  }
}
