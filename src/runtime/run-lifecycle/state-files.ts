import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function buildCurrentRunPayload({
  runId,
  prdPath,
  projectRoot,
  now = new Date().toISOString(),
}) {
  const rootPrefix = projectRoot ? `${projectRoot}/` : "";
  return {
    run_id: runId,
    started_at: now,
    prd: prdPath ? String(prdPath).replace(rootPrefix, "") : "auto",
  };
}

export function writeCurrentRunFile({ currentRunFile, runId, prdPath, projectRoot, now }) {
  try {
    const payload = buildCurrentRunPayload({ runId, prdPath, projectRoot, now });
    mkdirSync(dirname(currentRunFile), { recursive: true });
    const tmp = `${currentRunFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, currentRunFile);
    return { wrote: true, payload };
  } catch (error) {
    return { wrote: false, reason: "write_failed", error };
  }
}

export function archiveCurrentRunFile({
  currentRunFile,
  stateDir,
  runId,
  results = null,
  interrupted = false,
  now = new Date().toISOString(),
}) {
  try {
    if (!existsSync(currentRunFile)) return { archived: false, reason: "current_run_missing" };
    const payload = JSON.parse(readFileSync(currentRunFile, "utf8"));
    payload.completed_at = now;
    if (interrupted) payload.interrupted = true;
    if (results) {
      payload.passed = Array.isArray(results.completed) ? results.completed.length : (results.passed || 0);
      payload.failed = Array.isArray(results.failed) ? results.failed.length : (results.failed || 0);
    }

    const archiveDir = join(stateDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const archiveName = `${runId || payload.run_id}.json`;
    const archivePath = join(archiveDir, archiveName);
    const tmp = `${archivePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, archivePath);
    unlinkSync(currentRunFile);
    return { archived: true, archivePath, payload };
  } catch (error) {
    return { archived: false, reason: "archive_failed", error };
  }
}

export function cleanupRuntimeStateFiles({
  stateDir,
  fileNames = ["expanded-tasks.json", "runner.pid"],
} = {}) {
  const deleted = [];
  const skipped = [];
  const errors = [];

  for (const fileName of fileNames) {
    const filePath = join(stateDir, fileName);
    try {
      if (!existsSync(filePath)) {
        skipped.push(filePath);
        continue;
      }
      unlinkSync(filePath);
      deleted.push(filePath);
    } catch (error) {
      errors.push({ filePath, error });
    }
  }

  return { deleted, skipped, errors };
}
