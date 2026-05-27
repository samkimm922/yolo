import { execFileSync as defaultExecFileSync } from "node:child_process";
import { appendFileSync as defaultAppendFileSync } from "node:fs";

export const DEFAULT_DOC_UPDATE_FILES = ["SESSION.md", "SNAPSHOT.md", "DELIVERY_LOG.md"];

export function isDocUpdateHookFailure(error) {
  const stderr = String(error?.stderr || "");
  return stderr.includes("SNAPSHOT.md 未暂存") || stderr.includes("doc-update-check");
}

export function buildTaskCommitMessage({ task = {}, mode = "fix", businessFiles = [] } = {}) {
  const prefix = mode === "dev" ? "feat" : "fix";
  const tag = businessFiles.length > 0 ? "[code]" : "[metadata-only]";
  const title = (task.title || task.description || "").replace(/\n/g, " ").slice(0, 50);
  return `${prefix}: ${task.id} ${tag} ${title}`;
}

export function buildScopeAuditRecord({
  taskId,
  outOfScope = [],
  targetFiles = [],
  modified = [],
  nowIso = () => new Date().toISOString(),
} = {}) {
  return {
    ts: nowIso(),
    task: taskId,
    event: "SCOPE_AUDIT",
    outOfScope,
    targetFiles,
    modified,
  };
}

export function appendScopeAuditRecord({
  auditPath,
  taskId,
  outOfScope = [],
  targetFiles = [],
  modified = [],
  appendFileSync = defaultAppendFileSync,
  nowIso,
} = {}) {
  if (outOfScope.length === 0) {
    return { written: false, skipped: true, reason: "no_out_of_scope" };
  }
  const record = buildScopeAuditRecord({ taskId, outOfScope, targetFiles, modified, nowIso });
  try {
    appendFileSync(auditPath, `${JSON.stringify(record)}\n`);
    return { written: true, record };
  } catch (error) {
    return { written: false, record, error: error.message };
  }
}

export function buildScopeAuditDecision({
  task = {},
  outOfScope = [],
  targetFiles = [],
  modified = [],
} = {}) {
  if (outOfScope.length === 0) {
    return { logs: [], audit: null };
  }
  return {
    logs: [
      {
        id: task.id,
        marker: "⚠️",
        message: `工作区存在非本次任务文件: ${outOfScope.join("、")}`,
      },
      {
        id: task.id,
        marker: "[AUDIT]",
        message: `${outOfScope.length} files modified out of scope: ${outOfScope.join(", ")}`,
      },
    ],
    audit: {
      taskId: task.id,
      outOfScope,
      targetFiles,
      modified,
    },
  };
}

export function applyScopeAudit({
  auditPath,
  task = {},
  outOfScope = [],
  targetFiles = [],
  modified = [],
  log = () => {},
  appendRecord = appendScopeAuditRecord,
} = {}) {
  const decision = buildScopeAuditDecision({ task, outOfScope, targetFiles, modified });
  for (const entry of decision.logs) {
    log(entry.id, entry.marker, entry.message);
  }
  const auditResult = decision.audit
    ? appendRecord({ auditPath, ...decision.audit })
    : { written: false, skipped: true, reason: "no_out_of_scope" };
  return { decision, auditResult };
}

export function buildDryRunOutOfScopeBlock({
  task = {},
  hasRealCode = false,
  businessFiles = [],
  metadataFiles = [],
  outOfScope = [],
} = {}) {
  if (task.task_kind !== "dry_run_artifact" || outOfScope.length === 0) return null;
  return {
    committed: false,
    hasRealCode,
    businessFiles,
    metadataFiles,
    blocked: true,
    blockReason: `out_of_scope_files: ${outOfScope.join(", ")}`,
    outOfScope,
  };
}

export function buildCommitSkipDecision({
  task = {},
  code = [],
  hasRealCode = false,
  businessFiles = [],
  metadataFiles = [],
  outOfScope = [],
} = {}) {
  if (code.length === 0) {
    return {
      reason: "no_code",
      log: { id: "", marker: "└─", message: "无代码文件改动，跳过 commit" },
      result: { committed: false, hasRealCode: false, businessFiles: [], metadataFiles: [], outOfScope },
    };
  }
  if (!hasRealCode) {
    return {
      reason: "metadata_only",
      log: { id: "", marker: "└─", message: `仅元数据改动 (${metadataFiles.length} 个),无业务代码,跳过 commit` },
      result: { committed: false, hasRealCode: false, businessFiles, metadataFiles, outOfScope },
    };
  }
  if (task.task_kind === "dry_run_artifact") {
    return {
      reason: "dry_run_artifact",
      log: { id: "", marker: "└─", message: `dry-run artifact 已写入工作区 (${metadataFiles.length} 个),跳过 git commit` },
      result: { committed: true, hasRealCode: true, businessFiles, metadataFiles, outOfScope, skippedCommit: true },
    };
  }
  return null;
}

export function shouldUpdateDocsBeforeCommit(task = {}) {
  return task.task_kind !== "dry_run_artifact";
}

export function buildDocUpdatePayload({
  task = {},
  modifiedFiles = [],
  status = "PASS",
} = {}) {
  return {
    taskId: task.id,
    taskTitle: task.title || task.description || "",
    modifiedFiles,
    status,
  };
}

export async function updateDocsBeforeCommit({
  rootDir,
  task = {},
  modifiedFiles = [],
  status = "PASS",
  updateDocs,
  importDocUpdater = () => import("./doc-updater.js"),
} = {}) {
  if (!shouldUpdateDocsBeforeCommit(task)) {
    return { updated: false, skipped: true, reason: "dry_run_artifact" };
  }
  const payload = buildDocUpdatePayload({ task, modifiedFiles, status });
  try {
    const updater = updateDocs || (await importDocUpdater()).updateDocs;
    await updater(payload, { rootDir });
    return { updated: true, payload };
  } catch (error) {
    return {
      updated: false,
      skipped: true,
      reason: "doc_update_failed",
      error: error?.message || String(error),
      payload,
    };
  }
}

export function buildCommitResultDecision({
  commitResult = {},
  task = {},
  hasRealCode = false,
  businessFiles = [],
  metadataFiles = [],
} = {}) {
  const result = { committed: false, hasRealCode, businessFiles, metadataFiles };
  if (commitResult.committed) {
    return {
      status: "committed",
      logs: commitResult.retried ? [] : [{
        id: "",
        marker: "└─",
        message: `commit ok (${businessFiles.length} biz, ${metadataFiles.length} meta)`,
      }],
      events: commitResult.commit ? [{
        event: "task_commit",
        data: { task: task.id, commit: commitResult.commit },
      }] : [],
      refreshBaselines: true,
      result: { ...result, committed: true },
    };
  }
  if (commitResult.nonBlocking === true) {
    const reason = commitResult.reason || "commit_failed";
    return {
      status: "commit_warning",
      logs: [{
        id: task.id,
        marker: "WARN",
        message: `commit 未完成但不阻塞已通过 gate 的合并: ${reason}`,
      }],
      events: [{
        event: "task_commit_warning",
        data: { task: task.id, reason, error: commitResult.error || null },
      }],
      refreshBaselines: false,
      result: {
        ...result,
        commitWarning: reason,
        commitError: commitResult.error,
        nonBlocking: true,
      },
    };
  }
  if (commitResult.reason === "doc_retry_failed") {
    return {
      status: "doc_retry_failed",
      logs: [{
        id: task.id,
        marker: "!!",
        message: "commit 失败（doc 重试），worktree 已 merge，跳过 rollback",
      }],
      events: [],
      refreshBaselines: false,
      result,
    };
  }
  return {
    status: "commit_failed",
    logs: [{
      id: task.id,
      marker: "!!",
      message: "commit 失败，worktree 已 merge，跳过 rollback",
    }],
    events: [],
    refreshBaselines: false,
    result,
  };
}

export async function runTaskCommitFlow({
  rootDir,
  task = {},
  code = [],
  hasRealCode = false,
  businessFiles = [],
  metadataFiles = [],
  outOfScope = [],
  mode = "fix",
  log = () => {},
  emitEvent = () => {},
  refreshBaselines = () => {},
  updateDocs,
  importDocUpdater,
  commitChanges = commitTaskChanges,
} = {}) {
  const dryRunOutOfScopeBlock = buildDryRunOutOfScopeBlock({
    task,
    hasRealCode,
    businessFiles,
    metadataFiles,
    outOfScope,
  });
  if (dryRunOutOfScopeBlock) {
    return { status: "blocked", result: dryRunOutOfScopeBlock };
  }

  const docsResult = await updateDocsBeforeCommit({
    rootDir,
    task,
    modifiedFiles: code,
    updateDocs,
    importDocUpdater,
  });
  if (docsResult.reason === "doc_update_failed") {
    log(task.id, "WARN", `doc update skipped: ${docsResult.error}`);
  }
  const skipDecision = buildCommitSkipDecision({
    task,
    code,
    hasRealCode,
    businessFiles,
    metadataFiles,
    outOfScope,
  });
  if (skipDecision) {
    log(skipDecision.log.id, skipDecision.log.marker, skipDecision.log.message);
    return {
      status: skipDecision.reason,
      docsResult,
      skipDecision,
      result: skipDecision.result,
    };
  }

  const message = buildTaskCommitMessage({ task, mode, businessFiles });
  const commitResult = commitChanges({ rootDir, files: code, message });
  const commitDecision = buildCommitResultDecision({
    commitResult,
    task,
    hasRealCode,
    businessFiles,
    metadataFiles,
  });
  for (const entry of commitDecision.logs) {
    log(entry.id, entry.marker, entry.message);
  }
  for (const event of commitDecision.events) {
    emitEvent(event.event, event.data);
  }
  if (commitDecision.refreshBaselines) {
    refreshBaselines();
  }
  return {
    status: commitDecision.status,
    docsResult,
    message,
    commitResult,
    commitDecision,
    result: commitDecision.result,
  };
}

function readShortCommitHash({ rootDir, execFileSync = defaultExecFileSync } = {}) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function resetStagedFiles(files, { rootDir, execFileSync = defaultExecFileSync } = {}) {
  if (!files?.length) return false;
  try {
    execFileSync("git", ["reset", "HEAD", "--", ...files], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function describeGitError(error) {
  const stderr = String(error?.stderr || "").trim();
  const stdout = String(error?.stdout || "").trim();
  return stderr || stdout || error?.message || String(error);
}

export function commitTaskChanges({
  rootDir,
  files = [],
  docUpdateFiles = DEFAULT_DOC_UPDATE_FILES,
  message,
  execFileSync = defaultExecFileSync,
} = {}) {
  const gitOptions = { cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] };
  try {
    execFileSync("git", ["add", ...files], gitOptions);
  } catch (error) {
    return {
      committed: false,
      retried: false,
      reason: "git_add_failed",
      nonBlocking: true,
      error: describeGitError(error),
    };
  }

  try {
    execFileSync("git", ["commit", "-m", message], gitOptions);
    return {
      committed: true,
      retried: false,
      commit: readShortCommitHash({ rootDir, execFileSync }),
    };
  } catch (error) {
    if (isDocUpdateHookFailure(error)) {
      try {
        execFileSync("git", ["add", ...docUpdateFiles], gitOptions);
        execFileSync("git", ["commit", "-m", message], gitOptions);
        return {
          committed: true,
          retried: true,
          commit: readShortCommitHash({ rootDir, execFileSync }),
        };
      } catch {
        resetStagedFiles(docUpdateFiles, { rootDir, execFileSync });
        return {
          committed: false,
          retried: true,
          reason: "doc_retry_failed",
          nonBlocking: true,
          error: describeGitError(error),
        };
      }
    }
    resetStagedFiles(files, { rootDir, execFileSync });
    resetStagedFiles(docUpdateFiles, { rootDir, execFileSync });
    return {
      committed: false,
      retried: false,
      reason: "commit_failed",
      nonBlocking: true,
      error: describeGitError(error),
    };
  }
}
