import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptSession,
  buildRetryLearningText,
} from "../src/runtime/execution/session-prompt.js";

describe("session prompt helpers", () => {
  test("buildRetryLearningText combines learn output and failure hint", () => {
    assert.equal(buildRetryLearningText({
      learnStdout: "lesson",
      failureHint: "hint",
      lastGateError: "tsc failed",
    }), "lesson\nhint");
  });

  test("buildRetryLearningText adds file split instruction for 150-line scope failures", () => {
    const text = buildRetryLearningText({
      learnStdout: "lesson",
      failureHint: "hint",
      lastGateError: "改动范围 超过 150",
    });

    assert.match(text, /文件超过 150 行限制/);
    assert.match(text, /必须先拆分文件/);
  });

  test("buildPromptSession builds plain prompt args without gate failure context", () => {
    assert.deepEqual(buildPromptSession({
      task: { id: "FIX-1" },
      prdPath: "prd.json",
      attempt: 1,
      mode: "fix",
    }), {
      args: [
        "--task=FIX-1",
        "--prd=prd.json",
        "--attempt=1",
        "--mode=fix",
        "--session-id=FIX-1-attempt-1",
      ],
      failureHint: "",
      failureHintLog: null,
      contextContract: {
        schema: "yolo.task.fresh_session_context.v1",
        fresh_session: true,
        session_id: "FIX-1-attempt-1",
        task_id: "FIX-1",
        attempt: 1,
        allowed_context_refs: [{ kind: "prd_slice", ref: "prd.json" }],
        forbidden_context: [
          "previous_task_chat_transcript",
          "previous_task_provider_stdout",
          "unbounded_session_memory",
          "unscoped_project_history",
        ],
        project_root: null,
        state_root: null,
        max_failure_hint_chars: 2000,
      },
    });
  });

  test("buildPromptSession carries project and state roots for experience retrieval", () => {
    const session = buildPromptSession({
      task: { id: "FIX-ROOTS" },
      prdPath: "prd.json",
      attempt: 1,
      mode: "fix",
      rootDir: "/repo",
      stateRoot: "/repo/.yolo",
    });

    assert.deepEqual(session.args, [
      "--task=FIX-ROOTS",
      "--prd=prd.json",
      "--attempt=1",
      "--mode=fix",
      "--session-id=FIX-ROOTS-attempt-1",
      "--cwd=/repo",
      "--state-root=/repo/.yolo",
    ]);
    assert.equal(session.contextContract.fresh_session, true);
    assert.ok(session.contextContract.allowed_context_refs.some((entry) => entry.kind === "bounded_learning"));
  });

  test("buildPromptSession injects failure learnings when gate error exists", () => {
    const session = buildPromptSession({
      task: {
        id: "FIX-2",
        scope: { targets: [{ file: "src/a.ts" }] },
      },
      prdPath: "prd.json",
      attempt: 2,
      mode: "dev",
      lastGateError: [
        "以下 gate 检查失败:",
        "- tsc [FAIL]: src/a.ts error TS2322",
      ].join("\n"),
      learnStdout: "prior lesson",
    });

    assert.deepEqual(session.args.slice(0, 4), [
      "--task=FIX-2",
      "--prd=prd.json",
      "--attempt=2",
      "--mode=dev",
    ]);
    assert.equal(session.args[4], "--session-id=FIX-2-attempt-2");
    assert.equal(session.args[5], "--fix");
    assert.match(session.args[6], /^--learnings=prior lesson\n/);
    assert.match(session.args[6], /src\/a\.ts/);
    assert.match(session.failureHintLog, /错误注入 \(\d+ → \d+ 字符\)/);
    assert.ok(session.contextContract.allowed_context_refs.some((entry) => entry.kind === "bounded_failure_hint"));
  });
});
