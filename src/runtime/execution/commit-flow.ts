import { execFileSync as defaultExecFileSync } from "node:child_process";
import { appendFileSync as defaultAppendFileSync } from "node:fs";

export const DEFAULT_DOC_UPDATE_FILES = ["docs/memory/SESSION.md", "docs/memory/SNAPSHOT.md", "docs/memory/DELIVERY_LOG.md"];

export function isDocUpdateHookFailure(error: unknown) {
  const stderr = String((error as { stderr?: unknown } | null | undefined)?.stderr || "");
  return stderr.includes("SNAPSHOT.md") || stderr.includes("doc-update-check");
}

export function buildTaskCommitMessage({ task = Object(), mode = "fix", businessFiles = [] } = Object()) {
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
} = Object()) {
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
  required = true,
  appendFileSync = defaultAppendFileSync,
  nowIso,
} = Object()) {
  if (outOfScope.length === 0) {
    return { written: false, skipped: true, reason: "no_out_of_scope" };
  }
  const record = buildScopeAuditRecord({ taskId, outOfScope, targetFiles, modified, nowIso });
  try {
    appendFileSync(auditPath, `${JSON.stringify(record)}\n`);
    return { written: true, record };
  } catch (error) {
    return {
      written: false,
      record,
      reason: "scope_audit_write_failed",
      error: (error as { message?: string } | null | undefined)?.message || String(error),
      blocked: required !== false,
    };
  }
}

export function buildScopeAuditDecision({
  task = Object(),
  outOfScope = [],
  targetFiles = [],
  modified = [],
} = Object()) {
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
  task = Object(),
  outOfScope = [],
  targetFiles = [],
  modified = [],
  required = true,
  log = (..._args: unknown[]) => {},
  appendRecord = appendScopeAuditRecord,
} = Object()) {
  const decision = buildScopeAuditDecision({ task, outOfScope, targetFiles, modified });
  for (const entry of decision.logs) {
    log(entry.id, entry.marker, entry.message);
  }
  const auditResult = decision.audit
    ? appendRecord({ auditPath, ...decision.audit, required })
    : { written: false, skipped: true, reason: "no_out_of_scope" };
  if (auditResult?.error) {
    if (required !== false) {
      log(task.id, "!!", `scope audit write failed: ${auditResult.error}`);
      const error = Object.assign(new Error(`scope_audit_write_failed: ${auditResult.error}`), { auditResult });
      throw error;
    }
    log(task.id, "WARN", `scope audit skipped: ${auditResult.error}`);
  }
  return { decision, auditResult };
}

export function buildDryRunOutOfScopeBlock({
  task = Object(),
  hasRealCode = false,
  businessFiles = [],
  metadataFiles = [],
  outOfScope = [],
} = Object()) {
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

export function buildOutOfScopeBlock({
  hasRealCode = false,
  businessFiles = [],
  metadataFiles = [],
  outOfScope = [],
} = Object()) {
  if (outOfScope.length === 0) return null;
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

function uniqueFiles(files: string[] = []) {
  return [...new Set(files.filter(Boolean))];
}

export function buildCommitSkipDecision({
  task = Object(),
  code = [],
  hasRealCode = false,
  businessFiles = [],
  metadataFiles = [],
  outOfScope = [],
} = Object()) {
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

export function shouldUpdateDocsBeforeCommit(task = Object()) {
  return task.task_kind !== "dry_run_artifact";
}

export function buildDocUpdatePayload({
  task = Object(),
  modifiedFiles = [],
  status = "PASS",
} = Object()) {
  return {
    taskId: task.id,
    taskTitle: task.title || task.description || "",
    modifiedFiles,
    status,
  };
}

export async function updateDocsBeforeCommit({
  rootDir,
  task = Object(),
  modifiedFiles = [],
  status = "PASS",
  required = true,
  updateDocs,
  importDocUpdater = () => import("./doc-updater.js"),
} = Object()) {
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
      skipped: required === false,
      ...(required === false ? { warning: true } : { blocked: true }),
      reason: "doc_update_failed",
      error: (error as { message?: string } | null | undefined)?.message || String(error),
      payload,
    };
  }
}

function buildCommitFailureRecord({ commitResult = Object(), result = Object() } = Object()) {
  const reason = commitResult.reason || commitResult.commitWarning || "commit_failed";
  return {
    ...result,
    commitFailure: reason,
    ...(commitResult.error ? { commitError: commitResult.error } : {}),
  };
}

export function buildCommitResultDecision({
  commitResult = Object(),
  task = Object(),
  hasRealCode = false,
  businessFiles = [],
  metadataFiles = [],
} = Object()) {
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
      result: buildCommitFailureRecord({ commitResult, result }),
    };
  }
  const failureReason = commitResult.reason || commitResult.commitWarning || "commit_failed";
  return {
    status: failureReason === "git_add_failed" ? "git_add_failed" : "commit_failed",
    logs: [{
      id: task.id,
      marker: "!!",
      message: `commit 失败，worktree 已 merge，跳过 rollback: ${failureReason}`,
    }],
    events: [],
    refreshBaselines: false,
    result: buildCommitFailureRecord({ commitResult, result }),
  };
}

export async function runTaskCommitFlow({
  rootDir,
  task = Object(),
  code = [],
  hasRealCode = false,
  businessFiles = [],
  metadataFiles = [],
  outOfScope = [],
  docUpdateRequired = true,
  mode = "fix",
  log = (..._args: unknown[]) => {},
  emitEvent = (..._args: unknown[]) => {},
  refreshBaselines = (..._args: unknown[]) => {},
  updateDocs,
  importDocUpdater,
  commitChanges = commitTaskChanges,
} = Object()) {
  const effectiveOutOfScope = uniqueFiles(outOfScope);
  const dryRunOutOfScopeBlock = buildDryRunOutOfScopeBlock({
    task,
    hasRealCode,
    businessFiles,
    metadataFiles,
    outOfScope: effectiveOutOfScope,
  });
  if (dryRunOutOfScopeBlock) {
    return { status: "blocked", result: dryRunOutOfScopeBlock };
  }

  const outOfScopeBlock = buildOutOfScopeBlock({
    task,
    hasRealCode,
    businessFiles,
    metadataFiles,
    outOfScope: effectiveOutOfScope,
  });
  if (outOfScopeBlock) {
    return { status: "blocked", result: outOfScopeBlock };
  }

  const docsResult = Object.assign(Object(), await updateDocsBeforeCommit({
    rootDir,
    task,
    modifiedFiles: code,
    required: docUpdateRequired,
    updateDocs,
    importDocUpdater,
  }));
  if (docsResult.reason === "doc_update_failed") {
    if (docsResult.blocked) {
      const blockReason = `doc_update_failed: ${docsResult.error}`;
      log(task.id, "!!", `doc update failed: ${docsResult.error}`);
      return {
        status: "blocked",
        docsResult,
        result: {
          committed: false,
          hasRealCode,
          businessFiles,
          metadataFiles,
          blocked: true,
          blockReason,
          outOfScope: effectiveOutOfScope,
        },
      };
    }
    log(task.id, "WARN", `doc update skipped: ${docsResult.error}`);
  }
  const skipDecision = buildCommitSkipDecision({
    task,
    code,
    hasRealCode,
    businessFiles,
    metadataFiles,
    outOfScope: effectiveOutOfScope,
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

function readShortCommitHash({ rootDir, execFileSync = defaultExecFileSync } = Object()) {
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

function resetStagedFiles(files: string[], { rootDir, execFileSync = defaultExecFileSync } = Object()) {
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

function describeGitError(error: unknown) {
  const err = error as { stderr?: unknown; stdout?: unknown; message?: string } | null | undefined;
  const stderr = String(err?.stderr || "").trim();
  const stdout = String(err?.stdout || "").trim();
  return stderr || stdout || err?.message || String(error);
}

export function commitTaskChanges({
  rootDir,
  files = [],
  docUpdateFiles = DEFAULT_DOC_UPDATE_FILES,
  message,
  execFileSync = defaultExecFileSync,
} = Object()) {
  const gitOptions = { cwd: rootDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] };
  try {
    execFileSync("git", ["add", ...files], gitOptions);
  } catch (error) {
    return {
      committed: false,
      retried: false,
      reason: "git_add_failed",
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
      error: describeGitError(error),
    };
  }
}
