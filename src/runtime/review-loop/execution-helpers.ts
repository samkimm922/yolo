import { existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeReviewFindings } from "../../review/findings.js";

function runtimeScript(yoloRoot, relativePath) {
  const direct = join(yoloRoot, relativePath);
  if (existsSync(direct)) return direct;
  return join(yoloRoot, "dist", relativePath);
}

export function buildReviewScannerArgs({ yoloRoot, rootDir, reviewScopeFiles = [] }) {
  const args = [runtimeScript(yoloRoot, "src/review/scanner.js"), "--json"];
  if (rootDir) args.push(`--root=${rootDir}`);
  if (reviewScopeFiles.length > 0) args.push(`--files=${reviewScopeFiles.join(",")}`);
  return args;
}

export function scannerStdoutFromError(error) {
  return (error?.stdout || "").trim();
}

export function parseReviewFindings(scanResult) {
  const parsed = JSON.parse(scanResult);
  const findings = Array.isArray(parsed) ? parsed : (parsed?.findings || []);
  return normalizeReviewFindings(findings, { source: parsed?.source || "review-parser" });
}

export function shouldStopReviewAfterFailure(failureCount, maxFailures = 3) {
  return failureCount >= maxFailures;
}

export function normalizeAutoFixResult(autoResult = {}) {
  const escalatedFromAuto = autoResult.escalatedTasks || [];
  const autoFixedCount = autoResult.stats?.fixed || 0;
  return {
    escalatedFromAuto,
    autoFixedCount,
    summary: `AUTO_FIX 完成: ${autoFixedCount} 已修复, ${escalatedFromAuto.length} 升级为 CLAUDE_FIX`,
    gateMeta: {
      phase: "AUTO_FIX_RESULT",
      stats: autoResult.stats,
      escalated: escalatedFromAuto.map((task) => task.id),
    },
  };
}

export function autoFixErrorFallback(autoFixTasks = []) {
  return {
    escalatedFromAuto: autoFixTasks,
    autoFixedCount: 0,
  };
}
