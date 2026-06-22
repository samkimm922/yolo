#!/usr/bin/env node
// perf-benchmark — a machine-independent speed ratchet for a hot, pure code path.
//
// Wall-clock time is flaky in CI (runners vary). So we measure a RATIO:
//   ratio = workload_time / reference_time
// Both scale with machine speed, so the ratio is stable across machines and only moves
// when the workload's algorithmic cost actually changes. The ratchet fails on a real
// slowdown (ratio grows past baseline * TOLERANCE), not on machine noise.
//
//   (default)   measure ratio, print, write perf-baseline.json
//   --check     fail (exit 1) if ratio > baseline * TOLERANCE (a real regression)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTraceabilityMatrix } from "../src/spec/traceability.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "scripts", "quality", "perf-baseline.json");
const TOLERANCE = 1.5;      // allow up to 50% relative slowdown before failing
const WORKLOAD_ITERS = 400;
const REFERENCE_ITERS = 4_000_000;

// A sizeable, realistic PRD so the traceability build does real work.
function bigPrd() {
  const tasks = Array.from({ length: 120 }, (_, i) => ({
    id: `FIX-${i}`,
    title: `Task ${i}`,
    type: "bugfix",
    requirement_ids: [`REQ-${i % 20}`],
    design_ids: [`DES-${i % 10}`],
    scope: { targets: [{ file: `src/mod${i % 30}.ts` }, { file: `src/util/h${i % 15}.ts` }] },
    post_conditions: [{ id: `POST-${i}`, type: "target_file_modified", params: { file: `src/mod${i % 30}.ts` } }],
  }));
  const requirements = Array.from({ length: 20 }, (_, i) => ({ id: `REQ-${i}`, text: `Requirement ${i}` }));
  const designs = Array.from({ length: 10 }, (_, i) => ({ id: `DES-${i}`, text: `Design ${i}` }));
  return { version: "2.0", id: "PRD-20260101-PERF-001", requirements, designs, tasks };
}

function timeReference(): number {
  const start = performance.now();
  let acc = 0;
  for (let i = 0; i < REFERENCE_ITERS; i++) acc += (i * 31 + 7) % 17;
  if (acc === -1) throw new Error("unreachable");
  return performance.now() - start;
}

function timeWorkload(): number {
  const prd = bigPrd();
  const start = performance.now();
  for (let i = 0; i < WORKLOAD_ITERS; i++) buildTraceabilityMatrix(prd);
  return performance.now() - start;
}

function measureRatio(): number {
  // Warm up, then take the median of a few samples to reduce jitter.
  timeReference(); timeWorkload();
  const ratios: number[] = [];
  for (let i = 0; i < 5; i++) ratios.push(timeWorkload() / timeReference());
  ratios.sort((a, b) => a - b);
  return ratios[2];
}

function main() {
  const ratio = measureRatio();
  console.log(`[perf] workload/reference ratio = ${ratio.toFixed(4)}`);

  if (process.argv.includes("--check")) {
    let baseline = 0;
    try { baseline = Number(JSON.parse(readFileSync(BASELINE, "utf8")).ratio) || 0; }
    catch { console.error("[perf] no baseline; run with --update-baseline to write one."); process.exit(1); }
    const limit = baseline * TOLERANCE;
    console.log(`[perf] baseline ${baseline.toFixed(4)} · limit ${limit.toFixed(4)} (×${TOLERANCE})`);
    if (ratio > limit) {
      console.error(`[perf] REGRESSION: ratio ${ratio.toFixed(4)} > limit ${limit.toFixed(4)} — the hot path got meaningfully slower.`);
      process.exit(1);
    }
    console.log("[perf] gate OK (no meaningful slowdown).");
    return;
  }

  // Read-only by default — measuring perf must not rewrite the committed baseline
  // (it is load-sensitive; an accidental write could ratchet in a bad number).
  if (!process.argv.includes("--update-baseline")) {
    console.log("[perf] read-only (pass --update-baseline to write the baseline).");
    return;
  }

  writeFileSync(BASELINE, `${JSON.stringify({ ratio, workload_iters: WORKLOAD_ITERS, reference_iters: REFERENCE_ITERS, tolerance: TOLERANCE, updated_at: new Date().toISOString() }, null, 2)}\n`, "utf8");
  console.log(`[perf] wrote baseline ${BASELINE}`);
}

main();
