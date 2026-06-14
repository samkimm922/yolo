import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runYoloCli } from "../src/cli/yolo.js";

function tempProject(prefix = "yolo-release-cli-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function captureIo(cwd, extra = {}) {
  const stdout = { text: "", write(chunk) { this.text += chunk; } };
  const stderr = { text: "", write(chunk) { this.text += chunk; } };
  return {
    io: { cwd, stdout, stderr, ...extra },
    stdout,
    stderr,
  };
}

describe("YOLO release-candidate CLI", () => {
  test("defaults to the built-in generic RC gate and fails closed as JSON", async () => {
    const root = tempProject();
    try {
      const { io, stdout, stderr } = captureIo(root);
      const exitCode = await runYoloCli(["release", "candidate", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(stderr.text, "");
      assert.equal(exitCode, 1);
      assert.equal(payload.schema, "yolo.release_candidate_cli_result.v1");
      assert.equal(payload.status, "blocked");
      assert.equal(payload.code, "RELEASE_CANDIDATE_GATE_BLOCKED");
      assert.equal(payload.mode, "rc");
      assert.equal(payload.fail_closed, true);
      assert.equal(payload.not_trello_replay, true);
      assert.deepEqual(payload.allowances, { untracked: false, unknown: false });
      assert.equal(payload.gate_result.schema, "yolo.release.release_candidate_gate_result.v1");
      assert.deepEqual(payload.gates.map((gate) => gate.id), [
        "verify",
        "prd-preflight",
        "clean-env",
        "dogfood-matrix",
        "change-provenance",
      ]);
      assert.ok(payload.issue_codes.includes("RC_GATE_REPORT_BLOCKED"));
      assert.ok(payload.blockers.some((blocker) => blocker.issue_code === "RELEASE_CLEAN_ENVIRONMENT_NOT_EXECUTED"));
      assert.ok(!payload.blockers.some((blocker) => blocker.issue_code === "RELEASE_CANDIDATE_RESULT_INCONSISTENT"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("supports publish mode through the injected runner contract (no allow-untracked/allow-unknown bypass)", async () => {
    const root = tempProject();
    try {
      const { io, stdout } = captureIo(root, {
        releaseCandidateRunner(input) {
          assert.equal(input.command, "release");
          assert.equal(input.stage, "release-gate");
          assert.equal(input.gateId, "release-gate");
          assert.equal(input.internal_gate_id, "release-gate");
          assert.equal(input.mode, "publish");
          assert.equal(input.dryRun, false);
          assert.equal(input.allowUntracked, false);
          assert.equal(input.allowUnknown, false);
          assert.equal(input.failClosed, true);
          assert.equal(input.notTrelloReplay, true);
          assert.deepEqual(input.requiredGates.map((gate) => gate.id), [
            "verify",
            "prd-preflight",
            "clean-env",
            "dogfood-matrix",
            "change-provenance",
          ]);
          return {
            status: "pass",
            summary: "Injected generic RC gate passed.",
            gates: input.requiredGates.map((gate) => ({ ...gate, status: "pass" })),
            blockers: [],
            gate_result: {
              schema: "yolo.release.release_candidate_gate_result.v1",
              status: "pass",
              blockers: [],
              issue_codes: [],
            },
            next_actions: ["Manual publish authorization remains separate."],
          };
        },
      });
      const exitCode = await runYoloCli([
        "release",
        "gate",
        "--mode",
        "publish",
        "--json",
      ], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(exitCode, 0);
      assert.equal(payload.status, "pass");
      assert.equal(payload.command, "release");
      assert.equal(payload.mode, "publish");
      assert.equal(payload.dry_run, false);
      assert.equal(payload.fail_closed, true);
      assert.deepEqual(payload.allowances, { untracked: false, unknown: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("blocks inconsistent injected runner success instead of exiting 0", async () => {
    const root = tempProject();
    try {
      const { io, stdout, stderr } = captureIo(root, {
        releaseCandidateRunner(input) {
          return {
            status: "success",
            summary: "thin runner success",
            blockers: [{ code: "INNER_BLOCKED", message: "underlying gate was blocked" }],
            gates: input.requiredGates.map((gate, index) => ({
              ...gate,
              status: index === 0 ? "pass" : "blocked",
            })),
          };
        },
      });
      const exitCode = await runYoloCli(["release", "candidate", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(stderr.text, "");
      assert.equal(exitCode, 1);
      assert.equal(payload.status, "blocked");
      assert.equal(payload.code, "RELEASE_CANDIDATE_RESULT_INCONSISTENT");
      assert.ok(payload.blockers.some((blocker) => blocker.code === "INNER_BLOCKED"));
      assert.ok(payload.blockers.some((blocker) => blocker.code === "RELEASE_CANDIDATE_GATE_RESULT_MISSING"));
      assert.ok(payload.blockers.some((blocker) => blocker.code === "RELEASE_CANDIDATE_GATE_NOT_PASSING"));
      assert.ok(!payload.blockers.some((blocker) => blocker.code === "RELEASE_CANDIDATE_GATE_ERROR"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("catches injected runner exceptions and still emits parseable JSON", async () => {
    const root = tempProject();
    try {
      const { io, stdout, stderr } = captureIo(root, {
        releaseCandidateRunner() {
          throw new Error("boom from rc runner");
        },
      });
      const exitCode = await runYoloCli(["release", "candidate", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(stderr.text, "");
      assert.equal(exitCode, 1);
      assert.equal(payload.status, "error");
      assert.equal(payload.code, "RELEASE_CANDIDATE_GATE_ERROR");
      assert.match(payload.error, /boom from rc runner/);
      assert.ok(payload.blockers.some((blocker) => blocker.code === "RELEASE_CANDIDATE_GATE_ERROR"));
      assert.ok(!payload.blockers.some((blocker) => blocker.code === "RELEASE_CANDIDATE_GATE_NOT_PASSING"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects unknown modes with structured JSON", async () => {
    const root = tempProject();
    try {
      const { io, stdout, stderr } = captureIo(root);
      const exitCode = await runYoloCli(["release", "candidate", "--mode", "trello", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(stderr.text, "");
      assert.equal(exitCode, 1);
      assert.equal(payload.status, "error");
      assert.equal(payload.code, "INVALID_RELEASE_CANDIDATE_MODE");
      assert.equal(payload.fail_closed, true);
      assert.equal(payload.not_trello_replay, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not normalize injected ready status into release pass", async () => {
    const root = tempProject();
    try {
      const { io, stdout } = captureIo(root, {
        releaseCandidateRunner(input) {
          return {
            status: "ready",
            summary: "Gate evidence is ready for operator review, not approved.",
            gates: input.requiredGates.map((gate) => ({ ...gate, status: "pass" })),
            blockers: [],
            gate_result: {
              schema: "yolo.release.release_candidate_gate_result.v1",
              status: "pass",
              blockers: [],
              issue_codes: [],
            },
          };
        },
      });
      const exitCode = await runYoloCli(["release", "candidate", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(exitCode, 2);
      assert.equal(payload.status, "ready");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
