import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { generatePrompt } from "../src/cli/prompt.js";
import { registerGeneratedArtifactIntegrity } from "../src/runtime/evidence/artifact-integrity.js";
import { appendStateEvent, provisionLedgerHmacKey } from "../src/runtime/evidence/ledger.js";

describe("prompt contract", () => {
  test("uses scope max_lines_per_file in prompt budget text", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prompt-scope-lines-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/index.ts"), "export const value = 1;\n", "utf8");

    const prdPath = join(root, "prd.json");
    writeFileSync(prdPath, JSON.stringify({
      version: "2.0",
      tasks: [{
        id: "FIX-LINES-SCOPE",
        title: "Fix scoped line budget",
        type: "bugfix",
        status: "pending",
        description: "Change value",
        scope: {
          targets: [{ file: "src/index.ts" }],
          max_files: 1,
          max_lines_per_file: 250,
        },
        post_conditions: [{
          id: "POST-CONTAINS",
          type: "code_contains",
          severity: "FAIL",
          params: { file: "src/index.ts", text: "value = 2" },
        }],
      }],
    }), "utf8");

    const output = generatePrompt({
      taskId: "FIX-LINES-SCOPE",
      prdPath,
      cwd: root,
      noExperiencePack: true,
      config: { gate: { max_lines_per_file: 120 } },
    });

    assert.match(output, /上限 250 行/);
    assert.match(output, /单文件不超过 250 行/);
    assert.match(output, /改动后目标文件 ≤ 250 行/);
    assert.doesNotMatch(output, /上限 150 行/);
    assert.doesNotMatch(output, /单文件不超过 150 行/);
    assert.doesNotMatch(output, /改动后目标文件 ≤ 150 行/);
    rmSync(root, { recursive: true, force: true });
  });

  test("falls back to config gate max_lines_per_file when scope omits it", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prompt-config-lines-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/index.ts"), "export const value = 1;\n", "utf8");

    const prdPath = join(root, "prd.json");
    writeFileSync(prdPath, JSON.stringify({
      version: "2.0",
      tasks: [{
        id: "FIX-LINES-CONFIG",
        title: "Fix config line budget",
        type: "bugfix",
        status: "pending",
        description: "Change value",
        scope: {
          targets: [{ file: "src/index.ts" }],
          max_files: 1,
        },
        post_conditions: [{
          id: "POST-CONTAINS",
          type: "code_contains",
          severity: "FAIL",
          params: { file: "src/index.ts", text: "value = 2" },
        }],
      }],
    }), "utf8");

    const output = generatePrompt({
      taskId: "FIX-LINES-CONFIG",
      prdPath,
      cwd: root,
      noExperiencePack: true,
      config: { gate: { max_lines_per_file: 220 } },
    });

    assert.match(output, /上限 220 行/);
    assert.match(output, /单文件不超过 220 行/);
    assert.match(output, /改动后目标文件 ≤ 220 行/);
    assert.doesNotMatch(output, /上限 150 行/);
    assert.doesNotMatch(output, /单文件不超过 150 行/);
    assert.doesNotMatch(output, /改动后目标文件 ≤ 150 行/);
    rmSync(root, { recursive: true, force: true });
  });

  test("puts immediate edit instruction before session metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prompt-action-first-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/index.ts"), "export const value = 1;\n", "utf8");

    const prdPath = join(root, "prd.json");
    writeFileSync(prdPath, JSON.stringify({
      version: "2.0",
      tasks: [{
        id: "FIX-ACTION-FIRST",
        title: "Fix action first",
        type: "bugfix",
        status: "pending",
        description: "Change value",
        scope: {
          targets: [{ file: "src/index.ts" }],
          max_files: 1,
          max_lines_per_file: 90,
        },
      }],
    }), "utf8");

    const output = generatePrompt({
      taskId: "FIX-ACTION-FIRST",
      prdPath,
      cwd: root,
      noExperiencePack: true,
      config: { gate: { max_lines_per_file: 120 } },
    });

    assert.match(output, /## 立即执行\n- 直接用 Edit\/Write 修改 scope 目标文件/);
    assert.ok(output.indexOf("## 立即执行") < output.indexOf("## Session"));
    assert.doesNotMatch(output, /Fresh Session Contract/);
    assert.doesNotMatch(output, /### 步骤/);
    assert.doesNotMatch(output, /R1:/);
    rmSync(root, { recursive: true, force: true });
  });

  test("includes machine-verifiable condition params and readonly context", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prompt-contract-"));
    mkdirSync(join(root, "src/services"), { recursive: true });
    writeFileSync(join(root, "src/services/craft.service.ts"), "import { COLLECTIONS } from './constants';\nconst db = wx.cloud.database();\n", "utf8");
    writeFileSync(join(root, "src/services/db.ts"), "export const db = wx.cloud.database();\n", "utf8");
    writeFileSync(join(root, "src/services/constants.ts"), "export const COLLECTIONS = { CRAFTS: 'crafts' };\n", "utf8");

    const prdPath = join(root, "prd.json");
    writeFileSync(prdPath, JSON.stringify({
      version: "2.0",
      tasks: [{
        id: "FIX-PROMPT-001",
        title: "use db singleton",
        type: "bugfix",
        status: "pending",
        description: "Use db singleton",
        scope: {
          targets: [{ file: "src/services/craft.service.ts" }],
          readonly_files: ["src/services/db.ts"],
          max_files: 1,
          max_lines_per_file: 80,
        },
        pre_conditions: [{
          id: "PRE-DIRECT",
          type: "code_contains",
          severity: "FAIL",
          params: { file: "src/services/craft.service.ts", text: "const db = wx.cloud.database();" },
        }],
        post_conditions: [{
          id: "POST-IMPORT",
          type: "code_contains",
          severity: "FAIL",
          params: { file: "src/services/craft.service.ts", text: "import { db } from './db';" },
        }],
      }],
    }), "utf8");

    const output = execFileSync(process.execPath, [
      join(import.meta.dirname, "..", "dist/prompt.js"),
      "--task=FIX-PROMPT-001",
      `--prd=${prdPath}`,
      `--cwd=${root}`,
    ], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, PATH: process.env.PATH },
    });

    assert.match(output, /text: `const db = wx\.cloud\.database\(\);`/);
    assert.match(output, /text: `import \{ db \} from '\.\/db';`/);
    assert.match(output, /src\/services\/db\.ts（只读参考，不可修改）/);
    assert.match(output, /改动后目标文件 ≤ 80 行/);
    assert.match(output, /只修改 PRD scope 允许的目标文件/);
    assert.doesNotMatch(output, /小程序|Skyline|Taro|TanStack Query/);
    rmSync(root, { recursive: true, force: true });
  });

  test("split prompt respects allow_delete_files=false", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prompt-split-"));
    mkdirSync(join(root, "src/services/__tests__"), { recursive: true });
    writeFileSync(join(root, "src/services/__tests__/long.test.ts"), "describe('x', () => {})\n", "utf8");

    const prdPath = join(root, "prd.json");
    writeFileSync(prdPath, JSON.stringify({
      version: "2.0",
      tasks: [{
        id: "FIX-SPLIT-001",
        title: "[R9-file-length] src/services/__tests__/long.test.ts",
        type: "refactor",
        status: "pending",
        description: "文件超过 150 行，必须拆分",
        scope: {
          targets: [{ file: "src/services/__tests__/long.test.ts" }],
          max_files: 5,
          max_lines_per_file: 150,
          allow_new_files: true,
          allow_delete_files: false,
        },
        post_conditions: [{
          id: "POST-LINES",
          type: "file_lines_max",
          severity: "FAIL",
          params: { file: "src/services/__tests__/long.test.ts", max: 150 },
        }],
      }],
    }), "utf8");

    const output = execFileSync(process.execPath, [
      join(import.meta.dirname, "..", "dist/prompt.js"),
      "--task=FIX-SPLIT-001",
      `--prd=${prdPath}`,
      `--cwd=${root}`,
    ], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, PATH: process.env.PATH },
    });

    assert.match(output, /禁止删除原文件/);
    assert.match(output, /wc -l <原文件路径>/);
    assert.doesNotMatch(output, /必须\*\*用 Bash 工具执行 `rm <原文件路径>`/);
    rmSync(root, { recursive: true, force: true });
  });

  test("injects relevant learning records from the project state root without closed-loop loader", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-prompt-learning-"));
    const stateRoot = join(root, ".yolo");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(stateRoot, "state"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "export const value = 1;\n", "utf8");
    const acceptancePath = join(stateRoot, "lifecycle", "acceptance-report.json");
    const deliveryPath = join(stateRoot, "lifecycle", "delivery-report.json");
    mkdirSync(join(stateRoot, "lifecycle"), { recursive: true });
    provisionLedgerHmacKey(stateRoot);
    writeFileSync(acceptancePath, JSON.stringify({ status: "completed", report: { status: "pass" } }), "utf8");
    registerGeneratedArtifactIntegrity([acceptancePath], { rootDir: root, stateRoot, source: "test" });
    appendStateEvent(join(stateRoot, "state"), "lifecycle.acceptance.report", {
      stage: "acceptance", status: "pass", artifact: acceptancePath,
    }, { stateRoot, source: "test" });
    writeFileSync(deliveryPath, JSON.stringify({
      status: "completed",
      report: { status: "success", acceptance_report_path: acceptancePath },
    }), "utf8");
    registerGeneratedArtifactIntegrity([deliveryPath], { rootDir: root, stateRoot, source: "test" });
    appendStateEvent(join(stateRoot, "state"), "lifecycle.delivery.report", {
      stage: "delivery", status: "success", artifact: deliveryPath,
    }, { stateRoot, source: "test" });
    writeFileSync(join(stateRoot, "state/learning.jsonl"), `${JSON.stringify({
      schema_version: "1.0",
      id: "learn_tsc_service",
      ts: "2026-05-25T00:00:00.000Z",
      type: "retrospective",
      source: "test",
      source_outcome: "success",
      status: "advisory",
      confidence: 8,
      task_id: "FIX-OLD",
      gate: "tsc",
      lesson: "Verified TS2352 narrowing pattern in src/a.ts",
      prevention: "Narrow the value before casting.",
      fingerprint: {
        type: "failure",
        gate: "tsc",
        files: ["src/a.ts"],
        directories: ["src"],
        error_codes: ["TS2352"],
        risk_patterns: [],
        task_type: "bugfix",
      },
      fingerprint_key: "k1",
      occurrence_count: 1,
      evidence_refs: [deliveryPath],
      tags: [],
      legacy_source: "",
      legacy_id: "",
    })}\n`, "utf8");

    const prdPath = join(root, "prd.json");
    writeFileSync(prdPath, JSON.stringify({
      version: "2.0",
      tasks: [{
        id: "FIX-LEARNING-001",
        title: "Fix TS2352",
        type: "bugfix",
        status: "pending",
        description: "Fix TS2352 in src/a.ts",
        scope: {
          targets: [{ file: "src/a.ts" }],
          max_files: 1,
          max_lines_per_file: 80,
        },
        post_conditions: [{
          id: "POST-TSC",
          type: "tests_pass",
          severity: "FAIL",
          params: { command: "npm test" },
        }],
      }],
    }), "utf8");

    const output = execFileSync(process.execPath, [
      join(import.meta.dirname, "..", "dist/prompt.js"),
      "--task=FIX-LEARNING-001",
      `--prd=${prdPath}`,
      `--cwd=${root}`,
      `--state-root=${stateRoot}`,
      "--gate=tsc",
      "--learnings=src/a.ts error TS2352",
    ], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
      env: { ...process.env, PATH: process.env.PATH },
    });

    assert.match(output, /Relevant Experience Pack/);
    assert.match(output, /Verified TS2352 narrowing pattern/);
    assert.doesNotMatch(output, /前序知识/);
    rmSync(root, { recursive: true, force: true });
  });
});
