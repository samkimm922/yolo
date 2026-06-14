import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runYoloCli } from "../src/cli/yolo.js";

function tempProject() {
  return mkdtempSync(join(tmpdir(), "demand-onboard-"));
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
  // Soak finding: a non-technical user running `yolo demand "<idea>"` (no flags,
  // no prior session) used to hit a blocked DEMAND_NOT_PRD_READY snapshot with a
  // free-text question and no runnable next step. The interview stage is the
  // correct onboarding entry — it writes a session and hands back a
  // copy-pasteable `yolo interview answer ...` command. Route bare ideas there.
  test("bare `yolo demand \"<idea>\"` starts an interview session instead of blocking", async () => {
    const root = tempProject();
    try {
      const out = capture();
      const exitCode = await runYoloCli(
        ["demand", "做个看板", `--cwd=${root}`, "--json"],
        { cwd: root, stdout: out.stream },
      );

      const result = out.json();
      // Interview start is a success outcome (INTERVIEW_OK), not a blocked snapshot.
      assert.equal(exitCode, 0, `exit=${exitCode} status=${result.status}`);
      assert.equal(result.status, "success");
      assert.equal(result.code, "INTERVIEW_OK");

      // A real session file must land on disk so the next `yolo interview answer`
      // has somewhere to write.
      const sessionPath: string | undefined = result.session_path || result.interview?.interview_path;
      assert.ok(
        typeof sessionPath === "string" && sessionPath.length > 0,
        "interview must return a session_path",
      );
      assert.ok(
        existsSync(sessionPath),
        `interview session file must exist on disk: ${sessionPath}`,
      );

      // The session must carry the user's original idea so the onboarding flow
      // is continuous, not a blank restart.
      const session = JSON.parse(readFileSync(sessionPath, "utf8"));
      const ideaText = [session.idea, session.objective, session.title]
        .filter((value) => typeof value === "string" && value.length > 0)
        .join(" ");
      assert.ok(
        ideaText.includes("做个看板"),
        `session must preserve the user's idea; got idea=${JSON.stringify(session.idea)}, objective=${JSON.stringify(session.objective)}, title=${JSON.stringify(session.title)}`,
      );

      // The first question must be surfaced so the user knows what to answer next.
      assert.ok(
        result.next_question || result.interview?.next_question,
        "interview must surface a first question",
      );

      // Every next_action handed back must be runnable in a terminal — no slash forms.
      const actions: string[] = result.next_actions || [];
      assert.ok(actions.length > 0, "interview must hand back at least one next_action");
      for (const action of actions) {
        assert.ok(
          !action.includes("/yolo-"),
          `next_action must not reference slash commands: ${action}`,
        );
      }
      // And at least one action must be a concrete `yolo interview answer ...`.
      assert.ok(
        actions.some((action) => action.includes("yolo interview answer")),
        `expected a copy-pasteable 'yolo interview answer' action; got: ${actions.join(" | ")}`,
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
      assert.equal(result.code, "DEMAND_NOT_PRD_READY");
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
});
