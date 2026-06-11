import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

const TOKEN_PATTERNS = [
  ["WARN", /\bWARN\b/g],
  ["warning", /\bwarning\b/g],
  ["best-effort", /best[- ]effort/g],
  ["skip", /\bskip(?:s|ped|ping)?\b/g],
];

const SOURCE_ROOTS = ["src", "bin"];
const ROOT_ENTRYPOINTS = ["runner.ts", "gate.ts", "prompt.ts", "learn.ts", "sdk.ts"];

const INVENTORY = [
  ["src/cli/gate.ts", { WARN: 4, warning: 0, "best-effort": 0, skip: 0 }],
  ["src/cli/prd-preflight.ts", { WARN: 0, warning: 3, "best-effort": 0, skip: 0 }],
  ["src/cli/prompt.ts", { WARN: 2, warning: 2, "best-effort": 0, skip: 0 }],
  ["src/cli/review.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/cli/yolo.ts", { WARN: 0, warning: 18, "best-effort": 0, skip: 5 }],
  ["src/core/bootstrap.ts", { WARN: 0, warning: 1, "best-effort": 0, skip: 4 }],
  ["src/core/setup.ts", { WARN: 0, warning: 4, "best-effort": 0, skip: 8 }],
  ["src/demand/evidence-dispatch.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/demand/gate.ts", { WARN: 0, warning: 26, "best-effort": 0, skip: 0 }],
  ["src/demand/interview.ts", { WARN: 0, warning: 4, "best-effort": 0, skip: 0 }],
  ["src/demand/runtime.ts", { WARN: 1, warning: 14, "best-effort": 0, skip: 0 }],
  ["src/discovery/artifacts.ts", { WARN: 1, warning: 3, "best-effort": 0, skip: 2 }],
  ["src/discovery/gate.ts", { WARN: 0, warning: 4, "best-effort": 0, skip: 0 }],
  ["src/discovery/runtime.ts", { WARN: 0, warning: 2, "best-effort": 0, skip: 0 }],
  ["src/eval/benchmark.ts", { WARN: 0, warning: 7, "best-effort": 0, skip: 0 }],
  ["src/lib/auto-fix.ts", { WARN: 0, warning: 1, "best-effort": 0, skip: 1 }],
  ["src/lib/evaluators/file-check.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/lib/evaluators/quality-check.ts", { WARN: 1, warning: 1, "best-effort": 0, skip: 0 }],
  ["src/lib/scanner-to-task.ts", { WARN: 1, warning: 0, "best-effort": 0, skip: 0 }],
  ["src/lifecycle/guard.ts", { WARN: 0, warning: 3, "best-effort": 0, skip: 0 }],
  ["src/lifecycle/progress.ts", { WARN: 0, warning: 2, "best-effort": 0, skip: 0 }],
  ["src/lifecycle/schema.ts", { WARN: 0, warning: 1, "best-effort": 0, skip: 0 }],
  ["src/lifecycle/state.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 3 }],
  ["src/packs/manifest.ts", { WARN: 0, warning: 2, "best-effort": 0, skip: 0 }],
  ["src/packs/resolver.ts", { WARN: 0, warning: 7, "best-effort": 0, skip: 0 }],
  ["src/pm/index.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/prd/audit-to-prd.ts", { WARN: 1, warning: 0, "best-effort": 0, skip: 0 }],
  ["src/prd/check.ts", { WARN: 3, warning: 0, "best-effort": 0, skip: 13 }],
  ["src/prd/contract.ts", { WARN: 2, warning: 5, "best-effort": 0, skip: 0 }],
  ["src/prd/preflight.ts", { WARN: 1, warning: 49, "best-effort": 0, skip: 2 }],
  ["src/prd/validate.ts", { WARN: 0, warning: 4, "best-effort": 0, skip: 3 }],
  ["src/release/change-provenance.ts", { WARN: 0, warning: 3, "best-effort": 0, skip: 0 }],
  ["src/release/decision-gate.ts", { WARN: 0, warning: 34, "best-effort": 0, skip: 0 }],
  ["src/release/dogfood-matrix.ts", { WARN: 0, warning: 4, "best-effort": 0, skip: 0 }],
  ["src/release/hardening-drill.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 4 }],
  ["src/review/findings-to-tasks.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 3 }],
  ["src/review/fix-loop.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 2 }],
  ["src/review/scanner.ts", { WARN: 0, warning: 1, "best-effort": 0, skip: 2 }],
  ["src/runtime/acceptance/report.ts", { WARN: 0, warning: 6, "best-effort": 0, skip: 0 }],
  ["src/runtime/adapters/agent-contract.ts", { WARN: 0, warning: 1, "best-effort": 0, skip: 1 }],
  ["src/runtime/adapters/provider-runtime-matrix.ts", { WARN: 0, warning: 9, "best-effort": 0, skip: 0 }],
  ["src/runtime/devtools/doctor.ts", { WARN: 0, warning: 8, "best-effort": 0, skip: 0 }],
  ["src/runtime/evidence/log-change.ts", { WARN: 0, warning: 0, "best-effort": 1, skip: 0 }],
  ["src/runtime/evidence/report.ts", { WARN: 0, warning: 3, "best-effort": 0, skip: 16 }],
  ["src/runtime/execution/baselines.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 3 }],
  ["src/runtime/execution/commit-flow.ts", { WARN: 2, warning: 1, "best-effort": 0, skip: 6 }],
  ["src/runtime/execution/context-pack-validator.ts", { WARN: 0, warning: 1, "best-effort": 0, skip: 0 }],
  ["src/runtime/execution/dry-run-artifact.ts", { WARN: 1, warning: 0, "best-effort": 0, skip: 3 }],
  ["src/runtime/execution/post-precheck.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/runtime/execution/precheck-outcome.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/runtime/execution/session-validation.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/runtime/execution/worktree-session.ts", { WARN: 1, warning: 0, "best-effort": 0, skip: 0 }],
  ["src/runtime/gates/check-report.ts", { WARN: 0, warning: 70, "best-effort": 0, skip: 0 }],
  ["src/runtime/gates/diff-quality-gate.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 2 }],
  ["src/runtime/gates/failure-analysis.ts", { WARN: 1, warning: 0, "best-effort": 0, skip: 0 }],
  ["src/runtime/gates/prd-contract-doctor-gate.ts", { WARN: 0, warning: 3, "best-effort": 0, skip: 0 }],
  ["src/runtime/gates/prd-contract-doctor.ts", { WARN: 4, warning: 3, "best-effort": 0, skip: 0 }],
  ["src/runtime/gates/pre-execution-gates.ts", { WARN: 0, warning: 12, "best-effort": 0, skip: 0 }],
  ["src/runtime/gates/test-generation-validator.ts", { WARN: 0, warning: 2, "best-effort": 0, skip: 0 }],
  ["src/runtime/learning/learn.ts", { WARN: 9, warning: 0, "best-effort": 1, skip: 0 }],
  ["src/runtime/logging/task-logger.ts", { WARN: 0, warning: 0, "best-effort": 1, skip: 0 }],
  ["src/runtime/memory/retention.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/runtime/parallel/wave-planner.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 2 }],
  ["src/runtime/pi-runtimes.ts", { WARN: 0, warning: 3, "best-effort": 0, skip: 0 }],
  ["src/runtime/progress/lifecycle-dashboard.ts", { WARN: 0, warning: 1, "best-effort": 0, skip: 0 }],
  ["src/runtime/progress/server.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 18 }],
  ["src/runtime/progress/ui-evidence.ts", { WARN: 0, warning: 3, "best-effort": 0, skip: 4 }],
  ["src/runtime/recovery/retry-orchestrator.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 2 }],
  ["src/runtime/recovery/retry-round.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 5 }],
  ["src/runtime/review-loop/orchestrator.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 2 }],
  ["src/runtime/review-loop/round-helpers.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 4 }],
  ["src/runtime/run-lifecycle/finalize.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 11 }],
  ["src/runtime/run-lifecycle/recovery-checkpoints.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/runtime/run-lifecycle/state-files.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 3 }],
  ["src/runtime/run-lifecycle/task-runtime-bindings.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/runtime/runner-core-helpers.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/runtime/runner-core.ts", { WARN: 1, warning: 1, "best-effort": 0, skip: 0 }],
  ["src/runtime/runner-runtime.ts", { WARN: 0, warning: 1, "best-effort": 0, skip: 2 }],
  ["src/runtime/task-loop/main-loop.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/runtime/task-loop/outcome-handler.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 9 }],
  ["src/runtime/task-state/transitions.ts", { WARN: 0, warning: 0, "best-effort": 0, skip: 1 }],
  ["src/spec/lifecycle.ts", { WARN: 0, warning: 1, "best-effort": 0, skip: 0 }],
  ["src/spec/traceability.ts", { WARN: 0, warning: 1, "best-effort": 0, skip: 1 }],
  ["src/workflows/command-registry.ts", { WARN: 0, warning: 1, "best-effort": 0, skip: 1 }],
  ["src/workflows/install.ts", { WARN: 0, warning: 4, "best-effort": 0, skip: 4 }],
];

const COVERAGE_RULES = [
  { prefix: "src/lib/", rationale: "Legacy evaluator/autofix warnings are allowed only as non-blocking diagnostics.", coveredBy: ["__tests__/engine.test.ts", "__tests__/deterministic-auto-fix.test.ts"] },
  { prefix: "src/cli/", rationale: "CLI warning and support-entry paths must remain visible through public CLI smoke tests.", coveredBy: ["__tests__/public-entrypoints.test.ts", "__tests__/command-registry.test.ts"] },
  { prefix: "src/core/setup.ts", rationale: "Project setup may skip already-present scaffolding while reporting the plan.", coveredBy: ["__tests__/project-setup.test.ts"] },
  { prefix: "src/core/bootstrap.ts", rationale: "Bootstrap may skip existing project files but must report skipped paths.", coveredBy: ["__tests__/project-bootstrap.test.ts"] },
  { prefix: "src/demand/", rationale: "Demand warnings are advisory readiness gaps before executable PRD or code work.", coveredBy: ["__tests__/demand-runtime.test.ts", "__tests__/demand-interview.test.ts", "__tests__/discovery-gate.test.ts"] },
  { prefix: "src/discovery/", rationale: "Discovery warnings capture unclear demand facts without writing business code.", coveredBy: ["__tests__/discovery-runtime.test.ts", "__tests__/discovery-gate.test.ts"] },
  { prefix: "src/eval/", rationale: "Benchmark warnings are release-readiness advisories with explicit score thresholds.", coveredBy: ["__tests__/eval-benchmark.test.ts"] },
  { prefix: "src/lifecycle/", rationale: "Lifecycle warning states are explicit stage outcomes and not execution bypasses.", coveredBy: ["__tests__/lifecycle-guard.test.ts", "__tests__/lifecycle-state.test.ts", "__tests__/lifecycle-progress.test.ts"] },
  { prefix: "src/packs/", rationale: "Pack resolver warnings describe optional/unknown context and must stay inspectable.", coveredBy: ["__tests__/pack-resolver.test.ts"] },
  { prefix: "src/pm/", rationale: "PM entry skips are package import compatibility paths, not execution gates.", coveredBy: ["__tests__/public-entrypoints.test.ts"] },
  { prefix: "src/prd/", rationale: "PRD warnings/skips are schema and migration diagnostics covered by preflight/contract gates.", coveredBy: ["__tests__/prd-contract-doctor-gate.test.ts", "__tests__/pre-execution-gates.test.ts", "__tests__/spec-governance-gate.test.ts"] },
  { prefix: "src/release/", rationale: "Release skips and warnings are explicit evidence gates and cannot silently publish or approve a release candidate.", coveredBy: ["__tests__/release-hardening-drill.test.ts", "__tests__/release-local-dogfood-evidence.test.ts", "__tests__/release-candidate-gate.test.ts", "__tests__/release-change-provenance.test.ts", "__tests__/release-clean-environment-verify.test.ts", "__tests__/release-dogfood-matrix.test.ts"] },
  { prefix: "src/review/", rationale: "Review skips are scoped finding/task conversions and must not widen fixes.", coveredBy: ["__tests__/review-fix-loop.test.ts", "__tests__/review-finding-schema.test.ts"] },
  { prefix: "src/runtime/acceptance/", rationale: "Acceptance warnings are delivery evidence gaps rather than release approval.", coveredBy: ["__tests__/acceptance-report.test.ts"] },
  { prefix: "src/runtime/adapters/", rationale: "Adapter warnings cover missing or unverifiable external provider evidence.", coveredBy: ["__tests__/agent-adapter-contract.test.ts", "__tests__/provider-runtime-matrix.test.ts"] },
  { prefix: "src/runtime/devtools/", rationale: "Doctor warnings are read-only diagnostics for project setup and integration.", coveredBy: ["__tests__/yolo-doctor.test.ts"] },
  { prefix: "src/runtime/evidence/", rationale: "Evidence warning/skip counts must be reflected in generated reports.", coveredBy: ["__tests__/evidence-report.test.ts", "__tests__/evidence-sdk.test.ts"] },
  { prefix: "src/runtime/execution/", rationale: "Execution skip paths require explicit transition semantics and postcondition checks.", coveredBy: ["__tests__/commit-flow.test.ts", "__tests__/pre-session-flow.test.ts", "__tests__/post-precheck.test.ts", "__tests__/execution-baselines.test.ts"] },
  { prefix: "src/runtime/gates/", rationale: "Gate warnings are structured non-pass states and must not become silent pass-throughs.", coveredBy: ["__tests__/check-report.test.ts", "__tests__/prd-contract-doctor-gate.test.ts", "__tests__/pre-execution-gates.test.ts"] },
  { prefix: "src/runtime/learning/", rationale: "Learning warnings are best-effort memory diagnostics and cannot block gates.", coveredBy: ["__tests__/gate-learning.test.ts", "__tests__/learning-center.test.ts"] },
  { prefix: "src/runtime/logging/", rationale: "Logging best-effort paths must not affect task outcomes.", coveredBy: ["__tests__/task-logger.test.ts"] },
  { prefix: "src/runtime/memory/", rationale: "Memory retention skips preserve ledger safety and bounded history.", coveredBy: ["__tests__/memory-center.test.ts"] },
  { prefix: "src/runtime/parallel/", rationale: "Parallel planning skips keep dependency waves conservative.", coveredBy: ["__tests__/controlled-parallel.test.ts"] },
  { prefix: "src/runtime/pi-runtimes.ts", rationale: "PI runtime warnings are surfaced through public yolo run/check flows.", coveredBy: ["__tests__/public-entrypoints.test.ts", "__tests__/runtime-evidence-cli.test.ts"] },
  { prefix: "src/runtime/progress/", rationale: "Progress warning/skip states are presentation evidence and dashboard counts.", coveredBy: ["__tests__/progress-dashboard.test.ts", "__tests__/progress-dashboard-ui-evidence.test.ts"] },
  { prefix: "src/runtime/recovery/", rationale: "Recovery skips are retry orchestration decisions with explicit blocked/skip states.", coveredBy: ["__tests__/recovery-retry-orchestrator.test.ts", "__tests__/recovery-retry-round.test.ts"] },
  { prefix: "src/runtime/review-loop/", rationale: "Review-loop skips must be merged as structured task results.", coveredBy: ["__tests__/review-loop-orchestrator.test.ts", "__tests__/review-loop-round-helpers.test.ts"] },
  { prefix: "src/runtime/run-lifecycle/", rationale: "Run lifecycle skips preserve startup/finalize safety and state consistency.", coveredBy: ["__tests__/run-lifecycle-finalize.test.ts", "__tests__/run-lifecycle-startup.test.ts", "__tests__/run-lifecycle-state-files.test.ts"] },
  { prefix: "src/runtime/runner-", rationale: "Runner warnings/skips are engine-level support paths behind the public yolo run flow.", coveredBy: ["__tests__/runner-review-flow.test.ts", "__tests__/run-lifecycle-runtime-modules.test.ts"] },
  { prefix: "src/runtime/task-loop/", rationale: "Task-loop skips require verified postconditions before completion.", coveredBy: ["__tests__/task-loop-outcome-handler.test.ts", "__tests__/task-loop-main-loop.test.ts"] },
  { prefix: "src/runtime/task-state/", rationale: "Task-state skip transitions must remain structured and auditable.", coveredBy: ["__tests__/runner-task-state-writers.test.ts"] },
  { prefix: "src/spec/", rationale: "Spec warnings are governance diagnostics and stay visible in preflight evidence.", coveredBy: ["__tests__/spec-lifecycle.test.ts", "__tests__/spec-traceability.test.ts"] },
  { prefix: "src/workflows/", rationale: "Workflow install skips protect existing user/project agent files.", coveredBy: ["__tests__/workflow-skill-install.test.ts", "__tests__/command-registry.test.ts"] },
];

function walk(dir, files = []) {
  if (!existsSync(resolve(ROOT, dir))) return files;
  for (const name of readdirSync(resolve(ROOT, dir))) {
    const relative = join(dir, name);
    const absolute = resolve(ROOT, relative);
    const stat = statSync(absolute);
    if (stat.isDirectory()) walk(relative, files);
    else if (/\.(?:ts|js|mjs|cjs)$/.test(name)) files.push(relative);
  }
  return files;
}

function tokenCounts(relativePath) {
  const source = readFileSync(resolve(ROOT, relativePath), "utf8");
  const counts = {};
  for (const [name, pattern] of TOKEN_PATTERNS) counts[name] = [...source.matchAll(pattern)].length;
  return counts;
}

function scanWarningInventory() {
  const files = [
    ...SOURCE_ROOTS.flatMap((root) => walk(root)),
    ...ROOT_ENTRYPOINTS.filter((file) => existsSync(resolve(ROOT, file))),
  ].sort();

  return files
    .map((path) => [path, tokenCounts(path)])
    .filter(([, counts]) => Object.values(counts).some(Boolean));
}

function coverageFor(path) {
  return COVERAGE_RULES.find((rule) => path === rule.prefix || path.startsWith(rule.prefix));
}

describe("warning inventory meta gate", () => {
  test("runtime WARN/warning/best-effort/skip paths match the reviewed baseline", () => {
    assert.deepEqual(scanWarningInventory(), INVENTORY);
  });

  test("every warning inventory path has an explicit exemption and test coverage", () => {
    for (const [path] of INVENTORY) {
      const coverage = coverageFor(path);
      assert.ok(coverage, `${path} needs an inventory exemption`);
      assert.ok(coverage.rationale.trim().length >= 24, `${path} needs a concrete rationale`);
      assert.ok(coverage.coveredBy.length > 0, `${path} needs coveredBy tests`);
      for (const testPath of coverage.coveredBy) {
        assert.equal(existsSync(resolve(ROOT, testPath)), true, `${path} coveredBy missing: ${testPath}`);
      }
    }
  });
});
