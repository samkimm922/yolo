import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function inspectTypecheckReality(tsconfig, script) {
  const blockers = [];
  if (tsconfig.compilerOptions?.noCheck === true) {
    blockers.push("tsconfig-noCheck");
  }
  if (!/\btsc\b/.test(script) || !script.includes("-p tsconfig.json") || !script.includes("--noEmit")) {
    blockers.push("missing-real-tsc-noemit");
  }
  if (script.includes("typecheck-guard")) {
    blockers.push("toy-typecheck-guard");
  }
  return blockers;
}

describe("real typecheck guardrail", () => {
  test("project typecheck is real tsc without noCheck", () => {
    const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8"));
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

    assert.deepEqual(inspectTypecheckReality(tsconfig, packageJson.scripts.typecheck), []);
  });

  test("negative: fake green noCheck plus toy guard is blocked", () => {
    const blockers = inspectTypecheckReality(
      { compilerOptions: { noCheck: true } },
      "echo ok && node --import tsx scripts/typecheck-guard.ts",
    );

    assert.deepEqual(blockers, [
      "tsconfig-noCheck",
      "missing-real-tsc-noemit",
      "toy-typecheck-guard",
    ]);
  });
});
