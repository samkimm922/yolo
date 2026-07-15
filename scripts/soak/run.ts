#!/usr/bin/env tsx
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runYoloCli } from "../../src/cli/yolo.js";
import {
  classifyFakeSuccessReport,
  type FakeSuccessClassification,
  type RunReport,
} from "../../src/release/readiness.js";

const DEFAULT_FIXTURES = Object.freeze(["frontend-vite", "backend-api"]);
const DEFAULT_ROUNDS = 2;
const YOLO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Loose, write-only stream shape accepted by the YOLO CLI io bag. The CLI reads
 * `io.stdout`/`io.stderr` as optional duck-typed writable streams (see
 * src/cli/split/commands.ts), so this mirrors the contract it consumes rather
 * than narrowing the exported runYoloCli signature.
 */
interface StreamLike {
  write(chunk: unknown): boolean;
}

/** Structural shape of the JSON run reports produced by the YOLO CLI. */
type SoakRunReport = RunReport;

/** A parsed descriptor fixture (fixtures/<name>/fixture.json). */
type FixtureDescriptor = Record<string, unknown>;

interface SoakOptions {
  rounds: number;
  fixtures: string[];
  dryRun: boolean;
  real: boolean;
  help: boolean;
}

/** Subset of SoakOptions carried through runSoak into each round fixture. */
interface NormalizedSoakOptions {
  rounds: number;
  fixtures: string[];
  dryRun: boolean;
}

/**
 * Loose input bag accepted by runSoak(). All fields are optional because callers
 * (the CLI, tests, programmatic users) pass partial overrides on top of the
 * DEFAULT_ROUNDS/DEFAULT_FIXTURES/dryRun defaults. Mirrors the untyped
 * `options = Object()` baseline contract.
 */
interface SoakRunInput {
  rounds?: number;
  fixtures?: string[];
  dryRun?: boolean;
}

/** Result of a single CLI invocation captured by the soak harness. */
interface CommandResult {
  command: string;
  argv: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
  report: SoakRunReport | null;
}

/** A captured command result tagged with its soak step name. */
interface CommandRecord extends CommandResult {
  step: string;
}

interface CommandFailure {
  round: number;
  fixture: string;
  step: string;
  command: string;
  exit_code: number;
  expected_exit_codes: number[];
  code: string | null;
  status: string | null;
  summary: string;
}

interface RoundFixtureResult {
  reports: SoakRunReport[];
  failures: CommandFailure[];
  commands: CommandRecord[];
}

interface FixtureDetails {
  root: string;
  descriptor: FixtureDescriptor;
  targetFile: string;
  testFile: string;
  testCommand: string;
  requirementText: string;
  requirementId: string;
  title: string;
}

interface PresetInterview {
  idea: string;
  title: string;
  answers: [string, string][];
}

/** Runtime context threaded through a single fixture run. */
interface CliCommandContext {
  projectRoot: string;
  yoloRoot: string;
  runYoloCli: typeof runYoloCli;
}

/** io bag passed to main(), mirroring what the YOLO CLI dispatcher consumes. */
interface MainIo {
  stdout?: { write(chunk: unknown): boolean } | null;
  stderr?: { write(chunk: unknown): boolean } | null;
  yoloRoot?: string;
  runSoak?: typeof runSoak;
  runYoloCli?: typeof runYoloCli;
}

/** Dependencies injected into runSoak(). */
interface SoakDeps {
  yoloRoot?: string;
  runYoloCli?: typeof runYoloCli;
}

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object") ? value as Record<string, unknown> : {};
}

function rateValue(numerator: number, denominator: number) {
  if (!denominator || denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function readArgValue(argv: string[], index: number): { value: string | undefined; consumed: number } {
  const arg = argv[index] || "";
  if (arg.includes("=")) return { value: arg.split("=").slice(1).join("="), consumed: 0 };
  return { value: argv[index + 1], consumed: 1 };
}

export function parseSoakArgs(argv: string[] = []): SoakOptions {
  const options: SoakOptions = {
    rounds: DEFAULT_ROUNDS,
    fixtures: [...DEFAULT_FIXTURES],
    dryRun: true,
    real: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--rounds" || arg.startsWith("--rounds=")) {
      const read = readArgValue(argv, i);
      options.rounds = Number(read.value);
      i += read.consumed;
    } else if (arg === "--fixtures" || arg.startsWith("--fixtures=")) {
      const read = readArgValue(argv, i);
      options.fixtures = String(read.value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      i += read.consumed;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--real") {
      options.real = true;
      options.dryRun = false;
    } else {
      throw new Error(`Unknown soak option: ${arg}`);
    }
  }

  if (!Number.isInteger(options.rounds) || options.rounds <= 0) {
    throw new Error("--rounds must be a positive integer.");
  }
  if (options.fixtures.length === 0) {
    throw new Error("--fixtures must include at least one fixture name.");
  }

  return options;
}

export function usage() {
  return [
    "Usage:",
    "  npm run soak -- [--rounds N] [--fixtures frontend-vite,backend-api] [--dry-run]",
    "",
    "--dry-run is the default. --real is reserved and exits until an executor is configured.",
  ].join("\n");
}

function captureStream() {
  let value = "";
  const stream: StreamLike = {
    write(chunk: unknown) {
      value += String(chunk);
      return true;
    },
  };
  return {
    stream,
    text() {
      return value;
    },
    json(): SoakRunReport | null {
      const text = value.trim();
      return text ? (JSON.parse(text) as SoakRunReport) : null;
    },
  };
}

function fixtureRoot(name: string, yoloRoot = YOLO_ROOT) {
  return resolve(yoloRoot, "fixtures", name);
}

function copyFixtureToProject(source: string, destination: string) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(destination, entry), { recursive: true });
  }
}

function firstSourceFile(descriptor: FixtureDescriptor = Object()) {
  const files = asArray<string>(descriptor.files).map(clean).filter(Boolean);
  return files.find((file) => /^src\//.test(file))
    || files.find((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file))
    || "src/index.ts";
}

function firstTestFile(descriptor: FixtureDescriptor = Object()) {
  const files = asArray<string>(descriptor.files).map(clean).filter(Boolean);
  return files.find((file) => /(^|\/)(test|tests|__tests__)\//.test(file))
    || files.find((file) => /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file))
    || "test/index.test.ts";
}

function fixtureDetails(name: string, yoloRoot = YOLO_ROOT): FixtureDetails {
  const root = fixtureRoot(name, yoloRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Fixture not found: ${name}`);
  }
  const descriptorPath = join(root, "fixture.json");
  const descriptor: FixtureDescriptor = existsSync(descriptorPath)
    ? asRecord(readJson(descriptorPath))
    : {};
  const targetFile = firstSourceFile(descriptor);
  const testFile = firstTestFile(descriptor);
  const run = asRecord(descriptor.run);
  const commands = asArray<unknown>(run.commands);
  const testCommand = clean(commands[0]) || "npm test";
  const requirement = asRecord(descriptor.requirement);
  const requirementText = clean(requirement.text)
    || clean(descriptor.description)
    || `Exercise fixture ${name}.`;
  const requirementId = clean(requirement.id) || `REQ-${name.toUpperCase()}`;
  return {
    root,
    descriptor,
    targetFile,
    testFile,
    testCommand,
    requirementText,
    requirementId,
    title: clean(descriptor.label) || name,
  };
}

function presetInterview(details: FixtureDetails): PresetInterview {
  const { requirementText, requirementId, targetFile, testFile, testCommand, title } = details;
  const demandText = `Verify ${title} fixture requirement ${requirementId} through the existing smoke test.`;
  const idea = [
    demandText,
    `Files: ${targetFile}`,
    `Evidence: ${targetFile} exists in the fixture and ${testCommand} is the acceptance command.`,
  ].join("\n");
  return {
    idea,
    title,
    answers: [
      ["premise_consequence", `Without this flow, ${requirementId} can be skipped and a release can claim success without canonical smoke evidence.`],
      ["premise_minimum", `The minimum useful version verifies ${requirementId} through ${targetFile} and records the ${testCommand} result.`],
      ["premise_decision", "Continue."],
      ["target_users", `Release managers and fixture maintainers check ${title} daily before publishing and are responsible for confirming the smoke test result.`],
      ["status_quo", `Currently release maintainers manually run ${testCommand} in the fixture system and check ${testFile}; the process gets stuck when the canonical path is skipped.`],
      ["pain_points", `There is release risk because a run can claim success when ${requirementId} was not exercised through the canonical demand to auto path.`],
      ["layer_1_confirmation", "Confirmed, the roles, current flow, and pain are complete."],
      ["day_in_life", `Before publishing, the release maintainer opens the fixture, runs ${testCommand}, reviews ${testFile}, and records whether ${requirementId} passed.`],
      ["desired_outcome", `Release managers can verify the fixture behavior through ${targetFile} without touching unrelated files or delaying the fixture signoff.`],
      ["layer_2_confirmation", "Confirmed, this is the complete day-in-the-life flow."],
      ["exceptions", "No special cases beyond missing or failed fixture files; if the fixture test command is missing or failed, the soak round must not pass."],
      ["scope_boundaries", `Only ${targetFile}, ${testFile}, and generated .yolo artifacts are in scope; do not change roles, workflow, data, unrelated APIs, or UI.`],
      ["layer_3_confirmation", "Confirmed, the exceptions and boundaries are complete."],
      ["success_criteria", `Record a pass status when ${testCommand} validates ${testFile} and the behavior in ${targetFile} for ${requirementId}.`],
      ["layer_4_confirmation", "Confirmed, the requirement has observable acceptance evidence."],
      ["requirements_confirmation", "Confirmed, R-001 is accurate and complete."],
      ["execution_approval", "Approved, proceed to PRD and dry-run auto only."],
    ],
  };
}

async function runCliCommand(argv: string[], context: CliCommandContext): Promise<CommandResult> {
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await context.runYoloCli(argv, {
    cwd: context.projectRoot,
    stdout: stdout.stream,
    stderr: stderr.stream,
    yoloRoot: context.yoloRoot,
  });
  let report: SoakRunReport | null = null;
  try {
    report = stdout.json();
  } catch {
    report = null;
  }
  return {
    command: ["yolo", ...argv].join(" "),
    argv,
    exit_code: exitCode,
    stdout: stdout.text(),
    stderr: stderr.text(),
    report,
  };
}

function commandFailure(
  round: number,
  fixture: string,
  step: string,
  result: CommandResult,
  expectedExitCodes: number[],
): CommandFailure {
  // Field access on a RunReport (Record<string, unknown>) yields unknown; preserve
  // the original truthiness (`|| null` / chained `||`) semantics verbatim.
  const report = result.report ? asRecord(result.report) : {};
  const code = report.code || null;
  const status = report.status || null;
  const summary = report.summary || clean(result.stderr) || clean(result.stdout) || "command failed";
  return {
    round,
    fixture,
    step,
    command: result.command,
    exit_code: result.exit_code,
    expected_exit_codes: expectedExitCodes,
    code: code as string | null,
    status: status as string | null,
    summary: summary as string,
  };
}

function pushRunReport(
  reports: SoakRunReport[],
  round: number,
  fixture: string,
  step: string,
  result: CommandResult,
): void {
  if (!result.report || typeof result.report !== "object") return;
  const report = asRecord(result.report);
  // Preserve original `||` fallback: prefer the report's run_id, else synthesize one.
  const runId = report.run_id || `soak-${fixture}-r${round}-${step}`;
  reports.push({
    ...result.report,
    run_id: runId as string,
    soak_round: round,
    fixture,
    soak_step: step,
  });
}

function findJsonReports(root: string, names: string[]): { path: string; report: SoakRunReport }[] {
  const found: { path: string; report: SoakRunReport }[] = [];
  function visit(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".json") && names.some((name) => entry.name.includes(name))) {
        try {
          found.push({ path, report: asRecord(readJson(path)) as SoakRunReport });
        } catch {
          // Ignore malformed side reports; the command result remains the source of truth.
        }
      }
    }
  }
  visit(root);
  return found;
}

export function summarizeFakeSuccess(reports: SoakRunReport[] = []) {
  const fakeReports = reports
    .map((report) => classifyFakeSuccessReport(report))
    .filter((report): report is FakeSuccessClassification => report !== null);
  return {
    fake_success: fakeReports.length,
    fake_success_rate: rateValue(fakeReports.length, reports.length),
    fake_success_reports: fakeReports,
    run_report_count: reports.length,
  };
}

export function buildSoakSummary({
  rounds,
  fixtures,
  reports = [],
  failures = [],
}: {
  rounds: number;
  fixtures: string[];
  reports?: SoakRunReport[];
  failures?: CommandFailure[];
}) {
  const fake = summarizeFakeSuccess(reports);
  return {
    rounds,
    fixtures,
    fake_success: fake.fake_success,
    fake_success_rate: fake.fake_success_rate,
    failures,
  };
}

async function runRoundFixture({
  round,
  fixture,
  options,
  yoloRoot,
  runYoloCli: cli,
}: {
  round: number;
  fixture: string;
  options: NormalizedSoakOptions;
  yoloRoot: string;
  runYoloCli: typeof runYoloCli;
}): Promise<RoundFixtureResult> {
  const details = fixtureDetails(fixture, yoloRoot);
  const tempRoot = mkdtempSync(join(tmpdir(), `yolo-soak-${fixture}-r${round}-`));
  const projectRoot = join(tempRoot, basename(details.root));
  const reports: SoakRunReport[] = [];
  const failures: CommandFailure[] = [];
  const commands: CommandRecord[] = [];
  // `options` is part of the run contract (e.g. dryRun) but the canonical soak
  // path below does not read it directly; the binding is kept so the caller
  // shape is unchanged from the untyped baseline.

  try {
    copyFixtureToProject(details.root, projectRoot);
    const interview = presetInterview(details);
    const context: CliCommandContext = { projectRoot, yoloRoot, runYoloCli: cli };

    async function step(name: string, argv: string[], expectedExitCodes: number[] = [0]): Promise<CommandResult> {
      const result = await runCliCommand(argv, context);
      commands.push({ step: name, ...result });
      pushRunReport(reports, round, fixture, name, result);
      if (!expectedExitCodes.includes(result.exit_code)) {
        failures.push(commandFailure(round, fixture, name, result, expectedExitCodes));
      }
      return result;
    }

    const init = await step("init", [
      "init",
      projectRoot,
      "--name",
      `soak-${fixture}-r${round}`,
      "--json",
    ]);
    // baseline assigned but did not read init; keep assignment verbatim
    void init;
    if (failures.length) return { reports, failures, commands };

    const start = await step("interview-start", [
      "interview",
      "start",
      interview.idea,
      "--cwd",
      projectRoot,
      "--id",
      `soak-${fixture}-r${round}`,
      "--title",
      details.title,
      "--json",
    ]);
    if (failures.length) return { reports, failures, commands };

    const startReport = start.report ? asRecord(start.report) : {};
    const sessionPath = startReport.session_path;
    if (!sessionPath) {
      failures.push({
        round,
        fixture,
        step: "interview-start",
        command: start.command,
        exit_code: start.exit_code,
        expected_exit_codes: [0],
        code: "SOAK_SESSION_PATH_MISSING",
        status: start.report?.status || null,
        summary: "Interview start did not return session_path.",
      });
      return { reports, failures, commands };
    }

    async function confirmPlayback(stepPrefix: string): Promise<boolean> {
      const generatedPlayback = await step(`${stepPrefix}-generate`, [
        "interview",
        "playback",
        "--session",
        sessionPath as string,
        "--json",
      ]);
      if (failures.length) return false;
      const generatedReport = asRecord(generatedPlayback.report);
      const generatedOutput = asRecord(asArray<Record<string, unknown>>(generatedReport.outputs)[0]);
      const playbackHash = clean(asRecord(generatedOutput.playback).content_hash);
      if (!playbackHash) {
        failures.push({
          round,
          fixture,
          step: `${stepPrefix}-generate`,
          command: generatedPlayback.command,
          exit_code: generatedPlayback.exit_code,
          expected_exit_codes: [0],
          code: "SOAK_PLAYBACK_HASH_MISSING",
          status: generatedPlayback.report?.status || null,
          summary: "Playback generation did not return a content_hash.",
        });
        return false;
      }

      const playback = await step(`${stepPrefix}-confirm`, [
        "interview",
        "playback",
        "--session",
        sessionPath as string,
        "--confirm",
        playbackHash,
        "--json",
      ]);
      if (failures.length) return false;
      const playbackReport = playback.report ? asRecord(playback.report) : {};
      if (playbackReport.code !== "PLAYBACK_CONFIRMED") {
        failures.push({
          round,
          fixture,
          step: `${stepPrefix}-confirm`,
          command: playback.command,
          exit_code: playback.exit_code,
          expected_exit_codes: [0],
          code: "SOAK_PLAYBACK_NOT_CONFIRMED",
          status: playback.report?.status || null,
          summary: "Playback did not confirm understanding.",
        });
        return false;
      }
      return true;
    }

    for (const [question, answer] of interview.answers) {
      await step(`interview-answer-${question}`, [
        "interview",
        "answer",
        "--session",
        sessionPath as string,
        "--question",
        question,
        "--answer",
        answer,
        "--json",
      ]);
      if (failures.length) return { reports, failures, commands };
      if (question === "premise_decision" && !await confirmPlayback("interview-initial-playback")) {
        return { reports, failures, commands };
      }
    }

    if (!await confirmPlayback("interview-playback")) {
      return { reports, failures, commands };
    }

    const toDemand = await step("interview-to-demand", [
      "interview",
      "to-demand",
      "--session",
      sessionPath as string,
      "--cwd",
      projectRoot,
      "--json",
    ]);
    if (failures.length) return { reports, failures, commands };

    const toDemandReport = toDemand.report ? asRecord(toDemand.report) : {};
    const demandDir = toDemandReport.demand_dir;
    if (!demandDir) {
      failures.push({
        round,
        fixture,
        step: "interview-to-demand",
        command: toDemand.command,
        exit_code: toDemand.exit_code,
        expected_exit_codes: [0],
        code: "SOAK_DEMAND_DIR_MISSING",
        status: toDemand.report?.status || null,
        summary: "to-demand did not return demand_dir.",
      });
      return { reports, failures, commands };
    }

    await step("tasks", ["tasks", "--demand", demandDir as string, "--cwd", projectRoot, "--json"]);
    if (failures.length) return { reports, failures, commands };

    const prd = await step("prd", ["spec", "--demand", demandDir as string, "--json"]);
    if (failures.length) return { reports, failures, commands };

    const prdReport = prd.report ? asRecord(prd.report) : {};
    const outputs = asArray<Record<string, unknown>>(prdReport.outputs);
    const artifacts = asArray<unknown>(prdReport.artifacts);
    // Preserve the original chained `||` precedence over the candidate PRD paths.
    const prdPath = prdReport.prd_path
      || prdReport.output_path
      || outputs.find((output) => output?.type === "prd" && output?.path)?.path
      || artifacts.find((path) => /(^|[/\\])prd\.json$/.test(String(path)));
    if (!prdPath) {
      failures.push({
        round,
        fixture,
        step: "prd",
        command: prd.command,
        exit_code: prd.exit_code,
        expected_exit_codes: [0],
        code: "SOAK_PRD_PATH_MISSING",
        status: prd.report?.status || null,
        summary: "PRD generation did not return a JSON artifact path.",
      });
      return { reports, failures, commands };
    }

    await step("check", ["check", prdPath as string, "--cwd", projectRoot, "--json"]);
    if (failures.length) return { reports, failures, commands };

    await step("auto-dry-run", [
      "auto",
      details.requirementText,
      "--cwd",
      projectRoot,
      "--dry-run",
      "--json",
    ], [2]);

    for (const item of findJsonReports(join(projectRoot, ".yolo"), ["run", "acceptance"])) {
      const itemReport = asRecord(item.report);
      // Preserve original `||` fallback for the synthesized run_id.
      const runId = itemReport.run_id || `soak-${fixture}-r${round}-${basename(item.path)}`;
      reports.push({
        ...item.report,
        run_id: runId as string,
        soak_round: round,
        fixture,
        soak_report_path: item.path,
      });
    }

    return { reports, failures, commands };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function runSoak(options: SoakRunInput = Object(), deps: SoakDeps = Object()) {
  const normalized: NormalizedSoakOptions = {
    rounds: options.rounds ?? DEFAULT_ROUNDS,
    fixtures: options.fixtures ?? [...DEFAULT_FIXTURES],
    dryRun: options.dryRun !== false,
  };
  const yoloRoot = deps.yoloRoot || YOLO_ROOT;
  const cli = deps.runYoloCli || runYoloCli;
  const reports: SoakRunReport[] = [];
  const failures: CommandFailure[] = [];

  for (let round = 1; round <= normalized.rounds; round += 1) {
    for (const fixture of normalized.fixtures) {
      try {
        const result = await runRoundFixture({
          round,
          fixture,
          options: normalized,
          yoloRoot,
          runYoloCli: cli,
        });
        reports.push(...result.reports);
        failures.push(...result.failures);
      } catch (error) {
        failures.push({
          round,
          fixture,
          step: "setup",
          command: "soak fixture setup",
          exit_code: 1,
          expected_exit_codes: [0],
          code: "SOAK_FIXTURE_FAILED",
          status: "error",
          summary: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const summary = buildSoakSummary({
    rounds: normalized.rounds,
    fixtures: normalized.fixtures,
    reports,
    failures,
  });
  const exitCode = summary.failures.length > 0 || summary.fake_success_rate > 0 ? 1 : 0;
  return { summary, exitCode, reports };
}

export async function main(argv: string[] = process.argv.slice(2), io: MainIo = Object()): Promise<number> {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let options: SoakOptions;

  try {
    options = parseSoakArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  if (options.help) {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  if (options.real) {
    stdout.write("需配置 executor 后使用\n");
    return 2;
  }

  const result = io.runSoak
    ? await io.runSoak(options)
    : await runSoak(options, {
      yoloRoot: io.yoloRoot,
      runYoloCli: io.runYoloCli,
    });
  stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  stdout.write(`[soak] rounds=${result.summary.rounds} fixtures=${result.summary.fixtures.join(",")} fake_success=${result.summary.fake_success} fake_success_rate=${result.summary.fake_success_rate} failures=${result.summary.failures.length}\n`);
  return result.summary.failures.length > 0 || result.summary.fake_success_rate > 0 ? 1 : 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
