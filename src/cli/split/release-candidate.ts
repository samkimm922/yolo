// Release-candidate gate contract, builders, and result normalizers.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { preflightAllPrds } from "../../prd/preflight.js";
import { buildDogfoodMatrixReport } from "../../release/dogfood-matrix.js";
import { runReleaseCandidateGate } from "../../release/decision-gate.js";
import { readReleaseCandidateChangeManifest } from "../../release/change-provenance.js";
import { runCleanEnvironmentVerify } from "../../release/clean-environment-verify.js";
import { cleanCliText } from "./shared.js";

// Coerce a possibly-unknown CLI value into a string path suitable for resolve().
function resolveInputPath(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return process.cwd();
}

// Coerce an unknown CLI value into a string[] | null for manifest currentRoundFiles.
function asStringArrayOrNull(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return null;
}

export const RELEASE_CANDIDATE_RESULT_SCHEMA = "yolo.release_candidate_cli_result.v1";
export const RELEASE_CANDIDATE_REQUIRED_GATES = [
  {
    id: "verify",
    label: "verify",
    required: true,
    status: "pending",
    // source-grep-allow toolchain-drift: release gate runs YOLO's own verify script.
    command: "npm run verify",
    description: "Run the project verify suite before any release claim.",
  },
  {
    id: "prd-preflight",
    label: "prd preflight",
    required: true,
    status: "pending",
    // source-grep-allow toolchain-drift: release gate runs YOLO's own preflight script.
    command: "npm run preflight",
    description: "Run PRD dependency and contract preflight.",
  },
  {
    id: "clean-env",
    label: "clean env",
    required: true,
    status: "pending",
    description: "Prove the candidate in a clean environment or clean clone.",
  },
  {
    id: "dogfood-matrix",
    label: "dogfood matrix",
    required: true,
    status: "pending",
    description: "Run the required dogfood matrix and capture evidence.",
  },
  {
    id: "change-provenance",
    label: "change provenance",
    required: true,
    status: "pending",
    description: "Account for release-relevant changes and artifact provenance.",
  },
];

const RELEASE_CANDIDATE_REPORT_BY_GATE = {
  verify: "verify",
  "prd-preflight": "prdPreflight",
  "clean-env": "cleanEnvironment",
  "dogfood-matrix": "dogfoodMatrix",
  "change-provenance": "changeManifest",
};

export function cloneReleaseCandidateGates() {
  return RELEASE_CANDIDATE_REQUIRED_GATES.map((gate) => ({ ...gate }));
}

export function normalizeReleaseCandidateStatus(status: unknown) {
  const normalized = cleanCliText(status).toLowerCase();
  if (normalized === "pass" || normalized === "success") return "pass";
  if (["warning", "draft", "dry_run", "not_run", "indeterminate", "ready", "ready_for_operator"].includes(normalized)) return normalized;
  if (normalized === "error" || normalized === "failed") return "error";
  return "blocked";
}

export function releaseCandidateExitCode(result: Record<string, unknown> = {}) {
  const status = normalizeReleaseCandidateStatus(result.status);
  if (status === "pass") return 0;
  if (["warning", "draft", "dry_run", "not_run", "indeterminate", "ready", "ready_for_operator"].includes(status)) return 2;
  return 1;
}

export function releaseCandidateBaseResult({ command, input = {}, options = {}, projectRoot }: {
  command: string;
  input?: Record<string, unknown>;
  options?: Record<string, unknown>;
  projectRoot: string;
}) {
  return {
    schema: RELEASE_CANDIDATE_RESULT_SCHEMA,
    status: "blocked",
    code: "RELEASE_CANDIDATE_GATE_NOT_EXECUTED",
    command,
    mode: input.mode || "rc",
    dry_run: options.dryRun === true,
    fail_closed: true,
    project_root: projectRoot,
    scope: input.scope || "workspace",
    allowances: {
      untracked: options.allowUntracked === true,
      unknown: options.allowUnknown === true,
    },
    gate_kind: "generic_rc_gate",
    not_trello_replay: true,
    summary: "Generic release-candidate gate contract is exposed, but no concrete gate runner was provided.",
    gates: cloneReleaseCandidateGates(),
    blockers: [{
      code: "RELEASE_CANDIDATE_RUNNER_MISSING",
      message: "No releaseCandidateRunner was injected, so the command fails closed instead of claiming RC readiness.",
    }],
    next_actions: [
      "Run the generic RC gate; do not use Trello replay as the next release step.",
      "Provide a releaseCandidateRunner implementation that executes verify, PRD preflight, package smoke, clean env, dogfood matrix, change provenance, and review findings.",
    ],
  };
}

function releaseCandidateReport(report: Record<string, unknown> = {}) {
  const { status = "blocked", source, blockerCode, blockerMessage, blockers = [], warnings = [], approvals = [], ...extra } = report;
  const blockerList = (Array.isArray(blockers) ? blockers : []) as Array<{ code?: string; message?: string }>;
  const normalizedBlockers = blockerCode
    ? [{ code: blockerCode, message: blockerMessage || blockerCode }, ...blockerList]
    : blockerList;
  return {
    status,
    provenance: { source, id: `${source}-local` },
    blockers: normalizedBlockers,
    warnings,
    approvals,
    ...extra,
  };
}

export function buildDefaultReleaseCandidateReports(input: Record<string, unknown> = {}) {
  const yoloRoot = resolve(resolveInputPath(input.yoloRoot, input.yolo_root, input.projectRoot));
  const projectRoot = resolve(resolveInputPath(input.projectRoot, yoloRoot));

  // verify: actually run the release verify script in the project root
  let verifyReport: Record<string, unknown>;
  try {
    const startedAt = new Date().toISOString();
    // source-grep-allow toolchain-drift: release gate runs YOLO's own verify script.
    execSync("npm run verify", {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 300000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    verifyReport = releaseCandidateReport({
      status: "pass",
      source: "verify",
      // source-grep-allow toolchain-drift: release report records the exact release script.
      commands: [{ command: "npm run verify", exit_code: 0, status: "pass", started_at: startedAt, finished_at: new Date().toISOString() }],
    });
  } catch (err) {
    const error = err as { message?: string; status?: number };
    verifyReport = releaseCandidateReport({
      source: "verify",
      blockerCode: "RELEASE_VERIFY_FAILED",
      // source-grep-allow toolchain-drift: release report records the exact release script.
      blockerMessage: `npm run verify failed: ${error.message || err}`,
      // source-grep-allow toolchain-drift: release report records the exact release script.
      commands: [{ command: "npm run verify", exit_code: error.status || 1, status: "fail" }],
    });
  }

  // prdPreflight: actually run PRD preflight
  let prdPreflightReport: Record<string, unknown>;
  try {
    const prdDirs = [resolve(projectRoot, "data/prd/current"), resolve(projectRoot, "data/prd/archive")];
    const preflight = preflightAllPrds({ dirs: prdDirs });
    const pfStatus = preflight.status === "pass" ? "pass" : "block";
    prdPreflightReport = releaseCandidateReport({
      status: pfStatus,
      source: "prd-preflight",
      commands: [{ command: "preflightAllPrds", exit_code: pfStatus === "pass" ? 0 : 1, status: pfStatus }],
      blocked_reasons: preflight.blocked_reasons || [],
      results: preflight.results || [],
      file_count: preflight.file_count,
    });
  } catch (err) {
    const error = err as { message?: string };
    prdPreflightReport = releaseCandidateReport({
      source: "prd-preflight",
      blockerCode: "RELEASE_PRD_PREFLIGHT_FAILED",
      blockerMessage: `PRD preflight failed: ${error.message || err}`,
    });
  }

  const cleanEnvironment = runCleanEnvironmentVerify({ yoloRoot, dryRun: true });
  const dogfoodMatrix = buildDogfoodMatrixReport({ yoloRoot, projectRoot });
  const changeManifest = readReleaseCandidateChangeManifest({
    rootDir: yoloRoot,
    allowUntracked: input.allowUntracked === true,
    allowUnknown: input.allowUnknown === true,
    currentRoundFiles: asStringArrayOrNull(input.currentRoundFiles),
  });

  return {
    verify: verifyReport,
    prdPreflight: prdPreflightReport,
    cleanEnvironment: releaseCandidateReport({
      source: "clean-environment",
      blockerCode: "RELEASE_CLEAN_ENVIRONMENT_NOT_EXECUTED",
      blockerMessage: "Clean environment verification must execute before release readiness can pass; dry-run only produced a plan.",
      plan: cleanEnvironment.plan,
      dry_run: cleanEnvironment,
    }),
    dogfoodMatrix: releaseCandidateReport({
      source: "dogfood-matrix",
      status: dogfoodMatrix.status,
      blockers: dogfoodMatrix.blocked_reasons || [],
      warnings: dogfoodMatrix.warnings || [],
      scenarios: dogfoodMatrix.scenarios || [],
      report: dogfoodMatrix,
    }),
    changeManifest: releaseCandidateReport({
      source: "change-manifest",
      status: changeManifest.status,
      blockers: changeManifest.blockers || [],
      warnings: changeManifest.contains_possible_non_round_changes ? [{
        code: "CHANGE_MANIFEST_POSSIBLE_NON_ROUND_CHANGES",
        message: "Change manifest contains files not bound to the current release-candidate round.",
      }] : [],
      manifest: changeManifest,
    }),
  };
}

export async function runDefaultReleaseCandidateRunner(input: Record<string, unknown> = {}) {
  const yoloRoot = resolve(resolveInputPath(input.yoloRoot, input.yolo_root, input.projectRoot));
  const projectRoot = resolve(resolveInputPath(input.projectRoot, yoloRoot));
  const reports = (input.reports as Record<string, unknown> | undefined) || buildDefaultReleaseCandidateReports({
    yoloRoot,
    projectRoot,
    allowUntracked: input.allowUntracked,
    allowUnknown: input.allowUnknown,
    currentRoundFiles: input.currentRoundFiles,
  });
  const mode = typeof input.mode === "string" && input.mode ? input.mode : "rc";
  const gate = runReleaseCandidateGate({
    mode,
    reports,
    now: input.now as string | undefined,
  });
  const gateReports = (gate.reports || {}) as Record<string, { status?: string; blocker_count?: number; warning_count?: number }>;
  const gates = ((input.requiredGates as Array<{ id: string; required?: boolean }> | undefined) || cloneReleaseCandidateGates()).map((gateItem) => {
    const reportName = RELEASE_CANDIDATE_REPORT_BY_GATE[gateItem.id as keyof typeof RELEASE_CANDIDATE_REPORT_BY_GATE];
    const report = reportName ? gateReports[reportName] : null;
    return {
      ...gateItem,
      status: report?.status || "blocked",
      blocker_count: report?.blocker_count ?? 0,
      warning_count: report?.warning_count ?? 0,
    };
  });
  const status = normalizeReleaseCandidateStatus(gate.status);
  return {
    schema: RELEASE_CANDIDATE_RESULT_SCHEMA,
    status,
    code: status === "pass" ? "RELEASE_CANDIDATE_GATE_PASS" : "RELEASE_CANDIDATE_GATE_BLOCKED",
    command: typeof input.command === "string" && input.command ? input.command : "release-candidate",
    mode,
    dry_run: input.dryRun === true,
    fail_closed: true,
    yolo_root: yoloRoot,
    project_root: projectRoot,
    scope: input.scope || "workspace",
    allowances: {
      untracked: input.allowUntracked === true,
      unknown: input.allowUnknown === true,
    },
    gate_kind: "generic_rc_gate",
    not_trello_replay: true,
    summary: status === "pass"
      ? "Generic release-candidate gate passed."
      : "Generic release-candidate gate blocked missing, failed, or untrusted release evidence.",
    gates,
    blockers: gate.blockers || [],
    warnings: gate.warnings || [],
    issue_codes: gate.issue_codes || [],
    reports: gate.reports || {},
    gate_result: gate,
    next_actions: status === "pass"
      ? ["Proceed to human release authorization; publishing remains a separate controlled operation."]
      : ["Provide passing evidence for verify, PRD preflight, package smoke, clean env, dogfood matrix, change provenance, and review findings."],
  };
}

export function normalizeReleaseCandidateResult(raw: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  const base = releaseCandidateBaseResult(context as { command: string; input?: Record<string, unknown>; options?: Record<string, unknown>; projectRoot: string });
  const merged: Record<string, unknown> = {
    ...base,
    ...raw,
    schema: raw.schema || base.schema,
    command: raw.command || base.command,
    mode: raw.mode || base.mode,
    dry_run: raw.dry_run ?? base.dry_run,
    fail_closed: true,
    project_root: raw.project_root || base.project_root,
    allowances: raw.allowances || base.allowances,
    gate_kind: raw.gate_kind || base.gate_kind,
    not_trello_replay: raw.not_trello_replay ?? true,
    gates: Array.isArray(raw.gates) ? raw.gates : base.gates,
    blockers: Array.isArray(raw.blockers) ? raw.blockers : base.blockers,
    next_actions: Array.isArray(raw.next_actions) ? raw.next_actions : base.next_actions,
  };
  merged.status = normalizeReleaseCandidateStatus(merged.status);
  const consistencyBlockers = merged.status === "pass"
    ? releaseCandidateConsistencyBlockers(merged)
    : [];
  const mergedBlockers = (Array.isArray(merged.blockers) ? merged.blockers : []) as Array<{ code?: string }>;
  if (consistencyBlockers.length > 0) {
    merged.status = "blocked";
    merged.code = "RELEASE_CANDIDATE_RESULT_INCONSISTENT";
    const dedupedBlockers = [
      ...mergedBlockers,
      ...consistencyBlockers.filter((blocker) =>
        !mergedBlockers.some((existing) => existing.code === blocker.code)
      ),
    ];
    merged.blockers = dedupedBlockers;
    const issueCodes = (Array.isArray(merged.issue_codes) ? merged.issue_codes : []) as string[];
    merged.issue_codes = [...new Set([
      ...issueCodes,
      ...dedupedBlockers.map((blocker) => blocker.code).filter((v): v is string => Boolean(v)),
    ])];
    merged.summary = "Release candidate runner returned an internally inconsistent pass result.";
    merged.next_actions = [
      "Fix the release candidate runner so blockers, gates, dry-run state, and aggregate gate_result agree before claiming pass.",
    ];
  }
  return merged;
}

export function releaseCandidateErrorResult(error: unknown, context: Record<string, unknown> = {}, code = "RELEASE_CANDIDATE_GATE_ERROR") {
  const base = releaseCandidateBaseResult(context as { command: string; input?: Record<string, unknown>; options?: Record<string, unknown>; projectRoot: string });
  return {
    ...base,
    status: "error",
    code,
    summary: "Generic release-candidate gate failed before producing a passable result.",
    error: (error as { message?: string } | null | undefined)?.message || String(error),
    blockers: [{
      code,
      message: (error as { message?: string } | null | undefined)?.message || String(error),
    }],
    next_actions: ["Inspect the RC gate runner error, fix the failing contract, then rerun yolo release-candidate --json."],
  };
}

function releaseCandidateConsistencyBlockers(result: Record<string, unknown> = {}) {
  const blockers: Array<Record<string, unknown>> = [];
  if (Array.isArray(result.blockers) && result.blockers.length > 0) {
    blockers.push({
      code: "RELEASE_CANDIDATE_BLOCKERS_PRESENT",
      message: "release candidate runner cannot pass while blockers are present",
    });
  }
  if (result.dry_run === true) {
    blockers.push({
      code: "RELEASE_CANDIDATE_DRY_RUN_RESULT",
      message: "dry-run release candidate output cannot be promoted as passing release evidence",
    });
  }
  const requiredGates: Array<{ id?: string; status?: unknown; required?: boolean }> = Array.isArray(result.gates)
    ? (result.gates as Array<{ id?: string; status?: unknown; required?: boolean }>).filter((gate) => gate.required !== false)
    : [];
  const nonPassingGate = requiredGates.find((gate) => normalizeReleaseCandidateStatus(gate.status) !== "pass");
  if (requiredGates.length === 0 || nonPassingGate) {
    blockers.push({
      code: "RELEASE_CANDIDATE_GATE_NOT_PASSING",
      message: "every required release candidate gate must be present and passing",
      gate_id: nonPassingGate?.id || null,
      gate_status: nonPassingGate?.status || null,
    });
  }
  const gateResultRaw = result.gate_result || result.gateResult;
  if (!gateResultRaw || typeof gateResultRaw !== "object") {
    blockers.push({
      code: "RELEASE_CANDIDATE_GATE_RESULT_MISSING",
      message: "passing release candidate results must include the aggregate release candidate gate_result",
    });
  } else {
    const gateResult = gateResultRaw as { schema?: string; status?: unknown; blockers?: unknown[] };
    if (
      gateResult.schema !== "yolo.release.release_candidate_gate_result.v1"
      || normalizeReleaseCandidateStatus(gateResult.status) !== "pass"
      || (Array.isArray(gateResult.blockers) && gateResult.blockers.length > 0)
    ) {
      blockers.push({
        code: "RELEASE_CANDIDATE_GATE_RESULT_NOT_PASSING",
        message: "aggregate release candidate gate_result must be schema-valid, passing, and blocker-free",
        gate_result_status: gateResult.status || null,
      });
    }
  }
  return blockers;
}

// formatReleaseCandidateText lives in ./text-format.ts (it is a plain-text
// formatter). Re-exported here so existing importers using
// `from "./release-candidate.js"` keep working.
export { formatReleaseCandidateText } from "./text-format.js";
