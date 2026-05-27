import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  appendScopeAuditRecord,
  applyScopeAudit,
  buildCommitSkipDecision,
  buildCommitResultDecision,
  buildDocUpdatePayload,
  buildDryRunOutOfScopeBlock,
  buildScopeAuditDecision,
  buildScopeAuditRecord,
  buildTaskCommitMessage,
  commitTaskChanges,
  isDocUpdateHookFailure,
  runTaskCommitFlow,
  shouldUpdateDocsBeforeCommit,
  updateDocsBeforeCommit,
} from "../src/runtime/execution/commit-flow.js";

describe("commit flow helpers", () => {
  test("buildTaskCommitMessage preserves runner commit message shape", () => {
    assert.equal(buildTaskCommitMessage({
      task: { id: "T1", title: "first line\nsecond line" },
      mode: "dev",
      businessFiles: ["src/a.ts"],
    }), "feat: T1 [code] first line second line");

    assert.equal(buildTaskCommitMessage({
      task: { id: "T2", description: "metadata update" },
      mode: "fix",
      businessFiles: [],
    }), "fix: T2 [metadata-only] metadata update");
  });

  test("isDocUpdateHookFailure detects doc update hook stderr", () => {
    assert.equal(isDocUpdateHookFailure({ stderr: "SNAPSHOT.md 未暂存" }), true);
    assert.equal(isDocUpdateHookFailure({ stderr: "doc-update-check failed" }), true);
    assert.equal(isDocUpdateHookFailure({ stderr: "other git failure" }), false);
  });

  test("scope audit helpers build and append JSONL records without blocking callers", () => {
    const writes = [];
    const record = buildScopeAuditRecord({
      taskId: "T1",
      outOfScope: ["src/b.ts"],
      targetFiles: ["src/a.ts"],
      modified: ["src/a.ts", "src/b.ts"],
      nowIso: () => "2026-05-24T00:00:00.000Z",
    });

    assert.deepEqual(record, {
      ts: "2026-05-24T00:00:00.000Z",
      task: "T1",
      event: "SCOPE_AUDIT",
      outOfScope: ["src/b.ts"],
      targetFiles: ["src/a.ts"],
      modified: ["src/a.ts", "src/b.ts"],
    });

    const result = appendScopeAuditRecord({
      auditPath: "/repo/state/runtime/task-audit.jsonl",
      taskId: "T1",
      outOfScope: ["src/b.ts"],
      targetFiles: ["src/a.ts"],
      modified: ["src/a.ts", "src/b.ts"],
      appendFileSync: (file, content) => writes.push({ file, content }),
      nowIso: () => "2026-05-24T00:00:00.000Z",
    });

    assert.equal(result.written, true);
    assert.equal(writes[0].file, "/repo/state/runtime/task-audit.jsonl");
    assert.deepEqual(JSON.parse(writes[0].content), record);
    assert.deepEqual(appendScopeAuditRecord({ outOfScope: [] }), {
      written: false,
      skipped: true,
      reason: "no_out_of_scope",
    });
    assert.equal(appendScopeAuditRecord({
      auditPath: "/bad/path",
      taskId: "T1",
      outOfScope: ["src/b.ts"],
      appendFileSync: () => {
        throw new Error("disk full");
      },
    }).error, "disk full");
  });

  test("buildScopeAuditDecision returns logs and append payload for out-of-scope files", () => {
    assert.deepEqual(buildScopeAuditDecision({
      task: { id: "T1" },
      outOfScope: ["src/b.ts", "src/c.ts"],
      targetFiles: ["src/a.ts"],
      modified: ["src/a.ts", "src/b.ts", "src/c.ts"],
    }), {
      logs: [
        {
          id: "T1",
          marker: "⚠️",
          message: "工作区存在非本次任务文件: src/b.ts、src/c.ts",
        },
        {
          id: "T1",
          marker: "[AUDIT]",
          message: "2 files modified out of scope: src/b.ts, src/c.ts",
        },
      ],
      audit: {
        taskId: "T1",
        outOfScope: ["src/b.ts", "src/c.ts"],
        targetFiles: ["src/a.ts"],
        modified: ["src/a.ts", "src/b.ts", "src/c.ts"],
      },
    });
    assert.deepEqual(buildScopeAuditDecision({ outOfScope: [] }), {
      logs: [],
      audit: null,
    });
  });

  test("applyScopeAudit logs and appends audit decisions through injected callbacks", () => {
    const logs = [];
    const appends = [];
    const result = applyScopeAudit({
      auditPath: "/repo/state/runtime/task-audit.jsonl",
      task: { id: "T1" },
      outOfScope: ["src/b.ts"],
      targetFiles: ["src/a.ts"],
      modified: ["src/a.ts", "src/b.ts"],
      log: (id, marker, message) => logs.push({ id, marker, message }),
      appendRecord: (payload) => {
        appends.push(payload);
        return { written: true };
      },
    });

    assert.deepEqual(logs, [
      { id: "T1", marker: "⚠️", message: "工作区存在非本次任务文件: src/b.ts" },
      { id: "T1", marker: "[AUDIT]", message: "1 files modified out of scope: src/b.ts" },
    ]);
    assert.deepEqual(appends, [{
      auditPath: "/repo/state/runtime/task-audit.jsonl",
      taskId: "T1",
      outOfScope: ["src/b.ts"],
      targetFiles: ["src/a.ts"],
      modified: ["src/a.ts", "src/b.ts"],
    }]);
    assert.equal(result.auditResult.written, true);

    assert.deepEqual(applyScopeAudit({
      outOfScope: [],
      log: () => {
        throw new Error("should not log without out-of-scope files");
      },
      appendRecord: () => {
        throw new Error("should not append without out-of-scope files");
      },
    }).auditResult, {
      written: false,
      skipped: true,
      reason: "no_out_of_scope",
    });
  });

  test("buildDryRunOutOfScopeBlock hard-blocks dry-run scope violations", () => {
    assert.equal(buildDryRunOutOfScopeBlock({
      task: { task_kind: "feature" },
      outOfScope: ["src/b.ts"],
    }), null);

    assert.deepEqual(buildDryRunOutOfScopeBlock({
      task: { task_kind: "dry_run_artifact" },
      hasRealCode: true,
      businessFiles: ["src/a.ts"],
      metadataFiles: ["state/dry-run/report.md"],
      outOfScope: ["src/b.ts"],
    }), {
      committed: false,
      hasRealCode: true,
      businessFiles: ["src/a.ts"],
      metadataFiles: ["state/dry-run/report.md"],
      blocked: true,
      blockReason: "out_of_scope_files: src/b.ts",
      outOfScope: ["src/b.ts"],
    });
  });

  test("buildCommitSkipDecision models no-code metadata-only and dry-run skip outcomes", () => {
    assert.deepEqual(buildCommitSkipDecision({
      code: [],
      hasRealCode: true,
      businessFiles: ["src/a.ts"],
      metadataFiles: ["docs/a.md"],
      outOfScope: ["src/b.ts"],
    }), {
      reason: "no_code",
      log: { id: "", marker: "└─", message: "无代码文件改动，跳过 commit" },
      result: {
        committed: false,
        hasRealCode: false,
        businessFiles: [],
        metadataFiles: [],
        outOfScope: ["src/b.ts"],
      },
    });

    assert.deepEqual(buildCommitSkipDecision({
      code: ["package.json"],
      hasRealCode: false,
      businessFiles: [],
      metadataFiles: ["package.json"],
    }).result, {
      committed: false,
      hasRealCode: false,
      businessFiles: [],
      metadataFiles: ["package.json"],
      outOfScope: [],
    });

    assert.deepEqual(buildCommitSkipDecision({
      task: { task_kind: "dry_run_artifact" },
      code: ["state/dry-run/report.md"],
      hasRealCode: true,
      businessFiles: [],
      metadataFiles: ["state/dry-run/report.md"],
    }).result, {
      committed: true,
      hasRealCode: true,
      businessFiles: [],
      metadataFiles: ["state/dry-run/report.md"],
      outOfScope: [],
      skippedCommit: true,
    });

    assert.equal(buildCommitSkipDecision({
      task: { task_kind: "feature" },
      code: ["src/a.ts"],
      hasRealCode: true,
      businessFiles: ["src/a.ts"],
      metadataFiles: [],
    }), null);
  });

  test("doc update helpers skip dry-run artifacts and build runner payloads", async () => {
    assert.equal(shouldUpdateDocsBeforeCommit({ task_kind: "dry_run_artifact" }), false);
    assert.equal(shouldUpdateDocsBeforeCommit({ task_kind: "feature" }), true);

    assert.deepEqual(buildDocUpdatePayload({
      task: { id: "T1", title: "Task title" },
      modifiedFiles: ["src/a.ts"],
    }), {
      taskId: "T1",
      taskTitle: "Task title",
      modifiedFiles: ["src/a.ts"],
      status: "PASS",
    });

    const calls = [];
    const updated = await updateDocsBeforeCommit({
      task: { id: "T2", description: "Task description" },
      modifiedFiles: ["src/b.ts"],
      updateDocs: async (payload) => calls.push(payload),
    });

    assert.equal(updated.updated, true);
    assert.deepEqual(calls, [{
      taskId: "T2",
      taskTitle: "Task description",
      modifiedFiles: ["src/b.ts"],
      status: "PASS",
    }]);
    assert.deepEqual(await updateDocsBeforeCommit({
      task: { id: "D1", task_kind: "dry_run_artifact" },
      modifiedFiles: ["state/dry-run/report.md"],
      updateDocs: async () => {
        throw new Error("should not update dry-run docs");
      },
    }), {
      updated: false,
      skipped: true,
      reason: "dry_run_artifact",
    });
  });

  test("doc update helper imports the local updater, passes rootDir, and degrades to warning", async () => {
    const calls = [];
    const updated = await updateDocsBeforeCommit({
      rootDir: "/repo",
      task: { id: "T3", title: "Task title" },
      modifiedFiles: ["src/a.ts"],
      importDocUpdater: async () => ({
        updateDocs: async (payload, options) => calls.push({ payload, options }),
      }),
    });

    assert.equal(updated.updated, true);
    assert.deepEqual(calls, [{
      payload: {
        taskId: "T3",
        taskTitle: "Task title",
        modifiedFiles: ["src/a.ts"],
        status: "PASS",
      },
      options: { rootDir: "/repo" },
    }]);

    const failed = await updateDocsBeforeCommit({
      task: { id: "T4", title: "Task title" },
      modifiedFiles: ["src/b.ts"],
      importDocUpdater: async () => {
        throw new Error("missing updater");
      },
    });

    assert.equal(failed.updated, false);
    assert.equal(failed.skipped, true);
    assert.equal(failed.reason, "doc_update_failed");
    assert.equal(failed.error, "missing updater");
  });

  test("buildCommitResultDecision maps commit outcomes to logs events refresh and result", () => {
    assert.deepEqual(buildCommitResultDecision({
      commitResult: { committed: true, retried: false, commit: "abc123" },
      task: { id: "T1" },
      hasRealCode: true,
      businessFiles: ["src/a.ts"],
      metadataFiles: ["package.json"],
    }), {
      status: "committed",
      logs: [{ id: "", marker: "└─", message: "commit ok (1 biz, 1 meta)" }],
      events: [{ event: "task_commit", data: { task: "T1", commit: "abc123" } }],
      refreshBaselines: true,
      result: {
        committed: true,
        hasRealCode: true,
        businessFiles: ["src/a.ts"],
        metadataFiles: ["package.json"],
      },
    });

    assert.deepEqual(buildCommitResultDecision({
      commitResult: { committed: true, retried: true, commit: "def456" },
      task: { id: "T2" },
      hasRealCode: true,
      businessFiles: ["src/b.ts"],
      metadataFiles: [],
    }).logs, []);

    assert.deepEqual(buildCommitResultDecision({
      commitResult: { committed: false, reason: "git_add_failed", nonBlocking: true, error: "not a work tree" },
      task: { id: "T2B" },
      hasRealCode: true,
      businessFiles: ["src/c.ts"],
    }), {
      status: "commit_warning",
      logs: [{ id: "T2B", marker: "WARN", message: "commit 未完成但不阻塞已通过 gate 的合并: git_add_failed" }],
      events: [{ event: "task_commit_warning", data: { task: "T2B", reason: "git_add_failed", error: "not a work tree" } }],
      refreshBaselines: false,
      result: {
        committed: false,
        hasRealCode: true,
        businessFiles: ["src/c.ts"],
        metadataFiles: [],
        commitWarning: "git_add_failed",
        commitError: "not a work tree",
        nonBlocking: true,
      },
    });

    assert.deepEqual(buildCommitResultDecision({
      commitResult: { committed: false, reason: "doc_retry_failed" },
      task: { id: "T3" },
      businessFiles: ["src/a.ts"],
    }), {
      status: "doc_retry_failed",
      logs: [{ id: "T3", marker: "!!", message: "commit 失败（doc 重试），worktree 已 merge，跳过 rollback" }],
      events: [],
      refreshBaselines: false,
      result: {
        committed: false,
        hasRealCode: false,
        businessFiles: ["src/a.ts"],
        metadataFiles: [],
      },
    });

    assert.deepEqual(buildCommitResultDecision({
      commitResult: { committed: false, reason: "commit_failed" },
      task: { id: "T4" },
    }).logs, [
      { id: "T4", marker: "!!", message: "commit 失败，worktree 已 merge，跳过 rollback" },
    ]);
  });

  test("runTaskCommitFlow blocks dry-run out-of-scope before docs or commit work", async () => {
    const result = await runTaskCommitFlow({
      task: { id: "D1", task_kind: "dry_run_artifact" },
      code: ["state/dry-run/report.md"],
      hasRealCode: true,
      metadataFiles: ["state/dry-run/report.md"],
      outOfScope: ["src/app.ts"],
      updateDocs: async () => {
        throw new Error("should not update docs");
      },
      commitChanges: () => {
        throw new Error("should not commit");
      },
    });

    assert.equal(result.status, "blocked");
    assert.deepEqual(result.result, {
      committed: false,
      hasRealCode: true,
      businessFiles: [],
      metadataFiles: ["state/dry-run/report.md"],
      blocked: true,
      blockReason: "out_of_scope_files: src/app.ts",
      outOfScope: ["src/app.ts"],
    });
  });

  test("runTaskCommitFlow updates docs before skip decisions", async () => {
    const docs = [];
    const logs = [];
    const result = await runTaskCommitFlow({
      task: { id: "T1", title: "Metadata task" },
      code: ["package.json"],
      hasRealCode: false,
      metadataFiles: ["package.json"],
      updateDocs: async (payload) => docs.push(payload),
      log: (id, marker, message) => logs.push({ id, marker, message }),
      commitChanges: () => {
        throw new Error("should not commit skipped metadata-only work");
      },
    });

    assert.equal(result.status, "metadata_only");
    assert.deepEqual(docs, [{
      taskId: "T1",
      taskTitle: "Metadata task",
      modifiedFiles: ["package.json"],
      status: "PASS",
    }]);
    assert.deepEqual(logs, [
      { id: "", marker: "└─", message: "仅元数据改动 (1 个),无业务代码,跳过 commit" },
    ]);
    assert.deepEqual(result.result, {
      committed: false,
      hasRealCode: false,
      businessFiles: [],
      metadataFiles: ["package.json"],
      outOfScope: [],
    });
  });

  test("runTaskCommitFlow keeps doc update failures nonblocking", async () => {
    const logs = [];
    const result = await runTaskCommitFlow({
      rootDir: "/repo",
      task: { id: "T1", title: "Code task" },
      code: ["src/a.ts"],
      hasRealCode: true,
      businessFiles: ["src/a.ts"],
      importDocUpdater: async () => {
        throw new Error("doc import failed");
      },
      commitChanges: () => ({ committed: true, retried: false, commit: "abc123" }),
      log: (id, marker, message) => logs.push({ id, marker, message }),
    });

    assert.equal(result.status, "committed");
    assert.equal(result.docsResult.reason, "doc_update_failed");
    assert.deepEqual(logs, [
      { id: "T1", marker: "WARN", message: "doc update skipped: doc import failed" },
      { id: "", marker: "└─", message: "commit ok (1 biz, 0 meta)" },
    ]);
  });

  test("runTaskCommitFlow commits code work and applies logs events and baseline refresh", async () => {
    const docs = [];
    const commits = [];
    const logs = [];
    const events = [];
    let refreshCount = 0;
    const result = await runTaskCommitFlow({
      rootDir: "/repo",
      task: { id: "T2", title: "Implement feature" },
      code: ["src/a.ts"],
      hasRealCode: true,
      businessFiles: ["src/a.ts"],
      mode: "dev",
      updateDocs: async (payload) => docs.push(payload),
      commitChanges: (payload) => {
        commits.push(payload);
        return { committed: true, retried: false, commit: "abc123" };
      },
      log: (id, marker, message) => logs.push({ id, marker, message }),
      emitEvent: (event, data) => events.push({ event, data }),
      refreshBaselines: () => {
        refreshCount += 1;
      },
    });

    assert.equal(result.status, "committed");
    assert.equal(result.message, "feat: T2 [code] Implement feature");
    assert.deepEqual(docs, [{
      taskId: "T2",
      taskTitle: "Implement feature",
      modifiedFiles: ["src/a.ts"],
      status: "PASS",
    }]);
    assert.deepEqual(commits, [{
      rootDir: "/repo",
      files: ["src/a.ts"],
      message: "feat: T2 [code] Implement feature",
    }]);
    assert.deepEqual(logs, [
      { id: "", marker: "└─", message: "commit ok (1 biz, 0 meta)" },
    ]);
    assert.deepEqual(events, [
      { event: "task_commit", data: { task: "T2", commit: "abc123" } },
    ]);
    assert.equal(refreshCount, 1);
    assert.deepEqual(result.result, {
      committed: true,
      hasRealCode: true,
      businessFiles: ["src/a.ts"],
      metadataFiles: [],
    });
  });

  test("runTaskCommitFlow reports commit failures without refreshing baselines", async () => {
    const logs = [];
    let refreshCount = 0;
    const result = await runTaskCommitFlow({
      rootDir: "/repo",
      task: { id: "T3" },
      code: ["src/a.ts"],
      hasRealCode: true,
      businessFiles: ["src/a.ts"],
      updateDocs: async () => {},
      commitChanges: () => ({ committed: false, reason: "doc_retry_failed" }),
      log: (id, marker, message) => logs.push({ id, marker, message }),
      refreshBaselines: () => {
        refreshCount += 1;
      },
    });

    assert.equal(result.status, "doc_retry_failed");
    assert.deepEqual(logs, [
      { id: "T3", marker: "!!", message: "commit 失败（doc 重试），worktree 已 merge，跳过 rollback" },
    ]);
    assert.equal(refreshCount, 0);
    assert.deepEqual(result.result, {
      committed: false,
      hasRealCode: true,
      businessFiles: ["src/a.ts"],
      metadataFiles: [],
    });
  });

  test("commitTaskChanges stages files, commits, and reads short hash", () => {
    const calls = [];
    const execFileSync = (bin, args) => {
      calls.push([bin, ...args]);
      if (args[0] === "rev-parse") return "abc123\n";
      return "";
    };

    const result = commitTaskChanges({
      rootDir: "/repo",
      files: ["src/a.ts"],
      message: "fix: T1 [code] task",
      execFileSync,
    });

    assert.deepEqual(result, { committed: true, retried: false, commit: "abc123" });
    assert.deepEqual(calls, [
      ["git", "add", "src/a.ts"],
      ["git", "commit", "-m", "fix: T1 [code] task"],
      ["git", "rev-parse", "--short", "HEAD"],
    ]);
  });

  test("commitTaskChanges retries doc update hook failures with doc files", () => {
    const calls = [];
    let commitAttempts = 0;
    const execFileSync = (bin, args) => {
      calls.push([bin, ...args]);
      if (args[0] === "commit") {
        commitAttempts += 1;
        if (commitAttempts === 1) {
          const error = new Error("commit failed");
          error.stderr = "doc-update-check failed";
          throw error;
        }
      }
      if (args[0] === "rev-parse") return "def456\n";
      return "";
    };

    const result = commitTaskChanges({
      rootDir: "/repo",
      files: ["src/a.ts"],
      docUpdateFiles: ["SESSION.md", "SNAPSHOT.md"],
      message: "fix: T1 [code] task",
      execFileSync,
    });

    assert.deepEqual(result, { committed: true, retried: true, commit: "def456" });
    assert.deepEqual(calls, [
      ["git", "add", "src/a.ts"],
      ["git", "commit", "-m", "fix: T1 [code] task"],
      ["git", "add", "SESSION.md", "SNAPSHOT.md"],
      ["git", "commit", "-m", "fix: T1 [code] task"],
      ["git", "rev-parse", "--short", "HEAD"],
    ]);
  });

  test("commitTaskChanges resets docs only when doc retry fails", () => {
    const calls = [];
    let commitAttempts = 0;
    const execFileSync = (bin, args) => {
      calls.push([bin, ...args]);
      if (args[0] === "commit") {
        commitAttempts += 1;
        const error = new Error("commit failed");
        error.stderr = commitAttempts === 1 ? "SNAPSHOT.md 未暂存" : "retry failed";
        throw error;
      }
      return "";
    };

    const result = commitTaskChanges({
      rootDir: "/repo",
      files: ["src/a.ts"],
      docUpdateFiles: ["SESSION.md", "SNAPSHOT.md"],
      message: "fix: T1 [code] task",
      execFileSync,
    });

    assert.deepEqual(result, {
      committed: false,
      retried: true,
      reason: "doc_retry_failed",
      nonBlocking: true,
      error: "SNAPSHOT.md 未暂存",
    });
    assert.deepEqual(calls.at(-1), ["git", "reset", "HEAD", "--", "SESSION.md", "SNAPSHOT.md"]);
  });

  test("commitTaskChanges resets code and docs on normal commit failure", () => {
    const calls = [];
    const execFileSync = (bin, args) => {
      calls.push([bin, ...args]);
      if (args[0] === "commit") {
        const error = new Error("commit failed");
        error.stderr = "normal failure";
        throw error;
      }
      return "";
    };

    const result = commitTaskChanges({
      rootDir: "/repo",
      files: ["src/a.ts"],
      docUpdateFiles: ["SESSION.md", "SNAPSHOT.md"],
      message: "fix: T1 [code] task",
      execFileSync,
    });

    assert.deepEqual(result, {
      committed: false,
      retried: false,
      reason: "commit_failed",
      nonBlocking: true,
      error: "normal failure",
    });
    assert.deepEqual(calls.slice(-2), [
      ["git", "reset", "HEAD", "--", "src/a.ts"],
      ["git", "reset", "HEAD", "--", "SESSION.md", "SNAPSHOT.md"],
    ]);
  });

  test("commitTaskChanges returns a nonblocking warning when git add fails", () => {
    const calls = [];
    const execFileSync = (bin, args) => {
      calls.push([bin, ...args]);
      if (args[0] === "add") {
        const error = new Error("add failed");
        error.stderr = "fatal: this operation must be run in a work tree";
        throw error;
      }
      return "";
    };

    const result = commitTaskChanges({
      rootDir: "/repo",
      files: ["src/a.ts"],
      message: "fix: T1 [code] task",
      execFileSync,
    });

    assert.deepEqual(result, {
      committed: false,
      retried: false,
      reason: "git_add_failed",
      nonBlocking: true,
      error: "fatal: this operation must be run in a work tree",
    });
    assert.deepEqual(calls, [["git", "add", "src/a.ts"]]);
  });
});
