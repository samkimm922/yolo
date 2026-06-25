#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { regressionRatchetManifest, type RegressionRatchetEntry } from "./regression-ratchet.manifest.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_TIMEOUT_MS = 120_000;

type EntryCheck = {
  entry: RegressionRatchetEntry;
  failures: string[];
};

function activeTestNameFromCallee(callee: ts.Expression): "active" | "inactive" | null {
  if (ts.isIdentifier(callee)) {
    return callee.text === "test" || callee.text === "it" ? "active" : null;
  }
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!ts.isIdentifier(callee.expression)) return null;
  if (callee.expression.text !== "test" && callee.expression.text !== "it") return null;
  if (callee.name.text === "only") return "active";
  if (callee.name.text === "skip" || callee.name.text === "todo") return "inactive";
  return null;
}

function collectActiveTestNames(file: string, source: string): string[] {
  const names: string[] = [];
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && activeTestNameFromCallee(node.expression) === "active") {
      const title = node.arguments[0];
      if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) {
        names.push(title.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function trimOutput(value: string | Buffer | null | undefined) {
  const text = String(value || "").trim();
  if (text.length <= 4000) return text;
  return `... truncated ...\n${text.slice(-4000)}`;
}

function errorMessage(error: unknown) {
  if ((typeof error === "object" || typeof error === "function") && error !== null && "message" in error) {
    return error.message;
  }
  return undefined;
}

function runNamedTest(entry: RegressionRatchetEntry) {
  const args = [
    "--import",
    "tsx",
    "--test",
    "--test-name-pattern",
    entry.test_name_pattern,
    entry.test_file,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
    timeout: TEST_TIMEOUT_MS,
  });
  return { args, result };
}

function validateEntry(entry: RegressionRatchetEntry, seenIds: Set<string>): EntryCheck {
  const failures: string[] = [];
  if (seenIds.has(entry.id)) failures.push(`duplicate manifest id: ${entry.id}`);
  seenIds.add(entry.id);

  const testPath = resolve(ROOT, entry.test_file);
  if (!existsSync(testPath)) {
    failures.push(`missing test_file: ${entry.test_file}`);
    return { entry, failures };
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(entry.test_name_pattern);
  } catch (error: unknown) {
    failures.push(`invalid test_name_pattern regex ${JSON.stringify(entry.test_name_pattern)}: ${errorMessage(error)}`);
    return { entry, failures };
  }

  const source = readFileSync(testPath, "utf8");
  const testNames = collectActiveTestNames(entry.test_file, source);
  if (!testNames.some((name) => pattern.test(name))) {
    failures.push(`no active test()/it() title in ${entry.test_file} matches test_name_pattern: ${entry.test_name_pattern}`);
  }
  return { entry, failures };
}

function main() {
  const seenIds = new Set<string>();
  const failures: string[] = [];

  for (const entry of regressionRatchetManifest) {
    const check = validateEntry(entry, seenIds);
    if (check.failures.length > 0) {
      for (const failure of check.failures) failures.push(`[${entry.id}] ${failure}`);
      console.error(`not ok ${entry.id} - static regression test check failed`);
      continue;
    }

    const { args, result } = runNamedTest(entry);
    if (result.status !== 0) {
      const exit = result.error?.message || `exit ${result.status ?? "null"}${result.signal ? ` signal ${result.signal}` : ""}`;
      failures.push([
        `[${entry.id}] named regression test failed: ${exit}`,
        `command: node ${args.join(" ")}`,
        trimOutput(result.stdout),
        trimOutput(result.stderr),
      ].filter(Boolean).join("\n"));
      console.error(`not ok ${entry.id} - named regression test failed`);
      continue;
    }

    console.log(`ok ${entry.id} - ${entry.test_file} :: ${entry.test_name_pattern}`);
  }

  if (failures.length > 0) {
    console.error("\nRegression ratchet failed:");
    for (const failure of failures) console.error(`\n${failure}`);
    process.exit(1);
  }

  console.log(`\nRegression ratchet passed (${regressionRatchetManifest.length} entries).`);
}

main();
