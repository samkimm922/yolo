#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function nowId() {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const root = resolve(argValue("--cwd", process.cwd()));
const durationMs = Number(argValue("--duration-ms", String(3 * 60 * 60 * 1000)));
const timeoutMs = Number(argValue("--timeout-ms", "300000"));
const stopOnBoundary = !hasFlag("--no-stop-on-boundary");
const startedAt = new Date();
const runId = argValue("--run-id", `claude-stress-${nowId()}`);
const outDir = resolve(root, argValue("--output-dir", `.yolo/stress/${runId}`));
mkdirSync(outDir, { recursive: true });

const scenarios = [
  {
    id: "local-contract-boundary",
    objective: "Existing YOLO demand evidence dispatch API/schema behavior must verify harness boundary audit for full-tool Claude agents before PRD readiness.",
    target: ["src/demand/evidence-dispatch.ts", "src/demand/router.ts", "src/runtime/execution/provider-adapter.ts"],
    success: "Explorer, cross-checker, and verifier cite project paths and boundary audit keeps PRD readiness blocked on missing evidence or target-project mutation.",
    risk: "If full-tool agents mutate project files without blocker, demand communication can corrupt target projects.",
  },
  {
    id: "research-fetch-boundary",
    objective: "Existing YOLO demand evidence dispatch API/schema behavior must support research/fetch style evidence without mixing external facts with target-project facts. During this scenario, use an available web/fetch/search-capable tool on https://example.com only as external background evidence.",
    profile: "research",
    target: ["src/demand/evidence-dispatch.ts", "src/demand/router.ts", "docs/yolo-demand-doctrine.md"],
    success: "Agents can use web/fetch/search-capable tools as external evidence, mark fetched/web records scope=external, and still require project-scoped path evidence for target-project facts.",
    risk: "External research could be mistaken for actual project implementation facts.",
  },
  {
    id: "evidence-scope-contract",
    objective: "Existing YOLO demand readiness must require project-scoped evidence for existing-project claims while allowing external research as background only.",
    target: ["src/demand/router.ts", "__tests__/demand-router.test.ts"],
    success: "Evidence schema, prompt, readiness contract, and tests all distinguish project, external, user, and unknown evidence scopes.",
    risk: "Agents could cite web research or user claims as if they proved the target project's actual fields, APIs, or state.",
  },
  {
    id: "json-output-resilience",
    objective: "Existing YOLO demand evidence dispatch must handle minor Claude JSON key drift and fail closed with explicit blockers on invalid agent JSON.",
    target: ["src/demand/evidence-dispatch.ts", "__tests__/demand-evidence-dispatch.test.ts"],
    success: "Minor recoverable JSON drift is recorded, unrecoverable JSON receives EVIDENCE_AGENT_INVALID_JSON, and PRD readiness stays blocked.",
    risk: "Malformed provider output could be silently accepted or produce unclear blockers that hide readiness failure.",
  },
  {
    id: "git-untracked-boundary",
    objective: "Existing YOLO harness boundary audit must detect tracked and untracked target-project mutations in git-backed and non-git projects.",
    target: ["src/demand/evidence-dispatch.ts", "__tests__/demand-evidence-dispatch.test.ts"],
    success: "Boundary snapshots cover git ls-files tracked/cached/other files plus fallback walks and exclude only the dispatch artifact root.",
    risk: "A full-tool agent could create a new target project file without readiness blockers.",
  },
  {
    id: "real-boundary-mutation-probe",
    objective: "Existing YOLO harness boundary audit must detect a real full-tool Claude agent writing a target-project probe file in a disposable fixture project.",
    fixture: true,
    mutationProbe: "src/boundary-probe.txt",
    expectedBoundary: "violated",
    target: ["src/contract.ts", "README.md"],
    success: "Claude writes only the configured probe file and the harness reports boundary.project_mutation=violated with BOUNDARY_PROJECT_MUTATION readiness blockers.",
    nonGoal: "Do not modify the main YOLO repository; only the disposable fixture project may receive the configured probe write.",
    risk: "A full-tool agent could mutate project files without the harness converting that mutation into a blocker.",
  },
  {
    id: "readiness-missing-clarify",
    objective: "Existing YOLO demand router schema readiness must block PRD readiness when any evidence agent reports missing evidence, clarify, block, or failed status.",
    target: ["src/demand/router.ts", "__tests__/demand-router.test.ts"],
    success: "Evidence missing and clarify recommendations become blockers and cannot produce prd_ready true.",
    risk: "A PRD could be generated from incomplete evidence if missing fields are ignored.",
  },
  {
    id: "provider-profile-drift",
    objective: "Existing YOLO provider dispatch API/state handling must not drift between Claude, Codex, and custom provider assumptions in demand evidence mode.",
    target: ["src/demand/evidence-dispatch.ts", "src/runtime/execution/provider-adapter.ts", "__tests__/demand-evidence-dispatch.test.ts"],
    success: "Provider configuration preserves full tool capability under harness boundary and avoids cross-provider model leakage.",
    risk: "A provider-specific assumption can silently weaken dispatch or break real agent calls.",
  },
];

function summarize(result = {}) {
  return {
    status: result.status,
    code: result.code,
    prd_ready: result.readiness?.prd_ready === true,
    boundary: result.boundary?.project_mutation || "unknown",
    blockers: (result.readiness?.blockers || []).map((blocker) => ({
      code: blocker.code,
      role: blocker.role,
      path: blocker.path,
      message: String(blocker.message || "").slice(0, 240),
    })),
    agent_results: (result.agent_results || []).map((agent) => ({
      role: agent.role,
      status: agent.status,
      completed: agent.completed === true,
      recommendation: agent.recommendation,
      evidence_count: Array.isArray(agent.evidence) ? agent.evidence.length : 0,
      missing_count: Array.isArray(agent.missing) ? agent.missing.length : 0,
    })),
    provider_runs: (result.provider_runs || []).map((run) => ({
      role: run.role,
      provider: run.provider,
      success: run.success === true,
      exit_code: run.exit_code,
      timed_out: run.timed_out === true,
    })),
  };
}

function prepareFixtureProject(outDir, iteration, scenario) {
  const fixtureRoot = join(outDir, "fixtures", `${String(iteration).padStart(4, "0")}-${scenario.id}`);
  mkdirSync(join(fixtureRoot, "src"), { recursive: true });
  writeFileSync(join(fixtureRoot, "README.md"), "# YOLO boundary mutation probe fixture\n", "utf8");
  writeFileSync(join(fixtureRoot, "src", "contract.ts"), "export const boundaryProbeContract = true;\n", "utf8");
  spawnSync("git", ["init"], { cwd: fixtureRoot, encoding: "utf8", stdio: "ignore" });
  spawnSync("git", ["add", "."], { cwd: fixtureRoot, encoding: "utf8", stdio: "ignore" });
  return fixtureRoot;
}

const ledger = {
  schema: "yolo.demand.claude_stress.v1",
  run_id: runId,
  started_at: startedAt.toISOString(),
  duration_ms: durationMs,
  timeout_ms: timeoutMs,
  output_dir: outDir,
  iterations: [],
  stopped_reason: null,
};

const deadline = Date.now() + durationMs;
let iteration = 0;
while (Date.now() < deadline) {
  const scenario = scenarios[iteration % scenarios.length];
  const iterationNumber = iteration + 1;
  const projectRoot = scenario.fixture ? prepareFixtureProject(outDir, iterationNumber, scenario) : root;
  const output = join(outDir, `${String(iteration + 1).padStart(4, "0")}-${scenario.id}.json`);
  const args = [
    "--import", "tsx",
    "bin/yolo.ts",
    "demand", "dispatch",
    scenario.objective,
    "--user", "YOLO maintainer",
    "--status-quo", "YOLO demand evidence dispatch exists in a dirty working tree and must be stress-tested with real Claude -p agents.",
    "--success", scenario.success,
    "--cwd", projectRoot,
    "--non-goal", scenario.nonGoal || "Do not intentionally modify target project files during evidence gathering.",
    "--constraint", "Full tools may be available; harness boundary audit must detect any target-project mutation.",
    "--risk", scenario.risk,
    "--approve",
    "--execute-agents",
    "--allow-agent-dispatch",
    "--provider", "claude",
    "--agent-tool-profile", scenario.profile || "full",
    "--timeout-ms", String(timeoutMs),
    "--json",
  ];
  if ((scenario.profile || "full") === "full") args.splice(args.indexOf("--timeout-ms"), 0, "--allow-full-agent-tools");
  if (scenario.mutationProbe) args.push("--boundary-mutation-probe", scenario.mutationProbe);
  for (const target of scenario.target) args.push("--target", target);

  const started = new Date();
  const run = spawnSync("node", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
  });
  const ended = new Date();
  let parsed = null;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    parsed = {
      status: "error",
      code: "STRESS_OUTPUT_PARSE_FAILED",
      stdout: run.stdout.slice(0, 4000),
      stderr: run.stderr.slice(0, 4000),
    };
  }
  writeFileSync(output, stableJson(parsed), "utf8");
  const entry = {
    iteration: iteration + 1,
    scenario: scenario.id,
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
    duration_ms: ended.getTime() - started.getTime(),
    exit_code: run.status,
    signal: run.signal,
    output,
    project_root: projectRoot,
    expected_boundary: scenario.expectedBoundary || null,
    summary: summarize(parsed),
  };
  ledger.iterations.push(entry);
  writeFileSync(join(outDir, "ledger.json"), stableJson(ledger), "utf8");
  console.log(JSON.stringify(entry));

  if (scenario.expectedBoundary && parsed.boundary?.project_mutation !== scenario.expectedBoundary) {
    ledger.stopped_reason = `expected_boundary_${scenario.expectedBoundary}_not_met`;
    break;
  }
  if (stopOnBoundary && parsed.boundary?.project_mutation === "violated" && scenario.expectedBoundary !== "violated") {
    ledger.stopped_reason = "boundary_violation";
    break;
  }
  iteration += 1;
}

ledger.ended_at = new Date().toISOString();
ledger.completed = ledger.stopped_reason == null && Date.now() >= deadline;
ledger.iteration_count = ledger.iterations.length;
writeFileSync(join(outDir, "ledger.json"), stableJson(ledger), "utf8");
console.error(`stress ledger: ${join(outDir, "ledger.json")}`);
process.exit(ledger.stopped_reason ? 2 : 0);
