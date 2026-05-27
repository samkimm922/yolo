import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function appendTaskResult(resultsFile, record, options = {}) {
  const now = options.now || new Date().toISOString();
  const payload = {
    ...record,
    timestamp: record.timestamp || now,
  };
  appendFileSync(resultsFile, `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

export function updatePrdTaskStatusFile(prdPath, taskId, update) {
  try {
    const raw = readFileSync(prdPath, "utf8");
    const prd = JSON.parse(raw);
    const task = (prd.tasks || []).find((item) => item.id === taskId);
    if (!task) return { wrote: false, reason: "task_not_found" };

    Object.assign(task, update);
    const tmp = `${prdPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(prd, null, 2), "utf8");
    renameSync(tmp, prdPath);
    return { wrote: true, task, prd };
  } catch (error) {
    return { wrote: false, reason: "write_failed", error };
  }
}
