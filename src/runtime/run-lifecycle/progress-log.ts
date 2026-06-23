import { redact } from "../../lib/security/redact.js";

const MILESTONE_PREFIXES = [">>", "DONE", "!!"];

function isMilestoneLine(line) {
  return MILESTONE_PREFIXES.some((prefix) => line.includes(prefix));
}

export function createRunnerProgressLogger({
  progress,
  startTimeMs,
  getOutputLog,
  appendFileSync,
  nowMs = Date.now,
  localeTime = (date) => date.toLocaleTimeString("zh-CN", { hour12: false }),
  log = console.log,
  quiet = false,
} = Object()) {
  return function logProgress(id, phase, detail) {
    const ts = localeTime(new Date(nowMs()));
    const elapsedSeconds = ((nowMs() - startTimeMs) / 1000).toFixed(0);
    const indent = phase[0] === "├" || phase[0] === "└" ? "  " : "";
    const line = `[${ts}] (${elapsedSeconds}s) ${progress.done + progress.failed}/${progress.total} ${indent}${id ? id + " " : ""}${phase} ${detail || ""}`;
    const safeLine = redact(line);
    if (!quiet || isMilestoneLine(safeLine)) log(safeLine);
    try { appendFileSync(getOutputLog(), safeLine + "\n", "utf8"); } catch {}
  };
}
