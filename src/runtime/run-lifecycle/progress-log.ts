export function createRunnerProgressLogger({
  progress,
  startTimeMs,
  getOutputLog,
  appendFileSync,
  nowMs = Date.now,
  localeTime = (date) => date.toLocaleTimeString("zh-CN", { hour12: false }),
  log = console.log,
} = {}) {
  return function logProgress(id, phase, detail) {
    const ts = localeTime(new Date(nowMs()));
    const elapsedSeconds = ((nowMs() - startTimeMs) / 1000).toFixed(0);
    const indent = phase[0] === "├" || phase[0] === "└" ? "  " : "";
    const line = `[${ts}] (${elapsedSeconds}s) ${progress.done + progress.failed}/${progress.total} ${indent}${id ? id + " " : ""}${phase} ${detail || ""}`;
    log(line);
    try { appendFileSync(getOutputLog(), line + "\n", "utf8"); } catch {}
  };
}
