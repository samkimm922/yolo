import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  buildYoloBenchmarkPlan,
  formatYoloBenchmarkText,
  listBenchmarkFixtures,
  runYoloBenchmark,
  runYoloBenchmarkCli,
  scoreBenchmarkScenario,
} from "../src/eval/benchmark.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");

function passingResults(score = 92) {
  return Object.fromEntries(listBenchmarkFixtures().map((fixture) => [
    fixture.id,
    {
      status: "pass",
      metrics: Object.fromEntries(fixture.required_metrics.map((metric) => [metric, metric === "no_root_pollution" ? true : score])),
      evidence_refs: [`state/eval/${fixture.id}.json`],
    },
  ]));
}

describe("YOLO eval benchmark", () => {
  test("plan exposes fixed fixture counts and rubric", () => {
    const plan = buildYoloBenchmarkPlan({ projectRoot: "/tmp/project", writeEvidence: false });

    assert.equal(plan.schema, "yolo.eval.benchmark_plan.v1");
    assert.equal(plan.fixture_counts.vague_requirement, 10);
    assert.equal(plan.fixture_counts.ui_acceptance, 5);
    assert.equal(plan.fixture_counts.real_project_dogfood, 5);
    assert.equal(plan.fixture_counts.total, 20);
    assert.ok(plan.rubric.some((item) => item.id === "prd_executable"));
    assert.equal(plan.writes_yolo_package_root, false);
    assert.equal(plan.executes_billable_provider, false);
  });

  test("missing benchmark results fail closed and write evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-eval-missing-"));
    const report = runYoloBenchmark({ projectRoot: root });

    assert.equal(report.status, "blocked");
    assert.equal(report.public_readiness.status, "blocked");
    assert.equal(report.blockers.some((blocker) => blocker.code === "BENCHMARK_RESULT_MISSING"), true);
    assert.equal(report.guarantees.provider_execution, false);
    assert.equal(existsSync(join(root, ".yolo/state/reports/eval/benchmark-report.json")), true);
    assert.match(readFileSync(join(root, ".yolo/state/events.jsonl"), "utf8"), /eval\.benchmark\.report/);
    assert.match(formatYoloBenchmarkText(report), /\[yolo eval\] blocked/);
  });

  test("complete high-scoring results pass and low scores block public readiness", () => {
    const pass = runYoloBenchmark({
      projectRoot: mkdtempSync(join(tmpdir(), "yolo-eval-pass-")),
      results: passingResults(95),
      writeEvidence: false,
    });
    assert.equal(pass.status, "pass");
    assert.equal(pass.public_readiness.status, "pass");
    assert.ok(pass.overall_score >= 95);

    const blocked = runYoloBenchmark({
      projectRoot: mkdtempSync(join(tmpdir(), "yolo-eval-low-")),
      results: passingResults(70),
      writeEvidence: false,
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.public_readiness.status, "blocked");
    assert.equal(blocked.blockers.some((blocker) => blocker.code === "BENCHMARK_SCENARIO_BELOW_THRESHOLD"), true);
  });

  test("regression threshold blocks public readiness", () => {
    const baseline = {
      overall_score: 96,
      scenario_results: listBenchmarkFixtures().map((fixture) => ({ fixture_id: fixture.id, score: 96 })),
    };
    const report = runYoloBenchmark({
      projectRoot: mkdtempSync(join(tmpdir(), "yolo-eval-regression-")),
      results: passingResults(90),
      baseline,
      maxRegressionPoints: 3,
      writeEvidence: false,
    });

    assert.equal(report.status, "blocked");
    assert.equal(report.regression.status, "blocked");
    assert.equal(report.blockers.some((blocker) => blocker.code === "BENCHMARK_OVERALL_REGRESSION"), true);
  });

  test("scoreBenchmarkScenario normalizes boolean metric evidence", () => {
    const fixture = listBenchmarkFixtures()[0];
    const result = scoreBenchmarkScenario(fixture, {
      metrics: Object.fromEntries(fixture.required_metrics.map((metric) => [metric, true])),
    });

    assert.equal(result.status, "pass");
    assert.equal(result.score, 100);
  });

  test("yolo eval CLI consumes result files", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-eval-cli-"));
    const resultsPath = join(root, "results.json");
    writeFileSync(resultsPath, `${JSON.stringify(passingResults(93), null, 2)}\n`, "utf8");

    const result = spawnSync(process.execPath, [
      join(YOLO_DIR, "dist/bin/yolo.js"),
      "eval",
      `--cwd=${root}`,
      `--results=${resultsPath}`,
      "--json",
      "--no-write",
    ], { cwd: YOLO_DIR, encoding: "utf8" });

    assert.equal(result.stderr, "");
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "pass");
    assert.equal(payload.fixture_counts.total, 20);

    const help = execFileSync(process.execPath, [join(YOLO_DIR, "dist/bin/yolo.js"), "eval", "--help"], { cwd: YOLO_DIR, encoding: "utf8" });
    assert.match(help, /yolo eval/);
  });

  test("yolo eval CLI exits 2 for benchmark warnings", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-eval-cli-warning-"));
    const resultsPath = join(root, "results.json");
    const baselinePath = join(root, "baseline.json");
    let stdout = "";
    writeFileSync(resultsPath, JSON.stringify(passingResults(90)), "utf8");
    writeFileSync(baselinePath, JSON.stringify({
      overall_score: 92,
      scenario_results: listBenchmarkFixtures().map((fixture) => ({ fixture_id: fixture.id, score: 96 })),
    }), "utf8");

    const exitCode = await runYoloBenchmarkCli([
      "--results", resultsPath,
      "--baseline", baselinePath,
      "--max-regression", "3",
      "--cwd", root,
      "--json",
      "--no-write",
    ], {
      cwd: root,
      stdout: { write: (chunk) => { stdout += chunk; } },
    });
    const report = JSON.parse(stdout);

    assert.equal(exitCode, 2);
    assert.equal(report.status, "warning");
    assert.equal(report.code, "BENCHMARK_WARNING");
  });
});
