#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { inspectYoloCheck } from "../src/runtime/gates/check-report.js";
import {
  runDemandBrainstormRuntime,
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

function mergeInput(base, patch) {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (Array.isArray(value)) next[key] = [...(Array.isArray(next[key]) ? next[key] : []), ...value];
    else if (value && typeof value === "object" && !Array.isArray(value)) next[key] = { ...(next[key] || {}), ...value };
    else next[key] = value;
  }
  return next;
}

function prepareFixture(root, scenario) {
  mkdirSync(root, { recursive: true });
  writeText(join(root, "package.json"), `${JSON.stringify({
    name: `dialogue-prd-${scenario.id}`,
    type: "module",
    scripts: {
      test: "node --test",
      typecheck: "tsc --noEmit",
      accept: "node scripts/acceptance-smoke.mjs",
    },
    devDependencies: { typescript: "^5.0.0" },
  }, null, 2)}\n`);
  writeText(join(root, "scripts", "acceptance-smoke.mjs"), "console.log('acceptance smoke placeholder');\n");
  writeJson(join(root, ".yolo", "adapters", "local-browser.manifest.json"), {
    schema: "yolo.manifest.v1",
    id: "local-browser",
    kind: "acceptance_adapter",
    description: "Local browser acceptance adapter for demand dialogue stress fixtures",
    inputs: ["url", "prd"],
    outputs: ["acceptance_report"],
    commands: [{ command: "npm run accept" }],
    evidence: ["screenshot", "runtime_log"],
    capabilities: ["page_reachable", "screenshot", "runtime_errors"],
    applies_to: ["ui", "browser"],
  });
  for (const [file, content] of Object.entries(scenario.files || {})) {
    writeText(join(root, file), content);
  }
}

const scenarios = [
  {
    id: "real-ui-field-clarification",
    expect: "executable",
    files: {
      "src/pages/inventory-list.tsx": [
        "export function InventoryList({ items }) {",
        "  return <ul>{items.map((item) => <li key={item.sku}>{item.sku}: {item.qty_available_units}/{item.replenishment_floor_units}</li>)}</ul>;",
        "}",
        "",
      ].join("\n"),
    },
    turns: [
      {
        role: "user",
        text: "目标用户是店长/门店库存管理员；他们看库存列表时想加一个低库存提示，别影响下单导入。",
        agent_stage: "discovery",
        agent_question: "我先不把任何文件当执行范围。需要确认：入口是不是库存列表、现有字段从哪里来、低库存判定规则、可见文案位置，以及下单导入保持不动。",
        input: {
          idea: "Show a low-stock hint in the inventory list without changing order imports.",
          target_users: ["store manager"],
          status_quo: ["Managers only see raw inventory counts in the inventory list."],
          constraints: ["Do not change order import behavior."],
          non_goals: ["Do not build supplier ordering."],
          open_questions: ["Which existing row fields define low stock?", "What exact badge text should users see?"],
        },
        should_prd: "blocked",
      },
      {
        role: "user",
        text: "项目里字段不是普通 quantity，是 qty_available_units 和 replenishment_floor_units，小于等于补货线就是低库存。",
        agent_stage: "clarify",
        agent_question: "我已读取 src/pages/inventory-list.tsx，确认字段是 qty_available_units 和 replenishment_floor_units；规则是 qty_available_units <= replenishment_floor_units。还缺 UI 文案、展示位置、样式来源、以及你接受的验收证据。",
        input: {
          target_files: ["src/pages/inventory-list.tsx"],
          verified_target_files: ["src/pages/inventory-list.tsx"],
          evidence: ["Agent read src/pages/inventory-list.tsx and confirmed it renders qty_available_units and replenishment_floor_units in inventory rows."],
          assumptions: ["Inventory list rows expose qty_available_units and replenishment_floor_units."],
          decisions: ["Low stock means qty_available_units <= replenishment_floor_units."],
          open_questions: ["What exact badge text should users see?"],
        },
        should_prd: "blocked",
      },
      {
        role: "user",
        text: "文案就叫 Low stock，放在 SKU 后面，直接用当前列表字体做内联文本标签且不新增颜色；截图或组件测试能看到 affected SKU 有 badge 就可以。",
        agent_stage: "plan",
        agent_question: "计划收敛为一个 UI 原子任务：只在库存列表 SKU 后显示 Low stock badge，不碰导入。现在需要你显式批准后才生成 PRD。",
        input: {
          success_criteria: ["Inventory list displays an inline 'Low stock' badge after the SKU when qty_available_units <= replenishment_floor_units."],
          proof: ["A screenshot or component test shows an inline 'Low stock' badge after the SKU when qty_available_units <= replenishment_floor_units."],
          visual_style: ["Use an inline text label with the current list typography and no new color system."],
          decisions: ["Show an inline badge labelled 'Low stock' after the SKU when qty_available_units <= replenishment_floor_units."],
          open_questions: [],
          roadmap: ["MVP inline low-stock badge in inventory list."],
        },
        should_prd: "blocked",
      },
      {
        role: "user",
        text: "确认，就按这个计划生成 PRD。",
        agent_stage: "prd",
        agent_question: "收到显式批准，进入 PRD 生成；不会扩大到下单导入或供应商订货。",
        input: { approve: true },
        should_prd: "ready",
      },
    ],
  },
  {
    id: "contradicted-field-blocks",
    expect: "blocked",
    files: {
      "src/pages/inventory-list.tsx": [
        "export function InventoryList({ items }) {",
        "  return <ul>{items.map((item) => <li key={item.sku}>{item.sku}: {item.quantity}</li>)}</ul>;",
        "}",
        "",
      ].join("\n"),
    },
    turns: [
      {
        role: "user",
        text: "目标用户是店长/门店库存管理员；他们看库存列表时想加 Low stock badge，我觉得已经有 threshold 字段。",
        agent_stage: "discovery",
        agent_question: "这里不能默认 threshold 存在。我会先把它记录为待验证假设，并读取库存列表字段来源；在验证前不会生成可执行 PRD。",
        input: {
          idea: "Show a Low stock badge in the inventory list.",
          target_users: ["store manager"],
          status_quo: ["Managers only see quantity in the inventory list."],
          assumptions: ["Inventory list already receives quantity and threshold fields."],
          constraints: ["Do not change order import behavior."],
          non_goals: ["Do not build supplier ordering."],
          open_questions: ["Confirm the actual threshold field/source in project code."],
        },
        should_prd: "blocked",
      },
      {
        role: "user",
        text: "先别管字段，直接按 threshold 做吧，我批准。",
        agent_stage: "clarify",
        agent_question: "我已读取目标文件，ASM-001 被反证：当前只看到 item.quantity，没有 threshold/replenishment/floor 字段；批准不能覆盖这个字段事实。下一步只能三选一：A 派 agent 继续查字段来源；B 改成新增字段需求；C 改为只基于 quantity 的规则并重新确认验收。",
        input: {
          target_files: ["src/pages/inventory-list.tsx"],
          verified_target_files: ["src/pages/inventory-list.tsx"],
          evidence: ["Project read shows src/pages/inventory-list.tsx renders item.quantity and does not show threshold, replenishment, floor, or lowStock fields."],
          success_criteria: ["Inventory list displays an inline 'Low stock' badge on affected SKUs."],
          proof: ["A screenshot can show a Low stock badge below threshold."],
          decisions: ["Show an inline badge labelled 'Low stock' after the SKU."],
          open_questions: [],
          approve: true,
        },
        should_prd: "blocked",
      },
    ],
  },
  {
    id: "brainstorm-to-plan-with-deferred-scope",
    expect: "executable",
    files: {
      "src/api/orders.ts": [
        "export const ORDER_LINE_QUANTITY_FIELD = 'quantity';",
        "export function validateOrder(input) {",
        "  if (!input.customerId) return { ok: false, error: 'customer required' };",
        "  const lines = Array.isArray(input.lines) ? input.lines : [];",
        "  return { ok: true, lines };",
        "}",
        "",
      ].join("\n"),
      "src/api/orders.test.ts": "import { test } from 'node:test';\n",
    },
    turns: [
      {
        role: "user",
        text: "目标用户是运营管理员；他们创建订单这块想做得安全点，也许以后要防很多异常。",
        agent_stage: "brainstorm",
        agent_question: "先把大方向拆小。本轮 MVP 只能选一个可验证风险：负数、零数量、超库存，还是空 lines？还需要确认 payload 字段和明确不碰履约。",
        input: {
          idea: "Make order creation safer against invalid quantities.",
          target_users: ["operations admin"],
          status_quo: ["Order validation checks customer but not invalid line quantities."],
          open_questions: ["Which invalid quantity case is MVP?", "Where is the order line payload in code?"],
        },
        should_prd: "blocked",
      },
      {
        role: "user",
        text: "先只拦截负数，payload 是 input.lines[].quantity，别改履约；返回 ok:false 和 error code NEGATIVE_QUANTITY。",
        agent_stage: "plan",
        agent_question: "MVP、字段来源、边界和验收已收敛：本次做负数校验；本次不做零数量、库存可用性、空 lines；未来重新询问这些延期项。请确认这个范围后再批准。",
        input: {
          target_files: ["src/api/orders.ts", "src/api/orders.test.ts"],
          verified_target_files: ["src/api/orders.ts", "src/api/orders.test.ts"],
          evidence: ["src/api/orders.ts reads input.lines as the order line payload and declares ORDER_LINE_QUANTITY_FIELD = 'quantity'."],
          assumptions: ["Order line quantities are present as input.lines[].quantity."],
          success_criteria: ["validateOrder returns ok:false with error code NEGATIVE_QUANTITY when any input.lines[].quantity < 0."],
          proof: ["A regression test calls validateOrder with input.lines[].quantity < 0 and observes ok:false plus error code NEGATIVE_QUANTITY."],
          constraints: ["Do not change fulfillment integration."],
          non_goals: ["Do not redesign order creation UI.", "Do not add positive quantity normalization."],
          deferred: ["Zero quantity validation is deferred.", "Inventory availability checks are deferred.", "Empty lines validation is deferred."],
          decisions: ["Add a validation branch for input.lines[].quantity < 0 that returns ok:false with error code NEGATIVE_QUANTITY, plus a regression test only."],
          roadmap: ["MVP negative quantity validation."],
          open_questions: [],
        },
        should_prd: "blocked",
      },
      {
        role: "user",
        text: "确认，本次只做负数校验，零数量、库存可用性、空 lines 都延期，生成 PRD。",
        agent_stage: "prd",
        agent_question: "收到显式批准，按负数数量校验生成 PRD；不扩大到零数量、库存占用或履约流程。",
        input: { approve: true, deferred_scope_confirmed: true },
        should_prd: "ready",
      },
    ],
  },
];

function reviewPrompt({ scenario, transcriptPath, chainPath, prdPath, blockedPath, checkPath, projectRoot }) {
  const primary = prdPath || blockedPath;
  return [
    "You are an independent YOLO demand-stage dialogue reviewer.",
    "Use read/search tools if useful. Do not edit files.",
    "",
    `Scenario id: ${scenario.id}`,
    `Expected final class: ${scenario.expect}`,
    `Project root: ${projectRoot}`,
    `Dialogue transcript: ${transcriptPath}`,
    `Chain report: ${chainPath}`,
    primary ? `Primary final artifact: ${primary}` : "",
    checkPath ? `YOLO check report: ${checkPath}` : "",
    "",
    "Judge the full path from vague user demand through discussion, plan convergence, and PRD/blocking result.",
    "The chain report includes fixture_files and both concise blocker_codes plus full failed_readiness_check_codes; failed_readiness_check_codes are readiness checks that failed for that turn.",
    "Hard-fail if the chain generates PRD before explicit approval, generates PRD while deferred scope exists without explicit user confirmation, promotes auto-scouted candidate files into execution scope without verification, inserts a target audience that was not explicit in the dialogue or evidence, ignores missing project facts, accepts contradicted field assumptions, loses user constraints, skips required clarification, creates unbounded tasks, lacks executable behavior gates, or deadlocks after enough information exists.",
    "For blocked scenarios, pass only if the final result is blocked for the concrete missing/contradicted fact and does not produce an executable PRD.",
    "For executable scenarios, pass only if final PRD is specific enough for a fresh coding agent without guessing and the prior blocked turns stayed blocked.",
    "",
    "Return JSON only:",
    "{",
    '  "schema": "yolo.demand.dialogue_review.v1",',
    '  "scenario_id": "string",',
    '  "verdict": "pass|fail|blocked",',
    '  "correct_final_class": true,',
    '  "conversation_realistic": true,',
    '  "no_premature_prd": true,',
    '  "executable": true,',
    '  "score": 0,',
    '  "hard_failures": [{"code":"string","message":"string","path":"string|null"}],',
    '  "warnings": [{"code":"string","message":"string","path":"string|null"}],',
    '  "dimensions": {"clarification_quality":0,"project_fact_grounding":0,"stage_transition":0,"plan_convergence":0,"prd_executability":0,"deadlock_avoidance":0,"rework_risk":0},',
    '  "evidence": [{"path":"string","summary":"string"}]',
    "}",
  ].filter(Boolean).join("\n");
}

function runClaudeReview(params, options = {}) {
  const args = ["-p"];
  const model = String(options.model || "").trim();
  if (model) args.push("--model", model);
  args.push("--permission-mode", "bypassPermissions", "--tools", "default", "--no-session-persistence");
  const run = spawnSync("claude", args, {
    cwd: params.projectRoot,
    input: reviewPrompt(params),
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
    correct_final_class: review.correct_final_class === true,
    conversation_realistic: review.conversation_realistic === true,
    no_premature_prd: review.no_premature_prd === true,
    executable: review.executable === true,
    score: Number.isFinite(score) ? (score <= 10 ? score * 10 : score) : null,
    hard_failures: Array.isArray(review.hard_failures) ? review.hard_failures.map((item) => ({
      code: item.code,
      path: item.path || null,
      message: String(item.message || "").slice(0, 240),
    })) : [],
    warnings: Array.isArray(review.warnings) ? review.warnings.map((item) => ({
      code: item.code,
      path: item.path || null,
      message: String(item.message || "").slice(0, 240),
    })) : [],
    dimensions: review.dimensions && typeof review.dimensions === "object" ? review.dimensions : null,
  };
}

function readinessBlockerCodes(prdResult = {}) {
  return (prdResult.blockers || []).map((item) => item.code).filter(Boolean);
}

function conciseBlockerCodes(codes = [], turn = {}) {
  if (turn.should_prd === "ready") return codes;
  const preferred = new Set([
    "USER_APPROVAL_PRESENT",
    "BLOCKING_OPEN_QUESTIONS_EMPTY",
    "EXECUTION_SCOPE_PRESENT",
    "PROJECT_FACTS_GROUNDED",
  ]);
  return codes.filter((code) => preferred.has(code)).slice(0, 6);
}

function runScenario({ scenario, iteration, outDir, model, timeoutMs }) {
  const projectRoot = join(outDir, "fixtures", `${String(iteration).padStart(4, "0")}-${scenario.id}`);
  prepareFixture(projectRoot, scenario);
  const stateRoot = join(projectRoot, ".yolo");
  const demandId = `DEMAND-DIALOGUE-${String(iteration).padStart(4, "0")}-${safeId(scenario.id)}`;
  let accumulated = { demand_id: demandId, projectRoot, stateRoot, writeArtifacts: true, writeLifecycle: false };
  const transcript = [];
  const turns = [];
  let finalPrd = null;
  let finalCheck = null;
  let finalBlockedPath = "";
  for (const [index, turn] of scenario.turns.entries()) {
    accumulated = mergeInput(accumulated, turn.input);
    const traceQuestion = index === 0
      ? "What do you want to improve or clarify?"
      : scenario.turns[index - 1].agent_question;
    const questionTrace = [
      ...(Array.isArray(accumulated.question_trace) ? accumulated.question_trace : []),
      {
        id: `Q${String(index + 1).padStart(2, "0")}`,
        question: traceQuestion,
        answer: turn.text,
        source: "dialogue_stress",
      },
    ];
    accumulated.question_trace = questionTrace;
    accumulated.questions = questionTrace.map((item) => ({ id: item.id, question: item.question, answer: item.answer }));
    delete accumulated.open_questions;
    if (Array.isArray(turn.input?.open_questions)) accumulated.open_questions = turn.input.open_questions;

    const phaseResult = index === 0 && turn.agent_stage === "brainstorm"
      ? runDemandBrainstormRuntime({ ...accumulated, approve: false })
      : runDemandDiscussRuntime(accumulated);
    const prdPath = join(projectRoot, ".yolo", "dialogue-stress", `${scenario.id}-turn-${index + 1}.prd.json`);
    const prdResult = runDemandPrdRuntime({
      projectRoot,
      stateRoot,
      demandPath: phaseResult.demand_dir,
      prdPath,
      base_commit: "abcdef0",
      writeArtifacts: true,
      writeLifecycle: false,
    });
    const expectationMet = turn.should_prd === "ready" ? prdResult.status !== "blocked" : prdResult.status === "blocked";
    const fullBlockerCodes = readinessBlockerCodes(prdResult);
    turns.push({
      index: index + 1,
      user_text: turn.text,
      agent_stage: turn.agent_stage,
      agent_question: turn.agent_question,
      agent_response: turn.agent_response || turn.agent_question,
      expected_prd_state: turn.should_prd,
      demand_status: phaseResult.status,
      readiness_status: phaseResult.readiness?.status,
      readiness_level: phaseResult.readiness?.readiness_level,
      prd_status: prdResult.status,
      prd_code: prdResult.code,
      blocker_codes: conciseBlockerCodes(fullBlockerCodes, turn),
      failed_readiness_check_codes: fullBlockerCodes,
      expectation_met: expectationMet,
      demand_dir: phaseResult.demand_dir,
      prd_path: prdResult.artifacts?.[0] || null,
    });
    transcript.push(`Turn ${index + 1}\nUser: ${turn.text}\nAgent stage: ${turn.agent_stage}\nAgent: ${turn.agent_response || turn.agent_question}\nPRD result: ${prdResult.status} ${prdResult.code}`);
    if (index === scenario.turns.length - 1) finalPrd = prdResult;
  }

  if (finalPrd?.prd) {
    finalCheck = inspectYoloCheck({
      prdPath: finalPrd.artifacts[0],
      projectRoot,
      stateRoot,
      writeLifecycle: false,
    });
    writeJson(join(projectRoot, ".yolo", "dialogue-stress", `${scenario.id}.check.json`), finalCheck);
  } else {
    finalBlockedPath = writeJson(join(projectRoot, ".yolo", "dialogue-stress", `${scenario.id}.blocked.json`), {
      scenario_id: scenario.id,
      status: finalPrd?.status || "missing",
      code: finalPrd?.code || "NO_FINAL_PRD_RESULT",
      blockers: finalPrd?.blockers || [],
      warnings: finalPrd?.warnings || [],
      quality_report: finalPrd?.quality_report || null,
      readiness: finalPrd?.readiness || null,
    });
  }

  const transcriptPath = writeText(join(projectRoot, ".yolo", "dialogue-stress", `${scenario.id}.transcript.md`), `${transcript.join("\n\n")}\n`);
  const chainPath = writeJson(join(projectRoot, ".yolo", "dialogue-stress", `${scenario.id}.chain.json`), {
    scenario_id: scenario.id,
    expected: scenario.expect,
    fixture_files: walk(projectRoot).filter((file) => !file.startsWith(".yolo/")).sort(),
    turns,
    final_status: finalPrd?.status || null,
    final_code: finalPrd?.code || null,
    final_prd_path: finalPrd?.artifacts?.[0] || null,
    final_check_status: finalCheck?.status || null,
  });

  const beforeReview = snapshot(projectRoot);
  const provider = runClaudeReview({
    scenario,
    projectRoot,
    transcriptPath,
    chainPath,
    prdPath: finalPrd?.artifacts?.[0] || "",
    blockedPath: finalBlockedPath,
    checkPath: finalCheck ? join(projectRoot, ".yolo", "dialogue-stress", `${scenario.id}.check.json`) : "",
  }, { model, timeoutMs });
  const afterReview = snapshot(projectRoot);
  const reviewChanges = diffSnapshot(beforeReview, afterReview).filter((change) => !change.path.startsWith(".yolo/"));
  const review = provider.review || {};
  const noPrematurePrd = turns.slice(0, -1).every((turn) => turn.expected_prd_state !== "ready" ? turn.prd_status === "blocked" : true);
  const finalClassOk = scenario.expect === "blocked" ? !finalPrd?.prd && finalPrd?.status === "blocked" : !!finalPrd?.prd && finalPrd?.status !== "blocked";
  const checkOk = scenario.expect === "blocked" ? true : ["pass", "warning"].includes(finalCheck?.status);
  const normalizedScore = summarizeReview(review).score ?? 0;
  const claudeOk = provider.success
    && review.correct_final_class === true
    && review.no_premature_prd === true
    && (review.verdict === "pass" || (scenario.expect === "blocked" && review.verdict === "blocked"))
    && normalizedScore >= 80
    && summarizeReview(review).hard_failures.length === 0;
  const status = noPrematurePrd && finalClassOk && checkOk && claudeOk && reviewChanges.length === 0 ? "pass" : "fail";
  return {
    iteration,
    scenario: scenario.id,
    expected: scenario.expect,
    status,
    project_root: projectRoot,
    transcript_path: transcriptPath,
    chain_path: chainPath,
    prd_path: finalPrd?.artifacts?.[0] || null,
    blocked_path: finalBlockedPath || null,
    yolo: {
      no_premature_prd: noPrematurePrd,
      final_class_ok: finalClassOk,
      check_status: finalCheck?.status || null,
      turn_count: turns.length,
      turn_expectations_met: turns.filter((turn) => turn.expectation_met).length,
      blocker_codes: turns.flatMap((turn) => turn.blocker_codes || []),
    },
    claude: {
      success: provider.success,
      exit_code: provider.exit_code,
      signal: provider.signal,
      timed_out: provider.timed_out,
      parse_error: provider.parse_error,
      review: summarizeReview(provider.review),
      stdout: provider.success ? "" : provider.stdout,
      stderr: provider.success ? "" : provider.stderr,
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
const runId = argValue("--run-id", `demand-dialogue-${nowId()}`);
const outDir = resolve(root, argValue("--output-dir", `.yolo/stress/${runId}`));
mkdirSync(outDir, { recursive: true });

const ledger = {
  schema: "yolo.demand.dialogue_stress.v1",
  run_id: runId,
  started_at: new Date().toISOString(),
  project_root: root,
  output_dir: outDir,
  cycles,
  timeout_ms: timeoutMs,
  model: model || null,
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
      entry = runScenario({ scenario, iteration, outDir, model, timeoutMs });
    } catch (error) {
      entry = {
        iteration,
        scenario: scenario.id,
        expected: scenario.expect,
        status: "fail",
        error: error.stack || error.message,
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
    if (entry.status !== "pass" && !process.argv.includes("--continue-on-fail")) {
      ledger.stopped_reason = `failed_${entry.scenario}`;
      writeJson(join(outDir, "ledger.json"), ledger);
      console.error(`demand dialogue stress ledger: ${join(outDir, "ledger.json")}`);
      process.exit(2);
    }
  }
}

ledger.ended_at = new Date().toISOString();
ledger.completed = true;
ledger.iteration_count = ledger.iterations.length;
writeJson(join(outDir, "ledger.json"), ledger);
console.error(`demand dialogue stress ledger: ${join(outDir, "ledger.json")}`);
