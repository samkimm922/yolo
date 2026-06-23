#!/usr/bin/env node
// Quality score (v1): a deterministic scalar Q in [0,1] over a fixed robustness battery.
// Q measures how reliably `yolo check` handles good and malformed PRDs — the user-facing
// failure modes "卡死" (must reject structurally, not crash/pass) and "无法开发"
// (must not over-block a legitimate PRD).
//
// Modes:
//   (default)   compute Q, print breakdown, write the baseline file.
//   --check     compute Q and FAIL (exit 1) if Q < committed baseline (the ratchet gate).
//
// The battery is fixed so Q is comparable across commits. A code fix can only raise Q
// (or hold it). Expanding the battery is a separate, deliberate step that may lower Q to
// expose new territory.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { config } from "../src/lib/config.js";
import { runYoloCheckCli } from "../src/runtime/gates/check-report.js";
import { buildAcceptanceReport } from "../src/runtime/acceptance/report.js";
import { verifyArtifactIntegrity } from "../src/runtime/evidence/artifact-integrity.js";
import { inspectStoryAtomicityText } from "../src/demand/story-atomicity.js";
import { evaluatePostConditions } from "../src/prd/contract.js";
import { CHECK_BATTERY, type CheckBatteryCase } from "./quality/check-battery.js";
import { ACCEPTANCE_BATTERY, type AcceptanceBatteryCase } from "./quality/acceptance-battery.js";
import { ATOMICITY_BATTERY, type AtomicityBatteryCase } from "./quality/atomicity-battery.js";
import { RUNNER_BATTERY, type RunnerBatteryCase } from "./quality/runner-battery.js";
import { runProviderBattery } from "./quality/provider-battery.js";
import { runConfigBattery } from "./quality/config-battery.js";
import { runParallelBattery } from "./quality/parallel-battery.js";
import { runReleaseBattery } from "./quality/release-battery.js";
import { runEvidenceBattery } from "./quality/evidence-battery.js";
import { runShipBattery } from "./quality/ship-battery.js";
import { runConditionBattery } from "./quality/condition-battery.js";
import { runReviewBattery } from "./quality/review-battery.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "quality", "quality-baseline.json");

type CaseResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function setupProject(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "yolo-quality-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "quality@yolo.test"]);
  git(root, ["config", "user.name", "quality"]);
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf8");
  }
  writeFileSync(join(root, "README.md"), "# quality fixture\n", "utf8");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-m", "baseline", "--no-gpg-sign"]);
  return root;
}

function runCheckCase(testCase: CheckBatteryCase): CaseResult {
  const root = setupProject(testCase.files);
  if (testCase.kind === "artifact_integrity_escape") {
    const outsideRoot = mkdtempSync(join(tmpdir(), "yolo-quality-outside-"));
    try {
      const outsidePath = join(outsideRoot, "secret.txt");
      writeFileSync(outsidePath, "outside root\n", "utf8");
      const report = verifyArtifactIntegrity([outsidePath], { rootDir: root }) as { status?: string; artifacts?: Array<Record<string, unknown>> };
      const escaped = report.artifacts?.some((artifact) => artifact.issue === "path_escape");
      const status = report.status === "fail" && escaped ? "blocked" : String(report.status || "unknown");
      const correct = testCase.expect === "blocked" ? status === "blocked" : status === "pass";
      return { id: testCase.id, category: testCase.category, expect: testCase.expect, actualExit: correct ? 0 : 1, actualStatus: status, correct };
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
  try {
    const prdPath = join(root, "prd.json");
    writeFileSync(prdPath, JSON.stringify(testCase.prd, null, 2), "utf8");
    let stdout = "";
    let stderr = "";
    const exitCode = runYoloCheckCli([prdPath, "--json", "--no-write"], {
      cwd: root,
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: (chunk: string) => { stderr += chunk; return true; } },
    });
    let status = "";
    try {
      status = String(JSON.parse(stdout).status || "");
    } catch {
      status = stderr.includes("Error") ? "crash" : "unparsable";
    }
    const passed = exitCode === 0 && status === "pass";
    const blocked = exitCode !== 0 && status === "blocked";
    const correct = testCase.expect === "pass" ? passed : blocked;
    return { id: testCase.id, category: testCase.category, expect: testCase.expect, actualExit: exitCode, actualStatus: status, correct };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runAcceptanceCase(testCase: AcceptanceBatteryCase): CaseResult {
  const root = setupProject(testCase.files);
  try {
    const input: Record<string, unknown> = {
      prd: testCase.prd,
      reviewReport: testCase.reviewReport,
      projectRoot: root,
      stateRoot: join(root, ".yolo"),
    };
    if (testCase.runReport !== undefined) input.runReport = testCase.runReport;
    const report = buildAcceptanceReport(input) as { status?: string };
    const status = String(report.status || "");
    const correct = testCase.expect === "pass" ? status === "pass" : status === "blocked";
    return { id: testCase.id, category: testCase.category, expect: testCase.expect, actualExit: status === "pass" ? 0 : 1, actualStatus: status, correct };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runAtomicityCase(testCase: AtomicityBatteryCase): CaseResult {
  const report = inspectStoryAtomicityText(testCase.text, {}) as { status?: string };
  const status = String(report.status || "");
  // "warn" (capability noun) still counts as a single/atomic story, not multi.
  const detected = status === "blocked" ? "multi" : "atomic";
  const correct = detected === testCase.expect;
  return { id: testCase.id, category: "atomic_task_success", expect: testCase.expect, actualExit: correct ? 0 : 1, actualStatus: detected, correct };
}

function runRunnerCase(testCase: RunnerBatteryCase): CaseResult {
  const root = setupProject(testCase.baseFiles);
  const originalPath = process.env.PATH;
  const originalBuildTest = config.build?.test;
  try {
    for (const [rel, contents] of Object.entries(testCase.editFiles || {})) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, contents, "utf8");
    }
    for (const rel of testCase.deleteFiles || []) {
      const abs = join(root, rel);
      try { unlinkSync(abs); } catch { /* already absent */ }
    }
    for (const rel of testCase.executableFiles || []) {
      chmodSync(join(root, rel), 0o755);
    }
    if (testCase.envPathPrepend?.length) {
      process.env.PATH = [
        ...testCase.envPathPrepend.map((rel) => join(root, rel)),
        originalPath || "",
      ].filter(Boolean).join(delimiter);
    }
    if (Object.hasOwn(testCase, "buildTestCommand")) {
      config.build ??= {};
      config.build.test = testCase.buildTestCommand;
    }
    const report = evaluatePostConditions(testCase.task, {}, { cwd: root, root }) as { allPass?: boolean };
    const detected = report.allPass ? "done" : "not_done";
    const correct = detected === testCase.expect;
    return { id: testCase.id, category: "runner_outcome_accuracy", expect: testCase.expect, actualExit: correct ? 0 : 1, actualStatus: detected, correct };
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (Object.hasOwn(testCase, "buildTestCommand")) {
      config.build ??= {};
      config.build.test = originalBuildTest;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

async function computeQuality() {
  const providerResults = await runProviderBattery();
  const shipResults = await runShipBattery();
  const results = [
    ...CHECK_BATTERY.map(runCheckCase),
    ...ACCEPTANCE_BATTERY.map(runAcceptanceCase),
    ...ATOMICITY_BATTERY.map(runAtomicityCase),
    ...RUNNER_BATTERY.map(runRunnerCase),
    ...providerResults,
    ...runConfigBattery(),
    ...runParallelBattery(),
    ...runReleaseBattery(),
    ...runEvidenceBattery(),
    ...shipResults,
    ...runConditionBattery(),
    ...runReviewBattery(),
  ];
  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  const q = total > 0 ? correct / total : 0;

  const byCategory: Record<string, { total: number; correct: number }> = {};
  for (const r of results) {
    byCategory[r.category] ??= { total: 0, correct: 0 };
    byCategory[r.category].total += 1;
    if (r.correct) byCategory[r.category].correct += 1;
  }

  return { q, total, correct, results, byCategory };
}

async function main() {
  const checkMode = process.argv.includes("--check");
  const updateBaseline = process.argv.includes("--update-baseline");
  const { q, total, correct, results, byCategory } = await computeQuality();

  console.log(`[quality-score] battery: ${correct}/${total} correct`);
  for (const [cat, { total: t, correct: c }] of Object.entries(byCategory)) {
    console.log(`  ${cat}: ${c}/${t}`);
  }
  for (const r of results.filter((r) => !r.correct)) {
    console.log(`  MISS ${r.id} [${r.category}] expect=${r.expect} got exit=${r.actualExit} status=${r.actualStatus}`);
  }
  console.log(`[quality-score] Q = ${q.toFixed(4)}`);

  if (checkMode) {
    let baseline = 0;
    try {
      baseline = Number(JSON.parse(readFileSync(BASELINE_PATH, "utf8")).q) || 0;
    } catch {
      console.error("[quality-score] no baseline found; run with --update-baseline to write one.");
      process.exit(1);
    }
    console.log(`[quality-score] baseline Q = ${baseline.toFixed(4)}`);
    // Tolerate floating-point noise; fail only on a real regression.
    if (q + 1e-9 < baseline) {
      console.error(`[quality-score] REGRESSION: Q ${q.toFixed(4)} < baseline ${baseline.toFixed(4)}`);
      process.exit(1);
    }
    console.log("[quality-score] ratchet OK (Q did not regress).");
    return;
  }

  // Default is read-only so running the score never dirties the committed baseline
  // (a tool side effect, not a result). Writing the ratchet baseline is an explicit,
  // deliberate act gated behind --update-baseline.
  if (!updateBaseline) {
    console.log("[quality-score] read-only (pass --update-baseline to write the ratchet baseline).");
    return;
  }

  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ q, total, correct, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  console.log(`[quality-score] wrote baseline ${BASELINE_PATH}`);
}

await main();
