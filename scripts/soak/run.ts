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
import { classifyFakeSuccessReport } from "../../src/release/readiness.js";

const DEFAULT_FIXTURES = Object.freeze(["frontend-vite", "backend-api"]);
const DEFAULT_ROUNDS = 2;
const YOLO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function rateValue(numerator: number, denominator: number) {
  if (!denominator || denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(1));
}

function readArgValue(argv: string[], index: number) {
  const arg = argv[index] || "";
  if (arg.includes("=")) return { value: arg.split("=").slice(1).join("="), consumed: 0 };
  return { value: argv[index + 1], consumed: 1 };
}

export function parseSoakArgs(argv = []) {
  const options = {
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
  return {
    stream: {
      write(chunk: unknown) {
        value += String(chunk);
        return true;
      },
    },
    text() {
      return value;
    },
    json() {
      const text = value.trim();
      return text ? JSON.parse(text) : null;
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

function firstSourceFile(descriptor = Object()) {
  const files = asArray(descriptor.files).map(clean).filter(Boolean);
  return files.find((file) => /^src\//.test(file))
    || files.find((file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file))
    || "src/index.ts";
}

function firstTestFile(descriptor = Object()) {
  const files = asArray(descriptor.files).map(clean).filter(Boolean);
  return files.find((file) => /(^|\/)(test|tests|__tests__)\//.test(file))
    || files.find((file) => /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file))
    || "test/index.test.ts";
}

function fixtureDetails(name: string, yoloRoot = YOLO_ROOT) {
  const root = fixtureRoot(name, yoloRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Fixture not found: ${name}`);
  }
  const descriptorPath = join(root, "fixture.json");
  const descriptor = existsSync(descriptorPath) ? readJson(descriptorPath) : {};
  const targetFile = firstSourceFile(descriptor);
  const testFile = firstTestFile(descriptor);
  const testCommand = clean(descriptor.run?.commands?.[0]) || "npm test";
  const requirementText = clean(descriptor.requirement?.text)
    || clean(descriptor.description)
    || `Exercise fixture ${name}.`;
  const requirementId = clean(descriptor.requirement?.id) || `REQ-${name.toUpperCase()}`;
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

function presetInterview(details) {
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
      ["target_users", `Release managers and fixture maintainers check ${title} daily before publishing and are responsible for confirming the smoke test result.`],
      ["status_quo", `Currently release maintainers manually run ${testCommand} in the fixture system and check ${testFile}; the process gets stuck when the canonical path is skipped.`],
      ["pain_points", `There is release risk because a run can claim success when ${requirementId} was not exercised through the canonical demand to auto path.`],
      ["desired_outcome", `Release managers can verify the fixture behavior through ${targetFile} without touching unrelated files or delaying the fixture signoff.`],
      ["success_criteria", `Record a pass status when ${testCommand} validates ${testFile} and the behavior in ${targetFile} for ${requirementId}.`],
      ["success_proof", `Run ${testCommand}, verify the pass record, and confirm ${testFile} exercises ${targetFile} for ${requirementId}.`],
      ["scope_boundaries", `Only ${targetFile}, ${testFile}, and generated .yolo artifacts are in scope; do not change roles, workflow, data, unrelated APIs, or UI.`],
      ["exceptions", "No special cases beyond missing or failed fixture files; if the fixture test command is missing or failed, the soak round must not pass."],
      ["mvp_priority", `MVP is the single fixture requirement ${requirementId}; broader refactors can come later.`],
      ["execution_approval", "Approved, proceed to PRD and dry-run auto only."],
    ],
  };
}

async function runCliCommand(argv: string[], context) {
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await context.runYoloCli(argv, {
    cwd: context.projectRoot,
    stdout: stdout.stream,
    stderr: stderr.stream,
    yoloRoot: context.yoloRoot,
  });
  let report = null;
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

function commandFailure(round, fixture, step, result, expectedExitCodes) {
  return {
    round,
    fixture,
    step,
    command: result.command,
    exit_code: result.exit_code,
    expected_exit_codes: expectedExitCodes,
    code: result.report?.code || null,
    status: result.report?.status || null,
    summary: result.report?.summary || clean(result.stderr) || clean(result.stdout) || "command failed",
  };
}

function pushRunReport(reports, round, fixture, step, result) {
  if (!result.report || typeof result.report !== "object") return;
  reports.push({
    ...result.report,
    run_id: result.report.run_id || `soak-${fixture}-r${round}-${step}`,
    soak_round: round,
    fixture,
    soak_step: step,
  });
}

function findJsonReports(root: string, names: string[]) {
  const found = [];
  function visit(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".json") && names.some((name) => entry.name.includes(name))) {
        try {
          found.push({ path, report: readJson(path) });
        } catch {
          // Ignore malformed side reports; the command result remains the source of truth.
        }
      }
    }
  }
  visit(root);
  return found;
}

export function summarizeFakeSuccess(reports = []) {
  const fakeReports = reports.map((report) => classifyFakeSuccessReport(report)).filter(Boolean);
  return {
    fake_success: fakeReports.length,
    fake_success_rate: rateValue(fakeReports.length, reports.length),
    fake_success_reports: fakeReports,
    run_report_count: reports.length,
  };
}

export function buildSoakSummary({ rounds, fixtures, reports = [], failures = [] }) {
  const fake = summarizeFakeSuccess(reports);
  return {
    rounds,
    fixtures,
    fake_success: fake.fake_success,
    fake_success_rate: fake.fake_success_rate,
    failures,
  };
}

async function runRoundFixture({ round, fixture, options, yoloRoot, runYoloCli: cli }) {
  const details = fixtureDetails(fixture, yoloRoot);
  const tempRoot = mkdtempSync(join(tmpdir(), `yolo-soak-${fixture}-r${round}-`));
  const projectRoot = join(tempRoot, basename(details.root));
  const reports = [];
  const failures = [];
  const commands = [];

  try {
    copyFixtureToProject(details.root, projectRoot);
    const interview = presetInterview(details);
    const context = { projectRoot, yoloRoot, runYoloCli: cli };

    async function step(name: string, argv: string[], expectedExitCodes = [0]) {
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

    const sessionPath = start.report?.session_path;
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

    for (const [question, answer] of interview.answers) {
      await step(`interview-answer-${question}`, [
        "interview",
        "answer",
        "--session",
        sessionPath,
        "--question",
        question,
        "--answer",
        answer,
        "--json",
      ]);
      if (failures.length) return { reports, failures, commands };
    }

    const playback = await step("interview-playback", [
      "interview",
      "playback",
      "--session",
      sessionPath,
      "--confirm",
      "Confirmed for soak dry-run.",
      "--json",
    ]);
    if (failures.length) return { reports, failures, commands };
    if (playback.report?.code !== "PLAYBACK_CONFIRMED") {
      failures.push({
        round,
        fixture,
        step: "interview-playback",
        command: playback.command,
        exit_code: playback.exit_code,
        expected_exit_codes: [0],
        code: "SOAK_PLAYBACK_NOT_CONFIRMED",
        status: playback.report?.status || null,
        summary: "Playback did not confirm understanding.",
      });
      return { reports, failures, commands };
    }

    const toDemand = await step("interview-to-demand", [
      "interview",
      "to-demand",
      "--session",
      sessionPath,
      "--cwd",
      projectRoot,
      "--json",
    ]);
    if (failures.length) return { reports, failures, commands };

    const demandDir = toDemand.report?.demand_dir;
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

    await step("tasks", ["tasks", "--demand", demandDir, "--cwd", projectRoot, "--json"]);
    if (failures.length) return { reports, failures, commands };

    const prd = await step("prd", ["spec", "--demand", demandDir, "--json"]);
    if (failures.length) return { reports, failures, commands };

    const prdPath = prd.report?.artifacts?.find((path) => String(path).endsWith(".json"))
      || prd.report?.prd_path
      || prd.report?.output_path;
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

    await step("check", ["check", prdPath, "--cwd", projectRoot, "--json"]);
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
      reports.push({
        ...item.report,
        run_id: item.report?.run_id || `soak-${fixture}-r${round}-${basename(item.path)}`,
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

export async function runSoak(options = Object(), deps = Object()) {
  const normalized = {
    rounds: options.rounds ?? DEFAULT_ROUNDS,
    fixtures: options.fixtures ?? [...DEFAULT_FIXTURES],
    dryRun: options.dryRun !== false,
  };
  const yoloRoot = deps.yoloRoot || YOLO_ROOT;
  const cli = deps.runYoloCli || runYoloCli;
  const reports = [];
  const failures = [];

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

export async function main(argv = process.argv.slice(2), io = Object()) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let options;

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
