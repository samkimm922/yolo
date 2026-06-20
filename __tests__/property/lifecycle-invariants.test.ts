import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAcceptanceReport } from "../../src/runtime/acceptance/report.js";
import { inspectYoloCheck } from "../../src/runtime/gates/check-report.js";
import { writeLifecycleStageReport } from "../../src/lifecycle/progress.js";
import { evaluatePostConditions } from "../../src/prd/contract.js";
import { runDemandDiscussRuntime, runDemandPrdRuntime } from "../../src/demand/runtime.js";
import { deriveEvidenceRequirements, isGreenfieldDemandSession } from "../../src/demand/evidence-requirements.js";
import { orderTasksByDependencies } from "../../src/runtime/task-loop/expansion.js";
import {
  assertExecutableTaskGraph,
  duplicateTaskKeys,
  expectInvariantFailure,
  makeStrictPrd,
  makeStrictTask,
  runProperty,
  SeededRng,
  stableJson,
  writeJson,
  writeText,
} from "./helpers.js";

const DOMAIN_CASES = [
  {
    slug: "cli",
    target: "terminal operator",
    filePrefix: "taskcli",
    idea: "Build a local command tool for personal records.",
    statusQuo: "The user tracks one item manually in separate notes.",
    criterion: "The command records one local item and reports the saved item back.",
    proof: "A unit test confirms the saved item is listed back.",
    exception: "Empty input returns a clear validation error.",
  },
  {
    slug: "notes",
    target: "knowledge worker",
    filePrefix: "notes-library",
    idea: "Build a local note helper for saved snippets.",
    statusQuo: "The user searches scattered snippets by hand.",
    criterion: "The helper stores one snippet and returns the matching snippet title.",
    proof: "A deterministic test confirms the matching snippet title is returned.",
    exception: "Missing snippet title returns a clear validation error.",
  },
  {
    slug: "url",
    target: "API consumer",
    filePrefix: "url-service",
    idea: "Build a small local URL helper service.",
    statusQuo: "The user keeps generated URL aliases in an ad hoc list.",
    criterion: "The service stores one URL alias and returns the original URL.",
    proof: "A unit test confirms the stored URL alias resolves locally.",
    exception: "Unknown aliases return a deterministic not-found response.",
  },
  {
    slug: "csv",
    target: "data analyst",
    filePrefix: "csv-pipeline",
    idea: "Build a deterministic CSV row helper.",
    statusQuo: "The user cleans one CSV row manually before analysis.",
    criterion: "The helper cleans one CSV row and returns the normalized row.",
    proof: "A unit test confirms the normalized row is returned.",
    exception: "Malformed rows return a clear validation error.",
  },
];

const TASK_TYPES = ["feature", "bugfix", "cleanup"] as const;
const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

function propertyTempRoot(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function assertNoDuplicateTaskKeys(tasks: any[]) {
  const duplicates = duplicateTaskKeys(tasks);
  assert.deepEqual(duplicates, [], `duplicate task keys: ${stableJson(duplicates)}`);
}

function yoloCheckCodes(report: any) {
  return new Set((report.blockers || []).map((blocker: any) => blocker.code));
}

function assertYoloCheckBlocked(report: any, codes: string[]) {
  assert.equal(report.status, "blocked", `expected check blocked, got ${report.status}`);
  const actual = yoloCheckCodes(report);
  for (const code of codes) assert.ok(actual.has(code), `expected blocker ${code}; got ${[...actual].join(",")}`);
}

function graphCaseInput(rng: SeededRng, seed: number) {
  const domain = rng.pick(DOMAIN_CASES);
  const taskCount = rng.int(1, 8);
  const tasks = [];
  for (let index = 0; index < taskCount; index += 1) {
    const id = `FIX-PROP-${String(index + 1).padStart(3, "0")}`;
    const previousIds = tasks.map((task) => task.id);
    const dependencyLimit = Math.min(previousIds.length, rng.int(0, 3));
    const dependsOn = previousIds.length === 0 ? [] : rng.subset(previousIds, dependencyLimit);
    tasks.push(makeStrictTask({
      id,
      title: `${domain.slug} ${rng.pick(["target", "scope", "gate", "report"])} ${index + 1}`,
      type: rng.pick(TASK_TYPES),
      priority: rng.pick(PRIORITIES),
      file: `src/property/${domain.filePrefix}-${seed}-${index + 1}.ts`,
      dependsOn,
    }));
  }
  return {
    seed,
    domain: domain.slug,
    taskCount,
    tasks,
  };
}

function invalidNoRootCycleTasks(rng: SeededRng, seed: number) {
  const count = rng.int(2, 5);
  const ids = Array.from({ length: count }, (_, index) => `FIX-CYCLE-${String(index + 1).padStart(3, "0")}`);
  return ids.map((id, index) => makeStrictTask({
    id,
    title: `cycle task ${index + 1}`,
    type: rng.pick(TASK_TYPES),
    file: `src/property/cycle-${seed}-${index + 1}.ts`,
    dependsOn: ids.filter((other) => other !== id),
  }));
}

function runCheckForPrd(root: string, prd: any) {
  const prdPath = join(root, "prd.json");
  writeJson(prdPath, prd);
  return inspectYoloCheck({ prdPath, projectRoot: root, stateRoot: join(root, ".yolo"), writeLifecycle: false });
}

function demandCaseInput(rng: SeededRng, seed: number, greenfield = false) {
  const domain = rng.pick(DOMAIN_CASES);
  const file = greenfield
    ? `src/greenfield/${domain.filePrefix}-${seed}.ts`
    : `src/property/${domain.filePrefix}-${seed}.ts`;
  return {
    seed,
    demandId: `DEMAND-PROP-${domain.slug.toUpperCase()}-${seed}`,
    domain: domain.slug,
    greenfield,
    targetFile: file,
    targetUsers: [domain.target],
    idea: greenfield ? `${domain.idea} Start as a greenfield new project.` : domain.idea,
    statusQuo: [domain.statusQuo],
    evidence: greenfield
      ? ["This is a new project from scratch with a planned implementation surface."]
      : [`Agent read ${file} and confirmed it is the implementation target.`],
    assumptions: ["The workflow is local and can be verified with deterministic inputs."],
    successCriteria: [domain.criterion],
    proof: [domain.proof],
    constraints: ["Keep the implementation local, deterministic, and bounded to the target file."],
    nonGoals: ["No network service, background worker, or unrelated workflow expansion."],
    decisions: ["Use one source module and one deterministic verification path."],
    roadmap: ["Deliver the bounded MVP behavior first."],
    exceptions: [domain.exception],
  };
}

function seedExistingTarget(root: string, file: string) {
  writeText(join(root, file), [
    "export function propertyTarget(value: string) {",
    "  return value.trim();",
    "}",
    "",
  ].join("\n"));
}

function runDemandDiscussCase(root: string, input: ReturnType<typeof demandCaseInput>) {
  if (!input.greenfield) seedExistingTarget(root, input.targetFile);
  return runDemandDiscussRuntime({
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    demand_id: input.demandId,
    idea: input.idea,
    target_users: input.targetUsers,
    status_quo: input.statusQuo,
    evidence: input.evidence,
    assumptions: input.assumptions,
    success_criteria: input.successCriteria,
    proof: input.proof,
    constraints: input.constraints,
    non_goals: input.nonGoals,
    target_files: [input.targetFile],
    decisions: input.decisions,
    roadmap: input.roadmap,
    exceptions: input.exceptions,
    approve: true,
    playback: { confirmed: true, confirmed_by: "user" },
    writeArtifacts: true,
  });
}

function markSessionGreenfieldPlanned(session: any, file: string) {
  session.context_type = "greenfield";
  session.project_facts = session.project_facts || {};
  session.project_facts.target_files = [{
    file,
    status: "planned_new_file",
    source: "demand_greenfield_inference",
    new_file: true,
    allow_new_files: true,
  }];
  session.project_facts.candidate_target_files = [];
  session.project_facts.assumptions = [];
  session.project_facts.policy = {
    greenfield_new_files_are_execution_scope: true,
    unverified_project_facts_block_prd: true,
  };
  for (const scenario of session.scenario_matrix?.scenarios || []) {
    for (const surface of scenario.surfaces || []) {
      if ((surface.target_files || []).includes(file)) surface.allow_new_files = true;
    }
  }
}

function compileDemand(root: string, discuss: any) {
  return runDemandPrdRuntime({
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    demandPath: discuss.demand_dir,
    writeArtifacts: false,
  });
}

function writeMutatedSession(discuss: any) {
  writeJson(join(discuss.demand_dir, "session.json"), discuss.session);
}

function duplicateSurfaceCaseInput(rng: SeededRng, seed: number) {
  const base = demandCaseInput(rng, seed, false);
  return {
    ...base,
    duplicateSurfaceCount: rng.int(2, 6),
    addReadonlyContext: rng.bool(),
    surfaceLabel: rng.pick(["代码实现", "Core behavior", "Service update"]),
  };
}

function applyDuplicateSurfaces(discuss: any, input: ReturnType<typeof duplicateSurfaceCaseInput>) {
  const scenario = discuss.session.scenario_matrix.scenarios[0];
  const proof = scenario.proof || input.proof[0];
  scenario.surfaces = Array.from({ length: input.duplicateSurfaceCount }, (_, index) => ({
    id: `${scenario.id}-DUP-${String(index + 1).padStart(3, "0")}`,
    kind: "code",
    label: input.surfaceLabel,
    target_files: [input.targetFile],
    readonly_files: input.addReadonlyContext ? [input.targetFile] : [],
    allow_new_files: false,
    session_budget: { expected: "single_session", max_files: 1, max_lines_per_file: 120 },
    proof,
    verification_hint: `Verify ${proof} for duplicate surface ${index + 1}.`,
  }));
}

function initGitRepo(root: string) {
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "property@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Property Test"], { cwd: root, stdio: "ignore" });
  writeText(join(root, "README.md"), "# property fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
}

function targetModifiedInput(rng: SeededRng, seed: number) {
  const domain = rng.pick(DOMAIN_CASES);
  return {
    seed,
    targetFile: `src/untracked/${domain.filePrefix}-${seed}.ts`,
    createTarget: rng.bool(),
    addExtraDirtyFile: rng.bool(),
  };
}

function evaluateTargetModified(root: string, file: string) {
  const task: any = makeStrictTask({
    id: "FIX-TARGET-001",
    title: "Target modified",
    file,
    dependsOn: [],
  });
  task.scope.expected_zero_business_code = true;
  const result = evaluatePostConditions(task, makeStrictPrd({ tasks: [task] }), { root });
  return result.results.find((item: any) => item.type === "target_file_modified");
}

function acceptancePrd(seed: number, file: string) {
  const task = makeStrictTask({
    id: `FIX-ACCEPT-${Math.abs(seed)}`,
    title: "Accept run report",
    type: "feature",
    file,
    dependsOn: [],
  });
  return makeStrictPrd({ id: `PRD-20260620-ACCEPT-${Math.abs(seed)}`, title: "Acceptance property", tasks: [task] });
}

function runReport(seed: number, prdPath: string) {
  return {
    schema: "yolo.run.report.v1",
    status: "pass",
    run_id: `run-${seed}`,
    prd: prdPath,
    summary: {
      planned: 1,
      completed: 1,
      failed: 0,
      blocked: 0,
      skipped: 0,
      evidence_failures: 0,
    },
    gates: { failed_count: 0 },
    review: { issue_count: 0, error_count: 0 },
    fixtures: { status: "pass", fail_count: 0, blocked_count: 0, degraded_count: 0 },
    ledger: { integrity: { error_count: 0 } },
  };
}

describe("property lifecycle invariants", () => {
  test("INV-1 topology roots: check-passing PRDs are rooted DAGs and cyclic/no-root PRDs block", () => {
    runProperty("INV-1", 0x1A11CE, graphCaseInput, ({ input }, rng) => {
      const root = propertyTempRoot("yolo-inv1-");
      try {
        const prd = makeStrictPrd({
          id: `PRD-20260620-INV1-${input.seed}`,
          title: `Topology property ${input.domain}`,
          tasks: input.tasks,
        });
        const report = runCheckForPrd(root, prd);
        assert.equal(report.status, "pass", `check should pass for a generated DAG: ${stableJson(report.blockers)}`);
        assertExecutableTaskGraph(input.tasks);
        assert.equal(orderTasksByDependencies(input.tasks).preflight.status, "pass");

        const invalid = invalidNoRootCycleTasks(rng, input.seed);
        const invalidReport = runCheckForPrd(root, makeStrictPrd({
          id: `PRD-20260620-INV1-BAD-${input.seed}`,
          title: "Invalid topology property",
          tasks: invalid,
        }));
        assertYoloCheckBlocked(invalidReport, ["TASK_DEPENDENCY_NO_ROOT", "TASK_DEPENDENCY_CYCLE"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test("INV-1 reverse self-check: graph assertion fails for no-root cycle input", () => {
    const tasks = invalidNoRootCycleTasks(new SeededRng(0xBAD1), 0xBAD1);
    expectInvariantFailure("INV-1 reverse", () => assertExecutableTaskGraph(tasks), /zero-dependency root|topologically/);
  });

  test("INV-2 task dedup: compiled demand specs do not emit duplicate title/scope/type tasks", () => {
    runProperty("INV-2", 0x2D6D00, duplicateSurfaceCaseInput, ({ input }) => {
      const root = propertyTempRoot("yolo-inv2-");
      try {
        const discuss = runDemandDiscussCase(root, input);
        assert.equal(discuss.status, "success", `discuss should be ready: ${stableJson(discuss.blockers)}`);
        applyDuplicateSurfaces(discuss, input);
        writeMutatedSession(discuss);

        const compiled = compileDemand(root, discuss);
        assert.equal(compiled.status, "success", `compiled demand should succeed: ${stableJson(compiled.blockers)}`);
        assert.equal(compiled.code, "DEMAND_PRD_READY");
        assertNoDuplicateTaskKeys(compiled.prd.tasks);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test("INV-2 reverse self-check: duplicate key detector fails on duplicate task output", () => {
    const duplicate = makeStrictTask({
      id: "FIX-DUP-001",
      title: "Duplicate output",
      file: "src/dup.ts",
    });
    const tasks = [duplicate, { ...duplicate, id: "FIX-DUP-002" }];
    expectInvariantFailure("INV-2 reverse", () => assertNoDuplicateTaskKeys(tasks), /duplicate task keys/);
  });

  test("INV-3 greenfield planned-new-file approved demand compiles without project/external evidence blockers", () => {
    runProperty("INV-3", 0x34EAF1, (rng, seed) => demandCaseInput(rng, seed, true), ({ input }) => {
      const root = propertyTempRoot("yolo-inv3-");
      try {
        const discuss = runDemandDiscussCase(root, input);
        markSessionGreenfieldPlanned(discuss.session, input.targetFile);
        writeMutatedSession(discuss);

        assert.equal(isGreenfieldDemandSession({}, discuss.session), true);
        assert.deepEqual(deriveEvidenceRequirements({}, discuss.session, { kinds: ["project"] }), []);

        const compiled = compileDemand(root, discuss);
        assert.equal(compiled.status, "success", `greenfield compile should succeed: ${stableJson(compiled.blockers)}`);
        assert.equal(compiled.code, "DEMAND_PRD_READY");
        assert.equal(compiled.readiness.executable_prd_ready, true);
        assert.equal(compiled.quality_report.status, "pass");
        assert.equal(
          (compiled.blockers || []).some((blocker: any) => /EXTERNAL|PROJECT|TARGET_FILE_VERIFIED/.test(blocker.code || "")),
          false,
          `greenfield must not be evidence-blocked: ${stableJson(compiled.blockers)}`,
        );
        assert.ok(compiled.prd.tasks.every((task: any) => task.scope?.allow_new_files === true));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test("INV-3 reverse self-check: brownfield existing payload claims require project evidence", () => {
    const session = {
      project: { target_files: ["src/inventory.ts"] },
      project_facts: {
        target_files: [{ file: "src/inventory.ts", status: "verified" }],
      },
      requirements: {
        active: [{
          id: "REQ-BROWN",
          text: "Inventory list already receives quantity and threshold fields from the existing request payload.",
          acceptance_scenarios: [{ then: "A low-stock result can use those existing fields." }],
        }],
      },
    };
    assert.equal(isGreenfieldDemandSession({}, session), false);
    const requirements = deriveEvidenceRequirements({}, session, { kinds: ["project"] });
    assert.equal(requirements.some((item) => item.kind === "project" && item.status === "pending"), true);
  });

  test("INV-4 target_file_modified counts newly created untracked target files", () => {
    const root = propertyTempRoot("yolo-inv4-");
    try {
      initGitRepo(root);
      runProperty("INV-4", 0x4F17E, targetModifiedInput, ({ input }) => {
        if (input.addExtraDirtyFile) {
          writeText(join(root, `src/untracked/extra-${input.seed}.ts`), "export const extra = true;\n");
        }
        if (input.createTarget) {
          writeText(join(root, input.targetFile), "export const target = true;\n");
        }

        const targetResult = evaluateTargetModified(root, input.targetFile);
        assert.equal(
          targetResult?.passed,
          input.createTarget,
          `target_file_modified mismatch for ${stableJson(input)} result=${stableJson(targetResult)}`,
        );
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("INV-4 reverse self-check: missing untracked target remains unmodified", () => {
    const root = propertyTempRoot("yolo-inv4-reverse-");
    try {
      initGitRepo(root);
      const result = evaluateTargetModified(root, "src/untracked/missing.ts");
      expectInvariantFailure("INV-4 reverse", () => assert.equal(result?.passed, true), /false/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("INV-5 readiness and quality stay consistent for compiled approved demand", () => {
    runProperty("INV-5", 0x5EAD1, (rng, seed) => demandCaseInput(rng, seed, false), ({ input }) => {
      const root = propertyTempRoot("yolo-inv5-");
      try {
        const discuss = runDemandDiscussCase(root, input);
        assert.equal(discuss.status, "success", `discuss should be ready: ${stableJson(discuss.blockers)}`);
        const compiled = compileDemand(root, discuss);
        assert.equal(compiled.readiness.executable_prd_ready, true, stableJson(compiled.readiness.blockers));
        assert.equal(compiled.quality_report.status, "pass", stableJson(compiled.quality_report.blockers));
        assert.equal(compiled.status, "success");
        assert.equal(compiled.code, "DEMAND_PRD_READY");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test("INV-5 reverse self-check: check blocks executable-readiness PRDs with blocked demand quality", () => {
    const root = propertyTempRoot("yolo-inv5-reverse-");
    try {
      const task = makeStrictTask({
        id: "FIX-QUALITY-001",
        title: "Quality blocked",
        file: "src/quality.ts",
      });
      const report = runCheckForPrd(root, makeStrictPrd({
        id: "PRD-20260620-QUALITY-BLOCKED",
        title: "Quality blocked PRD",
        tasks: [task],
        qualityStatus: "blocked",
      }));
      assertYoloCheckBlocked(report, ["DEMAND_QUALITY_BLOCKED"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("INV-6 acceptance defaults to real state run report instead of lifecycle stage wrapper", () => {
    runProperty("INV-6", 0x6ACE, (rng, seed) => {
      const domain = rng.pick(DOMAIN_CASES);
      return {
        seed,
        file: `src/acceptance/${domain.filePrefix}-${seed}.ts`,
        oldRunId: `run-${seed}-a`,
        selectedRunId: `run-${seed}-z`,
      };
    }, ({ input }) => {
      const root = propertyTempRoot("yolo-inv6-");
      const stateRoot = join(root, ".yolo");
      try {
        const prdPath = join(root, "prd.json");
        writeJson(prdPath, acceptancePrd(input.seed, input.file));
        writeLifecycleStageReport("run", {
          status: "success",
          summary: "stage wrapper only; not structured run evidence",
        }, {
          projectRoot: root,
          stateRoot,
          source: "property-test",
          skipSequenceCheck: true,
        });
        writeJson(join(stateRoot, `state/reports/${input.oldRunId}/run-report.json`), {
          ...runReport(input.seed - 1, prdPath),
          run_id: input.oldRunId,
        });
        writeJson(join(stateRoot, `state/reports/${input.selectedRunId}/run-report.json`), {
          ...runReport(input.seed, prdPath),
          run_id: input.selectedRunId,
        });

        const report = buildAcceptanceReport({
          prdPath,
          projectRoot: root,
          stateRoot,
          reviewReport: { findings: [] },
        });
        assert.equal(report.status, "pass", `acceptance should pass from real run report: ${stableJson(report.issues)}`);
        assert.equal(report.issues.some((issue: any) => issue.code === "RUN_REPORT_INSUFFICIENT"), false);
        assert.ok(
          report.artifacts.some((artifact: string) => artifact.endsWith(`.yolo/state/reports/${input.selectedRunId}/run-report.json`)),
          `expected selected state run report in artifacts: ${stableJson(report.artifacts)}`,
        );
        assert.equal(
          report.artifacts.some((artifact: string) => artifact.endsWith(".yolo/lifecycle/run-report.json")),
          false,
          "lifecycle stage wrapper must not be treated as the default run evidence",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test("INV-6 reverse self-check: lifecycle stage wrapper alone is insufficient run evidence", () => {
    const root = propertyTempRoot("yolo-inv6-reverse-");
    const stateRoot = join(root, ".yolo");
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, acceptancePrd(0xBAD6, "src/acceptance/missing-real-run.ts"));
      writeLifecycleStageReport("run", {
        status: "success",
        summary: "stage wrapper only",
      }, {
        projectRoot: root,
        stateRoot,
        source: "property-test",
        skipSequenceCheck: true,
      });
      const report = buildAcceptanceReport({
        prdPath,
        projectRoot: root,
        stateRoot,
        reviewReport: { findings: [] },
      });
      expectInvariantFailure("INV-6 reverse", () => assert.equal(report.status, "pass"), /blocked/);
      assert.ok(report.issues.some((issue: any) => issue.code === "RUN_REPORT_INSUFFICIENT"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
