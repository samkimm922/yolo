#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "quality", "strict-typecheck-baseline.json");

const PROFILES = [
  {
    id: "strict",
    label: "strict",
    args: ["-p", "tsconfig.json", "--noEmit", "--strict", "--pretty", "false"],
  },
  {
    id: "strict_no_implicit_any",
    label: "strict + noImplicitAny",
    args: ["-p", "tsconfig.json", "--noEmit", "--strict", "--noImplicitAny", "--pretty", "false"],
  },
] as const;

type Baseline = {
  profiles?: Record<string, BaselineProfile>;
  max_errors: number;
  command: string;
  updated_at: string;
};

type BaselineProfile = {
  max_errors: number;
  command: string;
  updated_at: string;
};

type Profile = (typeof PROFILES)[number];

function commandFor(profile: Profile) {
  return `tsc ${profile.args.join(" ")}`;
}

function countStrictErrors(profile: Profile) {
  const tscBin = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tscBin, ...profile.args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const errorCount = (output.match(/\berror TS\d+:/g) || []).length;
  if ((result.status ?? 1) !== 0 && errorCount === 0) {
    throw new Error("strict tsc failed but produced no parseable TypeScript errors");
  }
  return {
    errorCount,
    exitCode: result.status ?? 1,
  };
}

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function normalizeBaseline(baseline: Baseline): Record<string, BaselineProfile> {
  const profiles = baseline.profiles || {};
  if (!profiles.strict && Number.isFinite(baseline.max_errors)) {
    profiles.strict = {
      max_errors: baseline.max_errors,
      command: baseline.command,
      updated_at: baseline.updated_at,
    };
  }
  return profiles;
}

function writeBaseline(results: Array<{ profile: Profile; errorCount: number }>) {
  const updatedAt = new Date().toISOString();
  const strict = results.find((result) => result.profile.id === "strict");
  const baseline: Baseline = {
    max_errors: strict?.errorCount ?? 0,
    command: strict ? commandFor(strict.profile) : commandFor(PROFILES[0]),
    updated_at: updatedAt,
    profiles: Object.fromEntries(results.map(({ profile, errorCount }) => [
      profile.id,
      {
        max_errors: errorCount,
        command: commandFor(profile),
        updated_at: updatedAt,
      },
    ])),
  };
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

function main() {
  const checkMode = process.argv.includes("--check");
  const updateBaseline = process.argv.includes("--update-baseline");
  const results = PROFILES.map((profile) => ({
    profile,
    ...countStrictErrors(profile),
  }));

  for (const { profile, errorCount } of results) {
    console.log(`[strict-typecheck] ${profile.label}: ${commandFor(profile)}`);
    console.log(`[strict-typecheck] current ${profile.id} errors: ${errorCount}`);
  }

  if (updateBaseline) {
    writeBaseline(results);
    console.log(`[strict-typecheck] wrote baseline ${BASELINE_PATH}`);
    return;
  }

  if (!checkMode) {
    if (results.every((result) => result.exitCode === 0)) console.log("[strict-typecheck] strict modes are clean.");
    else console.log("[strict-typecheck] read-only (pass --check to enforce or --update-baseline to ratchet).");
    return;
  }

  const profiles = normalizeBaseline(readBaseline());
  for (const { profile, errorCount } of results) {
    const baseline = profiles[profile.id];
    if (!baseline || !Number.isFinite(baseline.max_errors) || baseline.max_errors < 0) {
      throw new Error(`Invalid ${profile.id} strict typecheck baseline at ${BASELINE_PATH}`);
    }
    console.log(`[strict-typecheck] ${profile.id} baseline max errors: ${baseline.max_errors}`);
    if (errorCount > baseline.max_errors) {
      console.error(`[strict-typecheck] REGRESSION (${profile.id}): ${errorCount} > baseline ${baseline.max_errors}`);
      process.exit(1);
    }
    if (errorCount < baseline.max_errors) {
      console.log(`[strict-typecheck] ${profile.id} ratchet can be lowered: ${errorCount} < ${baseline.max_errors}`);
    }
  }
  console.log("[strict-typecheck] ratchet OK (strict error counts did not increase).");
}

try {
  main();
} catch (error) {
  console.error(`[strict-typecheck] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
