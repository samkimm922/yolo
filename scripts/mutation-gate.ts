#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type TestSpec = {
  label: string;
  files: string[];
  namePattern?: string;
  timeoutMs?: number;
};

type Mutation = {
  id: string;
  file: string;
  line: number;
  operator: string;
  description: string;
  original: string;
  replacement: string;
  tests: TestSpec[];
  expectedDetection: string;
};

type CommandResult = {
  label: string;
  command: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THRESHOLD = 1;

const tests = {
  targetUntracked: {
    label: "target_file_modified untracked target",
    files: ["__tests__/file-check-scope.test.ts"],
    namePattern: "falls back to git untracked files",
    timeoutMs: 30_000,
  },
  targetSuffix: {
    label: "target_file_modified suffix match",
    files: ["__tests__/file-check-scope.test.ts"],
    namePattern: "matches runner-provided changedFiles by target suffix",
    timeoutMs: 30_000,
  },
  expansionCycle: {
    label: "task dependency expansion cycle/no-root",
    files: ["__tests__/task-loop-expansion.test.ts"],
    namePattern: "blocks circular task dependencies|blocks fully connected dependency graphs",
    timeoutMs: 30_000,
  },
  checkReportCycle: {
    label: "check report dependency preflight",
    files: ["__tests__/check-report.test.ts"],
    namePattern: "YB-008 blocks circular task dependencies|YB-008 blocks fully connected dependency graphs",
    timeoutMs: 60_000,
  },
  demandDedup: {
    label: "demand runtime task dedup",
    files: ["__tests__/demand-runtime.test.ts"],
    namePattern: "deduplicates same-scenario tasks",
    timeoutMs: 60_000,
  },
  demandDependencies: {
    label: "demand runtime dependency/read-first context",
    files: ["__tests__/demand-runtime.test.ts"],
    namePattern: "approved demand compiles scenario surfaces without self-blocking",
    timeoutMs: 60_000,
  },
  demandLedgerReadiness: {
    label: "demand readiness evidence ledger",
    files: ["__tests__/demand-gate-ledger-evidence.test.ts"],
    namePattern: "R6 in deep mode",
    timeoutMs: 30_000,
  },
  demandLedgerQuality: {
    label: "demand quality evidence ledger",
    files: ["__tests__/demand-gate-ledger-evidence.test.ts"],
    namePattern: "without stateDir, evidence_grounded is false|with broken ledger chain, evidence_grounded is false",
    timeoutMs: 30_000,
  },
  demandQualityThreshold: {
    label: "demand quality thresholds",
    files: ["__tests__/demand-gate-thresholds.test.ts"],
    namePattern: "empty demand session is blocked|block score and pass score",
    timeoutMs: 30_000,
  },
  acceptanceDefaultRunReport: {
    label: "acceptance default real run report",
    files: ["__tests__/acceptance-report.test.ts"],
    namePattern: "default acceptance prefers latest state run report",
    timeoutMs: 30_000,
  },
  repeatedFailureFuse: {
    label: "run lifecycle repeated failure fuse",
    files: ["__tests__/run-lifecycle-orchestrator.test.ts"],
    namePattern: "skips retry and review after repeated failure fuse",
    timeoutMs: 30_000,
  },
  lifecycleSnapshotBlocked: {
    label: "blocked lifecycle stage does not bless source drift",
    files: ["__tests__/lifecycle-source-snapshot.test.ts"],
    namePattern: "blocked write-capable lifecycle stage does not bless source drift",
    timeoutMs: 30_000,
  },
  lifecycleSnapshotSuccess: {
    label: "successful lifecycle stage refreshes source snapshot",
    files: ["__tests__/lifecycle-source-snapshot.test.ts"],
    namePattern: "successful write-capable lifecycle stage refreshes post-run source snapshot",
    timeoutMs: 30_000,
  },
  sourceSnapshotYoloExclusion: {
    label: "source snapshot excludes yolo state",
    files: ["__tests__/lifecycle-source-snapshot.test.ts"],
    namePattern: "editing only .yolo state does not trigger drift",
    timeoutMs: 30_000,
  },
} satisfies Record<string, TestSpec>;

const mutations: Mutation[] = [
  {
    id: "M01-contract-untracked-target",
    file: "src/prd/contract.ts",
    line: 186,
    operator: "delete untracked-file source",
    description: "target_file_modified must include newly created untracked files.",
    original: "          `${r.out}\\n${untracked.out}`",
    replacement: "          `${r.out}\\n`",
    tests: [tests.targetUntracked],
    expectedDetection: "Untracked target files must make target_file_modified pass.",
  },
  {
    id: "M02-contract-suffix-match",
    file: "src/prd/contract.ts",
    line: 192,
    operator: "suffix/exact OR -> exact-only",
    description: "target_file_modified must match runner-provided changed paths by exact or suffix.",
    original: "const found = modified.some((f) => f === targetFile || f.endsWith(targetFile));",
    replacement: "const found = modified.some((f) => f === targetFile);",
    tests: [tests.targetSuffix],
    expectedDetection: "Prefixed changedFiles entries must still satisfy the target-file condition.",
  },
  {
    id: "M03-expansion-no-root",
    file: "src/runtime/task-loop/expansion.ts",
    line: 371,
    operator: "> 0 guard inverted",
    description: "Task dependency preflight must block graphs with no zero-dependency root.",
    original: "if (nodes.length > 0 && nodes.every((node) => taskDependencyIds(node.task).length > 0)) {",
    replacement: "if (nodes.length > 0 && nodes.every((node) => taskDependencyIds(node.task).length === 0)) {",
    tests: [tests.expansionCycle],
    expectedDetection: "No-root/cyclic task graphs must emit TASK_DEPENDENCY_NO_ROOT.",
  },
  {
    id: "M04-expansion-cycle",
    file: "src/runtime/task-loop/expansion.ts",
    line: 424,
    operator: "!== -> ===",
    description: "Task dependency preflight must block unsorted cyclic nodes.",
    original: "if (ordered.length !== nodes.length) {",
    replacement: "if (ordered.length === nodes.length) {",
    tests: [tests.expansionCycle],
    expectedDetection: "Cyclic task graphs must emit TASK_DEPENDENCY_CYCLE.",
  },
  {
    id: "M05-check-report-dependency-preflight",
    file: "src/runtime/gates/check-report.ts",
    line: 603,
    operator: "delete dependency blockers",
    description: "Yolo check must propagate dependency preflight blockers into the check report.",
    original: [
      "  const blockers = asArray((preflight as { blockers?: unknown[] }).blockers).map((blocker) => ({",
      "    code: blocker.code || \"TASK_DEPENDENCY_CYCLE\",",
      "    source: blocker.source || \"task-loop-expansion\",",
      "    task_id: blocker.task_id || null,",
      "    task_ids: asArray(blocker.task_ids),",
      "    message: blocker.message || \"Circular task dependency blocks check/preflight.\",",
      "    human_needed: true,",
      "  }));",
    ].join("\n"),
    replacement: "  const blockers = [];",
    tests: [tests.checkReportCycle],
    expectedDetection: "Check report must block cyclic/no-root PRDs instead of hiding preflight blockers.",
  },
  {
    id: "M06-demand-runtime-dedup",
    file: "src/demand/runtime.ts",
    line: 1164,
    operator: "delete duplicate guard",
    description: "Demand PRD compilation must deduplicate same-scenario same-scope tasks.",
    original: "if (scenarioTaskKeys.has(dedupKey)) continue;",
    replacement: "if (false && scenarioTaskKeys.has(dedupKey)) continue;",
    tests: [tests.demandDedup],
    expectedDetection: "Duplicate task keys must be rejected by demand runtime tests.",
  },
  {
    id: "M07-demand-runtime-read-first",
    file: "src/demand/runtime.ts",
    line: 1094,
    operator: "!== -> ===",
    description: "Demand-generated test tasks must read implementation files before verification.",
    original: "    related.push(...scenarioFiles.filter((file) => fileKind(file) !== \"test\"));",
    replacement: "    related.push(...scenarioFiles.filter((file) => fileKind(file) === \"test\"));",
    tests: [tests.demandDependencies],
    expectedDetection: "Generated test task handoff must include service read-first context.",
  },
  {
    id: "M08-demand-readiness-evidence-ledger",
    file: "src/demand/gate.ts",
    line: 869,
    operator: "evidence predicate -> true",
    description: "Demand readiness must fail closed when the evidence ledger is missing.",
    original: [
      "      hasLedgerEvidence(options.stateDir),",
      "      prdMode || deepMode ? \"error\" : \"warning\",",
    ].join("\n"),
    replacement: [
      "      true,",
      "      prdMode || deepMode ? \"error\" : \"warning\",",
    ].join("\n"),
    tests: [tests.demandLedgerReadiness],
    expectedDetection: "Missing ledger evidence must produce an EVIDENCE_GROUNDED readiness blocker.",
  },
  {
    id: "M09-demand-quality-evidence-ledger",
    file: "src/demand/gate.ts",
    line: 986,
    operator: "evidence predicate -> true",
    description: "Demand quality must expose whether project facts are evidence-grounded.",
    original: "const evidence_grounded = hasLedgerEvidence(options.stateDir);",
    replacement: "const evidence_grounded = true;",
    tests: [tests.demandLedgerQuality],
    expectedDetection: "Quality dimensions must report missing/broken ledger evidence as not grounded.",
  },
  {
    id: "M10-demand-quality-block-threshold",
    file: "src/demand/gate.ts",
    line: 1367,
    operator: "block threshold 70 -> 0",
    description: "Demand quality block threshold must stay fail-closed at 70 by default.",
    original: "const blockScore = Number(options.blockScore || 70);",
    replacement: "const blockScore = Number(options.blockScore || 0);",
    tests: [tests.demandQualityThreshold],
    expectedDetection: "Threshold tests must pin the default block score and low-score behavior.",
  },
  {
    id: "M11-acceptance-default-run-report",
    file: "src/runtime/acceptance/report.ts",
    line: 69,
    operator: "stage-wrapper guard removed",
    description: "Acceptance must prefer the latest real state run report over a lifecycle stage wrapper.",
    original: "if (lifecycleReport && !isLifecycleStageReport(lifecycleReport)) return lifecyclePath;",
    replacement: "if (lifecycleReport) return lifecyclePath;",
    tests: [tests.acceptanceDefaultRunReport],
    expectedDetection: "A lifecycle run-stage wrapper alone must not count as default run evidence.",
  },
  {
    id: "M12-run-lifecycle-fuse",
    file: "src/runtime/run-lifecycle/run-orchestrator.ts",
    line: 77,
    operator: "return false",
    description: "Repeated failure fuse must halt retry and review automation.",
    original: "return taskResults.stop_reason === \"repeated_failure_fuse\";",
    replacement: "return false;",
    tests: [tests.repeatedFailureFuse],
    expectedDetection: "The orchestrator test must observe retry/review are skipped after fuse.",
  },
  {
    id: "M13-progress-blocked-snapshot",
    file: "src/lifecycle/progress.ts",
    line: 49,
    operator: "&& stageStatus completed guard removed",
    description: "Blocked write-capable stages must not bless source drift with a fresh snapshot.",
    original: "return stage.writes_code === true && stageStatus === \"completed\";",
    replacement: "return stage.writes_code === true;",
    tests: [tests.lifecycleSnapshotBlocked],
    expectedDetection: "Blocked run-stage writes must leave source_snapshot null and drift visible.",
  },
  {
    id: "M14-progress-success-snapshot",
    file: "src/lifecycle/progress.ts",
    line: 49,
    operator: "return false",
    description: "Successful write-capable stages must refresh the source snapshot after in-band edits.",
    original: "return stage.writes_code === true && stageStatus === \"completed\";",
    replacement: "return false;",
    tests: [tests.lifecycleSnapshotSuccess],
    expectedDetection: "Successful run-stage writes must refresh source_snapshot and clear drift.",
  },
  {
    id: "M15-source-snapshot-yolo-exclusion",
    file: "src/lifecycle/source-snapshot.ts",
    line: 25,
    operator: "remove .yolo exclusion",
    description: "Source snapshot signatures must ignore yolo's own state writes.",
    original: "  \".yolo\", \".claude\", \".codex\", \".agents\",",
    replacement: "  \".claude\", \".codex\", \".agents\",",
    tests: [tests.sourceSnapshotYoloExclusion],
    expectedDetection: "Editing only .yolo state must not create source drift.",
  },
];

function commandFor(test: TestSpec) {
  const args = ["--import", "tsx", "--test"];
  if (test.namePattern) args.push("--test-name-pattern", test.namePattern);
  args.push(...test.files);
  return { args, command: `${process.execPath} ${args.join(" ")}` };
}

function runTest(test: TestSpec): CommandResult {
  const { args, command } = commandFor(test);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: test.timeoutMs ?? 120_000,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  return {
    label: test.label,
    command,
    status: result.status,
    signal: result.signal,
    timedOut: Boolean(result.error && result.error.message.includes("ETIMEDOUT")),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function testKey(test: TestSpec) {
  return JSON.stringify({ files: test.files, namePattern: test.namePattern || "" });
}

function uniqueTests() {
  const seen = new Set<string>();
  const values: TestSpec[] = [];
  for (const mutation of mutations) {
    for (const test of mutation.tests) {
      const key = testKey(test);
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(test);
    }
  }
  return values;
}

function countOccurrences(source: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const next = source.indexOf(needle, index);
    if (next === -1) return count;
    count += 1;
    index = next + needle.length;
  }
}

function tail(value: string, max = 3000) {
  if (value.length <= max) return value.trim();
  return value.slice(value.length - max).trim();
}

function restoreFiles(originals: Map<string, string>) {
  for (const [file, content] of originals) {
    writeFileSync(resolve(ROOT, file), content, "utf8");
  }
}

function applyMutation(mutation: Mutation, originals: Map<string, string>) {
  const path = resolve(ROOT, mutation.file);
  const originalFile = originals.get(mutation.file);
  const current = readFileSync(path, "utf8");
  if (originalFile != null && current !== originalFile) {
    throw new Error(`${mutation.file} is not restored before ${mutation.id}`);
  }
  const hits = countOccurrences(current, mutation.original);
  if (hits !== 1) {
    throw new Error(`${mutation.id} expected exactly one match in ${mutation.file}, found ${hits}`);
  }
  writeFileSync(path, current.replace(mutation.original, mutation.replacement), "utf8");
}

function runBaseline() {
  const baselineTests = uniqueTests();
  console.log(`[mutation-gate] Baseline: ${baselineTests.length} focused test command(s)`);
  for (const test of baselineTests) {
    const result = runTest(test);
    if (result.status !== 0) {
      console.error(`[mutation-gate] Baseline failed: ${test.label}`);
      console.error(result.command);
      if (result.stdout.trim()) console.error(tail(result.stdout));
      if (result.stderr.trim()) console.error(tail(result.stderr));
      process.exit(1);
    }
    console.log(`  pass ${test.label}`);
  }
}

function main() {
  const targetFiles = [...new Set(mutations.map((mutation) => mutation.file))];
  const originals = new Map(targetFiles.map((file) => [file, readFileSync(resolve(ROOT, file), "utf8")]));
  runBaseline();

  const survivors: Mutation[] = [];
  const killed: { mutation: Mutation; result: CommandResult }[] = [];

  try {
    for (const [index, mutation] of mutations.entries()) {
      console.log(`[mutation-gate] ${index + 1}/${mutations.length} ${mutation.id}`);
      applyMutation(mutation, originals);
      try {
        let killResult: CommandResult | null = null;
        for (const test of mutation.tests) {
          const result = runTest(test);
          if (result.status !== 0) {
            killResult = result;
            break;
          }
        }
        if (killResult) {
          killed.push({ mutation, result: killResult });
          console.log(`  killed by ${killResult.label}`);
        } else {
          survivors.push(mutation);
          console.log("  survived");
        }
      } finally {
        restoreFiles(originals);
      }
    }
  } finally {
    restoreFiles(originals);
    for (const [file, original] of originals) {
      const current = readFileSync(resolve(ROOT, file), "utf8");
      if (current !== original) {
        console.error(`[mutation-gate] Restore check failed for ${file}`);
        process.exit(1);
      }
    }
  }

  const total = mutations.length;
  const score = total > 0 ? killed.length / total : 0;
  const percent = (score * 100).toFixed(2);
  console.log(`[mutation-gate] Killed ${killed.length}/${total}; score=${percent}%; threshold=${(THRESHOLD * 100).toFixed(0)}%`);

  if (survivors.length > 0) {
    console.error("[mutation-gate] Surviving mutations:");
    for (const mutation of survivors) {
      console.error(`- ${mutation.id} ${mutation.file}:${mutation.line} ${mutation.operator}`);
      console.error(`  ${mutation.description}`);
      console.error(`  Needed assertion: ${mutation.expectedDetection}`);
    }
  }

  if (score < THRESHOLD) {
    process.exit(1);
  }
}

main();
