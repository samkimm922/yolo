#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { inspectYoloCheck } from "../src/runtime/gates/check-report.js";
import {
  runDemandDiscussRuntime,
  runDemandPrdRuntime,
} from "../src/demand/runtime.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function nowId() {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 17);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableJson(value), "utf8");
  return path;
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
  return path;
}

function safeId(value) {
  return String(value || "scenario").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "scenario";
}

function hashFile(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return null;
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function walk(root, dir = root, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, path, out);
    else out.push(relative(root, path).replace(/\\/g, "/"));
  }
  return out;
}

function snapshot(root) {
  const snap = new Map();
  for (const file of walk(root)) {
    const digest = hashFile(join(root, file));
    if (digest) snap.set(file, digest);
  }
  return snap;
}

function diffSnapshot(before, after) {
  const changes = [];
  for (const [file, digest] of before.entries()) {
    if (!after.has(file)) changes.push({ path: file, change: "deleted" });
    else if (after.get(file) !== digest) changes.push({ path: file, change: "modified" });
  }
  for (const [file] of after.entries()) {
    if (!before.has(file)) changes.push({ path: file, change: "added" });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function parseJsonOutput(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("empty Claude output");
  try {
    return JSON.parse(raw);
  } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1].trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(raw.slice(first, last + 1));
  throw new Error(`Claude output was not JSON: ${raw.slice(0, 240)}`);
}

function acceptanceAdapterManifest() {
  return {
    schema: "yolo.manifest.v1",
    id: "local-browser",
    kind: "acceptance_adapter",
    description: "Local browser acceptance adapter for PRD executability stress fixtures",
    inputs: ["url", "prd"],
    outputs: ["acceptance_report"],
    commands: [{ command: "npm run accept" }],
    evidence: ["screenshot", "runtime_log"],
    capabilities: ["page_reachable", "screenshot", "runtime_errors"],
    applies_to: ["ui", "browser"],
  };
}

function prepareFixture(root, scenario) {
  mkdirSync(root, { recursive: true });
  writeText(join(root, "package.json"), `${JSON.stringify({
    name: `prd-exec-${scenario.id}`,
    type: "module",
    scripts: {
      test: "node --test",
      typecheck: "tsc --noEmit",
      accept: "node scripts/acceptance-smoke.mjs",
    },
    devDependencies: { typescript: "^5.0.0" },
  }, null, 2)}\n`);
  writeText(join(root, "README.md"), `# ${scenario.title}\n\nDisposable PRD executability stress fixture.\n`);
  writeText(join(root, "scripts", "acceptance-smoke.mjs"), "console.log('acceptance smoke placeholder');\n");
  for (const [file, content] of Object.entries(scenario.files || {})) {
    writeText(join(root, file), content);
  }
  if (scenario.adapter) {
    writeJson(join(root, ".yolo", "adapters", "local-browser.manifest.json"), acceptanceAdapterManifest());
  }
}

const scenarios = [
  {
    id: "service-field-existing",
    title: "Existing service field addition",
    expect: "executable",
    files: {
      "src/services/inventory.ts": [
        "export type InventoryItem = { id: string; sku: string; quantity: number };",
        "const UPSTREAM_THRESHOLD_COLUMN = 'low_stock_threshold';",
        "export function toInventoryItem(row) {",
        "  return { id: row.id, sku: row.sku, quantity: row.quantity };",
        "}",
        "",
      ].join("\n"),
      "src/services/inventory.test.ts": "import { test } from 'node:test';\n",
    },
    demand: {
      idea: "Expose a lowStockThreshold field from the existing inventory service for store managers.",
      target_users: ["store manager"],
      status_quo: ["Inventory API returns quantity but not the threshold managers compare against."],
      evidence: ["Existing inventory service maps inventory rows in src/services/inventory.ts and uses row.low_stock_threshold as the upstream threshold source."],
      assumptions: ["Rows already contain row.low_stock_threshold from upstream inventory data."],
      success_criteria: ["Inventory service output includes lowStockThreshold for every item."],
      proof: ["A test can assert toInventoryItem returns lowStockThreshold from the source row."],
      constraints: ["Do not change SKU or quantity semantics."],
      non_goals: ["Do not build supplier ordering."],
      target_files: ["src/services/inventory.ts", "src/services/inventory.test.ts"],
      decisions: ["Keep this as a response shape change plus regression test; preserve row.low_stock_threshold as the source for lowStockThreshold."],
      roadmap: ["MVP service field and test."],
    },
  },
  {
    id: "ui-badge-with-adapter",
    title: "UI badge with acceptance adapter",
    expect: "executable",
    adapter: true,
    files: {
      "src/pages/inventory-list.tsx": [
        "export function InventoryList({ items }) {",
        "  return <ul>{items.map((item) => <li key={item.id}>{item.sku}: {item.qty_available_units}/{item.replenishment_floor_units}</li>)}</ul>;",
        "}",
        "",
      ].join("\n"),
    },
    demand: {
      idea: "Show a visible low-stock badge in the inventory list before stockout.",
      target_users: ["store manager"],
      status_quo: ["Managers only see raw inventory counts in the inventory list."],
      evidence: ["Support tickets mention surprise stockouts weekly.", "Inventory list rows expose qty_available_units and replenishment_floor_units."],
      assumptions: ["Inventory list already receives qty_available_units and replenishment_floor_units."],
      success_criteria: ["Inventory list displays a visible low-stock badge on affected SKUs."],
      proof: ["A screenshot or component test can show an inline 'Low stock' badge when qty_available_units <= replenishment_floor_units."],
      constraints: ["Do not change order import behavior."],
      non_goals: ["Do not build supplier ordering."],
      target_files: ["src/pages/inventory-list.tsx"],
      decisions: ["Start with an inline badge labelled 'Low stock' after the SKU when qty_available_units <= replenishment_floor_units."],
      roadmap: ["MVP badge in inventory list."],
    },
  },
  {
    id: "backend-validation-rule",
    title: "Backend validation rule",
    expect: "executable",
    files: {
      "src/api/orders.ts": [
        "export const ORDER_LINE_QUANTITY_FIELD = 'quantity';",
        "export function validateOrder(input) {",
        "  if (!input.customerId) return { ok: false, error: 'customer required' };",
        "  const lines = Array.isArray(input.lines) ? input.lines : [];",
        "  return { ok: true };",
        "}",
        "",
      ].join("\n"),
      "src/api/orders.test.ts": "import { test } from 'node:test';\n",
    },
    demand: {
      idea: "Reject orders with a negative quantity before they reach fulfillment.",
      target_users: ["operations admin"],
      status_quo: ["Order validation checks customer but not negative quantities."],
      evidence: ["src/api/orders.ts contains validateOrder, reads input.lines as the order line payload, and declares ORDER_LINE_QUANTITY_FIELD = 'quantity'."],
      assumptions: ["Order line quantities are present as input.lines[].quantity."],
      success_criteria: ["validateOrder returns an error when any line quantity is below zero."],
      proof: ["A regression test can call validateOrder with quantity -1 and observe an error."],
      constraints: ["Do not change fulfillment integration."],
      non_goals: ["Do not redesign order creation UI."],
      target_files: ["src/api/orders.ts", "src/api/orders.test.ts"],
      decisions: ["Add a validation branch for input.lines[].quantity < 0 and a regression test only."],
      roadmap: ["MVP validation rule."],
    },
  },
  {
    id: "unverified-ui-field-assumption-blocks",
    title: "Unverified UI field assumption must not compile",
    expect: "blocked",
    files: {
      "src/pages/inventory-list.tsx": [
        "export function InventoryList({ items }) {",
        "  return <ul>{items.map((item) => <li key={item.id}>{item.sku}: {item.quantity}</li>)}</ul>;",
        "}",
        "",
      ].join("\n"),
    },
    demand: {
      idea: "Show a visible low-stock badge in the inventory list before stockout.",
      target_users: ["store manager"],
      status_quo: ["Managers only see raw inventory counts in the inventory list."],
      evidence: ["Support tickets mention surprise stockouts weekly."],
      assumptions: ["Inventory list already receives quantity and threshold fields."],
      success_criteria: ["Inventory list displays a visible low-stock badge on affected SKUs."],
      proof: ["A screenshot or component test can show the low-stock badge on a SKU below threshold."],
      constraints: ["Do not change order import behavior."],
      non_goals: ["Do not build supplier ordering."],
      target_files: ["src/pages/inventory-list.tsx"],
      decisions: ["Start with an inline badge labelled 'Low stock' after the SKU."],
      roadmap: ["MVP badge in inventory list."],
    },
  },
  {
    id: "vague-proof-blocks",
    title: "Vague proof must not compile",
    expect: "blocked",
    files: {
      "src/pages/inventory-list.tsx": "export function InventoryList() { return null; }\n",
    },
    demand: {
      idea: "Improve inventory list.",
      target_users: ["store manager"],
      status_quo: ["Managers use the inventory list."],
      evidence: ["Inventory list exists."],
      assumptions: ["Inventory data is available."],
      success_criteria: ["Inventory list is better."],
      proof: ["ok"],
      constraints: ["Do not change order import behavior."],
      non_goals: ["Do not build supplier ordering."],
      target_files: ["src/pages/inventory-list.tsx"],
      decisions: ["Make a small UI improvement."],
      roadmap: ["MVP improvement."],
    },
  },
  {
    id: "missing-target-blocks",
    title: "Missing target files must not compile",
    expect: "blocked",
    files: {},
    demand: {
      idea: "Add low stock alerts.",
      target_users: ["store manager"],
      status_quo: ["Managers discover stockouts late."],
      evidence: ["Support tickets mention stockouts."],
      assumptions: ["Inventory data exists."],
      success_criteria: ["Managers see a low-stock alert."],
      proof: ["A manager can point to a visible alert before stockout."],
      constraints: ["Do not change order import behavior."],
      non_goals: ["Do not build supplier ordering."],
      decisions: ["Start with one alert path."],
      roadmap: ["MVP alert."],
    },
  },
  {
    id: "special-field-source",
    title: "Existing special field source must be preserved",
    expect: "executable",
    files: {
      "src/domain/inventoryRecord.ts": [
        "export type InventoryRecord = {",
        "  sku_code: string;",
        "  qty_available_units: number;",
        "  replenishment_floor_units: number;",
        "};",
        "export function stockSignal(record: InventoryRecord) {",
        "  return record.qty_available_units <= record.replenishment_floor_units ? 'low' : 'ok';",
        "}",
        "",
      ].join("\n"),
      "src/domain/inventoryRecord.test.ts": "import { test } from 'node:test';\n",
    },
    demand: {
      idea: "Expose the existing inventory stock signal without renaming the project's special inventory fields.",
      target_users: ["store manager"],
      status_quo: ["InventoryRecord already uses qty_available_units and replenishment_floor_units, not generic quantity or threshold fields."],
      evidence: ["src/domain/inventoryRecord.ts defines qty_available_units, replenishment_floor_units, and stockSignal(record)."],
      assumptions: ["The existing stockSignal rule is the source of truth."],
      success_criteria: ["InventoryRecord consumers can access a stockSignal value derived from qty_available_units and replenishment_floor_units."],
      proof: ["A regression test can assert stockSignal returns low when qty_available_units is less than or equal to replenishment_floor_units."],
      constraints: ["Do not rename qty_available_units or replenishment_floor_units."],
      non_goals: ["Do not introduce generic quantity or lowStockThreshold fields."],
      target_files: ["src/domain/inventoryRecord.ts", "src/domain/inventoryRecord.test.ts"],
      decisions: ["Preserve the special field names and use stockSignal as the only rule."],
      roadmap: ["MVP preserves existing field names and adds test coverage."],
    },
  },
  {
    id: "cross-layer-dependency",
    title: "Cross-layer PRD must express implementation test UI dependency",
    expect: "executable",
    adapter: true,
    files: {
      "src/services/inventory-alerts.ts": "export function isLowStock(item) { return false; }\n",
      "src/services/inventory-alerts.test.ts": "import { test } from 'node:test';\n",
      "src/pages/inventory-list.tsx": "export function InventoryList({ items }) { return <ul>{items.map((item) => <li key={item.sku}>{item.sku}</li>)}</ul>; }\n",
    },
    demand: {
      idea: "Use the inventory alert service to show a low-stock badge in the inventory list.",
      target_users: ["store manager"],
      status_quo: ["The service has a placeholder isLowStock rule and the UI currently renders only SKU text."],
      evidence: ["src/services/inventory-alerts.ts exports isLowStock; src/pages/inventory-list.tsx renders inventory rows."],
      assumptions: ["The UI should call or mirror the service rule rather than inventing a second stock rule."],
      success_criteria: [
        "isLowStock returns true when qty_available_units <= replenishment_floor_units.",
        "Inventory list displays a low-stock badge for items where isLowStock is true.",
      ],
      proof: [
        "A service test can assert isLowStock true when qty_available_units equals replenishment_floor_units.",
        "A UI screenshot or component test can show the badge only for rows where isLowStock is true.",
      ],
      constraints: ["Do not duplicate stock-rule logic in the UI."],
      non_goals: ["Do not build supplier ordering."],
      target_files: ["src/services/inventory-alerts.ts", "src/services/inventory-alerts.test.ts", "src/pages/inventory-list.tsx"],
      decisions: ["Implement service rule before UI badge and test both layers."],
      roadmap: ["MVP service rule, regression test, then UI badge."],
    },
  },
];

function reviewerPrompt({ scenario, projectRoot, prdPath, checkPath, blockedPath }) {
  const target = scenario.expect === "blocked" ? blockedPath : prdPath;
  return [
    "You are an independent PRD executability reviewer for YOLO.",
    "Use available read/search tools if useful. Do not edit files.",
    "",
    `Scenario id: ${scenario.id}`,
    `Expected class: ${scenario.expect}`,
    `Project root: ${projectRoot}`,
    target ? `Primary artifact: ${target}` : "",
    checkPath ? `YOLO check report: ${checkPath}` : "",
    "",
    "Review whether this artifact is safe and concrete enough for a fresh coding agent to execute without guessing.",
    "Hard-fail an executable PRD if any task lacks bounded scope, concrete target files, concrete handoff, explicit proof/acceptance, executable FAIL post_conditions, demand approval/trace, session/evidence paths, or required UI state/evidence plan.",
    "Assess rework risk explicitly: missing behavior-level FAIL gates, missing task dependencies, missing read-first implementation context for tests, undefined business thresholds/field sources, or generic design text should be reported with stable warning or hard_failure codes.",
    "For blocked scenarios, pass only if no executable PRD was produced and the blocker is concrete enough to prevent bad execution.",
    "",
    "Return JSON only with this shape:",
    "{",
    '  "schema": "yolo.prd.executability_review.v1",',
    '  "scenario_id": "string",',
    '  "verdict": "pass|fail|blocked",',
    '  "executable": true,',
    '  "correctly_blocked": false,',
    '  "score": 0,',
    '  "hard_failures": [{"code":"string","message":"string","task_id":"string|null","path":"string|null"}],',
    '  "warnings": [{"code":"string","message":"string","task_id":"string|null","path":"string|null"}],',
    '  "dimensions": {"intent_convergence":0,"project_fact_grounding":0,"behavior_gate_hardness":0,"task_dependency":0,"testability":0,"no_guessing_context":0,"runner_readiness":0,"rework_risk":0},',
    '  "evidence": [{"path":"string","summary":"string"}]',
    "}",
  ].filter(Boolean).join("\n");
}

function runClaudeReview(params, options = {}) {
  const prompt = reviewerPrompt(params);
  const args = ["-p"];
  const model = String(options.model || "").trim();
  if (model) args.push("--model", model);
  args.push("--permission-mode", "bypassPermissions", "--tools", "default", "--no-session-persistence");
  const run = spawnSync("claude", args, {
    cwd: params.projectRoot,
    input: prompt,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 20,
    timeout: Number(options.timeoutMs || 300000),
  });
  let parsed = null;
  let parseError = "";
  try {
    parsed = parseJsonOutput(run.stdout);
  } catch (error) {
    parseError = error.message;
  }
  return {
    success: run.status === 0 && !!parsed,
    exit_code: run.status,
    signal: run.signal,
    timed_out: run.error?.code === "ETIMEDOUT",
    stdout: String(run.stdout || "").slice(0, 4000),
    stderr: String(run.stderr || "").slice(0, 4000),
    parse_error: parseError,
    review: parsed,
  };
}

function summarizeReview(review = {}) {
  const score = Number(review.score ?? 0);
  return {
    verdict: review.verdict || null,
    executable: review.executable === true,
    correctly_blocked: review.correctly_blocked === true,
    score: Number.isFinite(score) ? (score <= 10 ? score * 10 : score) : null,
    hard_failures: Array.isArray(review.hard_failures) ? review.hard_failures.map((item) => ({
      code: item.code,
      task_id: item.task_id || null,
      path: item.path || null,
      message: String(item.message || "").slice(0, 220),
    })) : [],
    warnings: Array.isArray(review.warnings) ? review.warnings.map((item) => ({
      code: item.code,
      task_id: item.task_id || null,
      path: item.path || null,
      message: String(item.message || "").slice(0, 220),
    })) : [],
    dimensions: review.dimensions && typeof review.dimensions === "object" ? review.dimensions : null,
  };
}

const STRICT_REWORK_RISK = [
  /ACCEPTANCE.*WARN/i,
  /BEHAVIOR.*WARN/i,
  /POST.*WARN.*FAIL/i,
  /NO_FAIL_POST/i,
  /MISSING.*DEPENDS/i,
  /NO_TASK_DEPENDENCY/i,
  /MISSING_TASK_DEPENDENCY/i,
  /READONLY_REF/i,
  /READ_FIRST/i,
  /UNDEFINED.*THRESHOLD/i,
  /VAGUE_THRESHOLD/i,
  /LOW_STOCK_THRESHOLD_UNDEFINED/i,
  /FIELD.*SOURCE/i,
  /GENERIC_DESIGN/i,
  /DESIGN_TEXT_GENERIC/i,
  /ADAPTERS/i,
  /NO_COMPONENT_LIBRARY_HINT/i,
  /TASK_SESSION_STATE_FILE_MISSING/i,
];

function strictRisks(review = {}) {
  return [
    ...(Array.isArray(review.hard_failures) ? review.hard_failures : []),
    ...(Array.isArray(review.warnings) ? review.warnings : []),
  ]
    .filter((item) => STRICT_REWORK_RISK.some((pattern) => pattern.test(`${item.code || ""} ${item.message || ""}`)))
    .map((item) => ({
      code: item.code || "STRICT_REWORK_RISK",
      task_id: item.task_id || null,
      path: item.path || null,
      message: String(item.message || "").slice(0, 240),
    }));
}

function runScenario({ scenario, iteration, outDir, model, timeoutMs, strictExecutability = false }) {
  const scenarioRoot = join(outDir, "fixtures", `${String(iteration).padStart(4, "0")}-${scenario.id}`);
  prepareFixture(scenarioRoot, scenario);
  const stateRoot = join(scenarioRoot, ".yolo");
  const demandId = `DEMAND-${String(iteration).padStart(4, "0")}-${safeId(scenario.id)}`;
  const discuss = runDemandDiscussRuntime({
    ...scenario.demand,
    demand_id: demandId,
    projectRoot: scenarioRoot,
    stateRoot,
    approve: true,
    writeArtifacts: true,
  });
  const prdPath = join(scenarioRoot, ".yolo", "prd-executability", `${scenario.id}.prd.json`);
  const prdResult = runDemandPrdRuntime({
    projectRoot: scenarioRoot,
    stateRoot,
    demandPath: discuss.demand_dir,
    prdPath,
    base_commit: "abcdef0",
    writeArtifacts: true,
  });
  const check = prdResult.prd && prdResult.artifacts?.[0]
    ? inspectYoloCheck({
        prdPath: prdResult.artifacts[0],
        projectRoot: scenarioRoot,
        stateRoot,
        writeLifecycle: false,
      })
    : null;
  const checkPath = check ? writeJson(join(scenarioRoot, ".yolo", "prd-executability", `${scenario.id}.check.json`), check) : "";
  const blockedPath = !prdResult.prd
    ? writeJson(join(scenarioRoot, ".yolo", "prd-executability", `${scenario.id}.blocked.json`), {
        scenario_id: scenario.id,
        discuss_status: discuss.status,
        prd_status: prdResult.status,
        prd_code: prdResult.code,
        blockers: prdResult.blockers,
        warnings: prdResult.warnings,
        readiness: prdResult.readiness,
        quality_report: prdResult.quality_report,
      })
    : "";
  const beforeReview = snapshot(scenarioRoot);
  const provider = runClaudeReview({
    scenario,
    projectRoot: scenarioRoot,
    prdPath: prdResult.artifacts?.[0] || "",
    checkPath,
    blockedPath,
  }, { model, timeoutMs });
  const afterReview = snapshot(scenarioRoot);
  const reviewChanges = diffSnapshot(beforeReview, afterReview)
    .filter((change) => !change.path.startsWith(".yolo/"));
  const review = provider.review || {};
  const normalizedReview = summarizeReview(review);
  const reviewPass = scenario.expect === "blocked"
    ? review.correctly_blocked === true && (review.verdict === "pass" || review.verdict === "blocked")
    : review.executable === true && review.verdict === "pass" && Number(normalizedReview.score || 0) >= 80 && normalizedReview.hard_failures.length === 0;
  const yoloPass = scenario.expect === "blocked"
    ? !prdResult.prd && prdResult.status === "blocked"
    : !!prdResult.prd && ["pass", "warning"].includes(check?.status);
  const risks = strictRisks(review);
  let status = yoloPass && provider.success && reviewPass && reviewChanges.length === 0 ? "pass" : "fail";
  if (status === "pass" && strictExecutability && scenario.expect === "executable" && risks.length > 0) {
    status = "risk";
  }
  return {
    iteration,
    scenario: scenario.id,
    expected: scenario.expect,
    status,
    project_root: scenarioRoot,
    demand_dir: discuss.demand_dir,
    prd_path: prdResult.artifacts?.[0] || null,
    check_path: checkPath || null,
    blocked_path: blockedPath || null,
    yolo: {
      discuss_status: discuss.status,
      prd_status: prdResult.status,
      prd_code: prdResult.code,
      check_status: check?.status || null,
      check_code: check?.code || null,
      blocker_codes: [
        ...(prdResult.blockers || []).map((item) => item.code),
        ...(check?.blockers || []).map((item) => item.code),
      ].filter(Boolean),
      task_count: prdResult.prd?.tasks?.length || 0,
    },
    claude: {
      success: provider.success,
      exit_code: provider.exit_code,
      signal: provider.signal,
      timed_out: provider.timed_out,
      parse_error: provider.parse_error,
      review: summarizeReview(provider.review),
      strict_risks: risks,
    },
    reviewer_boundary: {
      project_mutation: reviewChanges.length > 0 ? "violated" : "clean",
      changes: reviewChanges,
    },
  };
}

const root = resolve(argValue("--cwd", process.cwd()));
const cycles = Math.max(1, Number(argValue("--cycles", "1")) || 1);
const timeoutMs = Number(argValue("--timeout-ms", "300000"));
const model = argValue("--model", "");
const strictExecutability = hasFlag("--strict-executability");
const continueOnFail = hasFlag("--continue-on-fail");
const stopOnRisk = hasFlag("--stop-on-risk");
const runId = argValue("--run-id", `prd-exec-${nowId()}`);
const outDir = resolve(root, argValue("--output-dir", `.yolo/stress/${runId}`));
mkdirSync(outDir, { recursive: true });

const ledger = {
  schema: "yolo.prd.executability_stress.v1",
  run_id: runId,
  started_at: new Date().toISOString(),
  project_root: root,
  output_dir: outDir,
  cycles,
  timeout_ms: timeoutMs,
  model: model || null,
  strict_executability: strictExecutability,
  iterations: [],
  stopped_reason: null,
};

let iteration = 0;
for (let cycle = 0; cycle < cycles; cycle += 1) {
  for (const scenario of scenarios) {
    iteration += 1;
    const started = new Date();
    let entry;
    try {
      entry = runScenario({ scenario, iteration, outDir, model, timeoutMs, strictExecutability });
    } catch (error) {
      entry = {
        iteration,
        scenario: scenario.id,
        expected: scenario.expect,
        status: "fail",
        error: error.message,
      };
    }
    entry.started_at = started.toISOString();
    entry.ended_at = new Date().toISOString();
    entry.duration_ms = new Date(entry.ended_at).getTime() - started.getTime();
    const output = join(outDir, `${String(iteration).padStart(4, "0")}-${scenario.id}.json`);
    writeJson(output, entry);
    entry.output = output;
    ledger.iterations.push(entry);
    writeJson(join(outDir, "ledger.json"), ledger);
    console.log(JSON.stringify({
      iteration: entry.iteration,
      scenario: entry.scenario,
      expected: entry.expected,
      status: entry.status,
      yolo: entry.yolo,
      claude: entry.claude,
      reviewer_boundary: entry.reviewer_boundary,
      output,
    }));
    if (entry.status === "risk" && !stopOnRisk) {
      continue;
    }
    if (entry.status !== "pass" && !continueOnFail) {
      ledger.stopped_reason = `failed_${entry.scenario}`;
      writeJson(join(outDir, "ledger.json"), ledger);
      console.error(`prd executability stress ledger: ${join(outDir, "ledger.json")}`);
      process.exit(2);
    }
  }
}

ledger.ended_at = new Date().toISOString();
ledger.completed = true;
ledger.iteration_count = ledger.iterations.length;
writeJson(join(outDir, "ledger.json"), ledger);
console.error(`prd executability stress ledger: ${join(outDir, "ledger.json")}`);
