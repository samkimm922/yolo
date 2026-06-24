#!/usr/bin/env node
/**
 * 审计报告 → 原子 PRD 生成器
 *
 * 读结构化审计 JSON，按调用链合并同类发现为原子 task，输出 v2 PRD.json。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { isBusinessFile } from "../runtime/execution/change-set.js";
import { readJsonFileBounded } from "../lib/bounded-read.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

function extractArea(files) {
  const areas = new Set();
  for (const file of files) {
    const match = String(file).match(/src\/(?:services|types|hooks|pages|components)\/([^/]+)/);
    if (match) areas.add(match[1].replace(/\.[^.]+$/, ""));
  }
  return [...areas].sort().join("+") || "unknown";
}

function makeTaskId(prefix, index) {
  return `${prefix}-AUTO-${String(index).padStart(3, "0")}`;
}

function isBusinessCode(file, options = Object()) {
  return isBusinessFile(file, options);
}

function normalizeTargetPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?:-\d+)?$/, "");
}

function normalizeConditionList(conditions = [], prefix) {
  return conditions.map((condition, index) => {
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      return {
        severity: "FAIL",
        ...condition,
        id: condition.id || `${prefix}-${index + 1}`,
        params: condition.params || {},
      };
    }

    return {
      id: `${prefix}-${index + 1}`,
      type: "acceptance_criteria",
      severity: "WARN",
      params: { text: String(condition) },
      message: String(condition),
    };
  });
}

function collectConditionFiles(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    out.push(normalizeTargetPath(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectConditionFiles(item, out);
    return out;
  }
  if (typeof value === "object") {
    for (const key of ["file", "path", "target", "target_file", "file_path"]) {
      if (value[key]) collectConditionFiles(value[key], out);
    }
  }
  return out;
}

function targetCoverageFiles(conditions = []) {
  const files = [];
  for (const condition of conditions) {
    if (condition?.severity !== "FAIL" || condition.type === "acceptance_criteria") continue;
    const params = condition.params || {};
    collectConditionFiles(params.file, files);
    collectConditionFiles(params.path, files);
    collectConditionFiles(params.target, files);
    collectConditionFiles(params.target_file, files);
    collectConditionFiles(params.file_path, files);
    collectConditionFiles(params.files, files);
    collectConditionFiles(params.paths, files);
    collectConditionFiles(params.targets, files);
  }
  return new Set(files.filter(Boolean));
}

const BEHAVIOR_VERIFICATION_CONDITION_TYPES = new Set([
  "build_pass",
  "no_new_lint_errors",
  "no_new_type_errors",
  "test_file_passes",
  "tests_pass",
]);

function conditionVerifyCommand(condition) {
  const params = condition?.params || {};
  return String(condition?.verify_command || condition?.verifyCommand || params.verify_command || params.verifyCommand || "").trim();
}

function hasBehaviorVerificationCondition(conditions = []) {
  return conditions.some((condition) =>
    condition?.severity === "FAIL" &&
    (BEHAVIOR_VERIFICATION_CONDITION_TYPES.has(condition.type) || conditionVerifyCommand(condition))
  );
}

function withTargetCoverageConditions(conditions, targetFiles, taskId, kind) {
  const normalizedTargets = targetFiles.map(normalizeTargetPath).filter(Boolean);
  const covered = targetCoverageFiles(conditions);
  const next = [...conditions];

  for (const [index, file] of normalizedTargets.entries()) {
    if (covered.has(file)) continue;
    const isFeature = kind === "atomic_feature";
    next.push({
      id: `POST-${taskId}-TARGET-${index + 1}`,
      type: isFeature ? "file_exists" : "target_file_modified",
      severity: "FAIL",
      params: { file },
      message: isFeature ? `目标文件必须存在: ${file}` : `目标文件必须被修改: ${file}`,
    });
  }

  return next;
}

function withBehaviorVerificationConditions(conditions, taskId) {
  if (hasBehaviorVerificationCondition(conditions)) return conditions;
  return [
    ...conditions,
    {
      id: `POST-${taskId}-TYPECHECK`,
      type: "no_new_type_errors",
      severity: "FAIL",
      params: { command: "npm run typecheck" },
      message: "项目 typecheck 必须通过。",
    },
  ];
}

function demandQualityReport(status = "pass") {
  return {
    schema_version: "1.0",
    schema: "yolo.demand.quality.v1",
    status,
    total_score: status === "pass" ? 100 : 0,
    dimensions: [],
  };
}

function uniqueTaskTargetFiles(tasks = []) {
  return [...new Set(tasks.flatMap((task) =>
    (task.scope?.targets || []).map((target) => target.file).filter(Boolean)
  ))];
}

function cloneJson(value) {
  return value ? JSON.parse(JSON.stringify(value)) : value;
}

function explicitDemandContractOption(options = Object()) {
  return options.approvedDemandContract
    || options.approved_demand_contract
    || options.demandContract
    || options.demand_contract
    || options.approvedDemand
    || options.approved_demand
    || null;
}

function requireApprovedDemandContract(input, tasks = []) {
  if (!input) return null;
  const contract = cloneJson(input);
  const demand = contract.demand || null;
  const readiness = contract.execution_readiness || null;
  const qualityStatuses = [
    demand?.quality_report?.status,
    demand?.execution_readiness?.quality_report?.status,
    demand?.execution_readiness?.quality_status,
    readiness?.quality_report?.status,
    readiness?.quality_status,
  ].filter(Boolean);
  const taskTargets = uniqueTaskTargetFiles(tasks);
  const verifiedTargets = new Set(
    (demand?.project_facts?.target_files || [])
      .filter((fact) => fact?.status === "verified")
      .map((fact) => fact.file)
      .filter(Boolean),
  );
  const missingVerifiedTargets = taskTargets.filter((file) => !verifiedTargets.has(file));

  if (!demand?.id) {
    throw new Error("approved demand contract requires demand.id");
  }
  if (demand?.approval?.approved !== true || demand?.approval?.effective_for_prd !== true) {
    throw new Error("approved demand contract requires approval.approved=true and effective_for_prd=true");
  }
  if (readiness?.level !== "L3" || readiness?.afk_ready !== true) {
    throw new Error("approved demand contract requires execution_readiness level=L3 and afk_ready=true");
  }
  if (!qualityStatuses.length || qualityStatuses.some((status) => status !== "pass")) {
    throw new Error("approved demand contract requires passing demand quality reports");
  }
  if (missingVerifiedTargets.length > 0) {
    throw new Error(`approved demand contract is missing verified target facts: ${missingVerifiedTargets.join(", ")}`);
  }

  return {
    source: contract.source || "approved_demand",
    demand_contract_required: true,
    demand,
    execution_readiness: readiness,
  };
}

function buildGeneratedDemandContract({ tasks = [], source = "audit" } = Object()) {
  const targetFiles = uniqueTaskTargetFiles(tasks);
  const quality = demandQualityReport("blocked");
  return {
    source: "audit_generated",
    demand_contract_required: true,
    demand: {
      id: `DEMAND-${Date.now()}-AUTO`,
      source,
      approval: {
        approved: false,
        effective_for_prd: false,
        approval_source: "audit_generated_pending_human_approval",
      },
      project_facts: {
        target_files: targetFiles.map((file) => ({ file, status: "candidate", source: "audit_generated", needs_verification: true })),
        assumptions: [],
      },
      quality_report: quality,
    },
    execution_readiness: {
      level: "draft",
      afk_ready: false,
      source: "audit_generated_pending_approval",
      quality_status: "blocked",
      quality_report: quality,
    },
  };
}

function groupFindings(findings) {
  const groups = { mechanical: new Map(), atomic_fix: new Map(), atomic_feature: [] };

  for (const finding of findings) {
    const kind = finding.kind || "atomic_fix";
    if (kind === "mechanical") {
      const key = finding.type || finding.id;
      if (!groups.mechanical.has(key)) groups.mechanical.set(key, []);
      groups.mechanical.get(key).push(finding);
    } else if (kind === "atomic_fix") {
      const area = finding.area || extractArea(finding.files || []);
      const key = `${finding.type || "fix"}:${area}`;
      if (!groups.atomic_fix.has(key)) groups.atomic_fix.set(key, []);
      groups.atomic_fix.get(key).push(finding);
    } else {
      groups.atomic_feature.push(finding);
    }
  }

  return groups;
}

function buildTask(kind, findingsList, index, options = Object()) {
  const id = makeTaskId(kind === "mechanical" ? "MECH" : kind === "atomic_fix" ? "FIX" : "FEAT", index);
  const allFiles = [...new Set(findingsList.flatMap((finding) => finding.files || []))];
  const highestSev = findingsList.reduce((worst, finding) => {
    const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    return order[finding.severity] < order[worst] ? finding.severity : worst;
  }, "LOW");

  const first = findingsList[0];
  const description = findingsList
    .map((finding) => `- [${finding.severity}] ${finding.description}${finding.suggestion ? ` -> ${finding.suggestion}` : ""}`)
    .join("\n");

  const targetFiles = allFiles.map(normalizeTargetPath);
  const allNonBusiness = targetFiles.length > 0 && targetFiles.every((file) => !isBusinessCode(file, options));
  const existingScope = findingsList.find((finding) => finding.scope && finding.scope.targets)?.scope;
  const scope = existingScope
    ? { ...existingScope }
    : { targets: targetFiles.map((file) => ({ file })) };

  if (allNonBusiness && !scope.expected_zero_business_code) {
    scope.expected_zero_business_code = true;
  }

  const existingPre = findingsList.find((finding) => Array.isArray(finding.pre_conditions) && finding.pre_conditions.length > 0)?.pre_conditions;
  const existingPost = findingsList.find((finding) => Array.isArray(finding.post_conditions) && finding.post_conditions.length > 0)?.post_conditions;
  const preConditions = normalizeConditionList(existingPre || [], `PRE-${id}`);
  const postConditions = withBehaviorVerificationConditions(
    withTargetCoverageConditions(
      normalizeConditionList(existingPost || [], `POST-${id}`),
      targetFiles,
      id,
      kind,
    ),
    id,
  );

  return {
    id,
    title: `${kind === "mechanical" ? "批量替换" : kind === "atomic_fix" ? "修复" : "新功能"}: ${first.type || first.description.slice(0, 40)}`,
    description,
    type: kind === "atomic_feature" ? "feature" : "bugfix",
    task_kind: kind,
    priority: highestSev === "CRITICAL" ? "P0" : highestSev === "HIGH" ? "P1" : highestSev === "MEDIUM" ? "P2" : "P3",
    status: "pending",
    requirement_ids: [`REQ-${id}`],
    design_ids: [`DES-${id}`],
    depends_on: [],
    scope,
    pre_conditions: preConditions,
    post_conditions: postConditions,
    acceptance_criteria: [
      ...findingsList.map((finding) => `${finding.description} 已修复`),
      "tsc + vitest 通过",
    ],
  };
}

export function buildPrdFromFindings(findings, options = Object()) {
  const groups = groupFindings(findings);
  const tasks = [];
  let taskIndex = 0;

  for (const [, group] of groups.mechanical) tasks.push(buildTask("mechanical", group, ++taskIndex, options));
  for (const [, group] of groups.atomic_fix) tasks.push(buildTask("atomic_fix", group, ++taskIndex, options));
  for (const finding of groups.atomic_feature) tasks.push(buildTask("atomic_feature", [finding], ++taskIndex, options));
  const explicitDemandContract = requireApprovedDemandContract(explicitDemandContractOption(options), tasks);
  const needsContractReview = !explicitDemandContract;
  for (const task of tasks) task.status = needsContractReview ? "needs_contract_review" : "pending";
  const requirements = tasks.map((task) => ({
    id: task.requirement_ids[0],
    text: task.description || task.title,
    demand_trace: {
      source: "structured_finding",
      task_id: task.id,
      evidence: task.scope?.targets?.map((target) => target.file).filter(Boolean) || [],
    },
  }));
  const designs = tasks.map((task) => ({
    id: task.design_ids[0],
    text: `Implement ${task.id} within declared scope and executable gates.`,
  }));

  let base_commit;
  try {
    base_commit = execSync("git rev-parse HEAD", {
      cwd: options.cwd || process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    base_commit = "0000000";
  }

  const source = options.source || "audit";
  const demandContract = explicitDemandContract || buildGeneratedDemandContract({ tasks, source });
  return {
    prd: {
      version: "2.0",
      id: options.id || `PRD-${Date.now()}-AUTO`,
      title: options.title || "审计修复",
      description: options.description || `审计修复 PRD，来源: ${source}`,
      project: options.project || {
        name: "project",
        language: "typescript",
        framework: "generic",
        package_manager: "other",
        test_framework: "unknown",
        lint_tool: "unknown",
        type_checker: "unknown",
      },
      generated_by: options.generated_by || "yolo-review-agent",
      generated_at: new Date().toISOString(),
      base_commit,
      status: needsContractReview ? "needs_contract_review" : "draft",
      executable: false,
      executable_after_preflight: !needsContractReview,
      needs_contract_review: needsContractReview,
      source: demandContract.source,
      demand_contract_required: demandContract.demand_contract_required,
      demand: demandContract.demand,
      execution_readiness: demandContract.execution_readiness,
      requirements,
      designs,
      tasks,
    },
    counts: {
      tasks: tasks.length,
      mechanical: groups.mechanical.size,
      atomic_fix: groups.atomic_fix.size,
      atomic_feature: groups.atomic_feature.length,
    },
    status: needsContractReview ? "draft" : "success",
    executable: false,
    executable_after_preflight: !needsContractReview,
    needs_contract_review: needsContractReview,
  };
}

export function convertAuditToPrd(input, options = Object()) {
  const audit = typeof input === "string"
    ? JSON.parse(readFileSync(resolve(input), "utf8"))
    : input;
  const findings = audit?.findings || [];

  if (!findings.length) {
    return {
      ok: false,
      error: "审计文件无 findings 数据",
      prd: null,
      output: null,
      counts: { tasks: 0, mechanical: 0, atomic_fix: 0, atomic_feature: 0 },
    };
  }

  const source = typeof input === "string" ? input : options.source || "audit";
  let built;
  try {
    built = buildPrdFromFindings(findings, { ...options, source });
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      prd: null,
      output: null,
      counts: { tasks: 0, mechanical: 0, atomic_fix: 0, atomic_feature: 0 },
    };
  }
  const output = options.output ? resolve(options.output) : null;

  if (output) {
    writeFileSync(output, JSON.stringify(built.prd, null, 2), "utf8");
  }

  return { ok: true, ...built, output };
}

function scanExistingPrds(dirs) {
  const files = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (
        file.endsWith(".json") &&
        !file.includes("baseline") &&
        !file.includes("learn") &&
        !file.includes("settings") &&
        file !== "package.json"
      ) {
        files.push({ name: file, path: resolve(dir, file) });
      }
    }
  }
  return files;
}

function findExistingExecutablePrd() {
  for (const existing of scanExistingPrds([PACKAGE_ROOT, join(PACKAGE_ROOT, "data")])) {
    try {
      const prd = readJsonFileBounded(existing.path, { errorCode: "PRD_JSON_SIZE_LIMIT_EXCEEDED" });
      if (prd.tasks && Array.isArray(prd.tasks) && prd.tasks.length > 0 && prd.tasks[0].status) {
        const pending = prd.tasks.filter((task) => task.status === "pending" || task.status === "running").length;
        return { ...existing, task_count: prd.tasks.length, pending };
      }
    } catch {}
  }
  return null;
}

function getOpt(args, name, fallback) {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.split("=").slice(1).join("=") : fallback;
}

function printSummary(result) {
  console.log(
    `Draft PRD 已导入: ${result.output}`,
    `\n  ${result.counts.tasks} 个 task`,
    `\n  状态: ${result.status}${result.needs_contract_review ? " / needs_contract_review" : ""}`,
    `\n  可执行性: executable only after preflight`,
    `\n    mechanical: ${result.counts.mechanical} 组`,
    `\n    atomic_fix: ${result.counts.atomic_fix} 组`,
    `\n    atomic_feature: ${result.counts.atomic_feature} 个`,
    `\n  tasks 详情:`,
  );
  for (const task of result.prd.tasks) {
    console.log(`    ${task.id} [${task.task_kind}] [${task.priority}] ${task.title}`);
  }
}

export function runAuditToPrdCli() {
  const args = process.argv.slice(2);
  const inputArg = args[0];
  const force = args.includes("--force");

  if (!inputArg || inputArg === "--help" || inputArg === "-h") {
    console.log("用法: yolo audit-to-prd <audit.json> [--title=xxx] [--output=prd.json] [--force]");
    console.log("");
    console.log("将结构化审计 JSON 导入为 draft PRD；executable only after preflight。");
    console.log("");
    console.log("选项:");
    console.log("  --title=xxx    PRD 标题（默认: 审计修复）");
    console.log("  --output=FILE  输出文件路径（默认: prd.json）");
    console.log("  --force        覆盖已有 PRD");
    process.exit(inputArg ? 0 : 1);
  }

  if (!force) {
    const existing = findExistingExecutablePrd();
    if (existing) {
      console.error(`\n已有 PRD: ${existing.name}（${existing.task_count} 个 task，${existing.pending} 个待处理）`);
      console.error("   如需生成新 PRD，请先归档旧 PRD 到 prd/ 目录，或加 --force 强制覆盖\n");
      process.exit(1);
    }
  }

  const result = convertAuditToPrd(inputArg, {
    title: getOpt(args, "title", "审计修复"),
    output: getOpt(args, "output", "prd.json"),
  });

  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }

  printSummary(result);
}

if (isMain) runAuditToPrdCli();
