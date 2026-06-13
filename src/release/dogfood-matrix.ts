export const DOGFOOD_MATRIX_SCHEMA_VERSION = "1.0";

export const DOGFOOD_MATRIX_SCENARIO_IDS = [
  "node-basic",
  "frontend-vite",
  "backend-api",
  "python-service",
  "monorepo",
  "dirty-tree",
  "failing-baseline",
];

const LIFECYCLE_COMMANDS = [
  { stage: "idea", command: "/yolo", check: "capture project-independent work intent" },
  { stage: "discovery", command: "/yolo-demand", check: "project facts and assumptions are recorded" },
  { stage: "plan", command: "/yolo-plan", check: "scoped task plan names target files and acceptance evidence" },
  { stage: "prd", command: "/yolo-prd", check: "PRD/spec traces requirement to task and checks" },
  { stage: "check", command: "/yolo-check", check: "pre-run gates and lifecycle checks are machine-readable" },
  { stage: "review", command: "/yolo-review", check: "review findings are structured and scoped" },
  { stage: "accept", command: "/yolo-accept", check: "acceptance report links evidence and final status" },
];
const FORBIDDEN_EVIDENCE_FLAGS = [
  "provider_execution",
  "billable_provider_execution",
  "network_access",
  "publishes",
  "publish",
  "reads_credentials",
  "credential_access",
  "writes_workspace",
  "edits_code",
  "package_root_mutation",
  "template_download",
];

function scenarioEvidencePaths(id) {
  return [
    `.yolo/state/reports/dogfood/matrix/${id}/plan.json`,
    `.yolo/state/reports/dogfood/matrix/${id}/check-report.json`,
    `.yolo/state/reports/dogfood/matrix/${id}/acceptance-report.json`,
  ];
}

function passExpected({ id, label, projectShape, fixtureCommand, passConditions = [], blockedConditions = [] }) {
  return {
    id,
    label,
    project_shape: projectShape,
    required_lifecycle_commands: [
      ...LIFECYCLE_COMMANDS,
      { stage: "project-check", command: fixtureCommand, check: "fixture-native lifecycle check passes" },
    ],
    required_checks: [
      "project shape detected without app-specific assumptions",
      "runner command plan is dry-run safe and scoped to the fixture",
      "evidence files are linked for plan, check, and acceptance",
      "no provider, network template download, publish, credential, or package-root mutation is claimed",
    ],
    expected: {
      outcome: "pass",
      pass_conditions: [
        "all required lifecycle checks pass",
        "all acceptance evidence paths are present",
        ...passConditions,
      ],
      fail_conditions: [
        "missing evidence",
        "project-native checks fail",
        "side effects or provider execution are claimed",
      ],
    },
    acceptance_evidence_paths: scenarioEvidencePaths(id),
    blocked_conditions: [
      "required evidence path is missing",
      "scenario status is not pass",
      "command plan contains project-specific product assumptions",
      ...blockedConditions,
    ],
  };
}

function failClosedExpected({ id, label, projectShape, fixtureCommand, failConditions, blockedConditions = [] }) {
  return {
    id,
    label,
    project_shape: projectShape,
    required_lifecycle_commands: [
      ...LIFECYCLE_COMMANDS,
      { stage: "project-check", command: fixtureCommand, check: "fixture-native lifecycle check exposes the unsafe baseline" },
    ],
    required_checks: [
      "project shape detected without app-specific assumptions",
      "runner command plan is dry-run safe and scoped to the fixture",
      "evidence files are linked for plan, check, and acceptance",
      "unsafe baseline is reported as blocked/fail-closed, not converted into a pass",
    ],
    expected: {
      outcome: "fail_closed",
      pass_conditions: [
        "the scenario blocks with linked evidence",
        "the report explains why automation cannot continue safely",
      ],
      fail_conditions: failConditions,
    },
    acceptance_evidence_paths: scenarioEvidencePaths(id),
    blocked_conditions: [
      "required evidence path is missing",
      "scenario is reported as pass even though fail-closed is expected",
      ...blockedConditions,
    ],
  };
}

export const GENERIC_DOGFOOD_MATRIX = [
  passExpected({
    id: "node-basic",
    label: "Node basic",
    fixtureCommand: "npm test",
    projectShape: {
      fixture: "fixtures/node-basic",
      language: "javascript",
      package_manager: "npm",
      test_framework: "node:test",
      files: ["package.json", "src/index.ts", "test/index.test.ts"],
    },
    passConditions: ["minimal npm package lifecycle succeeds"],
  }),
  passExpected({
    id: "frontend-vite",
    label: "Frontend Vite",
    fixtureCommand: "npm test",
    projectShape: {
      fixture: "fixtures/frontend-vite",
      language: "javascript",
      package_manager: "npm",
      framework: "vite",
      test_framework: "node:test",
      files: ["package.json", "prd.json", "src/counter.ts", "test/counter.test.ts"],
    },
    passConditions: ["frontend fixture is handled without task-board or product assumptions"],
  }),
  passExpected({
    id: "backend-api",
    label: "Backend API",
    fixtureCommand: "npm test",
    projectShape: {
      fixture: "fixtures/backend-api",
      language: "javascript",
      package_manager: "npm",
      architecture: "backend-api",
      test_framework: "node:test",
      files: ["package.json", "prd.json", "src/server.ts", "test/server.test.ts"],
    },
    passConditions: ["API fixture validates service checks without UI assumptions"],
  }),
  passExpected({
    id: "python-service",
    label: "Python service",
    fixtureCommand: "python3 -m unittest discover -s tests -p 'test_*.py'",
    projectShape: {
      fixture: "fixtures/python-service",
      language: "python",
      package_manager: null,
      architecture: "service",
      test_framework: "unittest",
      files: [
        "prd.json",
        "src/inventory_service/alerts.py",
        "src/inventory_service/cli.py",
        "tests/test_inventory_service.py",
      ],
    },
    passConditions: ["non-Node lifecycle evidence is accepted"],
  }),
  passExpected({
    id: "monorepo",
    label: "Monorepo",
    fixtureCommand: "node --test packages/app/test.ts",
    projectShape: {
      fixture: "fixtures/monorepo",
      language: "javascript",
      package_manager: "npm",
      layout: "monorepo",
      test_framework: "node:test",
      files: ["package.json", "prd.json", "packages/app/src/index.ts", "packages/utils/src/math.ts"],
    },
    passConditions: ["workspace package boundaries are preserved"],
  }),
  failClosedExpected({
    id: "dirty-tree",
    label: "Dirty tree",
    fixtureCommand: "node scripts/check-dirty-marker.ts",
    projectShape: {
      fixture: "fixtures/dirty-tree",
      language: "javascript",
      package_manager: "npm",
      scenario: "dirty-tree",
      files: ["package.json", "prd.json", "local/unsaved-note.txt", "src/index.ts"],
    },
    failConditions: [
      "pre-existing user work is present",
      "automation must stop instead of overwriting or normalizing the dirty tree",
    ],
    blockedConditions: ["dirty workspace is accepted as a clean pass"],
  }),
  failClosedExpected({
    id: "failing-baseline",
    label: "Failing baseline",
    fixtureCommand: "node scripts/check-baseline.ts",
    projectShape: {
      fixture: "fixtures/failing-baseline",
      language: "javascript",
      package_manager: "npm",
      scenario: "failing-baseline",
      files: ["package.json", "prd.json", "state/baseline/test-failures.txt", "test/legacy-failure.test.ts"],
    },
    failConditions: [
      "baseline checks are already failing",
      "automation must preserve the failure as blocked evidence instead of claiming success",
    ],
    blockedConditions: ["known failing baseline is accepted as a smooth pass"],
  }),
];

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === "") return [];
  return [value];
}

function unique(values = []) {
  return [...new Set(asArray(values).map(String).filter(Boolean))];
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeEvidenceByScenario(options = Object()) {
  return options.evidenceByScenario
    || options.evidence_by_scenario
    || options.scenarioEvidence
    || options.scenario_evidence
    || options.evidence
    || {};
}

function evidencePaths(evidence = Object()) {
  return unique([
    evidence.artifact_path,
    evidence.report_path,
    ...(evidence.evidence_files || []),
    ...(evidence.evidence || []),
    ...(evidence.acceptance_evidence_paths || []),
  ]);
}

function evidenceWarnings(evidence = Object()) {
  return unique([
    ...(evidence.warnings || []),
    ...(evidence.warning ? [evidence.warning] : []),
  ]);
}

function evidenceBlockers(evidence = Object()) {
  return [
    ...(evidence.blockers || []),
    ...(evidence.blocked_reasons || []),
    ...(evidence.blocked_reason ? [evidence.blocked_reason] : []),
  ].map((item) => {
    if (typeof item === "string") return { code: "DOGFOOD_MATRIX_SCENARIO_BLOCKED", message: item };
    return item;
  }).filter(Boolean);
}

function includesEveryEvidencePath(actualPaths, requiredPaths) {
  const actual = new Set(actualPaths);
  return requiredPaths.every((path) => actual.has(path));
}

function forbiddenSideEffectBlockers(evidence = Object()) {
  return FORBIDDEN_EVIDENCE_FLAGS
    .filter((field) => evidence[field] === true)
    .map((field) => ({
      code: "DOGFOOD_MATRIX_FORBIDDEN_SIDE_EFFECT",
      message: `scenario evidence claims forbidden side effect: ${field}`,
      field,
    }));
}

function buildCommandPlan(scenario) {
  return scenario.required_lifecycle_commands.map((item) => ({
    scenario: scenario.id,
    stage: item.stage,
    command: item.command,
    check: item.check,
  }));
}

function scenarioReport(scenario, evidence) {
  const paths = evidencePaths(evidence);
  const missingEvidence = scenario.acceptance_evidence_paths.filter((path) => !paths.includes(path));
  const blockers = evidenceBlockers(evidence);
  const warnings = evidenceWarnings(evidence);
  const hasEvidence = isObject(evidence);
  const status = String(evidence?.status || "");
  const expectedFailClosed = scenario.expected.outcome === "fail_closed";
  const passedSmoothly = status === "pass";
  const failedClosed = ["blocked", "fail", "failed", "fail_closed"].includes(status);
  const sideEffectBlockers = forbiddenSideEffectBlockers(evidence);

  if (!hasEvidence) {
    return {
      scenario: scenario.id,
      status: "blocked",
      expected_outcome: scenario.expected.outcome,
      missing_evidence: scenario.acceptance_evidence_paths,
      blocked_reasons: [{ code: "DOGFOOD_MATRIX_SCENARIO_EVIDENCE_MISSING", message: "scenario evidence is missing" }],
      warnings,
      command_plan: buildCommandPlan(scenario),
      evidence: null,
    };
  }

  if (sideEffectBlockers.length > 0) {
    return {
      scenario: scenario.id,
      status: "blocked",
      expected_outcome: scenario.expected.outcome,
      missing_evidence: [],
      blocked_reasons: sideEffectBlockers,
      warnings,
      command_plan: buildCommandPlan(scenario),
      evidence,
    };
  }

  if (!includesEveryEvidencePath(paths, scenario.acceptance_evidence_paths)) {
    return {
      scenario: scenario.id,
      status: "blocked",
      expected_outcome: scenario.expected.outcome,
      missing_evidence: missingEvidence,
      blocked_reasons: [{ code: "DOGFOOD_MATRIX_ACCEPTANCE_EVIDENCE_MISSING", message: "required acceptance evidence is missing" }, ...blockers],
      warnings,
      command_plan: buildCommandPlan(scenario),
      evidence,
    };
  }

  if (expectedFailClosed) {
    if (passedSmoothly) {
      return {
        scenario: scenario.id,
        status: "blocked",
        expected_outcome: "fail_closed",
        missing_evidence: [],
        blocked_reasons: [{
          code: "DOGFOOD_MATRIX_FAIL_CLOSED_EXPECTED",
          message: "scenario must fail closed and cannot be accepted as a smooth pass",
        }],
        warnings,
        command_plan: buildCommandPlan(scenario),
        evidence,
      };
    }
    if (failedClosed) {
      return {
        scenario: scenario.id,
        status: "fail_closed",
        expected_outcome: "fail_closed",
        missing_evidence: [],
        blocked_reasons: blockers.length > 0
          ? blockers
          : [{ code: "DOGFOOD_MATRIX_EXPECTED_FAIL_CLOSED", message: scenario.expected.fail_conditions[0] }],
        warnings,
        command_plan: buildCommandPlan(scenario),
        evidence,
      };
    }
  }

  if (status === "pass") {
    return {
      scenario: scenario.id,
      status: "pass",
      expected_outcome: scenario.expected.outcome,
      missing_evidence: [],
      blocked_reasons: [],
      warnings,
      command_plan: buildCommandPlan(scenario),
      evidence,
    };
  }

  return {
    scenario: scenario.id,
    status: "blocked",
    expected_outcome: scenario.expected.outcome,
    missing_evidence: [],
    blocked_reasons: blockers.length > 0
      ? blockers
      : [{ code: "DOGFOOD_MATRIX_SCENARIO_NOT_PASSING", message: "scenario evidence did not meet the expected outcome" }],
    warnings,
    command_plan: buildCommandPlan(scenario),
    evidence,
  };
}

export function listDogfoodMatrixScenarios() {
  return GENERIC_DOGFOOD_MATRIX.map((scenario) => ({
    ...scenario,
    required_lifecycle_commands: scenario.required_lifecycle_commands.map((item) => ({ ...item })),
    required_checks: [...scenario.required_checks],
    acceptance_evidence_paths: [...scenario.acceptance_evidence_paths],
    blocked_conditions: [...scenario.blocked_conditions],
  }));
}

export function buildDogfoodMatrixPlan(options = Object()) {
  const scenarios = listDogfoodMatrixScenarios();
  return {
    schema_version: DOGFOOD_MATRIX_SCHEMA_VERSION,
    schema: "yolo.release.dogfood_matrix_plan.v1",
    matrix: "generic",
    project_root: options.projectRoot || options.project_root || null,
    yolo_root: options.yoloRoot || options.yolo_root || null,
    scenarios,
    scenario_ids: scenarios.map((scenario) => scenario.id),
    command_plan: scenarios.flatMap(buildCommandPlan),
    required_evidence: scenarios.flatMap((scenario) => scenario.acceptance_evidence_paths),
    blocked_conditions: [
      "any generic scenario is missing required evidence",
      "any pass-expected scenario does not pass",
      "dirty-tree or failing-baseline is reported as a smooth pass",
      "any command plan contains product-specific assumptions",
    ],
    runner: {
      required: false,
      injectable: true,
      note: "Real execution may be supplied by an external runner; this module validates local plan/report evidence only.",
    },
  };
}

function scenarioSetBlockers(scenarios = []) {
  const ids = scenarios.map((scenario) => scenario.id).filter(Boolean);
  const uniqueIds = new Set(ids);
  const missing = DOGFOOD_MATRIX_SCENARIO_IDS.filter((id) => !uniqueIds.has(id));
  const unexpected = ids.filter((id) => !DOGFOOD_MATRIX_SCENARIO_IDS.includes(id));
  if (missing.length === 0 && unexpected.length === 0 && uniqueIds.size === DOGFOOD_MATRIX_SCENARIO_IDS.length) {
    return [];
  }
  return [{
    code: "DOGFOOD_MATRIX_SCENARIO_SET_INCOMPLETE",
    message: "dogfood matrix must include every generic scenario exactly once",
    required_scenarios: DOGFOOD_MATRIX_SCENARIO_IDS,
    present_scenarios: ids,
    missing_scenarios: missing,
    unexpected_scenarios: unexpected,
  }];
}

export function buildDogfoodMatrixReport(options = Object()) {
  const plan = options.plan || buildDogfoodMatrixPlan(options);
  const evidenceByScenario = normalizeEvidenceByScenario(options);
  const scenarios = plan.scenarios || listDogfoodMatrixScenarios();
  const matrixBlockers = scenarioSetBlockers(scenarios);
  const scenarioReports = scenarios.map((scenario) => scenarioReport(scenario, evidenceByScenario[scenario.id]));
  const blockers = scenarioReports
    .filter((report) => !["pass", "fail_closed"].includes(report.status))
    .flatMap((report) => report.blocked_reasons.map((reason) => ({
      ...reason,
      scenario: report.scenario,
    })));
  const missingEvidence = scenarioReports.flatMap((report) => (
    report.missing_evidence || []
  ).map((path) => ({ scenario: report.scenario, path })));
  const warnings = scenarioReports.flatMap((report) => report.warnings.map((warning) => ({
    scenario: report.scenario,
    warning,
  })));

  return {
    schema_version: DOGFOOD_MATRIX_SCHEMA_VERSION,
    schema: "yolo.release.dogfood_matrix_report.v1",
    status: matrixBlockers.length === 0 && blockers.length === 0 ? "pass" : "blocked",
    matrix: plan.matrix || "generic",
    scenario_count: scenarioReports.length,
    scenarios: scenarioReports,
    missing_evidence: missingEvidence,
    blocked_reasons: [...matrixBlockers, ...blockers],
    warnings,
    command_plan: plan.command_plan || scenarios.flatMap(buildCommandPlan),
    plan,
  };
}

export function buildDogfoodMatrixEvidence(statusByScenario = Object()) {
  return Object.fromEntries(GENERIC_DOGFOOD_MATRIX.map((scenario) => {
    const configured = statusByScenario[scenario.id];
    const status = typeof configured === "string"
      ? configured
      : configured?.status || (scenario.expected.outcome === "fail_closed" ? "fail_closed" : "pass");
    const extra = isObject(configured) ? configured : {};
    return [scenario.id, {
      status,
      acceptance_evidence_paths: [...scenario.acceptance_evidence_paths],
      evidence_files: [...scenario.acceptance_evidence_paths],
      blockers: scenario.expected.outcome === "fail_closed"
        ? [{ code: "DOGFOOD_MATRIX_EXPECTED_FAIL_CLOSED", message: scenario.expected.fail_conditions[0] }]
        : [],
      provider_execution: false,
      billable_provider_execution: false,
      writes_workspace: false,
      ...extra,
    }];
  }));
}
