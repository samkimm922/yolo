import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import createYoloSdk from "../sdk.js";

const YOLO_DIR = fileURLToPath(new URL("..", import.meta.url));

function writeDryRunArtifactPrd(prdPath) {
  writeFileSync(prdPath, `${JSON.stringify({
    version: "2.0",
    id: "PRD-20260524-STATE-ROOT",
    title: "Runner stateRoot smoke",
    project: { name: "state-root-smoke", language: "javascript" },
    generated_by: "yolo-review-agent",
    generated_at: "2026-05-24T00:00:00.000Z",
    base_commit: "abcdef0",
    review_policy: { mode: "disabled" },
    requirements: [{ id: "REQ-STATE-ROOT-001", text: "Runner execution state must stay out of package root." }],
    designs: [{ id: "DES-STATE-ROOT-001", text: "Use caller supplied stateRoot for run artifacts." }],
    tasks: [{
      id: "FIX-STATE-ROOT-001",
      title: "Write deterministic state root smoke artifact",
      priority: "P3",
      type: "cleanup",
      task_kind: "dry_run_artifact",
      status: "pending",
      requirement_ids: ["REQ-STATE-ROOT-001"],
      design_ids: ["DES-STATE-ROOT-001"],
      scope: {
        targets: [{ file: "artifacts/state-root-smoke.md" }],
        allow_new_files: true,
        expected_zero_business_code: true,
      },
      post_conditions: [{
        id: "POST-FILE",
        type: "file_exists",
        severity: "FAIL",
        params: { file: "artifacts/state-root-smoke.md" },
      }],
    }],
  }, null, 2)}\n`, "utf8");
}

describe("runner state root", () => {
  test("SDK runner execution writes run artifacts under the project stateRoot", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "yolo-runner-state-root-"));
    const stateRoot = join(projectRoot, ".yolo");
    const prdPath = join(stateRoot, "data/prd/current/state-root-smoke.json");
    const runId = `run-state-root-${Date.now()}`;
    try {
      mkdirSync(join(stateRoot, "data/prd/current"), { recursive: true });
      writeFileSync(join(projectRoot, "README.md"), "# state root smoke\n", "utf8");
      writeDryRunArtifactPrd(prdPath);

      const sdk = createYoloSdk({ projectRoot });
      const result = await sdk.runtime.runRunner({
        prdPath,
        mode: "dev",
        runId,
        startProgressServer: false,
        initializeBaselines: false,
      });

      assert.equal(result.status, "success");
      assert.equal(result.run_id, runId);
      assert.deepEqual(result.completed, ["FIX-STATE-ROOT-001"]);
      assert.equal(existsSync(join(stateRoot, "state/reports", runId, "run-report.json")), true);
      assert.equal(existsSync(join(stateRoot, "state/progress-snapshots/latest.json")), true);
      assert.equal(existsSync(join(stateRoot, "state/evidence/prd-contract-doctor")), true);
      assert.equal(existsSync(join(projectRoot, "artifacts/state-root-smoke.md")), true);
      assert.equal(existsSync(join(stateRoot, "state/runtime/task-results.jsonl")), false);
      assert.equal(existsSync(join(stateRoot, "state/runtime/task-logs")), false);
      assert.equal(existsSync(join(stateRoot, "state/runner.pid")), false);
      assert.equal(existsSync(join(stateRoot, "state/yolo-output.log")), false);
      assert.equal(existsSync(join(YOLO_DIR, "state/reports", runId, "run-report.json")), false);

      const snapshot = JSON.parse(readFileSync(join(stateRoot, "state/progress-snapshots/latest.json"), "utf8"));
      assert.match(snapshot.prd, /state-root-smoke\.json$/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
