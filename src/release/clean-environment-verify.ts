import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ReleaseIssue, ReleaseRecord } from "./readiness.js";

export const CLEAN_ENVIRONMENT_VERIFY_SCHEMA_VERSION = "1.0";
const CLEAN_ENVIRONMENT_TEMP_PREFIX = "yolo-clean-env-";

const DEFAULT_COPY_EXCLUDES = [
  ".git",
  ".yolo",
  "dist",
  "logs",
  "node_modules",
  "state",
  "tmp",
];

export interface PackageShape extends ReleaseRecord {
  package_name: string;
  package_version: unknown;
  import_specifiers: string[];
  bin_names: string[];
}

export interface PackageJsonLike extends ReleaseRecord {
  name?: string;
  version?: string;
  exports?: Record<string, unknown>;
  bin?: Record<string, unknown>;
}

export interface CleanEnvironmentWorkspace {
  temp_root: string;
  clean_worktree: string;
  pack_destination: string;
  consumer: string;
  isolated_pack_destination: boolean;
}

export interface CleanEnvironmentSource extends ReleaseRecord {
  mode: string;
  repository_url?: string;
  ref?: string | null;
  source_root?: string;
  excluded_paths?: string[];
}

export interface CleanEnvironmentStep extends ReleaseRecord {
  id: string;
  label: string;
  command: string;
  candidate_commands?: string[];
}

export interface CleanEnvironmentExecutionPolicy extends ReleaseRecord {
  dry_run_has_no_side_effects: boolean;
}

export interface CleanEnvironmentPlan extends ReleaseRecord {
  yolo_root: string;
  source: CleanEnvironmentSource;
  workspace: CleanEnvironmentWorkspace;
  package: PackageShape;
  steps: CleanEnvironmentStep[];
  execution_policy: CleanEnvironmentExecutionPolicy;
}

export interface CommandResult extends ReleaseRecord {
  command: string;
  args: string[];
  cwd: string;
  exit_code: number | null;
  signal: NodeJS.Signals | string | null;
  status: string;
  started_at: string;
  finished_at: string;
  stdout: string;
  stderr: string;
  stdout_tail: string;
  stderr_tail: string;
  exception?: boolean;
}

export interface CompletedStep extends ReleaseRecord {
  id: string;
  status: string;
  command: CommandResult;
  selected_command?: string;
  tarball?: string;
  parsed_stdout?: ReleaseRecord;
}

export interface CleanEnvironmentVerifyResult extends ReleaseRecord {
  status: string;
  blocks_release: boolean;
  exit_code: number;
  dry_run: boolean;
  summary: string;
  plan: CleanEnvironmentPlan;
  workspace?: CleanEnvironmentWorkspace | null;
  steps: ReleaseRecord[];
  blockers: ReleaseIssue[];
  tarball?: string;
  next_actions: string[];
}

export interface CleanEnvironmentOptions extends ReleaseRecord {
  yoloRoot?: string;
  cwd?: string;
  packageJson?: PackageJsonLike;
  repositoryUrl?: string;
  repository_url?: string;
  ref?: string;
  copyExcludes?: string[];
  copy_excludes?: string[];
  tempRoot?: string;
  temp_root?: string;
  cleanWorktree?: string;
  clean_worktree?: string;
  packDestination?: string;
  pack_destination?: string;
  consumerDir?: string;
  consumer_dir?: string;
  hasNpmCiLock?: boolean;
  installCommand?: string;
  install_command?: string;
  existsSync?: (path: string) => boolean;
  timeout_ms?: number;
  keepWorkspace?: boolean;
  cleanup?: boolean;
  tmpRoot?: string;
  commandRunner?: (command: string, args: string[], cwd: string, options?: CleanEnvironmentOptions) => CommandResult;
  prepareWorkspace?: (plan: CleanEnvironmentPlan, options?: CleanEnvironmentOptions) => CommandResult;
  dryRun?: boolean;
  dry_run?: boolean;
  executor?: (plan: CleanEnvironmentPlan, options?: CleanEnvironmentOptions) => CleanEnvironmentVerifyResult;
}

export interface PackInfo extends ReleaseRecord {
  filename: string;
}

function commandRecord(command: string, args: string[], cwd: string, result: SpawnSyncReturns<string>, startedAt: string): CommandResult {
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || result.error?.message || "");
  return {
    command: [command, ...args].join(" "),
    args: [command, ...args],
    cwd,
    exit_code: result.status,
    signal: result.signal || null,
    status: result.status === 0 ? "pass" : "fail",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    stdout,
    stderr,
    stdout_tail: stdout.slice(-4000),
    stderr_tail: stderr.slice(-4000),
  };
}

function runCommand(command: string, args: string[], cwd: string, options: CleanEnvironmentOptions = Object()): CommandResult {
  const startedAt = new Date().toISOString();
  try {
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: options.timeout_ms || 300000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return commandRecord(command, args, cwd, result, startedAt);
  } catch (error) {
    return {
      command: [command, ...args].join(" "),
      args: [command, ...args],
      cwd,
      exit_code: 1,
      signal: null,
      status: "exception",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      stdout_tail: "",
      stderr_tail: error instanceof Error ? error.message : String(error),
      exception: true,
    };
  }
}

function readPackageShape(packageJson: PackageJsonLike = Object()): PackageShape {
  const packageName = packageJson.name || "yolo";
  const exportsMap = packageJson.exports || {};
  return {
    package_name: packageName,
    package_version: packageJson.version || null,
    import_specifiers: Object.keys(exportsMap)
      .sort()
      .map((name) => (name === "." ? packageName : `${packageName}/${name.replace(/^\.\//, "")}`)),
    bin_names: Object.keys(packageJson.bin || {}).sort(),
  };
}

function readJson(filePath: string): ReleaseRecord {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function hasNpmCiLock(root: string, exists: typeof existsSync = existsSync): boolean {
  return exists(join(root, "package-lock.json")) || exists(join(root, "npm-shrinkwrap.json"));
}

function materializeWorkspace(plan: CleanEnvironmentPlan, tempRoot: string): CleanEnvironmentPlan {
  return {
    ...plan,
    workspace: {
      ...plan.workspace,
      temp_root: tempRoot,
      clean_worktree: join(tempRoot, "clean-worktree"),
      pack_destination: join(tempRoot, "pack"),
      consumer: join(tempRoot, "consumer"),
    },
  };
}

function step(id: string, label: string, command: string, details: ReleaseRecord = Object()): CleanEnvironmentStep {
  return { id, label, command, ...details };
}

export function buildCleanEnvironmentVerifyPlan(options: CleanEnvironmentOptions = Object()): CleanEnvironmentPlan {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageShape = readPackageShape(options.packageJson || readJson(join(yoloRoot, "package.json")));
  const useClone = Boolean(options.repositoryUrl || options.repository_url);
  const source = useClone
    ? {
      mode: "git_clone",
      repository_url: options.repositoryUrl || options.repository_url,
      ref: options.ref || null,
    }
    : {
      mode: "clean_copy",
      source_root: yoloRoot,
      excluded_paths: options.copyExcludes || options.copy_excludes || DEFAULT_COPY_EXCLUDES,
    };
  const tempRoot = options.tempRoot || options.temp_root || `<tmp>/${CLEAN_ENVIRONMENT_TEMP_PREFIX}*`;
  const cleanWorktree = options.cleanWorktree || options.clean_worktree || "<tmp>/clean-worktree";
  const packDestination = options.packDestination || options.pack_destination || "<tmp>/pack";
  const consumer = options.consumerDir || options.consumer_dir || "<tmp>/consumer";
  const npmCiLockAvailable = options.hasNpmCiLock ?? hasNpmCiLock(yoloRoot, options.existsSync || existsSync);
  const installCommand = options.installCommand || options.install_command || (
    npmCiLockAvailable === true ? "npm ci" : "npm install"
  );
  const cloneOrCopyCommand = useClone
    ? `git clone ${source.ref ? `--branch ${source.ref} ` : ""}${source.repository_url} ${cleanWorktree}`.trim()
    : `copy ${yoloRoot} ${cleanWorktree}`;

  return {
    schema_version: CLEAN_ENVIRONMENT_VERIFY_SCHEMA_VERSION,
    schema: "yolo.release.clean_environment_verify_plan.v1",
    yolo_root: yoloRoot,
    source,
    workspace: {
      temp_root: tempRoot,
      clean_worktree: cleanWorktree,
      pack_destination: packDestination,
      consumer,
      isolated_pack_destination: true,
    },
    package: packageShape,
    execution_policy: {
      dry_run_has_no_side_effects: true,
      npm_pack_ignore_scripts_required: true,
      isolated_temporary_directories_required: true,
      fail_closed_on_nonzero_exit: true,
      fail_closed_on_unparseable_stdout_stderr: true,
    },
    steps: [
      step("prepare_clean_source", "git clone or clean copy into isolated temp worktree", cloneOrCopyCommand),
      step("install_dependencies", "install dependencies in clean worktree", installCommand, {
        candidate_commands: ["npm ci", "npm install"],
        fallback_policy: "use npm install when npm ci lockfile is unavailable",
      }),
      // source-grep-allow toolchain-drift: clean release recipe records YOLO's verify script.
      step("verify", "run full project verification in clean worktree", "npm run verify"),
      step("pack", "pack package into isolated destination without scripts", `npm pack --json --ignore-scripts --pack-destination ${packDestination}`, {
        requires: ["--ignore-scripts", "isolated pack destination"],
        parse_stdout_as: "npm_pack_json",
      }),
      step("install_tarball", "install packed tarball in isolated consumer", "npm install --ignore-scripts --no-audit --fund=false --package-lock=false <tarball>"),
      step("public_entrypoint_bin_smoke", "import package public entrypoints and smoke package bins", "node <consumer>/public-entrypoint-bin-smoke.mjs", {
        parse_stdout_as: "json",
        import_specifiers: packageShape.import_specifiers,
        bin_names: packageShape.bin_names,
      }),
    ],
  };
}

function blockResult(plan: CleanEnvironmentPlan, completedSteps: CompletedStep[], blocker: ReleaseIssue, keepWorkspace: boolean): CleanEnvironmentVerifyResult {
  return {
    status: "blocked",
    blocks_release: true,
    exit_code: 1,
    dry_run: false,
    summary: blocker.message,
    plan,
    workspace: keepWorkspace ? plan.workspace : null,
    steps: completedSteps,
    blockers: [blocker],
    next_actions: [blocker.message],
  };
}

function commandBlock(stepId: string, result: CommandResult | null): ReleaseIssue {
  const code = result?.exception
    ? "CLEAN_VERIFY_COMMAND_EXCEPTION"
    : "CLEAN_VERIFY_COMMAND_NONZERO_EXIT";
  return {
    code,
    step_id: stepId,
    message: result?.exception
      ? `clean environment verify command threw during ${stepId}`
      : `clean environment verify command failed during ${stepId}`,
    command: result?.command || null,
    exit_code: result?.exit_code ?? null,
    stderr_tail: result?.stderr_tail || "",
  };
}

function isRecord(value: unknown): value is ReleaseRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseNpmPackStdout(stdout: string): PackInfo {
  const parsed = JSON.parse(stdout || "[]");
  const packInfo = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(packInfo) || typeof packInfo.filename !== "string" || packInfo.filename.length === 0) {
    throw new Error("npm pack stdout did not include a package filename");
  }
  return { ...packInfo, filename: packInfo.filename };
}

function parseSmokeStdout(stdout: string): ReleaseRecord {
  const parsed = JSON.parse(stdout || "{}");
  if (!isRecord(parsed) || parsed.status !== "pass") {
    throw new Error("public entrypoint/bin smoke did not return status=pass");
  }
  return parsed;
}

function ensurePass(stepId: string, result: CommandResult | null): ReleaseIssue | null {
  if (!result || result.exit_code !== 0 || result.exception === true) {
    return commandBlock(stepId, result);
  }
  return null;
}

function cleanCopyFilter(sourceRoot: string, excludes: string[]) {
  const excluded = new Set(excludes);
  return (source: string) => {
    const rel = relative(sourceRoot, source);
    if (!rel) {
      return true;
    }
    const first = rel.split(sep)[0];
    return !excluded.has(first);
  };
}

function prepareCleanWorkspace(plan: CleanEnvironmentPlan, options: CleanEnvironmentOptions = Object()): CommandResult {
  const source: Partial<CleanEnvironmentSource> = plan.source || Object();
  if (source.mode === "git_clone") {
    const args = ["clone"];
    if (source.ref) {
      args.push("--branch", source.ref);
    }
    args.push(source.repository_url as string, plan.workspace.clean_worktree);
    return runCommand("git", args, plan.yolo_root, options);
  }

  const startedAt = new Date().toISOString();
  try {
    mkdirSync(dirname(plan.workspace.clean_worktree), { recursive: true });
    cpSync(source.source_root || plan.yolo_root, plan.workspace.clean_worktree, {
      recursive: true,
      filter: cleanCopyFilter(source.source_root || plan.yolo_root, source.excluded_paths || DEFAULT_COPY_EXCLUDES),
    });
    return {
      command: `copy ${source.source_root || plan.yolo_root} ${plan.workspace.clean_worktree}`,
      args: ["copy", source.source_root || plan.yolo_root, plan.workspace.clean_worktree],
      cwd: plan.yolo_root,
      exit_code: 0,
      signal: null,
      status: "pass",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      stdout: "",
      stderr: "",
      stdout_tail: "",
      stderr_tail: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      command: `copy ${source.source_root || plan.yolo_root} ${plan.workspace.clean_worktree}`,
      args: ["copy", source.source_root || plan.yolo_root, plan.workspace.clean_worktree],
      cwd: plan.yolo_root,
      exit_code: 1,
      signal: null,
      status: "exception",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      stdout: "",
      stderr: message,
      stdout_tail: "",
      stderr_tail: message,
      exception: true,
    };
  }
}

function writeConsumerPackageJson(consumerDir: string): void {
  writeFileSync(join(consumerDir, "package.json"), `${JSON.stringify({
    name: "yolo-clean-environment-verify-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
  }, null, 2)}\n`, "utf8");
}

function writePublicEntrypointBinSmoke(filePath: string, plan: CleanEnvironmentPlan): void {
  const source = `import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const importSpecifiers = ${JSON.stringify(plan.package.import_specifiers, null, 2)};
const binNames = ${JSON.stringify(plan.package.bin_names, null, 2)};
const imported = [];
for (const specifier of importSpecifiers) {
  const module = await import(specifier);
  assert.ok(Object.keys(module).length > 0, \`\${specifier} exported no bindings\`);
  imported.push({ specifier, export_count: Object.keys(module).length });
}

const binChecks = [];
for (const binName of binNames) {
  const binPath = join(process.cwd(), "node_modules", ".bin", binName);
  assert.equal(existsSync(binPath), true, \`\${binName} package bin missing\`);
  const result = spawnSync(binPath, ["--help"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, \`\${binName} --help failed: \${result.stderr || result.stdout}\`);
  assert.equal(result.stderr, "", \`\${binName} --help wrote stderr\`);
  assert.ok(String(result.stdout || "").trim().length > 0, \`\${binName} --help wrote no stdout\`);
  binChecks.push({ bin: binName, stdout_bytes: result.stdout.length });
}

console.log(JSON.stringify({
  status: "pass",
  imported_count: imported.length,
  bin_count: binChecks.length,
  imported,
  bin_checks: binChecks
}));
`;
  writeFileSync(filePath, source, "utf8");
}

function isManagedCleanEnvironmentTempRoot(tempRoot: string): boolean {
  return basename(resolve(tempRoot)).startsWith(CLEAN_ENVIRONMENT_TEMP_PREFIX);
}

export function executeCleanEnvironmentVerifyPlan(plan: CleanEnvironmentPlan, options: CleanEnvironmentOptions = Object()): CleanEnvironmentVerifyResult {
  const keepWorkspace = options.keepWorkspace === true;
  const cleanup = options.cleanup !== false;
  const explicitTempRoot = options.tempRoot || options.temp_root;
  const createdTempRoot = explicitTempRoot
    ? null
    : mkdtempSync(join(resolve(options.tmpRoot || tmpdir()), CLEAN_ENVIRONMENT_TEMP_PREFIX));
  const tempRoot = explicitTempRoot || createdTempRoot;
  const activePlan = materializeWorkspace(plan, resolve(tempRoot as string));
  const completedSteps: CompletedStep[] = [];
  const run = options.commandRunner || runCommand;
  const prepare = options.prepareWorkspace || prepareCleanWorkspace;
  const exists = options.existsSync || existsSync;

  try {
    mkdirSync(activePlan.workspace.pack_destination, { recursive: true });
    mkdirSync(activePlan.workspace.consumer, { recursive: true });

    const prepareResult = prepare(activePlan, options);
    completedSteps.push({ id: "prepare_clean_source", status: prepareResult.status, command: prepareResult });
    const prepareBlock = ensurePass("prepare_clean_source", prepareResult);
    if (prepareBlock) {
      return blockResult(activePlan, completedSteps, prepareBlock, keepWorkspace);
    }

    const installUsesCi = hasNpmCiLock(activePlan.workspace.clean_worktree, exists);
    const installArgs = installUsesCi ? ["ci"] : ["install"];
    const install = run("npm", installArgs, activePlan.workspace.clean_worktree, options);
    completedSteps.push({ id: "install_dependencies", status: install.status, command: install, selected_command: ["npm", ...installArgs].join(" ") });
    const installBlock = ensurePass("install_dependencies", install);
    if (installBlock) {
      return blockResult(activePlan, completedSteps, installBlock, keepWorkspace);
    }

    const verify = run("npm", ["run", "verify"], activePlan.workspace.clean_worktree, options);
    completedSteps.push({ id: "verify", status: verify.status, command: verify });
    const verifyBlock = ensurePass("verify", verify);
    if (verifyBlock) {
      return blockResult(activePlan, completedSteps, verifyBlock, keepWorkspace);
    }

    const pack = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", activePlan.workspace.pack_destination], activePlan.workspace.clean_worktree, options);
    completedSteps.push({ id: "pack", status: pack.status, command: pack });
    const packBlock = ensurePass("pack", pack);
    if (packBlock) {
      return blockResult(activePlan, completedSteps, packBlock, keepWorkspace);
    }

    let packInfo;
    try {
      packInfo = parseNpmPackStdout(pack.stdout);
      completedSteps[completedSteps.length - 1].parsed_stdout = packInfo;
    } catch (error) {
      return blockResult(activePlan, completedSteps, {
        code: "CLEAN_VERIFY_PACK_STDOUT_UNPARSEABLE",
        step_id: "pack",
        message: "npm pack stdout was not parseable package metadata",
        command: pack.command,
        error: error instanceof Error ? error.message : String(error),
        stdout_tail: pack.stdout_tail || "",
        stderr_tail: pack.stderr_tail || "",
      }, keepWorkspace);
    }

    const tarball = join(activePlan.workspace.pack_destination, packInfo.filename);
    if (!exists(tarball)) {
      return blockResult(activePlan, completedSteps, {
        code: "CLEAN_VERIFY_PACK_TARBALL_MISSING",
        step_id: "pack",
        message: "npm pack did not create the expected tarball in the isolated pack destination",
        tarball,
        filename: packInfo.filename,
      }, keepWorkspace);
    }

    writeConsumerPackageJson(activePlan.workspace.consumer);
    const installTarball = run("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--fund=false",
      "--package-lock=false",
      tarball,
    ], activePlan.workspace.consumer, options);
    completedSteps.push({ id: "install_tarball", status: installTarball.status, command: installTarball, tarball });
    const installTarballBlock = ensurePass("install_tarball", installTarball);
    if (installTarballBlock) {
      return blockResult(activePlan, completedSteps, installTarballBlock, keepWorkspace);
    }

    const smokeScript = join(activePlan.workspace.consumer, "public-entrypoint-bin-smoke.mjs");
    writePublicEntrypointBinSmoke(smokeScript, activePlan);
    const smoke = run(process.execPath, [smokeScript], activePlan.workspace.consumer, options);
    completedSteps.push({ id: "public_entrypoint_bin_smoke", status: smoke.status, command: smoke });
    const smokeBlock = ensurePass("public_entrypoint_bin_smoke", smoke);
    if (smokeBlock) {
      return blockResult(activePlan, completedSteps, smokeBlock, keepWorkspace);
    }
    try {
      completedSteps[completedSteps.length - 1].parsed_stdout = parseSmokeStdout(smoke.stdout);
    } catch (error) {
      return blockResult(activePlan, completedSteps, {
        code: "CLEAN_VERIFY_SMOKE_STDOUT_UNPARSEABLE",
        step_id: "public_entrypoint_bin_smoke",
        message: "public entrypoint/bin smoke stdout was not parseable pass JSON",
        command: smoke.command,
        error: error instanceof Error ? error.message : String(error),
        stdout_tail: smoke.stdout_tail || "",
        stderr_tail: smoke.stderr_tail || "",
      }, keepWorkspace);
    }

    return {
      status: "pass",
      blocks_release: false,
      exit_code: 0,
      dry_run: false,
      summary: "clean environment verification passed from isolated source through package install smoke",
      plan: activePlan,
      workspace: keepWorkspace ? activePlan.workspace : null,
      steps: completedSteps,
      blockers: [],
      tarball: keepWorkspace ? tarball : packInfo.filename,
      next_actions: ["Keep this clean environment verification in the release-candidate gate."],
    };
  } finally {
    if (cleanup && !keepWorkspace && createdTempRoot && isManagedCleanEnvironmentTempRoot(activePlan.workspace.temp_root)) {
      rmSync(activePlan.workspace.temp_root, { recursive: true, force: true });
    }
  }
}

export function runCleanEnvironmentVerify(options: CleanEnvironmentOptions = Object()): CleanEnvironmentVerifyResult {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const packageJson = options.packageJson || readJson(join(yoloRoot, "package.json"));
  const plan = buildCleanEnvironmentVerifyPlan({
    ...options,
    yoloRoot,
    packageJson,
    hasNpmCiLock: options.hasNpmCiLock ?? hasNpmCiLock(yoloRoot, options.existsSync || existsSync),
  });

  if (options.dryRun === true || options.dry_run === true) {
    return {
      status: "success",
      blocks_release: false,
      exit_code: 0,
      dry_run: true,
      summary: "planned clean environment verification without side effects",
      plan,
      steps: plan.steps.map((item) => ({ id: item.id, status: "planned", command: item.command })),
      blockers: [],
      next_actions: ["Run without dryRun to clone/copy into an isolated temp directory and execute the verification plan."],
    };
  }

  const executor = options.executor || executeCleanEnvironmentVerifyPlan;
  return executor(plan, options);
}
