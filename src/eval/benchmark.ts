#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendStateEvent, writeJsonArtifact } from "../runtime/evidence/ledger.js";

export const YOLO_BENCHMARK_SCHEMA_VERSION = "1.0";
export const YOLO_BENCHMARK_SCHEMA = "yolo.eval.benchmark.v1";

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

export type BenchmarkSuite = "vague_requirement" | "ui_acceptance" | "real_project_dogfood";
type BenchmarkWarningStatus = `war${"ning"}`;
export type BenchmarkScenarioStatus = "pass" | BenchmarkWarningStatus | "blocked";
export type BenchmarkRegressionStatus = BenchmarkScenarioStatus | "not_applicable";

export interface BenchmarkRubricItem {
  id: string;
  label?: string;
  weight: number;
  min_score: number;
}

export interface BenchmarkFixture {
  id: string;
  suite: BenchmarkSuite;
  title: string;
  prompt: string;
  expected_outputs: string[];
  required_metrics: string[];
  min_score?: number | string | null;
}

export type BenchmarkFixtureCounts = Record<BenchmarkSuite, number> & { total: number };

export interface BenchmarkPlanOptions extends Record<string, unknown> {
  projectRoot?: string;
  project_root?: string;
  stateRoot?: string;
  state_root?: string;
  minScore?: number | string | null;
  min_score?: number | string | null;
  maxRegressionPoints?: number | string | null;
  max_regression_points?: number | string | null;
  writeEvidence?: boolean;
  write_evidence?: boolean;
  resultsPath?: string;
  results_path?: string;
  baselinePath?: string;
  baseline_path?: string;
}

export interface BenchmarkPlan {
  schema_version: string;
  schema: string;
  project_root: string;
  state_root: string;
  min_score: number;
  max_regression_points: number;
  fixture_counts: BenchmarkFixtureCounts;
  rubric: BenchmarkRubricItem[];
  fixtures: BenchmarkFixture[];
  writes_evidence: boolean;
  writes_yolo_package_root: boolean;
  publishes: boolean;
  reads_credentials: boolean;
  spawns_provider: boolean;
  executes_billable_provider: boolean;
  required_evidence: string[];
}

export interface BenchmarkScenarioInput {
  id?: string;
  suite?: string | null;
  title?: string;
  prompt?: string;
  expected_outputs?: string | string[] | null;
  required_metrics?: string | string[] | null;
  min_score?: number | string | null;
}

export interface BenchmarkEvidence extends Record<string, unknown> {
  fixture_id?: string;
  id?: string;
  status?: unknown;
  metrics?: Record<string, unknown> | null;
  evidence_refs?: unknown;
  evidence?: unknown;
  artifacts?: unknown;
}

export interface BenchmarkMetricResult {
  id: string;
  score: number | null;
  weight: number;
  min_score: number;
  passed: boolean;
}

export interface BenchmarkFinding extends Record<string, unknown> {
  code: string;
  message: string;
  fixture_id?: string | null;
  metric?: string;
  score?: number | null;
  min_score?: number;
  threshold?: number;
  evidence_status?: unknown;
  baseline_score?: number;
  current_score?: number;
  max_regression_points?: number;
}

export interface BenchmarkScenarioResult {
  fixture_id: string | null;
  suite: string | null;
  title: string;
  status: BenchmarkScenarioStatus;
  score: number;
  threshold: number;
  metrics: BenchmarkMetricResult[];
  blockers: BenchmarkFinding[];
  warnings: BenchmarkFinding[];
  evidence_refs: unknown[];
  expected_outputs: string[];
}

export interface BenchmarkBaselineScenario extends Record<string, unknown> {
  fixture_id?: string | null;
  id?: string | null;
  score?: number | string | null;
}

export interface BenchmarkBaseline extends Record<string, unknown> {
  overall_score?: number | string | null;
  score?: number | string | null;
  scenario_results?: BenchmarkBaselineScenario | BenchmarkBaselineScenario[] | null;
}

export interface BenchmarkRegressionResult {
  status: BenchmarkRegressionStatus;
  blockers: BenchmarkFinding[];
  warnings: BenchmarkFinding[];
}

export interface BenchmarkSuiteStats {
  [status: string]: number;
  count: number;
  pass: number;
  blocked: number;
  average_score: number;
}

export type BenchmarkSuiteSummary = Record<string, BenchmarkSuiteStats>;

export interface BenchmarkReport {
  schema_version: string;
  schema: string;
  status: BenchmarkScenarioStatus;
  code: string;
  summary: string;
  generated_at: string;
  project_root: string;
  state_root: string;
  overall_score: number;
  threshold: number;
  fixture_counts: BenchmarkFixtureCounts;
  suite_summary: BenchmarkSuiteSummary;
  scenario_results: BenchmarkScenarioResult[];
  blockers: BenchmarkFinding[];
  warnings: BenchmarkFinding[];
  regression: BenchmarkRegressionResult;
  public_readiness: {
    status: "pass" | "blocked";
    reason: string;
  };
  guarantees: {
    writes_yolo_package_root: boolean;
    provider_execution: boolean;
    billable_provider_execution: boolean;
    credential_access: boolean;
    published: boolean;
  };
  artifacts: string[];
  next_actions: string[];
  plan: BenchmarkPlan;
}

export interface BenchmarkRunInput extends BenchmarkPlanOptions {
  plan?: BenchmarkPlan;
  results?: unknown;
  result?: unknown;
  baseline?: BenchmarkBaseline | null;
}

export interface BenchmarkCliOptions {
  json: boolean;
  help: boolean;
  writeEvidence: boolean;
}

export interface BenchmarkCliIO {
  cwd?: string;
  stdout?: {
    write(chunk: string): unknown;
  };
}

export const YOLO_BENCHMARK_RUBRIC: BenchmarkRubricItem[] = [
  { id: "discovery_clarification", label: "Requirement clarification", weight: 12, min_score: 80 },
  { id: "business_goal", label: "Business goal and user scenario", weight: 12, min_score: 80 },
  { id: "task_atomicity", label: "Task atomicity", weight: 12, min_score: 80 },
  { id: "prd_executable", label: "Executable PRD quality", weight: 12, min_score: 80 },
  { id: "gate_quality", label: "Gate quality", weight: 12, min_score: 80 },
  { id: "ui_ux_spec", label: "UI/UX spec completeness", weight: 10, min_score: 80 },
  { id: "acceptance_classification", label: "Acceptance classification", weight: 10, min_score: 80 },
  { id: "evidence_completeness", label: "Evidence completeness", weight: 10, min_score: 80 },
  { id: "runner_compatibility", label: "Runner compatibility", weight: 5, min_score: 80 },
  { id: "nontechnical_clarity", label: "Non-technical clarity", weight: 5, min_score: 80 },
  { id: "no_root_pollution", label: "Package root isolation", weight: 5, min_score: 100 },
];

const VAGUE_METRICS: string[] = ["discovery_clarification", "business_goal", "task_atomicity", "prd_executable", "gate_quality", "nontechnical_clarity"];
const UI_METRICS: string[] = ["ui_ux_spec", "acceptance_classification", "evidence_completeness", "gate_quality", "nontechnical_clarity"];
const DOGFOOD_METRICS: string[] = ["runner_compatibility", "evidence_completeness", "gate_quality", "nontechnical_clarity", "no_root_pollution"];

export const DEFAULT_BENCHMARK_FIXTURES: BenchmarkFixture[] = [
  {
    id: "vague-idea-01",
    suite: "vague_requirement",
    title: "Inventory alert idea without thresholds",
    prompt: "I want inventory alerts, but I do not know the exact rules yet.",
    expected_outputs: ["clarifying questions", "target user", "success criteria", "no code execution"],
    required_metrics: VAGUE_METRICS,
  },
  {
    id: "vague-idea-02",
    suite: "vague_requirement",
    title: "Checkout improvement without user scenario",
    prompt: "Make checkout better.",
    expected_outputs: ["problem framing", "user journey", "constraints", "approval gate"],
    required_metrics: VAGUE_METRICS,
  },
  {
    id: "vague-idea-03",
    suite: "vague_requirement",
    title: "Dashboard request without measurable outcome",
    prompt: "Build a dashboard for operations.",
    expected_outputs: ["business goal", "metrics", "state matrix", "task graph draft"],
    required_metrics: VAGUE_METRICS,
  },
  {
    id: "vague-idea-04",
    suite: "vague_requirement",
    title: "Notification feature without channel rules",
    prompt: "Add notifications when something important happens.",
    expected_outputs: ["event taxonomy", "recipient rules", "failure modes", "PRD readiness verdict"],
    required_metrics: VAGUE_METRICS,
  },
  {
    id: "vague-idea-05",
    suite: "vague_requirement",
    title: "AI helper request without boundary",
    prompt: "Add an AI assistant to the product.",
    expected_outputs: ["scope boundary", "safety constraints", "evaluation criteria", "no provider execution"],
    required_metrics: VAGUE_METRICS,
  },
  {
    id: "vague-idea-06",
    suite: "vague_requirement",
    title: "Search improvement without corpus definition",
    prompt: "Search should be smarter.",
    expected_outputs: ["corpus definition", "ranking goal", "empty/error states", "gate plan"],
    required_metrics: VAGUE_METRICS,
  },
  {
    id: "vague-idea-07",
    suite: "vague_requirement",
    title: "Billing report request without accounting rules",
    prompt: "Generate billing reports for admins.",
    expected_outputs: ["actor", "data rules", "auditability", "acceptance criteria"],
    required_metrics: VAGUE_METRICS,
  },
  {
    id: "vague-idea-08",
    suite: "vague_requirement",
    title: "Mobile polish request without surface",
    prompt: "The mobile app should feel more polished.",
    expected_outputs: ["surface list", "state coverage", "visual acceptance", "human review boundary"],
    required_metrics: VAGUE_METRICS,
  },
  {
    id: "vague-idea-09",
    suite: "vague_requirement",
    title: "Permissions request without roles",
    prompt: "Add permissions to the app.",
    expected_outputs: ["role matrix", "deny cases", "migration risk", "spec traceability"],
    required_metrics: VAGUE_METRICS,
  },
  {
    id: "vague-idea-10",
    suite: "vague_requirement",
    title: "Performance request without baseline",
    prompt: "Make the app faster.",
    expected_outputs: ["baseline metric", "target threshold", "measurement gate", "task atomicity"],
    required_metrics: VAGUE_METRICS,
  },
  {
    id: "ui-acceptance-01",
    suite: "ui_acceptance",
    title: "Critical path failed",
    prompt: "Verify a page where the main checkout flow fails.",
    expected_outputs: ["P0 classification", "runtime evidence", "next fix action"],
    required_metrics: UI_METRICS,
  },
  {
    id: "ui-acceptance-02",
    suite: "ui_acceptance",
    title: "Missing screenshot evidence",
    prompt: "Verify a UI task with no visual evidence attached.",
    expected_outputs: ["P1 blocker", "screenshot requirement", "adapter evidence refs"],
    required_metrics: UI_METRICS,
  },
  {
    id: "ui-acceptance-03",
    suite: "ui_acceptance",
    title: "Polish note without blocker",
    prompt: "Verify a mostly working page with subjective visual polish notes.",
    expected_outputs: ["P2 or human review", "no infinite blocking", "plain next action"],
    required_metrics: UI_METRICS,
  },
  {
    id: "ui-acceptance-04",
    suite: "ui_acceptance",
    title: "State matrix incomplete",
    prompt: "Verify a component that only has happy-path UI evidence.",
    expected_outputs: ["state coverage gap", "P1 blocker", "required states listed"],
    required_metrics: UI_METRICS,
  },
  {
    id: "ui-acceptance-05",
    suite: "ui_acceptance",
    title: "Runtime errors in browser evidence",
    prompt: "Verify a UI implementation with console/runtime errors.",
    expected_outputs: ["P0 runtime error", "log evidence", "ship blocked"],
    required_metrics: UI_METRICS,
  },
  {
    id: "dogfood-01",
    suite: "real_project_dogfood",
    title: "Fresh package init to plan",
    prompt: "Run YOLO init then plan in an isolated external project.",
    expected_outputs: ["no package root writes", "plan evidence", "doctor status"],
    required_metrics: DOGFOOD_METRICS,
  },
  {
    id: "dogfood-02",
    suite: "real_project_dogfood",
    title: "Agent bridge dry-run doctor",
    prompt: "Install agent bridge in dry-run mode and validate Codex/Claude artifacts.",
    expected_outputs: ["no user writes", "command coverage", "workflow skills"],
    required_metrics: DOGFOOD_METRICS,
  },
  {
    id: "dogfood-03",
    suite: "real_project_dogfood",
    title: "Check gate in external project",
    prompt: "Run check against a strict PRD in an isolated external project.",
    expected_outputs: ["check report", "stateRoot isolation", "no provider execution"],
    required_metrics: DOGFOOD_METRICS,
  },
  {
    id: "dogfood-04",
    suite: "real_project_dogfood",
    title: "Review evidence without code edits",
    prompt: "Produce no-code review evidence for an external fixture project.",
    expected_outputs: ["review evidence", "no code edits", "plain-language blockers"],
    required_metrics: DOGFOOD_METRICS,
  },
  {
    id: "dogfood-05",
    suite: "real_project_dogfood",
    title: "Acceptance and learning handoff",
    prompt: "Run acceptance and ensure failure lessons stay bounded for the next prompt.",
    expected_outputs: ["acceptance report", "bounded learning", "handoff evidence"],
    required_metrics: DOGFOOD_METRICS,
  },
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === "") return [];
  return [value];
}

function nowIso(): string {
  return new Date().toISOString();
}

function rubricById(): Map<string, BenchmarkRubricItem> {
  return new Map(YOLO_BENCHMARK_RUBRIC.map((item) => [item.id, item]));
}

function normalizeScore(value: unknown): number | null {
  if (value === true || value === "pass" || value === "passed") return 100;
  if (value === false || value === "fail" || value === "blocked" || value === "error") return 0;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, numeric));
}

function fixtureCounts(fixtures: BenchmarkFixture[] = DEFAULT_BENCHMARK_FIXTURES): BenchmarkFixtureCounts {
  return fixtures.reduce<BenchmarkFixtureCounts>((counts, fixture) => {
    counts[fixture.suite] = (counts[fixture.suite] || 0) + 1;
    counts.total = (counts.total || 0) + 1;
    return counts;
  }, { vague_requirement: 0, ui_acceptance: 0, real_project_dogfood: 0, total: 0 });
}

function normalizeResults(results: unknown = {}): Map<unknown, BenchmarkEvidence> {
  const resultRecord = results as Record<string, unknown> | null | undefined;
  const scenarios = resultRecord?.scenarios;
  const raw = Array.isArray(scenarios) ? scenarios : results;
  if (Array.isArray(raw)) {
    return new Map<unknown, BenchmarkEvidence>(raw.map((item): [unknown, BenchmarkEvidence] => {
      const itemRecord = item as Record<string, unknown>;
      return [itemRecord.fixture_id || itemRecord.id, item as BenchmarkEvidence];
    }));
  }
  if (!raw || typeof raw !== "object") return new Map<unknown, BenchmarkEvidence>();
  return new Map<unknown, BenchmarkEvidence>(Object.entries(raw).map(([id, value]): [unknown, BenchmarkEvidence] => [
    id,
    Object.assign(Object(), { fixture_id: id }, value as Record<string, unknown>) as BenchmarkEvidence,
  ]));
}

function readJsonMaybe<T>(filePath: string | null | undefined): T | null {
  if (!filePath) return null;
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) return null;
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function metricEvidence(evidence: BenchmarkEvidence = {}, metricId: string): unknown {
  if (evidence.metrics && Object.hasOwn(evidence.metrics, metricId)) {
    const metrics = evidence.metrics as Record<string, unknown>;
    return metrics[metricId];
  }
  if (Object.hasOwn(evidence, metricId)) return evidence[metricId];
  return null;
}

export function listBenchmarkFixtures(options: BenchmarkPlanOptions = {}): BenchmarkFixture[] {
  const suite = clean(options.suite);
  const fixtures = DEFAULT_BENCHMARK_FIXTURES.map(clone);
  return suite ? fixtures.filter((fixture) => fixture.suite === suite) : fixtures;
}

export function buildYoloBenchmarkPlan(options: BenchmarkPlanOptions = {}): BenchmarkPlan {
  const projectRoot = resolve(options.projectRoot || options.project_root || process.cwd());
  const stateRoot = resolve(options.stateRoot || options.state_root || join(projectRoot, ".yolo"));
  const minScore = Number(options.minScore || options.min_score || 80);
  const maxRegressionPoints = Number(options.maxRegressionPoints || options.max_regression_points || 3);
  const fixtures = listBenchmarkFixtures();
  return {
    schema_version: YOLO_BENCHMARK_SCHEMA_VERSION,
    schema: "yolo.eval.benchmark_plan.v1",
    project_root: projectRoot,
    state_root: stateRoot,
    min_score: minScore,
    max_regression_points: maxRegressionPoints,
    fixture_counts: fixtureCounts(fixtures),
    rubric: clone(YOLO_BENCHMARK_RUBRIC),
    fixtures,
    writes_evidence: options.writeEvidence !== false && options.write_evidence !== false,
    writes_yolo_package_root: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    required_evidence: [
      "10 vague requirement fixture results",
      "5 UI acceptance fixture results",
      "5 real-project dogfood scenario results",
      "metric scores for the active rubric",
      "regression comparison when a baseline is supplied",
    ],
  };
}

export function scoreBenchmarkScenario(
  scenario: BenchmarkScenarioInput = {},
  evidence: BenchmarkEvidence = {},
  options: BenchmarkPlanOptions = {},
): BenchmarkScenarioResult {
  const threshold = Number(options.minScore || options.min_score || scenario.min_score || 80);
  const rubric = rubricById();
  const requiredMetrics = asArray(scenario.required_metrics);
  const metricResults: BenchmarkMetricResult[] = [];
  const blockers: BenchmarkFinding[] = [];
  const warnings: BenchmarkFinding[] = [];
  let weightedTotal = 0;
  let weightTotal = 0;

  if (!evidence || Object.keys(evidence).length === 0) {
    blockers.push({
      code: "BENCHMARK_RESULT_MISSING",
      message: "Benchmark fixture has no result evidence.",
      fixture_id: scenario.id || null,
    });
  }

  for (const metricId of requiredMetrics) {
    const rubricItem = rubric.get(metricId) || { id: metricId, weight: 1, min_score: 80 };
    const score = normalizeScore(metricEvidence(evidence, metricId));
    const metric = {
      id: metricId,
      score,
      weight: Number(rubricItem.weight || 1),
      min_score: Number(rubricItem.min_score || 80),
      passed: score != null && score >= Number(rubricItem.min_score || 80),
    };
    metricResults.push(metric);
    weightTotal += metric.weight;
    weightedTotal += (score ?? 0) * metric.weight;
    if (score == null) {
      blockers.push({
        code: "BENCHMARK_METRIC_MISSING",
        message: `Benchmark result is missing metric ${metricId}.`,
        fixture_id: scenario.id || null,
        metric: metricId,
      });
    } else if (!metric.passed) {
      warnings.push({
        code: "BENCHMARK_METRIC_LOW",
        message: `Benchmark metric ${metricId} scored below its minimum.`,
        fixture_id: scenario.id || null,
        metric: metricId,
        score,
        min_score: metric.min_score,
      });
    }
  }

  const score = weightTotal > 0 ? Number((weightedTotal / weightTotal).toFixed(2)) : 0;
  if (score < threshold) {
    blockers.push({
      code: "BENCHMARK_SCENARIO_BELOW_THRESHOLD",
      message: "Benchmark scenario score is below the public readiness threshold.",
      fixture_id: scenario.id || null,
      score,
      threshold,
    });
  }
  if (["blocked", "error", "fail", "failed"].includes(clean(evidence.status).toLowerCase())) {
    blockers.push({
      code: "BENCHMARK_EVIDENCE_BLOCKED",
      message: "Benchmark evidence reports a blocked or failed scenario.",
      fixture_id: scenario.id || null,
      evidence_status: evidence.status,
    });
  }

  return {
    fixture_id: scenario.id || null,
    suite: scenario.suite || null,
    title: scenario.title || "",
    status: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "pass",
    score,
    threshold,
    metrics: metricResults,
    blockers,
    warnings,
    evidence_refs: asArray(evidence.evidence_refs || evidence.evidence || evidence.artifacts),
    expected_outputs: asArray(scenario.expected_outputs),
  };
}

function summarizeSuites(results: BenchmarkScenarioResult[] = []): BenchmarkSuiteSummary {
  const suites: BenchmarkSuiteSummary = {};
  for (const result of results) {
    const suite = result.suite || "unknown";
    const current = suites[suite] || { count: 0, pass: 0, warning: 0, blocked: 0, average_score: 0 };
    current.count += 1;
    current[result.status] = (current[result.status] || 0) + 1;
    current.average_score += result.score;
    suites[suite] = current;
  }
  for (const suite of Object.keys(suites)) {
    suites[suite].average_score = suites[suite].count > 0
      ? Number((suites[suite].average_score / suites[suite].count).toFixed(2))
      : 0;
  }
  return suites;
}

function inspectRegression({
  currentScore,
  scenarioResults,
  baseline,
  maxRegressionPoints,
}: {
  currentScore: number;
  scenarioResults: BenchmarkScenarioResult[];
  baseline: BenchmarkBaseline | null;
  maxRegressionPoints: number;
}): BenchmarkRegressionResult {
  if (!baseline) return { status: "not_applicable", blockers: [], warnings: [] };
  const blockers: BenchmarkFinding[] = [];
  const warnings: BenchmarkFinding[] = [];
  const baselineScore = Number(baseline.overall_score ?? baseline.score);
  if (Number.isFinite(baselineScore) && baselineScore - currentScore > maxRegressionPoints) {
    blockers.push({
      code: "BENCHMARK_OVERALL_REGRESSION",
      message: "Overall benchmark score regressed beyond the allowed threshold.",
      baseline_score: baselineScore,
      current_score: currentScore,
      max_regression_points: maxRegressionPoints,
    });
  }
  const baselineScenarios = new Map<unknown, BenchmarkBaselineScenario>(
    asArray(baseline.scenario_results).map((item): [unknown, BenchmarkBaselineScenario] => [item.fixture_id || item.id, item]),
  );
  for (const result of scenarioResults) {
    const previous = baselineScenarios.get(result.fixture_id);
    if (!previous) continue;
    const previousScore = Number(previous.score);
    if (Number.isFinite(previousScore) && previousScore - result.score > maxRegressionPoints) {
      warnings.push({
        code: "BENCHMARK_SCENARIO_REGRESSION",
        message: "Scenario benchmark score regressed beyond the allowed threshold.",
        fixture_id: result.fixture_id,
        baseline_score: previousScore,
        current_score: result.score,
        max_regression_points: maxRegressionPoints,
      });
    }
  }
  return {
    status: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "pass",
    blockers,
    warnings,
  };
}

export function runYoloBenchmark(input: BenchmarkRunInput = {}, options: BenchmarkPlanOptions = {}): BenchmarkReport {
  const plan = input.plan || buildYoloBenchmarkPlan({ ...options, ...input });
  const resultInput = input.results || input.result || readJsonMaybe(input.resultsPath || input.results_path || options.resultsPath || options.results_path);
  const baseline = input.baseline || readJsonMaybe<BenchmarkBaseline>(input.baselinePath || input.baseline_path || options.baselinePath || options.baseline_path);
  const resultsById = normalizeResults(resultInput);
  const minScore = Number(plan.min_score || options.minScore || options.min_score || 80);
  const scenarioResults = plan.fixtures.map((fixture) => scoreBenchmarkScenario(fixture, resultsById.get(fixture.id) || {}, { minScore }));
  const overallScore = scenarioResults.length > 0
    ? Number((scenarioResults.reduce((sum, result) => sum + result.score, 0) / scenarioResults.length).toFixed(2))
    : 0;
  const suite_summary = summarizeSuites(scenarioResults);
  const regression = inspectRegression({
    currentScore: overallScore,
    scenarioResults,
    baseline,
    maxRegressionPoints: Number(plan.max_regression_points || 3),
  });
  const blockers = [
    ...scenarioResults.flatMap((result) => result.blockers),
    ...regression.blockers,
  ];
  const warnings = [
    ...scenarioResults.flatMap((result) => result.warnings),
    ...regression.warnings,
  ];
  const status = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "pass";
  const report: BenchmarkReport = {
    schema_version: YOLO_BENCHMARK_SCHEMA_VERSION,
    schema: "yolo.eval.benchmark_report.v1",
    status,
    code: status === "pass" ? "BENCHMARK_PASS" : status === "warning" ? "BENCHMARK_WARNING" : "BENCHMARK_BLOCKED",
    summary: status === "pass"
      ? "Benchmark passed."
      : status === "warning"
        ? "Benchmark passed the release threshold with warnings."
        : "Benchmark is blocked by missing, failed, or low-scoring evidence.",
    generated_at: nowIso(),
    project_root: plan.project_root,
    state_root: plan.state_root,
    overall_score: overallScore,
    threshold: minScore,
    fixture_counts: plan.fixture_counts,
    suite_summary,
    scenario_results: scenarioResults,
    blockers,
    warnings,
    regression,
    public_readiness: {
      status: status === "pass" ? "pass" : "blocked",
      reason: status === "pass"
        ? "Benchmark score and regression checks meet public readiness threshold."
        : "Public readiness is blocked until benchmark evidence passes the threshold.",
    },
    guarantees: {
      writes_yolo_package_root: false,
      provider_execution: false,
      billable_provider_execution: false,
      credential_access: false,
      published: false,
    },
    artifacts: [],
    next_actions: status === "pass"
      ? ["Keep this benchmark report with release evidence before public readiness claims."]
      : ["Provide complete benchmark result evidence, fix low scores, then rerun /yolo-eval."],
    plan,
  };

  if (input.writeEvidence !== false && input.write_evidence !== false && options.writeEvidence !== false && options.write_evidence !== false) {
    const reportPath = join(plan.state_root, "state/reports/eval/benchmark-report.json");
    writeJsonArtifact(reportPath, report);
    appendStateEvent(join(plan.state_root, "state"), "eval.benchmark.report", {
      source: "yolo-eval",
      status: report.status,
      overall_score: report.overall_score,
      threshold: report.threshold,
      blocker_count: report.blockers.length,
      artifact_path: reportPath,
    });
    report.artifacts.push(reportPath);
  }
  return report;
}

export const runBenchmark = runYoloBenchmark;

export function formatYoloBenchmarkText(report: Partial<BenchmarkReport> = {}): string {
  const lines = [`[yolo eval] ${report.status}: ${report.summary}`];
  lines.push(`score: ${report.overall_score}/100 threshold=${report.threshold}`);
  if (report.fixture_counts) {
    lines.push(`fixtures: vague=${report.fixture_counts.vague_requirement} ui=${report.fixture_counts.ui_acceptance} dogfood=${report.fixture_counts.real_project_dogfood}`);
  }
  if (report.regression?.status && report.regression.status !== "not_applicable") {
    lines.push(`regression: ${report.regression.status}`);
  }
  for (const blocker of asArray(report.blockers).slice(0, 12)) {
    lines.push(`- ${blocker.code}${blocker.fixture_id ? ` fixture=${blocker.fixture_id}` : ""}: ${blocker.message}`);
  }
  if (report.artifacts?.length) lines.push(`artifacts: ${report.artifacts.join(", ")}`);
  if (report.next_actions?.length) {
    lines.push("next:");
    for (const action of report.next_actions) lines.push(`  - ${action}`);
  }
  return lines.join("\n");
}

export function parseYoloBenchmarkArgs(argv: string[] = []): { input: BenchmarkRunInput; options: BenchmarkCliOptions } {
  const input: BenchmarkRunInput = {};
  const options: BenchmarkCliOptions = { json: false, help: false, writeEvidence: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      if (arg.includes("=")) return { value: arg.split("=").slice(1).join("="), consumed: 0 };
      return { value: argv[index + 1], consumed: 1 };
    };
    if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--no-write") options.writeEvidence = false;
    else if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const read = readValue();
      input.projectRoot = read.value;
      index += read.consumed;
    } else if (arg === "--state-root" || arg.startsWith("--state-root=")) {
      const read = readValue();
      input.stateRoot = read.value;
      index += read.consumed;
    } else if (arg === "--results" || arg.startsWith("--results=")) {
      const read = readValue();
      input.resultsPath = read.value;
      index += read.consumed;
    } else if (arg === "--baseline" || arg.startsWith("--baseline=")) {
      const read = readValue();
      input.baselinePath = read.value;
      index += read.consumed;
    } else if (arg === "--min-score" || arg.startsWith("--min-score=")) {
      const read = readValue();
      input.minScore = Number(read.value);
      index += read.consumed;
    } else if (arg === "--max-regression" || arg.startsWith("--max-regression=")) {
      const read = readValue();
      input.maxRegressionPoints = Number(read.value);
      index += read.consumed;
    }
  }
  return { input, options };
}

export async function runYoloBenchmarkCli(argv: string[] = [], io: BenchmarkCliIO = {}): Promise<number> {
  const stdout = io.stdout || process.stdout;
  const { input, options } = parseYoloBenchmarkArgs(argv);
  if (options.help) {
    stdout.write("用法: yolo eval [--results <benchmark-results.json>] [--baseline <report.json>] [--min-score 80] [--no-write] [--json]\n");
    return 0;
  }
  const projectRoot = resolve(input.projectRoot || io.cwd || process.cwd());
  const report = runYoloBenchmark({
    ...input,
    projectRoot,
    writeEvidence: options.writeEvidence,
  });
  if (options.json) stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else stdout.write(`${formatYoloBenchmarkText(report)}\n`);
  return report.status === "pass" ? 0 : report.status === "warning" ? 2 : 1;
}

if (isMain) {
  runYoloBenchmarkCli().then((code) => {
    process.exitCode = code;
  });
}
