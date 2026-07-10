import { safeRegExp } from "../../lib/security/regex-guard.js";

export type ErrorOutputRule = {
  id?: unknown;
  type?: unknown;
  contains?: unknown;
  pattern?: unknown;
  flags?: unknown;
  detail?: unknown;
};

export type CommandFailureContext = {
  exitCode?: unknown;
  stdout?: unknown;
  stderr?: unknown;
  output?: unknown;
  ok?: unknown;
  rejected?: unknown;
  command_not_found?: unknown;
  timed_out?: unknown;
  config?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function ruleMatchesText(rule: ErrorOutputRule, value: string): boolean {
  const needles = asArray(rule.contains)
    .map(text)
    .filter(Boolean);
  if (needles.some((needle) => value.includes(needle))) return true;

  const pattern = text(rule.pattern);
  if (!pattern) return false;
  const regex = safeRegExp(pattern, text(rule.flags));
  return regex ? regex.test(value) : false;
}

function declarationNodes(source: unknown): Record<string, unknown>[] {
  if (!isObject(source)) return [];
  const config = isObject(source.config) ? source.config : null;
  const project = isObject(source.project) ? source.project : null;
  const build = isObject(source.build) ? source.build : null;
  const configProject = config && isObject(config.project) ? config.project : null;
  const configBuild = config && isObject(config.build) ? config.build : null;
  return [source, config, project, build, configProject, configBuild].filter(isObject);
}

export function declaredErrorOutputRules(...sources: unknown[]): ErrorOutputRule[] {
  const rules: ErrorOutputRule[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const node of declarationNodes(source)) {
      const declared = node.failure_output_rules ?? node.failureOutputRules;
      for (const value of asArray(declared)) {
        const rule = isObject(value) ? value as ErrorOutputRule : { contains: value };
        const key = JSON.stringify(rule);
        if (seen.has(key)) continue;
        seen.add(key);
        rules.push(rule);
      }
    }
  }
  return rules;
}

function ruleNeedles(rule: ErrorOutputRule): string[] {
  return asArray(rule.contains)
    .map(text)
    .filter(Boolean);
}

function matchingLine(output: string, needles: string[]): string {
  return output.split(/\r?\n/).find((line) => needles.some((needle) => line.includes(needle)))?.trim() || "";
}

function matchingLineForRule(output: string, rule: ErrorOutputRule): string {
  return output.split(/\r?\n/).find((line) => ruleMatchesText(rule, line))?.trim() || "";
}

function exitCode(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function combinedOutput(context: CommandFailureContext): string {
  return [context.stderr, context.stdout, context.output]
    .map(text)
    .filter(Boolean)
    .join("\n");
}

export function commandOutput(context: CommandFailureContext = Object()): string {
  return combinedOutput(context);
}

export function matchDeclaredErrorOutput(output: string, ...sources: unknown[]): Array<{
  id: string;
  type: string;
  detail: string;
  rules: string[];
}> {
  return declaredErrorOutputRules(...sources).flatMap((rule, index) => {
    const needles = ruleNeedles(rule);
    if (!needles.length && !text(rule.pattern)) return [];
    if (!ruleMatchesText(rule, output)) return [];
    const id = text(rule.id) || `declared-output-${index + 1}`;
    const type = text(rule.type) || "command";
    const detail = text(rule.detail) || matchingLineForRule(output, rule) || matchingLine(output, needles) || output;
    return [{ id, type, detail: detail.slice(0, 300), rules: [id] }];
  });
}

export function commandOutputSnapshotKeys(output = "", ...sources: unknown[]): string[] {
  const rules = declaredErrorOutputRules(...sources);
  const lines = String(output || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const keys = lines.map((line) => {
    const matchingRules = rules.flatMap((rule, index) => {
      if (!ruleMatchesText(rule, line)) return [];
      return [text(rule.id) || `declared-output-${index + 1}`];
    });
    return matchingRules.length > 0
      ? `rule:${matchingRules.join(",")}:${line}`
      : `line:${line}`;
  });
  return [...new Set(keys)];
}

function hasFailureSignal(context: CommandFailureContext, code: number | null): boolean {
  return (code !== null && code !== 0) ||
    context.ok === false ||
    context.rejected === true ||
    context.command_not_found === true ||
    context.timed_out === true;
}

export function commandFailureIssues(context: CommandFailureContext = Object()) {
  const output = combinedOutput(context);
  const code = exitCode(context.exitCode);
  if (!hasFailureSignal(context, code)) return [];

  const declared = matchDeclaredErrorOutput(output, context.config);
  if (declared.length > 0) {
    return declared.map((failure) => ({ ...failure, exit_code: code }));
  }

  const detail = text(context.stderr) || text(context.stdout) || text(context.output) ||
    (code === null ? "configured command failed" : `command exited with code ${code}`);
  return [{
    id: "command-failed",
    type: "command",
    detail: detail.slice(0, 300),
    rules: ["non_zero_exit"],
    exit_code: code,
  }];
}
