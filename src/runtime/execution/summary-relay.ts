import { estimateTokens, formatSummaryBlock, TASK_SUMMARY_SCHEMA } from "./task-summary.js";

export const RELAY_SCHEMA = "yolo.summary_relay.v1";

function clean(value) {
  return String(value ?? "").trim();
}

function distinct(values) {
  return [...new Set(values.filter(Boolean))];
}

export function rollupBatch(summaries = []) {
  const completed = summaries.filter((s) => s.status === "completed");
  const failed = summaries.filter((s) => s.status === "failed" || s.status === "blocked");

  // Cross-task fragility patterns
  const allFragility = summaries.flatMap((s) => (s.forward_intelligence?.fragility_points || []));
  const fragilityCounts = new Map();
  for (const fp of allFragility) {
    const key = fp.slice(0, 80);
    fragilityCounts.set(key, (fragilityCounts.get(key) || 0) + 1);
  }
  const crossTaskFragility = [...fragilityCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([key, count]) => `[${count} tasks] ${key}`);

  // Assumption drift across batch
  const allAssumptionChanges = summaries.flatMap((s) => (s.forward_intelligence?.assumption_changes || []));
  const assumptionDrift = distinct(allAssumptionChanges);

  // File overlap analysis
  const filesByTask = new Map();
  for (const s of summaries) {
    filesByTask.set(s.task_id, s.files_touched || []);
  }

  return {
    schema: RELAY_SCHEMA,
    total_tasks: summaries.length,
    completed: completed.length,
    failed: failed.length,
    task_ids: summaries.map((s) => s.task_id),
    cross_task_fragility: crossTaskFragility,
    assumption_drift: assumptionDrift,
    generated_at: new Date().toISOString(),
  };
}

export function buildRelayInjection(summaries = [], { maxTokens = 2500 } = Object()) {
  if (!summaries.length) return "";

  const rollup = rollupBatch(summaries);

  const blocks = [];

  // Header
  blocks.push(`## Prior Task Relay (${summaries.length} tasks)`);

  // Per-task summaries (most recent last, prioritized)
  const recentSummaries = summaries.slice(-5);
  for (const summary of recentSummaries) {
    const block = formatSummaryBlock(summary);
    const blockTokens = estimateTokens(block);
    // If adding this block would exceed budget, skip it
    const currentTokens = estimateTokens(blocks.join("\n\n"));
    if (currentTokens + blockTokens > maxTokens * 0.8) break;
    blocks.push(block);
  }

  // Cross-task fragility (only if budget allows)
  if (rollup.cross_task_fragility.length) {
    const fragilityBlock = `### Cross-Task Fragility\n${rollup.cross_task_fragility.join("\n")}`;
    const currentTokens = estimateTokens(blocks.join("\n\n"));
    if (currentTokens + estimateTokens(fragilityBlock) < maxTokens) {
      blocks.push(fragilityBlock);
    }
  }

  // Assumption drift (only if budget allows)
  if (rollup.assumption_drift.length) {
    const driftBlock = `### Assumption Drift\n${rollup.assumption_drift.join("\n")}`;
    const currentTokens = estimateTokens(blocks.join("\n\n"));
    const truncated = driftBlock.slice(0, (maxTokens - currentTokens) * 4);
    if (estimateTokens(truncated) + currentTokens <= maxTokens) {
      blocks.push(truncated);
    }
  }

  // Final budget check — truncate if still over
  let relay = blocks.join("\n\n");
  let tokens = estimateTokens(relay);
  while (tokens > maxTokens && blocks.length > 1) {
    blocks.pop();
    relay = blocks.join("\n\n");
    tokens = estimateTokens(relay);
  }

  // If still over budget, slice the last block
  if (tokens > maxTokens) {
    const budget = maxTokens * 4; // approximate char budget
    relay = relay.slice(0, budget);
    tokens = estimateTokens(relay);
  }

  return relay;
}

export function formatRelayForPromptInjection(relayText) {
  if (!relayText.trim()) return "";
  return [
    "<!-- PRIOR_TASK_RELAY_START -->",
    relayText.trim(),
    "<!-- PRIOR_TASK_RELAY_END -->",
  ].join("\n");
}
