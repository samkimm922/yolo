import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runYoloCli } from "../src/cli/yolo.js";
import { resolveDemandContinuation } from "../src/demand/runtime.js";

function tempProject() {
  const root = mkdtempSync(join(tmpdir(), "demand-onboard-"));
  mkdirSync(join(root, ".yolo", "keys"), { recursive: true });
  writeFileSync(join(root, ".yolo", "keys", "ledger.hmac"), "demand-onboarding-test-key", "utf8");
  return root;
}

function capture() {
  let value = "";
  return {
    stream: { write: (chunk) => { value += String(chunk); } },
    text: () => value,
    json: () => JSON.parse(value),
  };
}

describe("yolo demand non-technical onboarding", () => {
  // A non-technical user starts with one command. Persisted artifacts decide
  // every later step, while explicit stage selection remains an advanced path.
  test("bare `yolo demand \"<idea>\"` starts the first automatic step", async () => {
    const root = tempProject();
    try {
      const out = capture();
      const exitCode = await runYoloCli(
        ["demand", "做个看板", `--cwd=${root}`, "--json"],
        { cwd: root, stdout: out.stream },
      );

      const result = out.json();
      assert.equal(result.progress.current_step, 1);
      assert.equal(result.progress.total_steps, 6);
      assert.equal(result.progress.current, "brainstorm");
      assert.equal(result.progress.remaining_steps, 5);
      assert.ok([0, 1, 2].includes(exitCode));

      const sessionPath: string | undefined = result.artifacts?.find((path: string) => path.endsWith("session.json"));
      assert.ok(
        typeof sessionPath === "string" && sessionPath.length > 0,
        "brainstorm must return a session path",
      );
      assert.ok(
        existsSync(sessionPath),
        `brainstorm session file must exist on disk: ${sessionPath}`,
      );

      // The session must carry the user's original idea so the onboarding flow
      // is continuous, not a blank restart.
      const session = JSON.parse(readFileSync(sessionPath, "utf8"));
      const ideaText = [session.vision?.idea, session.vision?.statement, session.project?.title]
        .filter((value) => typeof value === "string" && value.length > 0)
        .join(" ");
      assert.ok(
        ideaText.includes("做个看板"),
        `session must preserve the user's idea; got idea=${JSON.stringify(session.idea)}, objective=${JSON.stringify(session.objective)}, title=${JSON.stringify(session.title)}`,
      );

    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit `yolo demand status` is unchanged — still returns a demand snapshot, never an interview", async () => {
    const root = tempProject();
    try {
      const out = capture();
      const exitCode = await runYoloCli(
        ["demand", "status", "做个看板", `--cwd=${root}`, "--json"],
        { cwd: root, stdout: out.stream },
      );

      const result = out.json();
      // The status subcommand must keep its read-only snapshot semantics.
      assert.equal(result.code, "DEMAND_PRD_INTAKE_BLOCKED");
      assert.notEqual(result.code, "INTERVIEW_OK");
      // Blocked snapshots exit non-zero; the explicit-status path must not be
      // silently rewritten into a session-writing interview call.
      assert.equal(exitCode, 1);

      // And no session file should have been created.
      const interviewsDir = join(root, ".yolo", "demand-interviews");
      assert.ok(
        !existsSync(interviewsDir),
        "explicit `yolo demand status` must not write an interview session",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("`yolo demand` with no idea is unchanged — still returns an empty status snapshot", async () => {
    const root = tempProject();
    try {
      const out = capture();
      const exitCode = await runYoloCli(
        ["demand", `--cwd=${root}`, "--json"],
        { cwd: root, stdout: out.stream },
      );

      const result = out.json();
      // No idea → no interview. The empty snapshot stays a status call.
      assert.notEqual(result.code, "INTERVIEW_OK");
      assert.equal(exitCode, 1);
      const interviewsDir = join(root, ".yolo", "demand-interviews");
      assert.ok(
        !existsSync(interviewsDir),
        "bare `yolo demand` with no idea must not write an interview session",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("default continuation reads .yolo and advances from start through generated PRD", () => {
    const root = tempProject();
    const stateRoot = join(root, ".yolo");
    const demandDir = join(stateRoot, "demand", "DEMAND-AUTO");
    const officeDir = join(stateRoot, "demand", "office-hours", "OFFICE-AUTO");
    try {
      assert.equal(resolveDemandContinuation({ projectRoot: root }).stage, "brainstorm");

      mkdirSync(demandDir, { recursive: true });
      writeFileSync(join(demandDir, "session.json"), JSON.stringify({ phase: "brainstorm", readiness: { status: "ready" } }));
      assert.equal(resolveDemandContinuation({ projectRoot: root }).stage, "discuss");

      writeFileSync(join(demandDir, "session.json"), JSON.stringify({ phase: "discuss", readiness: { status: "ready" } }));
      assert.equal(resolveDemandContinuation({ projectRoot: root }).stage, "office-hours");

      mkdirSync(officeDir, { recursive: true });
      writeFileSync(join(officeDir, "brief.json"), JSON.stringify({ selected_alternative: { id: "A" } }));
      assert.equal(resolveDemandContinuation({ projectRoot: root }).stage, "plan");

      writeFileSync(join(demandDir, "tasks.json"), JSON.stringify({ status: "success", tasks: [] }));
      assert.equal(resolveDemandContinuation({ projectRoot: root }).stage, "discover");

      mkdirSync(join(stateRoot, "discovery"), { recursive: true });
      writeFileSync(join(stateRoot, "discovery", "discovery.json"), JSON.stringify({ ready_for_plan: true }));
      assert.equal(resolveDemandContinuation({ projectRoot: root }).stage, "prd");

      writeFileSync(join(demandDir, "prd.json"), JSON.stringify({ schema: "yolo.prd.v1" }));
      const complete = resolveDemandContinuation({ projectRoot: root });
      assert.equal(complete.completed, true);
      assert.equal(complete.progress.remaining_steps, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit --stage remains an advanced rerun override", async () => {
    const root = tempProject();
    try {
      mkdirSync(join(root, ".yolo", "discovery"), { recursive: true });
      writeFileSync(join(root, ".yolo", "discovery", "discovery.json"), JSON.stringify({ ready_for_plan: true }));
      const out = capture();
      await runYoloCli(["demand", "--stage", "brainstorm", "重跑头脑风暴", `--cwd=${root}`, "--json", "--no-write"], { cwd: root, stdout: out.stream });
      const result = out.json();
      assert.ok(["DEMAND_BLOCKED", "DEMAND_WARNING", "DEMAND_READY"].includes(result.code));
      assert.equal(result.progress, undefined, "explicit override must not be decorated as automatic continuation");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
