import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

export const PACKAGE_INSTALL_SMOKE_SCHEMA_VERSION = "1.0";

export const DEFAULT_PACKAGE_SMOKE_FORBIDDEN_PREFIXES = [
  "__tests__/",
  "closed-loop/",
  "data/",
  "dist/__tests__/",
  "dist/closed-loop/",
  "dist/data/",
  "dist/logs/",
  "dist/node_modules/",
  "dist/state/",
  "dist/tmp/",
  "hooks/",
  "logs/",
  "node_modules/",
  "scripts/",
  "state/",
  "tmp/",
];

export const DEFAULT_PACKAGE_SMOKE_REQUIRED_ENTRIES = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "dist/package.json",
  "dist/sdk.js",
  "dist/bin/yolo.js",
  "dist/tools/install-agent-bridge.js",
  "dist/docs/agent-chat-usage.md",
  "dist/docs/agent-native-integration.md",
  "dist/docs/memory/MEMORY_INDEX.md",
  "dist/docs/memory/CURRENT_STATUS.md",
  "dist/docs/memory/DOCUMENT_GOVERNANCE.md",
  "dist/docs/memory/LEARNING_INDEX.md",
  "dist/docs/memory/LESSONS_PLAYBOOK.md",
  "dist/src/core/bootstrap.js",
  "dist/src/core/init-smoke.js",
  "dist/src/runtime/learning/center.js",
  "dist/src/runtime/memory/center.js",
  "dist/src/runtime/memory/retention.js",
  "dist/src/devtools/memory-center.js",
  "dist/src/release/readiness.js",
  "dist/src/release/decision-gate.js",
  "dist/src/release/change-provenance.js",
  "dist/src/release/clean-environment-verify.js",
  "dist/src/release/dogfood-matrix.js",
  "dist/src/release/operator-state.js",
  "dist/src/release/operator-runbook.js",
  "dist/src/release/post-release-audit.js",
  "dist/src/release/stable-graduation.js",
  "dist/src/release/manual-external-release.js",
  "dist/src/release/agent-integration-doctor.js",
  "dist/src/release/real-project-dogfood.js",
  "dist/src/release/pi-execution-drill.js",
  "dist/src/release/runtime-boundary-decision.js",
  "dist/src/release/public-beta-evidence.js",
  "dist/src/release/real-project-dogfood-pack.js",
  "dist/src/release/experience-pack-audit.js",
  "dist/src/release/nontechnical-ux-doctor.js",
  "dist/src/eval/benchmark.js",
  "dist/schemas/prd-v2.schema.json",
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function runCommand(command, args, cwd, options = Object()) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: options.timeout_ms || 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    command: [command, ...args].join(" "),
    exit_code: result.status,
    signal: result.signal || null,
    status: result.status === 0 ? "pass" : "fail",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || result.error?.message || ""),
    stdout_tail: String(result.stdout || "").slice(-4000),
    stderr_tail: String(result.stderr || result.error?.message || "").slice(-4000),
  };
}

function parseNpmPackJson(stdout) {
  const parsed = JSON.parse(stdout || "[]");
  const pack = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!pack || typeof pack !== "object") {
    throw new Error("npm pack did not return package metadata");
  }
  return pack;
}

export function packageExportSpecifiers(packageJson = Object()) {
  const packageName = packageJson.name || "yolo";
  return Object.keys(packageJson.exports || {})
    .sort()
    .map((name) => (name === "." ? packageName : `${packageName}/${name.replace(/^\.\//, "")}`));
}

export function buildPackageInstallSmokePlan(options = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJson = options.packageJson || readJson(join(yoloRoot, "package.json"));
  const importSpecifiers = options.importSpecifiers || packageExportSpecifiers(packageJson);
  const binNames = Object.keys(packageJson.bin || {}).sort();

  return {
    schema_version: PACKAGE_INSTALL_SMOKE_SCHEMA_VERSION,
    schema: "yolo.release.package_install_smoke_plan.v1",
    yolo_root: yoloRoot,
    package_name: packageJson.name || null,
    package_version: packageJson.version || null,
    package_private: packageJson.private === true,
    package_files: Array.isArray(packageJson.files) ? packageJson.files : [],
    import_specifiers: importSpecifiers,
    bin_names: binNames,
    required_entries: options.requiredEntries || DEFAULT_PACKAGE_SMOKE_REQUIRED_ENTRIES,
    forbidden_prefixes: options.forbiddenPrefixes || DEFAULT_PACKAGE_SMOKE_FORBIDDEN_PREFIXES,
    commands: [
      "npm pack --json --ignore-scripts --pack-destination <tmp>/pack",
      "npm install --ignore-scripts --no-audit --fund=false --package-lock=false <tarball>",
      "node <tmp>/consumer/import-smoke.js",
      "sdk.provider.inspectProviderRuntimeMatrix()",
      "sdk.workflows.runSkillTargetSmoke()",
      "node_modules/.bin/yolo --help",
    ],
  };
}

export function inspectPackedPackage(packInfo = Object(), options = Object()) {
  const paths = (packInfo.files || []).map((file) => file.path).sort();
  const requiredEntries = options.requiredEntries || DEFAULT_PACKAGE_SMOKE_REQUIRED_ENTRIES;
  const forbiddenPrefixes = options.forbiddenPrefixes || DEFAULT_PACKAGE_SMOKE_FORBIDDEN_PREFIXES;
  const missingEntries = requiredEntries.filter((entry) => !paths.includes(entry));
  const forbiddenEntries = paths.filter((entry) =>
    forbiddenPrefixes.some((prefix) => entry === prefix.replace(/\/$/, "") || entry.startsWith(prefix))
  );
  const blockers = [];
  if (missingEntries.length > 0) {
    blockers.push({
      code: "PACKAGE_PACK_MISSING_REQUIRED_ENTRY",
      message: "package tarball is missing required public/runtime files",
      entries: missingEntries,
    });
  }
  if (forbiddenEntries.length > 0) {
    blockers.push({
      code: "PACKAGE_PACK_FORBIDDEN_ENTRY",
      message: "package tarball contains local tests, runtime state, legacy data, or workspace-only files",
      entries: forbiddenEntries,
    });
  }

  return {
    status: blockers.length > 0 ? "blocked" : "pass",
    blocks_release: blockers.length > 0,
    filename: packInfo.filename || null,
    entry_count: paths.length,
    size: packInfo.size || 0,
    unpacked_size: packInfo.unpackedSize || 0,
    required_entries: requiredEntries,
    missing_entries: missingEntries,
    forbidden_prefixes: forbiddenPrefixes,
    forbidden_entries: forbiddenEntries,
    blockers,
  };
}

function writeConsumerPackageJson(consumerDir) {
  writeFileSync(join(consumerDir, "package.json"), `${JSON.stringify({
    name: "yolo-package-install-smoke-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: { typecheck: 'node -e "process.exit(0)"' },
  }, null, 2)}\n`, "utf8");
}

function writeImportSmokeScript(filePath, plan) {
  const source = `import assert from "node:assert/strict";
	import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
	import { createRequire } from "node:module";
	import { dirname, join, resolve } from "node:path";

const importSpecifiers = ${JSON.stringify(plan.import_specifiers, null, 2)};
const imported = [];
for (const specifier of importSpecifiers) {
  const module = await import(specifier);
  assert.ok(Object.keys(module).length > 0, \`\${specifier} exported no bindings\`);
  imported.push({ specifier, export_count: Object.keys(module).length });
}

const root = await import(${JSON.stringify(plan.package_name || "yolo")});
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve(${JSON.stringify(plan.package_name || "yolo")}));
const projectRoot = resolve(process.cwd());
assert.equal(typeof root.createYoloSdk, "function");
assert.equal(typeof root.runPackageInstallSmoke, "function");
const sdk = root.createYoloSdk();
assert.equal(sdk.paths.projectRoot, projectRoot);
assert.equal(sdk.paths.stateRoot, join(projectRoot, ".yolo"));
assert.equal(sdk.paths.yoloPath("runtime"), join(projectRoot, ".yolo", "state", "runtime"));
assert.equal(typeof sdk.project.runInitToFirstPrdSmoke, "function");
assert.equal(typeof sdk.release.inspectPublicBetaReadiness, "function");
assert.equal(typeof sdk.release.runPackageInstallSmoke, "function");
assert.equal(typeof sdk.release.runControlledBetaReleaseDecisionGate, "function");
assert.equal(typeof sdk.release.runReleaseCandidateGate, "function");
assert.equal(typeof sdk.release.readReleaseCandidateChangeManifest, "function");
assert.equal(typeof sdk.release.runCleanEnvironmentVerify, "function");
assert.equal(typeof sdk.release.buildDogfoodMatrixReport, "function");
assert.equal(typeof sdk.release.runOperatorReleaseStateMutation, "function");
assert.equal(typeof sdk.release.runOperatorReleaseRunbookGate, "function");
assert.equal(typeof sdk.release.runPostReleaseAuditGate, "function");
assert.equal(typeof sdk.release.runStableGraduationGate, "function");
assert.equal(typeof sdk.release.runManualExternalReleaseGate, "function");
assert.equal(typeof sdk.release.runAgentIntegrationDoctor, "function");
assert.equal(typeof sdk.release.runRealProjectDogfoodGate, "function");
assert.equal(typeof sdk.release.runPiExecutionDrillGate, "function");
assert.equal(typeof sdk.release.runRuntimeBoundaryDecisionGate, "function");
assert.equal(typeof sdk.release.runPublicBetaEvidenceGate, "function");
assert.equal(typeof sdk.release.runRealProjectDogfoodPack, "function");
assert.equal(typeof sdk.release.runExperiencePackEffectivenessAudit, "function");
assert.equal(typeof sdk.release.runNonTechnicalUxDoctor, "function");
assert.equal(typeof sdk.eval.runBenchmark, "function");
assert.equal(typeof sdk.eval.buildBenchmarkPlan, "function");
assert.equal(typeof sdk.provider.inspectProviderRuntimeMatrix, "function");
assert.equal(typeof sdk.provider.inspectProviderCliDryRunMatrix, "function");
const providerMatrix = sdk.provider.inspectProviderRuntimeMatrix({
  commandExists: (command) => ["claude", "codex", "cat", "sh"].includes(command),
  now: () => 123,
  random: () => 0.5,
  providerConfigs: {
    custom: { ai: { custom_command: "cat", custom_sandbox: "workspace-write" } }
  }
});
assert.equal(providerMatrix.blocks_execution, false);
assert.deepEqual(providerMatrix.matrix.providers.map((entry) => entry.provider), ["claude", "codex", "custom"]);
assert.equal(providerMatrix.matrix.gate_log_dir, join(projectRoot, ".yolo", "state", "runtime"));
assert.equal(
  providerMatrix.matrix.providers.find((entry) => entry.provider === "codex").invocation.output_file,
  join(projectRoot, ".yolo", "state", "runtime", "codex-output-123-8.txt")
);
const providerCliDryRun = sdk.provider.inspectProviderCliDryRunMatrix({
  commandExists: (command) => ["claude", "codex", "cat", "sh"].includes(command),
  now: () => 123,
  random: () => 0.5,
  providerConfigs: {
    custom: { ai: { custom_command: "cat", custom_sandbox: "workspace-write" } }
  }
});
assert.equal(providerCliDryRun.blocks_execution, false);
assert.equal(providerCliDryRun.matrix.execution_allowed, false);
assert.deepEqual(providerCliDryRun.matrix.providers.map((entry) => entry.will_spawn), [false, false, false]);
assert.equal(
  providerCliDryRun.matrix.providers.find((entry) => entry.provider === "codex").output_capture.output_file,
  join(projectRoot, ".yolo", "state", "runtime", "codex-output-123-8.txt")
);
assert.equal(typeof sdk.workflows.runSkillTargetSmoke, "function");
const workflowTargetSmoke = sdk.workflows.runSkillTargetSmoke({
  packageRoot,
  targets: ["yolo", "agents", "claude"],
  workflows: ["fix"]
});
assert.equal(workflowTargetSmoke.status, "pass");
assert.deepEqual(workflowTargetSmoke.plan.targets.map((target) => target.target_dir), [
  ".yolo/skills",
  ".agents/skills",
  ".claude/skills"
]);
assert.equal(existsSync(join(projectRoot, ".yolo", "skills", "yolo.fix", "skill.json")), true);
assert.equal(existsSync(join(projectRoot, ".agents", "skills", "yolo.fix", "SKILL.md")), true);
assert.equal(existsSync(join(projectRoot, ".claude", "skills", "index.json")), true);
const claudeSkill = JSON.parse(readFileSync(join(projectRoot, ".claude", "skills", "yolo.fix", "skill.json"), "utf8"));
assert.equal(claudeSkill.agent, "claude");
const piPlan = sdk.agents.createPiPlan({
  requirement: "For package consumers, verify package root isolation in src/package-root-isolation.js so PI artifacts are written under the consumer .yolo directory; success criteria: outputDir starts with the consumer .yolo path.",
  runId: "pi-root-isolation"
});
assert.equal(piPlan.status, "success");
assert.equal(piPlan.artifacts.outputDir.startsWith(join(projectRoot, ".yolo")), true);
	const init = sdk.project.initProject({ projectName: "package-consumer" });
	assert.equal(init.status, "success");
	assert.equal(existsSync(join(projectRoot, ".yolo", "config.json")), true);
	const runnerPrdPath = join(projectRoot, ".yolo", "data/prd/current/pack-runner-state-root.json");
	const packRunnerQuality = {
	  schema_version: "1.0",
	  schema: "yolo.demand.quality.v1",
	  status: "pass",
	  total_score: 100,
	  dimensions: []
	};
	mkdirSync(dirname(runnerPrdPath), { recursive: true });
	writeFileSync(runnerPrdPath, JSON.stringify({
	  version: "2.0",
	  id: "PRD-20260524-PACK-RUNNER",
	  title: "Pack runner state root smoke",
	  project: { name: "package-consumer", language: "javascript" },
	  generated_by: "yolo-review-agent",
	  generated_at: "2026-05-24T00:00:00.000Z",
	  base_commit: "abcdef0",
	  review_policy: { mode: "disabled" },
	  source: "approved_demand",
	  demand_contract_required: true,
	  demand: {
	    id: "DEMAND-PACK-RUNNER-TEST",
	    approval: { approved: true, effective_for_prd: true },
	    project_facts: {
	      target_files: [{ file: "artifacts/pack-runner-smoke.md", status: "verified" }],
	      assumptions: []
	    },
	    quality_report: packRunnerQuality
	  },
	  execution_readiness: {
	    level: "L3",
	    afk_ready: true,
	    quality_status: "pass",
	    quality_report: packRunnerQuality
	  },
	  requirements: [{
	    id: "REQ-PACK-001",
	    text: "Runner state belongs to the consumer project.",
	    demand_trace: { evidence: ["EVID-REQ-PACK-001"] }
	  }],
	  designs: [{ id: "DES-PACK-001", text: "Run artifacts use SDK stateRoot." }],
	  tasks: [{
	    id: "FIX-PACK-001",
	    title: "Write package runner smoke artifact",
	    priority: "P3",
	    type: "cleanup",
	    task_kind: "dry_run_artifact",
	    status: "pending",
	    requirement_ids: ["REQ-PACK-001"],
	    design_ids: ["DES-PACK-001"],
	    scope: {
	      targets: [{ file: "artifacts/pack-runner-smoke.md" }],
	      allow_new_files: true,
	      expected_zero_business_code: true
	    },
	    post_conditions: [{
	      id: "POST-FILE",
	      type: "file_exists",
	      severity: "FAIL",
	      params: { file: "artifacts/pack-runner-smoke.md" }
	    }, {
	      id: "POST-TYPECHECK",
	      type: "no_new_type_errors",
	      severity: "FAIL",
	      params: { command: "npm run typecheck" }
	    }]
	  }]
	}, null, 2) + "\\n", "utf8");
	sdk.lifecycle.writeStageReport("discovery", { status: "success" });
	sdk.lifecycle.writeStageReport("roadmap", { status: "success" });
	sdk.lifecycle.writeStageReport("prd", {
	  status: "success",
	  prd_path: runnerPrdPath,
	  artifacts: [runnerPrdPath]
	});
	const runnerCheck = sdk.runtime.inspectCheck({ prdPath: runnerPrdPath, writeLifecycle: true });
	assert.notEqual(runnerCheck.status, "blocked");
	const runner = await sdk.runtime.runRunner({
	  prdPath: runnerPrdPath,
	  runId: "run-pack-state-root",
	  mode: "dev",
	  startProgressServer: false,
	  runReviewLoop: false,
	  initializeBaselines: false
	});
	assert.equal(runner.status, "success");
	assert.deepEqual(runner.completed, ["FIX-PACK-001"]);
	assert.equal(existsSync(join(projectRoot, "artifacts", "pack-runner-smoke.md")), true);
	const runReportPath = join(projectRoot, ".yolo", "state", "reports", "run-pack-state-root", "run-report.json");
	assert.equal(existsSync(runReportPath), true);
	assert.match(readFileSync(runReportPath, "utf8"), /FIX-PACK-001/);
	assert.equal(existsSync(join(projectRoot, ".yolo", "state", "runtime", "task-results.jsonl")), false);
	assert.equal(existsSync(join(projectRoot, ".yolo", "state", "runtime", "task-logs")), false);
	for (const dir of ["state", "data", "logs", ".yolo", ".agents", ".claude", ".codex"]) {
	  assert.equal(existsSync(join(packageRoot, dir)), false, \`package root leaked writable \${dir}\`);
	}

console.log(JSON.stringify({
  status: "pass",
  imported_count: imported.length,
  bin_count: ${JSON.stringify(plan.bin_names.length)},
  package_root: packageRoot,
  project_root: projectRoot,
  state_root: sdk.paths.stateRoot
}));
`;
  writeFileSync(filePath, source, "utf8");
}

export function runPackageInstallSmoke(options = Object()) {
  const plan = buildPackageInstallSmokePlan(options);
  if (options.dryRun === true || options.dry_run === true) {
    return {
      status: "success",
      summary: "planned package install smoke",
      exit_code: 0,
      dry_run: true,
      plan,
      next_actions: ["Run without dryRun to create a tarball, install it into a temp project, and import public exports."],
    };
  }

  const tempRoot = resolve(options.workspace || mkdtempSync(join(resolve(options.tmpRoot || tmpdir()), "yolo-pack-smoke-")));
  const packDir = join(tempRoot, "pack");
  const consumerDir = join(tempRoot, "consumer");
  const keepWorkspace = options.keepWorkspace === true;
  mkdirSync(packDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });

  try {
    const packCommand = runCommand("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], plan.yolo_root, options);
    if (packCommand.exit_code !== 0) {
      return {
        status: "error",
        summary: "npm pack failed",
        exit_code: packCommand.exit_code || 1,
        dry_run: false,
        plan,
        workspace: keepWorkspace ? tempRoot : null,
        pack: { command: packCommand, inspection: null, tarball: null },
        next_actions: ["Fix npm pack errors before public beta release."],
      };
    }

    const packInfo = parseNpmPackJson(packCommand.stdout);
    const inspection = inspectPackedPackage(packInfo, plan);
    const tarball = join(packDir, packInfo.filename || `${plan.package_name}-${plan.package_version}.tgz`);
    if (inspection.blocks_release || !existsSync(tarball)) {
      return {
        status: "blocked",
        summary: inspection.blocks_release ? "package tarball contains release-blocking entries" : "npm pack did not create the expected tarball",
        exit_code: 1,
        dry_run: false,
        plan,
        workspace: keepWorkspace ? tempRoot : null,
        pack: { command: packCommand, info: packInfo, inspection, tarball },
        next_actions: inspection.blockers.map((blocker) => blocker.message),
      };
    }

    writeConsumerPackageJson(consumerDir);
    const install = runCommand("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--fund=false",
      "--package-lock=false",
      tarball,
    ], consumerDir, options);

    const importScript = join(consumerDir, "import-smoke.js");
    writeImportSmokeScript(importScript, plan);
    const importCheck = install.exit_code === 0
      ? runCommand(process.execPath, [importScript], consumerDir, options)
      : null;

    const binPath = join(consumerDir, "node_modules", ".bin", "yolo");
    const binChecks = [];
    if (install.exit_code === 0) {
      binChecks.push(runCommand(binPath, ["--help"], consumerDir, options));
    }

    const failedChecks = [
      install,
      importCheck,
      ...binChecks,
    ].filter((item) => item && item.exit_code !== 0);

    return {
      status: failedChecks.length === 0 ? "pass" : "blocked",
      summary: failedChecks.length === 0
        ? "package tarball installed and public exports/bin loaded from an external temp project"
        : "package install smoke blocked",
      exit_code: failedChecks.length === 0 ? 0 : 1,
      dry_run: false,
      plan,
      workspace: keepWorkspace ? tempRoot : null,
      pack: { command: packCommand, info: packInfo, inspection, tarball: keepWorkspace ? tarball : basename(tarball) },
      install,
      import_check: importCheck,
      bin_checks: binChecks,
      next_actions: failedChecks.length === 0
        ? ["Keep package install smoke in release verification before removing private=true."]
        : ["Fix failed install/import/bin checks before public beta release."],
    };
  } finally {
    if (!keepWorkspace) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}
