#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getArg, hasFlag } from "../../lib/cli-utils.js";
import { buildEvidenceArtifact, writeJsonArtifact } from "../evidence/ledger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOLO_ROOT = resolve(__dirname, "../../..");
const PROJECT_ROOT = resolve(YOLO_ROOT, "../..");

const DATA_TERMS = [
  "inventory", "stock", "quantity", "transaction", "deduct", "decrement",
  "库存", "扣减", "数量", "事务", "销售记录",
];
const UI_TERMS = ["ui", "page", "component", "selecteditem", "selector", "onchange", "页面", "组件", "选择", "回调"];
const HOOK_TERMS = ["hook", "hooks/"];
const STRUCTURAL_POSTCONDITION_TYPES = new Set([
  "files_modified_max",
  "file_lines_max",
  "no_new_type_errors",
  "tests_pass",
  "build_pass",
]);

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function resolvePrdPath(input) {
  if (!input) return null;
  const abs = resolve(YOLO_ROOT, input);
  if (existsSync(abs)) return abs;
  const basename = String(input).split("/").pop();
  for (const candidate of [
    resolve(YOLO_ROOT, "data/prd/current", basename),
    resolve(YOLO_ROOT, "data", basename),
    resolve(YOLO_ROOT, "data/prd/archive", basename),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return abs;
}

function normalizeFile(file) {
  return String(file || "").replace(/^\.\//, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function conditionText(conditions = []) {
  return conditions.map((condition) => [
    condition.id,
    condition.type,
    condition.message,
    condition.params?.file,
    condition.params?.text,
    condition.params?.pattern,
  ].filter(Boolean).join(" ")).join("\n");
}

function taskText(task) {
  return [
    task.id,
    task.title,
    task.description,
    conditionText(task.pre_conditions),
    conditionText(task.post_conditions),
    JSON.stringify(task.scope?.forbidden_patterns || []),
  ].filter(Boolean).join("\n").toLowerCase();
}

function fileLayer(file) {
  const f = normalizeFile(file);
  if (f.startsWith("src/pages/")) return "pages";
  if (f.startsWith("src/services/")) return "services";
  if (f.startsWith("src/components/")) return "components";
  if (f.startsWith("src/hooks/") || f.includes("/hooks/")) return "hooks";
  if (f.startsWith("src/types/") || f.endsWith(".d.ts")) return "types";
  if (f.startsWith("cloudfunctions/")) return "cloudfunctions";
  if (f.startsWith("scripts/yolo/")) return "yolo_engine";
  return f.split("/")[0] || "unknown";
}

function countFailPostconditions(task) {
  return (task.post_conditions || []).filter((condition) => (condition.severity || "FAIL") === "FAIL").length;
}

function countBehavioralFailPostconditions(task) {
  return (task.post_conditions || []).filter((condition) => {
    if ((condition.severity || "FAIL") !== "FAIL") return false;
    return !STRUCTURAL_POSTCONDITION_TYPES.has(condition.type);
  }).length;
}

function isStructuralSingleFileTask(task, files, behavioralFailPostconditions) {
  if (files.length !== 1 || behavioralFailPostconditions > 0) return false;
  const sourceFindings = task.source_findings || [];
  const allFindingsStructural = sourceFindings.length > 0
    && sourceFindings.every((finding) => ["R9-file-length"].includes(finding.scanner_id));
  const postconditions = task.post_conditions || [];
  const allPostconditionsStructural = postconditions.length > 0
    && postconditions.every((condition) => STRUCTURAL_POSTCONDITION_TYPES.has(condition.type));
  return allFindingsStructural || allPostconditionsStructural;
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function existingTargets(files, roots = [PROJECT_ROOT, YOLO_ROOT]) {
  const resolvedRoots = unique(roots.map((root) => resolve(root)));
  return files.filter((file) => resolvedRoots.some((root) => existsSync(resolve(root, normalizeFile(file)))));
}

function buildSplitSuggestions(task, files, layers, text) {
  const suggestions = [];
  const pageLike = files.filter((file) => ["pages", "components", "hooks"].includes(fileLayer(file)));
  const serviceLike = files.filter((file) => ["services", "cloudfunctions"].includes(fileLayer(file)));
  const base = task.id;

  if (pageLike.length) {
    suggestions.push({
      id: `${base}A`,
      title: `拆分 ${task.title || task.id}: UI/页面状态修复`,
      files: pageLike,
      goal: "只修页面/组件/Hook 的状态流和调用关系；不得修改 service/database 行为。",
      required_investigation: [
        "读取所有 UI target 文件",
        "追踪 onChange/props/state 数据流",
        "用证据说明错位数据从哪里产生、修复后由哪个 item 成为单源真相",
      ],
    });
  }

  if (serviceLike.length) {
    suggestions.push({
      id: `${base}B`,
      title: `拆分 ${task.title || task.id}: service/数据一致性修复`,
      files: serviceLike,
      goal: "只修 service 层持久化和库存一致性；不得修改页面 UI。",
      required_investigation: [
        "读取目标 service 和 readonly 相关 service/types",
        "追踪 create/update 现有库存扣减模式",
        "用证据说明 quantity 写入与库存扣减的原子性策略",
      ],
    });
  }

  if (suggestions.length === 0 && files.length > 1) {
    for (const [index, file] of files.entries()) {
      suggestions.push({
        id: `${base}${String.fromCharCode(65 + index)}`,
        title: `拆分 ${task.title || task.id}: ${file}`,
        files: [file],
        goal: `只处理 ${file} 内可验证的最小行为变化。`,
      });
    }
  }

  if (includesAny(text, DATA_TERMS) && !serviceLike.length) {
    suggestions.push({
      id: `${base}${String.fromCharCode(65 + suggestions.length)}`,
      title: `补充调查 ${task.title || task.id}: 数据一致性影响面`,
      files: task.scope?.readonly_files || [],
      goal: "先调查数据/库存/事务相关文件，再决定是否生成 service 子任务。",
      mode: "research_only",
    });
  }

  return suggestions;
}

export function inspectAtomicTask(task, options = {}) {
  if (!task || !task.id) throw new Error("inspectAtomicTask requires task.id");

  const projectRoot = resolve(options.projectRoot || options.project_root || options.root || PROJECT_ROOT);
  const targetRoots = unique([projectRoot, PROJECT_ROOT, YOLO_ROOT]);
  const targets = task.scope?.targets || [];
  const files = unique(targets.map((target) => normalizeFile(target.file)));
  const readonlyFiles = unique(task.scope?.readonly_files || []);
  const layers = unique(files.map(fileLayer));
  const text = taskText(task);
  const failPostconditions = countFailPostconditions(task);
  const behavioralFailPostconditions = countBehavioralFailPostconditions(task);
  const structuralSingleFileTask = isStructuralSingleFileTask(task, files, behavioralFailPostconditions);
  const uiOnlyTargets = files.length > 0 && files.every((file) => ["pages", "components", "hooks"].includes(fileLayer(file)));
  const dataTerms = uiOnlyTargets ? [] : DATA_TERMS.filter((term) => text.includes(term));
  const uiTerms = UI_TERMS.filter((term) => text.includes(term));
  const hookTerms = HOOK_TERMS.filter((term) => text.includes(term));
  const crossesPagesServices = layers.includes("pages") && layers.includes("services");
  const missingSourceTargets = files.filter((file) => file.startsWith("src/") && !existingTargets([file], targetRoots).includes(file));
  const hasNewFile = missingSourceTargets.length > 0 && task.scope?.allow_new_files !== false;
  const isSplitChild = Boolean(task.parent_task_id || task.split_from);
  const isSingleFileSplitChild = isSplitChild && files.length === 1 && task.scope?.max_files === 1;
  const behaviorDomains = unique([
    uiTerms.length ? "ui_state" : null,
    dataTerms.length ? "data_consistency" : null,
    hookTerms.length ? "hook_api" : null,
    text.includes("tsc") || text.includes("compile") || text.includes("编译") ? "compile" : null,
  ]);

  let score = 0;
  const reasons = [];
  const add = (points, id, detail, evidence = {}) => {
    score += points;
    reasons.push({ id, points, detail, evidence });
  };

  if (files.length > 1) add((files.length - 1) * 2, "MULTI_FILE", `目标文件 ${files.length} 个`, { files });
  if (files.length > 3) add(2, "TARGET_FILES_GT_3", "目标文件超过 3 个，模型上下文和改动范围容易漂移", { files });
  if (crossesPagesServices) add(3, "CROSSES_PAGES_SERVICES", "任务同时跨页面层和 service 层", { layers, files });
  if (dataTerms.length) add(3, "DATA_CONSISTENCY_TERMS", "任务涉及库存/数量/事务/数据库等数据一致性词", { terms: dataTerms });
  if (hookTerms.length) add(2, "HOOK_OR_API_TERMS", "任务涉及 hook/API 调用契约", { terms: hookTerms });
  if (hasNewFile) add(2, "CREATES_NEW_FILE", "任务包含新文件创建", { files: missingSourceTargets });
  if (behavioralFailPostconditions) {
    add(Math.min(behavioralFailPostconditions, 3), "BEHAVIORAL_FAIL_POSTCONDITIONS", `行为后置条件 ${behavioralFailPostconditions} 个`, {
      behavioralFailPostconditions,
      totalFailPostconditions: failPostconditions,
    });
  }
  if (behaviorDomains.length > 1) add(2, "MULTIPLE_BEHAVIOR_DOMAINS", "任务包含多个独立行为域", { behaviorDomains });
  if (task.scope?.max_files && files.length >= task.scope.max_files && files.length > 1) {
    add(1, "AT_SCOPE_FILE_LIMIT", "目标文件数已经贴近/达到 scope.max_files，没有缓冲空间", { max_files: task.scope.max_files, files: files.length });
  }

  const hardSplit =
    crossesPagesServices ||
    (!structuralSingleFileTask && behaviorDomains.includes("ui_state") && behaviorDomains.includes("data_consistency")) ||
    files.length > 3 ||
    failPostconditions > 7 ||
    (hasNewFile && files.length > 1 && behaviorDomains.length > 1);

  let mode = "direct_patch";
  if (hardSplit || score >= 10) mode = "must_split";
  else if (score >= 6 || files.length > 1 || behaviorDomains.length > 1) mode = "investigate_then_patch";
  else if (!files.length || !targets.length) mode = "research_only";

  if (
    mode === "must_split" &&
    (isSingleFileSplitChild || (files.length === 1 && task.scope?.max_files === 1)) &&
    !crossesPagesServices &&
    !hasNewFile &&
    failPostconditions <= 5
  ) {
    mode = "investigate_then_patch";
    reasons.push({
      id: isSingleFileSplitChild ? "SINGLE_FILE_SPLIT_CHILD_CAP" : "SINGLE_FILE_TASK_CAP",
      points: 0,
      detail: "只有 1 个目标文件且 scope.max_files=1，禁止用拆分替代执行，改为先调查再最小修改。",
      evidence: { parent_task_id: task.parent_task_id || task.split_from || null, files },
    });
  }

  const status = mode === "must_split" ? "fail" : "pass";
  const evidence = buildEvidenceArtifact("task.atomic_investigation", {
    task_id: task.id,
    status,
    mode,
    score,
    threshold: { direct_patch_max: 5, must_split_min: 10 },
    files,
    readonly_files: readonlyFiles,
    layers,
    behavior_domains: behaviorDomains,
    structural_single_file_task: structuralSingleFileTask,
    fail_postconditions: failPostconditions,
    behavioral_fail_postconditions: behavioralFailPostconditions,
    reasons,
    split_suggestions: mode === "must_split" ? buildSplitSuggestions(task, files, layers, text) : [],
    next_action: mode === "must_split"
      ? "split_task_before_model_spawn"
      : mode === "investigate_then_patch"
        ? "force_prompt_to_read_and_report_evidence_before_patch"
        : "allow_runner_execution",
  }, { source: "atomic-task-doctor" });

  const evidenceRoot = resolve(options.root || YOLO_ROOT, "state/evidence", task.id);
  const evidenceFile = resolve(evidenceRoot, "investigation.json");
  if (options.writeEvidence !== false) {
    writeJsonArtifact(evidenceFile, evidence);
  }

  return {
    status,
    mode,
    task_id: task.id,
    score,
    reasons,
    evidence_file: relative(options.root || YOLO_ROOT, evidenceFile),
    split_suggestions: evidence.split_suggestions,
    next_action: evidence.next_action,
  };
}

export function inspectTaskFromPrd(prdPath, taskId, options = {}) {
  const resolved = resolvePrdPath(prdPath);
  const prd = readJson(resolved);
  const task = (prd.tasks || []).find((item) => item.id === taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  return inspectAtomicTask(task, { ...options, prdPath: resolved });
}

export function runAtomicTaskDoctorCli(options = {}) {
  const yoloRoot = resolve(options.yoloRoot || YOLO_ROOT);
  const prdPath = getArg("--prd=");
  const taskId = getArg("--task=");
  const json = hasFlag("--json");
  const noWrite = hasFlag("--no-write");
  const projectRoot = getArg("--project-root=") || getArg("--project_root=");
  if (!prdPath || !taskId) {
    console.error("用法: node atomic-task-doctor.js --prd=<prd.json> --task=<task-id> [--project-root=<project-root>] [--json] [--no-write]");
    process.exit(2);
  }
  try {
    const result = inspectTaskFromPrd(prdPath, taskId, { root: yoloRoot, projectRoot, writeEvidence: !noWrite });
    console.log(json ? JSON.stringify(result, null, 2) : `[atomic-task-doctor] ${result.task_id} ${result.mode} score=${result.score}`);
    process.exit(result.status === "fail" ? 1 : 0);
  } catch (error) {
    const payload = { status: "error", error: error.message };
    console.error(json ? JSON.stringify(payload, null, 2) : `[atomic-task-doctor] ${error.message}`);
    process.exit(2);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runAtomicTaskDoctorCli();
}
