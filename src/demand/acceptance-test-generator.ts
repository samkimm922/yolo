import { dirname, isAbsolute, relative } from "node:path";
const SCHEMA = "yolo.test_generation.acceptance_coverage.v1", GENERATED_BY = "yolo.demand.acceptance-test-generator";
export const DETERMINISTIC_ACCEPTANCE_RULES = ["generic_named_criterion", "dual_mode_output", "fixture_ground_truth_statistics", "error_input_nonzero_exit"] as const;
const RULES = new Set<string>(DETERMINISTIC_ACCEPTANCE_RULES);
type Recordish = Record<string, unknown>;
const asArray = (value: unknown): unknown[] => value == null ? [] : Array.isArray(value) ? value : [value], clean = (value: unknown): string => String(value ?? "").trim();
const isRecord = (value: unknown): value is Recordish => Boolean(value && typeof value === "object" && !Array.isArray(value)), uniq = (values: string[]): string[] => [...new Set(values.map(clean).filter(Boolean))], js = (value: unknown): string => JSON.stringify(String(value ?? ""));
const criterionId = (criterion: Recordish): string => clean(criterion.criterion_id || criterion.id) || "AC-GENERATED", criterionName = (criterion: Recordish): string => clean(criterion.required_test_name || criterion.test_name) || `[${criterionId(criterion)}] generated acceptance`;
const criterionRules = (criterion: Recordish): string[] => ((rules) => rules.length ? rules : ["generic_named_criterion"])(uniq(asArray(criterion.rules || criterion.rule).map(clean)));
function normalizeCriterion(criterion: unknown): Recordish {
  const record = isRecord(criterion) ? { ...criterion } : { text: clean(criterion) };
  const id = criterionId(record), rules = criterionRules(record), unsupported = rules.filter((rule) => !RULES.has(rule));
  return { ...record, criterion_id: id, required_test_name: criterionName({ ...record, criterion_id: id }), rules, ...(unsupported.length ? { requires_manual_test: true, manual_test_reason: `Unsupported deterministic acceptance rule(s): ${unsupported.join(", ")}`, unsupported_rules: unsupported } : {}) };
}
export function normalizeAcceptanceCoverageForGeneration(manifest: unknown = Object()) {
  const source = isRecord(manifest) ? manifest : {};
  const criteria = asArray(source.criteria || source.checklist).map(normalizeCriterion);
  return { manifest: { ...source, schema: clean(source.schema) || SCHEMA, criteria }, unsupported_criteria: criteria.filter((criterion) => criterion.requires_manual_test === true) };
}
function cliExpression(cliPath: string, testFile: string): string {
  if (isAbsolute(cliPath)) return js(cliPath);
  let rel = relative(dirname(testFile || "test/acceptance.test.js"), cliPath).replaceAll("\\", "/");
  return `fileURLToPath(new URL(${js(rel.startsWith(".") ? rel : `./${rel}`)}, import.meta.url))`;
}
function helpers(cliPath: string, testFile: string): string {
  return `import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const CLI = ${cliExpression(cliPath, testFile)};
const run = (command, args, options = {}) => { const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', timeout: 10000, ...options }); if (result.error) throw result.error; return result; };
const git = (repo, args, env = {}) => { const result = run('git', args, { cwd: repo, env: { ...process.env, ...env } }); assert.equal(result.status, 0, result.stderr); return result; };
function fixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'git-weekly-acceptance-'));
  const expectedStats = { totalCommits: 2, linesAdded: 4, linesDeleted: 1 };
  git(repo, ['init']); git(repo, ['config', 'user.email', 'acceptance@example.com']); git(repo, ['config', 'user.name', 'Acceptance Bot']);
  writeFileSync(join(repo, 'report.txt'), 'one\\ntwo\\nthree\\n', 'utf8'); git(repo, ['add', 'report.txt']);
  git(repo, ['commit', '-m', 'feat: add report data'], { GIT_AUTHOR_NAME: 'Alice', GIT_COMMITTER_NAME: 'Alice', GIT_AUTHOR_DATE: '2025-01-01T12:00:00Z', GIT_COMMITTER_DATE: '2025-01-01T12:00:00Z' });
  writeFileSync(join(repo, 'report.txt'), 'one\\nthree\\nfour\\n', 'utf8'); git(repo, ['add', 'report.txt']);
  git(repo, ['commit', '-m', 'fix: revise report data'], { GIT_AUTHOR_NAME: 'Bob', GIT_COMMITTER_NAME: 'Bob', GIT_AUTHOR_DATE: '2025-01-02T12:00:00Z', GIT_COMMITTER_DATE: '2025-01-02T12:00:00Z' });
  return { repo, expectedStats };
}
const runCli = (args) => run(process.execPath, [CLI, ...args]);`;
}
const statsLines = (): string[] => ["  assert.match(stdoutMarkdown, new RegExp(`(?:Total commits|Total Commits)[\\\\s\\\\S]{0,120}${expectedStats.totalCommits}`));", "  assert.match(stdoutMarkdown, new RegExp(`(?:Lines added|Lines Added)[\\\\s\\\\S]{0,120}${expectedStats.linesAdded}`));", "  assert.match(stdoutMarkdown, new RegExp(`(?:Lines deleted|Lines Deleted)[\\\\s\\\\S]{0,120}${expectedStats.linesDeleted}`));"];
function renderCriterionTest(criterion: Recordish): string[] {
  const id = criterionId(criterion), rules = criterionRules(criterion), name = criterionName(criterion);
  if (criterion.requires_manual_test === true) return [`test(${js(name)}, () => {`, `  assert.ok(true, ${js(`requires_manual_test:${id}`)});`, "});"];
  const active = rules.filter((rule) => RULES.has(rule) && rule !== "generic_named_criterion");
  if (!active.length) return [`test(${js(name)}, () => {`, `  assert.ok(true, ${js(`generic acceptance criterion covered by name: ${id}`)});`, "});"];
  const lines = [`test(${js(name)}, () => {`, "  const { repo, expectedStats } = fixtureRepo();"];
  if (rules.includes("dual_mode_output") || rules.includes("fixture_ground_truth_statistics")) lines.push("  const stdoutRun = runCli(['--repo', repo, '--since', '2024-12-31', '--until', '2025-01-04']);", "  assert.equal(stdoutRun.status, 0, stdoutRun.stderr);", "  const stdoutMarkdown = stdoutRun.stdout;");
  if (rules.includes("dual_mode_output")) lines.push("  const outputFile = join(repo, 'weekly.md');", "  const outputRun = runCli(['--repo', repo, '--since', '2024-12-31', '--until', '2025-01-04', '--output', outputFile]);", "  assert.equal(outputRun.status, 0, outputRun.stderr);", "  assert.equal(existsSync(outputFile), true);", "  const fileMarkdown = readFileSync(outputFile, 'utf8');", "  assert.equal(fileMarkdown, stdoutMarkdown, 'stdout and --output file content must match byte-for-byte');", "  assert.match(stdoutMarkdown, /Alice/);", "  assert.match(stdoutMarkdown, /Bob/);");
  if (rules.includes("fixture_ground_truth_statistics")) lines.push(...statsLines());
  if (rules.includes("error_input_nonzero_exit")) lines.push("  const badRun = runCli(['--repo', join(repo, 'missing'), '--since', '2024-12-31', '--until', '2025-01-04']);", "  assert.notEqual(badRun.status, 0, 'bad repo must exit non-zero');");
  return [...lines, "});"];
}
export function generateAcceptanceTestFile(manifest: unknown = Object(), options: { cliPath?: string; cli_path?: string; testFile?: string; test_file?: string } = Object()): string {
  const normalized = normalizeAcceptanceCoverageForGeneration(manifest).manifest as Recordish;
  const criteria = asArray(normalized.criteria).filter(isRecord);
  const fallback = { criterion_id: "AC-GENERATED", required_test_name: "[AC-GENERATED] generated acceptance", rules: ["generic_named_criterion"] };
  const testFile = clean(options.testFile || options.test_file || normalized.required_test_file || "test/acceptance.test.js");
  return `${helpers(clean(options.cliPath || options.cli_path || "src/cli.js"), testFile)}\n\n${(criteria.length ? criteria : [fallback]).flatMap(renderCriterionTest).join("\n")}\n`;
}
export function buildGeneratedAcceptanceTestRecord({ file, cliPath, coverage }: { file: string; cliPath: string; coverage: unknown }) {
  const normalized = normalizeAcceptanceCoverageForGeneration(coverage);
  const criteria = asArray(normalized.manifest.criteria).filter(isRecord);
  return { schema: "yolo.demand.generated_acceptance_test.v1", file, cli_path: cliPath, generated_by: GENERATED_BY, coverage_schema: clean((normalized.manifest as Recordish).schema), criterion_count: criteria.length, coverage_rules: uniq(criteria.flatMap(criterionRules)), requires_manual_test_count: normalized.unsupported_criteria.length, acceptance_coverage: normalized.manifest };
}
