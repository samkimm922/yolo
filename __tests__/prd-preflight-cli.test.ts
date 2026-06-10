import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runPrdPreflightCli } from "../src/cli/prd-preflight.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "yolo-prd-preflight-cli-"));
}

function writeJson(file, payload) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
}

function prdWithWarning() {
  return {
    version: "2.0",
    id: "PRD-20260606-PREFLIGHT-WARNING",
    title: "Preflight warning fixture",
    project: { name: "test", language: "typescript" },
    generated_by: "yolo-demand",
    generated_at: "2026-06-06T00:00:00.000Z",
    base_commit: "abcdef0",
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-PREFLIGHT",
      approval: { approved: true, effective_for_prd: true },
      project_facts: {
        target_files: [{ file: "src/a.ts", status: "verified" }],
        assumptions: [],
      },
      quality_report: {
        schema_version: "1.0",
        schema: "yolo.demand.quality.v1",
        status: "pass",
        total_score: 100,
        dimensions: [],
      },
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: {
        schema_version: "1.0",
        schema: "yolo.demand.quality.v1",
        status: "pass",
        total_score: 100,
        dimensions: [],
      },
    },
    requirements: [{
      id: "REQ-1",
      text: "Keep a small target covered.",
      demand_trace: { evidence: ["EVID-1"] },
    }],
    designs: [{ id: "DES-1", text: "Use executable target coverage." }],
    tasks: [{
      id: "FIX-PREFLIGHT-001",
      title: "Update small target",
      priority: "P1",
      type: "bugfix",
      status: "pending",
      requirement_ids: ["REQ-1"],
      design_ids: ["DES-1"],
      scope: { targets: [{ file: "src/a.ts" }] },
      acceptance_criteria: ["Target update is visible."],
      post_conditions: [
        {
          id: "POST-TARGET",
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: "src/a.ts" },
        },
        {
          id: "POST-MANUAL",
          type: "acceptance_criteria",
          severity: "FAIL",
          params: { text: "Human-readable acceptance still needs review." },
        },
      ],
    }],
  };
}

describe("prd preflight CLI warning policy", () => {
  test("check-all blocks when no PRD files are available", () => {
    const root = tempProject();
    const previousCwd = process.cwd();
    let stdout = "";
    let stderr = "";
    try {
      const emptyDir = join(root, "empty-prds");
      mkdirSync(emptyDir, { recursive: true });
      process.chdir(root);
      const exitCode = runPrdPreflightCli(["--check-all", "--dir", emptyDir, "--json"], {
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const payload = JSON.parse(stdout);

      assert.equal(stderr, "");
      assert.equal(exitCode, 1);
      assert.equal(payload.status, "blocked");
      assert.equal(payload.code, "PRD_PREFLIGHT_NO_FILES");
      assert.equal(payload.file_count, 0);
      assert.ok(payload.blocked_reasons.some((reason) => reason.code === "PRD_PREFLIGHT_NO_FILES"));
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("default verify blocks warning PRDs instead of returning success", () => {
    const root = tempProject();
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, prdWithWarning());

      const result = spawnSync(process.execPath, [
        "--import",
        "tsx",
        resolve("src/prd/preflight.ts"),
        prdPath,
        "--json",
      ], { cwd: resolve("."), encoding: "utf8" });
      const payload = JSON.parse(result.stdout);

      assert.equal(result.stderr, "");
      assert.equal(result.status, 1);
      assert.equal(payload.status, "blocked");
      assert.equal(payload.warning_policy.mode, "verify");
      assert.equal(payload.blocking_warning_count > 0, true);
      assert.ok(payload.blocked_reasons.some((reason) => reason.code === "MANUAL_FAIL_CONDITION"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("advisory mode removed — warning PRDs are blocked regardless of mode", () => {
    const root = tempProject();
    let stdout = "";
    let stderr = "";
    try {
      const prdPath = join(root, "prd.json");
      writeJson(prdPath, prdWithWarning());

      const direct = spawnSync(process.execPath, [
        "--import",
        "tsx",
        resolve("src/prd/preflight.ts"),
        prdPath,
        "--mode=advisory",
        "--json",
      ], { cwd: resolve("."), encoding: "utf8" });
      const directPayload = JSON.parse(direct.stdout);

      assert.equal(direct.stderr, "");
      assert.equal(direct.status, 1);
      assert.equal(directPayload.status, "blocked");
      assert.equal(directPayload.blocking_warning_count > 0, true);

      const wrapperExit = runPrdPreflightCli([prdPath, "--mode=advisory", "--json"], {
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: (chunk) => { stderr += chunk; } },
      });
      const wrapperPayload = JSON.parse(stdout);

      assert.equal(stderr, "");
      assert.equal(wrapperExit, 1);
      assert.equal(wrapperPayload.status, "blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
