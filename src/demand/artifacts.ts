import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { buildDemandArtifactGraph } from "./graph.js";
import { inspectDemandReadiness } from "./gate.js";
import { buildUnderstandingPlayback } from "./understanding-playback.js";
import { targetUserRoleItems } from "./interview.js";
import {
  buildEvidenceRequirements,
  evidenceRequirementSummary,
} from "./evidence-requirements.js";

export const DEMAND_SESSION_SCHEMA_VERSION = "1.0";
export const DEMAND_SESSION_SCHEMA = "yolo.demand.session.v1";

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function clean(value) {
  return String(value ?? "").trim();
}

function arrayOfStrings(value) {
  return asArray(value)
    .flatMap((item) => String(item ?? "").split(/\r?\n/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(value) {
  return [...new Set(arrayOfStrings(value))];
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nowIso(options = Object()) {
  return clean(options.now) || new Date().toISOString();
}

function slug(value, fallback = "DEMAND") {
  const text = clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return text || fallback;
}

function idDate(now) {
  return clean(now).slice(0, 10).replace(/-/g, "") || "00000000";
}

function demandId(input = Object(), now) {
  return clean(input.id || input.demand_id || input.demandId)
    || `DEMAND-${idDate(now)}-${slug(input.title || input.idea || input.objective || input.requirement || "PROJECT")}`;
}

const LABELS = {
  problem: ["Problem", "问题"],
  target_users: ["Target User", "Target Users", "User", "Users", "用户", "对象"],
  success_criteria: ["Success", "Success Criteria", "Acceptance", "验收", "成功标准"],
  constraints: ["Constraint", "Constraints", "限制", "约束"],
  non_goals: ["Non-goal", "Non-goals", "Out of scope", "不做", "非目标"],
  status_quo: ["Status quo", "Current", "Workaround", "现状", "替代方案"],
  evidence: ["Evidence", "证据"],
  assumptions: ["Assumption", "Assumptions", "假设"],
  target_files: ["Scope", "Target", "Targets", "Files", "范围", "文件"],
  touchpoint: ["Touchpoint", "Entry", "Flow", "Page", "入口", "流程", "页面", "位置"],
  trigger: ["Trigger", "When", "触发", "什么时候", "条件"],
  exception: ["Exception", "Edge case", "异常", "边界情况"],
  proof: ["Proof", "Verify", "Evidence plan", "证明", "如何证明"],
  visual_style: ["Visual style", "Style source", "UI style", "样式", "视觉样式", "样式来源"],
};

const ALL_LABELS = Object.values(LABELS).flat().sort((a, b) => b.length - a.length);

function labelPattern(labels) {
  return labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

function extractLabel(text, labels) {
  const source = clean(text);
  if (!source) return "";
  const current = labelPattern(labels);
  const all = labelPattern(ALL_LABELS);
  const pattern = new RegExp(`(?:^|[\\n.;])\\s*(?:${current})\\s*[:：]\\s*([\\s\\S]*?)(?=(?:[\\n.;]\\s*(?:${all})\\s*[:：])|$)`, "i");
  return clean(source.match(pattern)?.[1] || "");
}

const LIST_ITEM_PREFIX = /^(?:[-*•]\s+|\d{1,3}[.)、](?!\d)\s*|[（(]\d{1,3}[）)]\s*|[一二三四五六七八九十]{1,4}[.)、]\s*)/u;
const INLINE_NUMBERED_ITEM = /\s+(?=(?:\d{1,3}[.)、](?!\d)\s*|[（(]\d{1,3}[）)]\s*|[一二三四五六七八九十]{1,4}[.)、]\s*))/u;

function splitStructuredListItem(value) {
  return clean(value)
    .split(INLINE_NUMBERED_ITEM)
    .flatMap((item) => item.split(/;\s+|\s+\|\s+/))
    .map((item) => clean(item).replace(LIST_ITEM_PREFIX, "").trim())
    .filter(Boolean);
}

function splitList(value) {
  return uniqueStrings(
    arrayOfStrings(value)
      .flatMap(splitStructuredListItem),
  );
}

const SCOUT_EXCLUDED_DIRS = new Set([
  ".git",
  ".yolo",
  "dist",
  "node_modules",
  "coverage",
  ".next",
  ".nuxt",
  "build",
]);

const SCOUT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".json",
  ".md",
]);

function extname(path) {
  const match = String(path || "").match(/(\.[^.\/]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function collectProjectFiles(projectRoot, options = Object()) {
  const root = resolve(clean(projectRoot) || process.cwd());
  const maxFiles = Number(options.maxFiles || 600);
  if (!existsSync(root)) return [];
  const files = [];
  function visit(dir) {
    if (files.length >= maxFiles) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (SCOUT_EXCLUDED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && SCOUT_EXTENSIONS.has(extname(entry.name))) {
        try {
          if (statSync(full).size <= 250_000) files.push(relative(root, full));
        } catch {
          // Ignore transient files during a lightweight scout.
        }
      }
    }
  }
  visit(root);
  return files.sort();
}

function tokens(value) {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function surfaceKindFromFile(file) {
  const path = clean(file).toLowerCase();
  if (/(^|\/)(__tests__|tests?|specs?)\//.test(path) || /\.(test|spec)\./.test(path)) return "test";
  if (/(^|\/)(pages?|views?|screens?|components?|ui)\//.test(path)) return "ui";
  if (/(^|\/)(routes?|api|controllers?|server)\//.test(path)) return "api";
  if (/(^|\/)(models?|repositories|migrations?|database|db)\//.test(path)) return "data";
  if (/(^|\/)(services?|hooks?|stores?|lib|utils|domain)\//.test(path)) return "service";
  if (/(^|\/)(docs?|specs?)\//.test(path) || path.endsWith(".md")) return "doc";
  return "code";
}

function inferSurfaceKinds(text, files = []) {
  const source = clean(text).toLowerCase();
  const kinds = new Set(files.map(surfaceKindFromFile));
  if (/页面|列表|按钮|展示|显示|筛选|弹窗|ui|page|screen|component|button|display|show|render/.test(source)) kinds.add("ui");
  if (/接口|api|route|endpoint|server|controller|请求/.test(source)) kinds.add("api");
  if (/规则|计算|阈值|库存|数量|状态|service|domain|logic|calculate|threshold|status|rule/.test(source)) kinds.add("service");
  if (/保存|数据库|表|记录|持久|迁移|data|database|db|model|repository/.test(source)) kinds.add("data");
  if (/测试|验证|证明|test|spec|verify/.test(source)) kinds.add("test");
  if (kinds.size === 0) kinds.add("service");
  return [...kinds];
}

function surfaceLabel(kind) {
  return {
    ui: "用户可见界面",
    api: "接口/服务入口",
    service: "业务规则/服务逻辑",
    data: "数据/持久化",
    test: "测试/验证",
    doc: "文档/说明",
    code: "代码实现",
  }[kind] || "代码实现";
}

function scoreCandidateFile(file, tokenList, kind) {
  const lower = file.toLowerCase();
  let score = 0;
  if (surfaceKindFromFile(file) === kind) score += 6;
  for (const token of tokenList) {
    if (token.length >= 2 && lower.includes(token)) score += token.length >= 5 ? 3 : 1;
  }
  if (lower.includes("inventory") || lower.includes("库存")) score += tokenList.includes("inventory") || tokenList.includes("库存") ? 3 : 0;
  if (/(readme|changelog|package-lock|pnpm-lock|yarn.lock)/.test(lower)) score -= 8;
  return score;
}

function inferTargetFiles({ projectRoot, text, explicitFiles = [], maxPerKind = 2 } = Object()) {
  const explicit = uniqueStrings(explicitFiles);
  if (explicit.length > 0) return explicit;
  const files = collectProjectFiles(projectRoot);
  if (files.length === 0) return [];
  const tokenList = tokens(text);
  const kinds = inferSurfaceKinds(text);
  const selected = [];
  for (const kind of kinds) {
    const ranked = files
      .map((file) => ({ file, score: scoreCandidateFile(file, tokenList, kind) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, maxPerKind)
      .map((item) => item.file);
    selected.push(...ranked);
  }
  return [...new Set(selected)].slice(0, 8);
}

function resolveProjectFile(projectRoot, file) {
  const root = resolve(clean(projectRoot) || process.cwd());
  const path = clean(file);
  return isAbsolute(path) ? path : resolve(root, path);
}

function scopedProjectFile(projectRoot, file) {
  const root = resolve(clean(projectRoot) || process.cwd());
  const declared = clean(file);
  const absolute = isAbsolute(declared) ? resolve(declared) : resolve(root, declared);
  const relativePath = relative(root, absolute);
  const insideRoot = relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath);
  return {
    declared,
    absolute,
    relative: relativePath,
    insideRoot,
  };
}

function evidenceText(evidence = []) {
  return uniqueStrings(evidence).join("\n");
}

function evidenceMentionsFile(evidence = [], file = "") {
  const target = clean(file);
  return target && evidenceText(evidence).includes(target);
}

function targetFileFacts({ projectRoot, explicitFiles = [], inferredFiles = [], evidence = [], verifiedFiles = [] } = Object()) {
  const verifiedSet = new Set(uniqueStrings(verifiedFiles));
  const explicit = uniqueStrings(explicitFiles);
  const inferred = uniqueStrings(inferredFiles).filter((file) => !explicit.includes(file));
  const facts = [];
  for (const file of explicit) {
    const scoped = scopedProjectFile(projectRoot, file);
    if (!scoped.insideRoot) {
      facts.push({
        file,
        status: "invalid_scope",
        source: "outside_project_root",
        evidence: [],
        message: "Target file is outside the project root and cannot enter execution scope.",
      });
      continue;
    }
    const normalizedFile = scoped.relative;
    const exists = existsSync(scoped.absolute);
    const evidenceVerified = evidenceMentionsFile(evidence, normalizedFile) || evidenceMentionsFile(evidence, file);
    const verifiedInput = verifiedSet.has(normalizedFile) || verifiedSet.has(file);
    const verified = exists || evidenceVerified || verifiedInput;
    facts.push({
      file: normalizedFile,
      ...(normalizedFile !== file ? { declared_file: file } : {}),
      status: verified ? "verified" : "needs_verification",
      source: exists ? "project_read" : evidenceVerified ? "evidence_record" : verifiedInput ? "verified_input" : "user_or_agent_declared",
      evidence: exists ? [`${normalizedFile} exists in project root.`] : evidenceVerified ? [`Evidence mentions ${normalizedFile}.`] : [],
      message: verified
        ? "Target file is verified enough to enter execution scope."
        : "Target file is declared but not verified by project read or evidence; keep blocked before executable PRD.",
    });
  }
  for (const file of inferred) {
    const scoped = scopedProjectFile(projectRoot, file);
    if (!scoped.insideRoot) continue;
    facts.push({
      file: scoped.relative,
      status: "candidate",
      source: "auto_scout_candidate",
      evidence: existsSync(scoped.absolute) ? [`${scoped.relative} exists, but relevance is only inferred.`] : [],
      message: "Auto-scouted file is only a candidate and must not enter execution scope until verified.",
    });
  }
  return facts;
}

function targetFilesFromFacts(facts = []) {
  return facts
    .filter((fact) => ["verified", "needs_verification"].includes(fact.status))
    .map((fact) => fact.file);
}

function candidateFilesFromFacts(facts = []) {
  return facts
    .filter((fact) => fact.status === "candidate")
    .map((fact) => fact.file);
}

function projectFactIdentifiers(text = "") {
  const source = clean(text);
  const camelOrSnake = source.match(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:Threshold|Quantity|Qty|Units|Available|Stock|Floor|Replenishment)[A-Za-z0-9_$]*\b|[a-z]+_[a-z0-9_]*(?:threshold|quantity|qty|units|available|stock|floor|replenishment)[a-z0-9_]*/g) || [];
  const dotted = source.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\[\]\.[A-Za-z_$][A-Za-z0-9_$]*|\b[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
  const simple = source.match(/\b(threshold|quantity|qty|stock|floor|replenishment)\b/gi) || [];
  return uniqueStrings([...camelOrSnake, ...dotted.flatMap((item) => item.split(".")).filter((part) => !part.endsWith("[]")), ...simple]);
}

function assumptionRecords({ assumptions = [], evidence = [], targetFacts = [], projectRoot = "" } = Object()) {
  const evidenceSource = evidenceText(evidence).toLowerCase();
  const targetText = targetFacts
    .filter((fact) => ["verified", "needs_verification"].includes(fact.status))
    .flatMap((fact) => {
      try {
        const scoped = scopedProjectFile(projectRoot, fact.file);
        if (!scoped.insideRoot) return [];
        return existsSync(scoped.absolute) ? [String(readFileSync(scoped.absolute, "utf8")).slice(0, 64000)] : [];
      } catch {
        return [];
      }
    })
    .join("\n")
    .toLowerCase();
  return uniqueStrings(assumptions).map((text, index) => {
    const thresholdClaim = /threshold|replenishment|floor|lowstock|low_stock/i.test(text);
    const contradictedByEvidence = thresholdClaim && /\b(no|not|does not|without|missing)\b[^\n.]{0,100}\b(threshold|replenishment|floor|lowstock|low_stock)\b/i.test(evidenceSource);
    const contradictedByProject = thresholdClaim
      && targetText
      && !/threshold|replenishment|floor|lowstock|low_stock/i.test(targetText);
    const identifiers = projectFactIdentifiers(text);
    const concrete = identifiers.length > 0;
    const identifiersVerified = concrete && identifiers.every((identifier) => {
      const lowerIdentifier = identifier.toLowerCase();
      return evidenceSource.includes(lowerIdentifier) || targetText.includes(lowerIdentifier);
    });
    const status = contradictedByEvidence || contradictedByProject
      ? "contradicted"
      : identifiersVerified
        ? "verified"
      : concrete
        ? "needs_verification"
        : "assumption";
    return {
      id: `ASM-${String(index + 1).padStart(3, "0")}`,
      text,
      status,
      source: "user_or_dialogue",
      contradicted_by: contradictedByEvidence
        ? ["evidence"]
        : contradictedByProject
          ? ["project_read"]
          : [],
      identifiers,
      verified_by: identifiersVerified ? [
        ...(targetText ? ["project_read"] : []),
        ...(evidenceSource ? ["evidence"] : []),
      ] : [],
      message: status === "contradicted"
        ? "Assumption conflicts with available evidence or project files and must not be promoted to fact."
        : status === "verified"
          ? "Assumption is grounded by evidence or target project files."
        : status === "needs_verification"
          ? "Assumption names project facts and needs verification before executable PRD."
          : "Business assumption not yet verified.",
    };
  });
}

function buildNonTechnicalIntake({
  input = Object(),
  objective = "",
  problem = "",
  targetUsers = [],
  statusQuo = [],
  successCriteria = [],
  constraints = [],
  nonGoals = [],
  evidence = [],
  assumptions = [],
  targetFiles = [],
  candidateTargetFiles = [],
  visualStyleSource = [],
} = Object()) {
  const touchpoints = mergeField(input, "touchpoints", LABELS.touchpoint, objective);
  const triggers = mergeField(input, "triggers", LABELS.trigger, objective);
  const exceptions = mergeField(input, "exceptions", LABELS.exception, objective);
  const proof = mergeField(input, "proof", LABELS.proof, objective);
  return {
    schema: "yolo.demand.nontechnical_intake.v1",
    actor: targetUsers[0] || "target user",
    audience: targetUsers,
    plain_language_problem: problem || objective,
    touchpoints,
    current_workarounds: statusQuo,
    desired_outcomes: successCriteria,
    success_proof: proof.length ? proof : successCriteria,
    visual_style_source: visualStyleSource,
    boundaries: [...constraints, ...nonGoals],
    exceptions,
    evidence,
    assumptions,
    technical_terms_required_from_user: false,
    user_should_not_need_to_name_files: true,
    inferred_target_files: targetFiles,
    candidate_target_files: candidateTargetFiles,
    question_model: [
      "Who has the problem?",
      "Where in the workflow does it happen?",
      "What happens today?",
      "What should happen instead?",
      "For visible UI, what exact copy, position, style source/component, and proof are acceptable?",
      "For API/service failures, what error shape, message, or code should be observable?",
      "How will you know it worked?",
      "What is explicitly out of scope?",
      "What edge cases would make this feel wrong?",
    ],
  };
}

function readObjectField(source, keys = []) {
  if (!isPlainObject(source)) return undefined;
  for (const key of keys) {
    if (source[key] != null) return source[key];
  }
  return undefined;
}

function questionId(value, index) {
  const id = clean(value)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || `Q${index + 1}`;
}

function questionTraceIds(value) {
  return [...new Set(asArray(value)
    .map((item) => {
      if (isPlainObject(item)) return clean(item.id || item.question_id || item.questionId);
      return clean(item);
    })
    .filter(Boolean))];
}

function traceEntries(value) {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) {
    return Object.entries(value).map(([key, item]) => (
      isPlainObject(item)
        ? Object.assign(Object(), { id: key }, item)
        : { id: key, question: key, answer: item }
    ));
  }
  return clean(value) ? [value] : [];
}

function normalizeTraceItem(item, index, input = Object(), source = "interview") {
  const fallbackQuestion = asArray(input.questions || input.question)[index];
  if (isPlainObject(item)) {
    const answerValue = item.answer ?? item.response ?? item.value ?? item.result ?? item.content;
    const answer = Array.isArray(answerValue) ? arrayOfStrings(answerValue).join("; ") : clean(answerValue);
    const question = clean(item.question || item.prompt || item.label || item.text || fallbackQuestion);
    const reason = clean(item.reason || item.why || item.intent);
    if (!question && !answer && !reason) return null;
    return {
      id: questionId(item.id || item.question_id || item.questionId || item.key, index),
      question,
      answer,
      source: clean(item.source || source),
      ...(reason ? { reason } : {}),
    };
  }
  const answer = clean(item);
  const question = clean(fallbackQuestion || `Interview answer ${index + 1}`);
  if (!question && !answer) return null;
  return {
    id: `Q${index + 1}`,
    question,
    answer,
    source,
  };
}

function normalizeInterviewContext(input = Object()) {
  const interview = input.interview;
  const interviewObject = isPlainObject(interview) ? interview : {};
  const answers = input.interview_answers
    ?? input.interviewAnswers
    ?? readObjectField(interviewObject, ["interview_answers", "interviewAnswers", "answers", "responses"]);
  const explicitTrace = input.question_trace
    ?? input.questionTrace
    ?? readObjectField(interviewObject, ["question_trace", "questionTrace", "questions", "rounds"]);
  const prdIntake = input.prd_intake
    ?? input.prdIntake
    ?? input.intake
    ?? readObjectField(interviewObject, ["prd_intake", "prdIntake", "intake"]);
  const coverage = input.interview_coverage
    ?? input.interviewCoverage
    ?? readObjectField(interviewObject, ["coverage", "interview_coverage", "interviewCoverage"]);
  const approvalReason = clean(
    input.approval_reason
      || input.approvalReason
      || readObjectField(interviewObject, ["approval_reason", "approvalReason", "approved_reason", "approvedReason"])
      || readObjectField(prdIntake, ["approval_reason", "approvalReason", "approved_reason", "approvedReason"]),
  );
  const sources = [];
  if (explicitTrace != null) sources.push({ source: "question_trace", items: traceEntries(explicitTrace) });
  if (answers != null) sources.push({ source: "interview_answers", items: traceEntries(answers) });
  if (Array.isArray(interview)) sources.push({ source: "interview", items: interview });
  if (typeof interview === "string" && clean(interview)) sources.push({ source: "interview", items: [interview] });
  if (!sources.length && (input.questions || input.question)) {
    sources.push({ source: "questions", items: traceEntries(input.questions || input.question) });
  }

  const seen = new Set();
  const questionTrace = [];
  for (const source of sources) {
    for (const item of source.items) {
      const trace = normalizeTraceItem(item, questionTrace.length, input, source.source);
      if (!trace || seen.has(trace.id)) continue;
      seen.add(trace.id);
      questionTrace.push(trace);
    }
  }

  return {
    present: interview != null || answers != null || prdIntake != null,
    source: interview != null ? "input.interview" : answers != null ? "input.interview_answers" : prdIntake != null ? "input.intake" : "input.questions",
    question_trace: questionTrace,
    prd_intake_source: prdIntake,
    coverage: isPlainObject(coverage) ? coverage : null,
    approval_reason: approvalReason,
  };
}

function buildPrdIntake({ nontechnicalIntake = Object(), interviewContext = Object() } = Object()) {
  const raw = interviewContext.prd_intake_source;
  const rawObject = isPlainObject(raw) ? raw : {};
  const rawText = typeof raw === "string" ? clean(raw) : "";
  return {
    schema: "yolo.demand.prd_intake.v1",
    source: interviewContext.present ? interviewContext.source : "derived_nontechnical_intake",
    question_ids: questionTraceIds(interviewContext.question_trace),
    plain_language_problem: clean(rawObject.plain_language_problem || rawObject.problem || nontechnicalIntake.plain_language_problem),
    audience: splitList(rawObject.audience || rawObject.target_users || nontechnicalIntake.audience),
    desired_outcomes: splitList(rawObject.desired_outcomes || rawObject.success_criteria || nontechnicalIntake.desired_outcomes),
    success_proof: splitList(rawObject.success_proof || rawObject.proof || nontechnicalIntake.success_proof),
    boundaries: splitList(rawObject.boundaries || rawObject.constraints || nontechnicalIntake.boundaries),
    exceptions: splitList(rawObject.exceptions || rawObject.edge_cases || nontechnicalIntake.exceptions),
    ...(rawText ? { raw_text: rawText } : {}),
  };
}

function groupFilesBySurface(files = []) {
  const groups = new Map();
  for (const file of uniqueStrings(files)) {
    const kind = surfaceKindFromFile(file);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(file);
  }
  return [...groups.entries()].map(([kind, targetFiles], index) => ({
    id: `SFC-${String(index + 1).padStart(3, "0")}`,
    kind,
    label: surfaceLabel(kind),
    user_visible: kind === "ui",
    target_files: targetFiles,
    readonly_files: [],
    session_budget: {
      expected: "single_session",
      max_files: Math.max(1, Math.min(2, targetFiles.length || 1)),
      max_lines_per_file: 120,
    },
  }));
}

function buildScenarioMatrix({
  input = Object(),
  objective = "",
  requirements = [],
  targetUsers = [],
  statusQuo = [],
  constraints = [],
  nonGoals = [],
  targetFiles = [],
  visualStyleSource = [],
  questionTrace = [],
} = Object()) {
  const touchpoints = mergeField(input, "touchpoints", LABELS.touchpoint, objective);
  const triggers = mergeField(input, "triggers", LABELS.trigger, objective);
  const exceptions = mergeField(input, "exceptions", LABELS.exception, objective);
  const proof = mergeField(input, "proof", LABELS.proof, objective);
  const actor = targetUsers[0] || "target user";
  const sourceQuestionIds = questionTraceIds(questionTrace);
  const baseSurfaces = groupFilesBySurface(targetFiles);
  const inferredKinds = inferSurfaceKinds(`${objective}\n${requirements.map((item) => item.text).join("\n")}`, targetFiles);
  const fallbackSurfaces = inferredKinds.map((kind, index) => ({
    id: `SFC-${String(index + 1).padStart(3, "0")}`,
    kind,
    label: surfaceLabel(kind),
    user_visible: kind === "ui",
    target_files: [],
    readonly_files: [],
    session_budget: {
      expected: "single_session",
      max_files: 1,
      max_lines_per_file: 120,
    },
  }));
  const surfaces = baseSurfaces.length ? baseSurfaces : fallbackSurfaces;
  const scenarios = requirements.map((requirement, index) => {
    const requirementScenarios = asArray(requirement.acceptance_scenarios || requirement.scenarios);
    const firstScenario = requirementScenarios[0] || {};
    return {
      id: `SCN-${String(index + 1).padStart(3, "0")}`,
      requirement_id: requirement.id,
      actor,
      touchpoint: touchpoints[index] || touchpoints[0] || "primary user workflow",
      trigger: clean(firstScenario.when) || triggers[index] || triggers[0] || "the user reaches this scenario",
      current_behavior: statusQuo[index] || statusQuo[0] || "Captured in demand context.",
      desired_behavior: requirement.text,
      proof: proof[index] || proof[0] || clean(firstScenario.then || firstScenario.text) || requirement.text,
      out_of_scope: nonGoals,
      constraints,
      exceptions,
      surfaces: surfaces.map((surface, surfaceIndex) => ({
        ...surface,
        id: `SCN-${String(index + 1).padStart(3, "0")}-${surface.id || `SFC-${surfaceIndex + 1}`}`,
        proof: proof[index] || proof[0] || requirement.text,
        visual_style_source: surface.user_visible ? visualStyleSource : [],
      })),
      question_trace: sourceQuestionIds,
      source_question_ids: sourceQuestionIds,
    };
  });
  return {
    schema: "yolo.demand.scenario_matrix.v1",
    generated_from: "nontechnical_interview",
    nontechnical_user_safe: true,
    scenarios,
    atomic_task_rule: "one user-visible story with one proof becomes one task; file and surface budgets only bound implementation scope",
  };
}

function mergeField(input, key, labels, text) {
  const explicit = input[key] ?? input[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())];
  const extracted = extractLabel(text, labels);
  return splitList([...arrayOfStrings(explicit), extracted]);
}

function firstField(input, keys, text, labels) {
  for (const key of keys) {
    const value = clean(input[key]);
    if (value) return value;
  }
  return clean(extractLabel(text, labels));
}

function requirementRecord(text, index, input = Object()) {
  const id = `REQ-${String(index + 1).padStart(3, "0")}`;
  const scenarioText = clean(input.acceptance_scenario || input.acceptanceScenario || text);
  const sourceQuestionIds = questionTraceIds(input.questionTrace || input.question_trace);
  return {
    id,
    text: clean(text),
    source: "demand",
    status: "confirmed",
    acceptance_scenarios: [
      {
        id: `SCN-${String(index + 1).padStart(3, "0")}`,
        when: clean(input.scenario_when || input.scenarioWhen || "the user exercises this requirement"),
        then: scenarioText,
      },
    ],
    trace: {
      evidence: uniqueStrings(input.evidence).map((_, evidenceIndex) => `EVID-${String(evidenceIndex + 1).padStart(3, "0")}`),
      decisions: uniqueStrings(input.decisions || input.decision).map((_, decisionIndex) => `DEC-${String(decisionIndex + 1).padStart(3, "0")}`),
      question_ids: sourceQuestionIds,
    },
  };
}

function normalizeStoryText(value) {
  return clean(value)
    .replace(/\s+/g, " ")
    .replace(/^[,，;；\s]+|[,，;；\s]+$/g, "");
}

function splitRepeatedUserStories(text) {
  const matches = [...clean(text).matchAll(/当用户/g)];
  if (matches.length <= 1) return [];
  const parts = matches.map((match, index) => {
    const start = match.index || 0;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return normalizeStoryText(text.slice(start, end));
  }).filter((part) => part.length >= 8);
  return parts.length > 1 ? parts : [];
}

function splitEditMoveStory(text) {
  const match = clean(text).match(/^当用户把(.+?)编辑为(.+?)并移动到(.+?)时[，,](.+)$/);
  if (!match) return [];
  const [, before, after, destination, consequence] = match;
  return [
    `当用户把${clean(before)}编辑为${clean(after)}时，旧标题不可见，新标题可见。`,
    `当用户将${clean(after)}移动到${clean(destination)}时，${normalizeStoryText(consequence)}`,
  ].map(normalizeStoryText);
}

function splitCreateListCardStory(text) {
  const match = clean(text).match(/^当用户(.+?(?:新增|新建|创建|添加|增加).+?(?:列表|清单|看板列|列).+?)并(.+?(?:新增|新建|创建|添加|增加).+?(?:卡片|任务卡|卡).+?)时[，,](.+)$/u);
  if (!match) return [];
  const [, listAction, cardAction, consequence] = match;
  const clauses = normalizeStoryText(consequence)
    .split(/\s*[，,]\s*/)
    .map(normalizeStoryText)
    .filter(Boolean);
  const listClause = clauses.find((clause) => /列表|清单|看板列|列/.test(clause)) || "列表创建结果可见。";
  const cardClause = clauses.find((clause) => /卡片|任务卡|卡/.test(clause)) || "卡片创建结果可见。";
  return [
    `当用户${normalizeStoryText(listAction)}时，${listClause}`,
    `当用户${normalizeStoryText(cardAction)}时，${cardClause}`,
  ].map(normalizeStoryText);
}

function splitArchivePersistenceStory(text) {
  const match = clean(text).match(/^当用户归档(.+?)并(刷新|重新加载)页面时[，,](.+)$/);
  if (!match) return [];
  const [, item, refreshVerb, consequence] = match;
  const clauses = normalizeStoryText(consequence)
    .split(/\s*[，,]\s*/)
    .map(normalizeStoryText)
    .filter(Boolean);
  const hiddenClause = clauses.find((clause) => /不显示|隐藏/.test(clause)) || clauses[0] || "普通列表不显示该归档项。";
  const restoreClause = clauses.find((clause) => /恢复|保留|localStorage|持久/.test(clause)) || clauses.slice(1).join("，") || "未归档数据仍可恢复。";
  return [
    `当用户归档${clean(item)}时，${hiddenClause}`,
    `当用户${refreshVerb}页面时，${restoreClause}`,
  ].map(normalizeStoryText);
}

function storySlicesForRequirement(text) {
  const source = clean(text);
  const repeated = splitRepeatedUserStories(source);
  if (repeated.length > 1) return repeated.flatMap(storySlicesForRequirement);
  const createListCard = splitCreateListCardStory(source);
  if (createListCard.length > 1) return createListCard.flatMap(storySlicesForRequirement);
  const editMove = splitEditMoveStory(source);
  if (editMove.length > 1) return editMove.flatMap(storySlicesForRequirement);
  const archivePersistence = splitArchivePersistenceStory(source);
  if (archivePersistence.length > 1) return archivePersistence.flatMap(storySlicesForRequirement);
  return [source].filter(Boolean);
}

function expandRequirementStories(requirements = []) {
  const expanded = [];
  for (const requirement of requirements) {
    const stories = storySlicesForRequirement(requirement.text);
    if (stories.length <= 1) {
      expanded.push(requirement);
      continue;
    }
    stories.forEach((story, storyIndex) => {
      const id = `${requirement.id}-S${String(storyIndex + 1).padStart(2, "0")}`;
      expanded.push({
        ...requirement,
        id,
        text: story,
        source_requirement_id: requirement.id,
        story_index: storyIndex + 1,
        story_count: stories.length,
        story_atomicity: {
          schema: "yolo.demand.story_atomicity.v1",
          source_requirement_id: requirement.id,
          source_text: requirement.text,
          split: true,
          reason: "compound_user_story",
        },
        acceptance_scenarios: asArray(requirement.acceptance_scenarios || requirement.scenarios).map((scenario, scenarioIndex) => ({
          ...scenario,
          id: `SCN-${String(expanded.length + 1).padStart(3, "0")}-${String(scenarioIndex + 1).padStart(2, "0")}`,
          then: story,
          text: story,
        })),
      });
    });
  }
  return expanded;
}

function buildRounds(input = Object(), questionTrace = []) {
  const rounds = asArray(input.rounds || input.discussion_rounds || input.questions || input.question).filter(Boolean);
  if (rounds.length > 0) {
    return rounds.map((item, index) => {
      if (typeof item === "object") return { id: item.id || `Q${index + 1}`, ...item };
      return { id: `Q${index + 1}`, question: clean(item), answer: clean(asArray(input.answers || input.answer)[index]) };
    });
  }
  if (asArray(questionTrace).length > 0) {
    return asArray(questionTrace).map((item, index) => ({
      id: clean(item.id) || `Q${index + 1}`,
      question: clean(item.question || "Interview question"),
      answer: clean(item.answer || ""),
      source: clean(item.source || "question_trace"),
    }));
  }
  const decisions = uniqueStrings(input.decisions || input.decision);
  return decisions.length > 0 ? decisions.map((decision, index) => ({
    id: `Q${index + 1}`,
    question: "Decision confirmed during demand discussion.",
    answer: decision,
  })) : [];
}

function truthyConfirmation(value) {
  if (value === true) return true;
  const text = clean(value).toLowerCase();
  return ["true", "yes", "approved", "confirm", "confirmed", "ok", "确认", "批准", "同意"].includes(text);
}

function deferredScopeConfirmation(input = Object(), deferredItems = [], now = "") {
  const items = uniqueStrings(deferredItems);
  const raw = input.deferred_scope_confirmed
    ?? input.deferredScopeConfirmed
    ?? input.confirm_deferred_scope
    ?? input.confirmDeferredScope
    ?? input.deferred_confirmation
    ?? input.deferredConfirmation
    ?? input.deferred_confirmed
    ?? input.deferredConfirmed;
  const confirmed = items.length === 0 || truthyConfirmation(raw);
  return {
    schema: "yolo.demand.deferred_scope_confirmation.v1",
    required: items.length > 0,
    confirmed,
    status: items.length === 0 ? "not_required" : confirmed ? "confirmed" : "needs_confirmation",
    items,
    confirmed_by: confirmed && items.length > 0 ? clean(input.approved_by || input.approvedBy || "user") : null,
    confirmed_at: confirmed && items.length > 0 ? clean(input.deferred_confirmed_at || input.deferredConfirmedAt || now) : null,
    prompt: items.length > 0
      ? [
        "本次不做，未来重新询问：",
        ...items.map((item) => `- ${item}`),
        "",
        "请确认这个延期范围。",
      ].join("\n")
      : "",
  };
}

function completedArtifacts(session = Object()) {
  const completed = [];
  if (clean(session.vision?.statement || session.vision?.idea).length >= 10) completed.push("vision");
  if (session.reflection?.assumptions?.length || session.reflection?.alternatives?.length || clean(session.reflection?.summary)) completed.push("reflection");
  if (session.investigation?.evidence?.length || session.reflection?.assumptions?.length) completed.push("investigation");
  if (session.discussion?.rounds?.length || session.discussion?.decisions?.length) completed.push("questioning_rounds");
  if (session.readiness) completed.push("depth_verification");
  if (session.requirements?.active?.length) completed.push("requirements_confirmation");
  if (session.context?.summary || session.context?.domain_terms?.length) completed.push("context");
  if (session.roadmap?.mvp?.length || session.roadmap?.phases?.length) completed.push("roadmap");
  if (session.approval?.approved) completed.push("approval");
  return completed;
}

export function buildDemandSession(input = Object(), options = Object()) {
  const now = nowIso(options);
  const objective = clean(input.objective || input.idea || input.requirement || input.text || input.title);
  const projectRoot = input.projectRoot || input.project_root || options.projectRoot || options.project_root;
  const interviewContext = normalizeInterviewContext(input);
  const questionTrace = interviewContext.question_trace;
  const id = demandId({ ...input, objective }, now);
  const problem = firstField(input, ["problem"], objective, LABELS.problem);
  const targetUsers = targetUserRoleItems(mergeField(input, "target_users", LABELS.target_users, objective));
  const successCriteria = mergeField(input, "success_criteria", LABELS.success_criteria, objective);
  const constraints = mergeField(input, "constraints", LABELS.constraints, objective);
  const nonGoals = mergeField(input, "non_goals", LABELS.non_goals, objective);
  const statusQuo = mergeField(input, "status_quo", LABELS.status_quo, objective);
  const evidence = mergeField(input, "evidence", LABELS.evidence, objective);
  const assumptions = mergeField(input, "assumptions", LABELS.assumptions, objective);
  const explicitTargetFiles = mergeField(input, "target_files", LABELS.target_files, objective);
  const visualStyleSource = mergeField(input, "visual_style", LABELS.visual_style, objective);
  const alternatives = uniqueStrings(input.alternatives || input.alternative);
  const risks = uniqueStrings(input.risks || input.risk);
  const decisions = uniqueStrings(input.decisions || input.decision);
  const openQuestions = uniqueStrings(input.open_questions || input.openQuestions || ((input.answer || input.answers || questionTrace.length > 0) ? [] : input.question));
  const roadmapItems = uniqueStrings(input.roadmap || input.mvp || input.phase || input.phases);
  const deferredItems = uniqueStrings(input.deferred || input.followups || input.follow_ups);
  const deferredConfirmation = deferredScopeConfirmation(input, deferredItems, now);
  const scoutText = [
    objective,
    problem,
    targetUsers.join(" "),
    successCriteria.join(" "),
    statusQuo.join(" "),
  ].join("\n");
  const inferredTargetFiles = explicitTargetFiles.length > 0 ? [] : inferTargetFiles({
    projectRoot,
    text: scoutText,
    explicitFiles: [],
  });
  const targetFileFactRecords = targetFileFacts({
    projectRoot,
    explicitFiles: explicitTargetFiles,
    inferredFiles: inferredTargetFiles,
    evidence,
    verifiedFiles: input.verified_target_files || input.verifiedTargetFiles,
  });
  const targetFiles = targetFilesFromFacts(targetFileFactRecords);
  const candidateTargetFiles = candidateFilesFromFacts(targetFileFactRecords);
  const assumptionFactRecords = assumptionRecords({
    assumptions,
    evidence,
    targetFacts: targetFileFactRecords,
    projectRoot,
  });
  const projectFactNextActions = [
    ...targetFileFactRecords
      .filter((fact) => fact.status === "needs_verification")
      .map((fact) => `Read or cite ${fact.file} before executable PRD generation.`),
    ...targetFileFactRecords
      .filter((fact) => fact.status === "candidate")
      .map((fact) => `Confirm whether ${fact.file} is in execution scope before promoting it from candidate.`),
    ...assumptionFactRecords
      .filter((fact) => fact.status === "contradicted")
      .map((fact) => `Resolve contradicted assumption ${fact.id}: ${fact.text}`),
    ...assumptionFactRecords
      .filter((fact) => fact.status === "needs_verification")
      .map((fact) => `Verify assumption ${fact.id} against project evidence before PRD execution.`),
  ];
  const rawRequirements = (successCriteria.length > 0 ? successCriteria : uniqueStrings(input.requirements || input.requirement_text))
    .map((text, index) => requirementRecord(text, index, { ...input, evidence, decisions, questionTrace }));
  const requirements = expandRequirementStories(rawRequirements);
  const nontechnicalIntake = buildNonTechnicalIntake({
    input,
    objective,
    problem,
    targetUsers,
    statusQuo,
    successCriteria,
    constraints,
    nonGoals,
    evidence,
    assumptions,
    targetFiles,
    candidateTargetFiles,
    visualStyleSource,
  });
  const prdIntake = buildPrdIntake({ nontechnicalIntake, interviewContext });
  const scenarioMatrix = buildScenarioMatrix({
    input,
    objective,
    requirements,
    targetUsers,
    statusQuo,
    constraints,
    nonGoals,
    targetFiles,
    visualStyleSource,
    questionTrace,
  });
  const approvalReason = interviewContext.approval_reason || clean(input.approval_note || input.approvalNote);

  const session = Object.assign(Object(), {
    schema_version: DEMAND_SESSION_SCHEMA_VERSION,
    schema: DEMAND_SESSION_SCHEMA,
    id,
    generated_at: now,
    phase: clean(input.phase || options.phase || "discuss"),
    mode: clean(input.mode || options.mode || "standard"),
    source: clean(input.source || options.source || "yolo-demand"),
    project: {
      title: clean(input.title || objective).slice(0, 160) || "Demand session",
      target_users: targetUsers,
      target_files: targetFiles,
      candidate_target_files: candidateTargetFiles,
    },
    project_facts: {
      schema: "yolo.demand.project_facts.v1",
      target_files: targetFileFactRecords,
      candidate_target_files: candidateTargetFiles,
      assumptions: assumptionFactRecords,
      policy: {
        inferred_files_are_execution_scope: false,
        unverified_project_facts_block_prd: true,
        user_approval_cannot_override_fact_conflicts: true,
      },
      next_actions: projectFactNextActions,
    },
    question_trace: questionTrace,
    prd_intake: prdIntake,
    approval_reason: approvalReason,
    interview: interviewContext.present ? {
      schema: "yolo.demand.interview.v1",
      source: interviewContext.source,
      question_trace: questionTrace,
      prd_intake: prdIntake,
      coverage: interviewContext.coverage,
      approval_reason: approvalReason || null,
    } : null,
    nontechnical_intake: nontechnicalIntake,
    vision: {
      statement: clean(input.vision || objective),
      idea: objective,
      problem,
      target_users: targetUsers,
      status_quo: statusQuo,
      narrow_wedge: clean(input.narrow_wedge || input.wedge),
    },
    reflection: {
      summary: clean(input.reflection || ""),
      assumptions,
      assumption_records: assumptionFactRecords,
      alternatives,
      premise_challenges: uniqueStrings(input.premise_challenges || input.premise || input.challenge),
    },
    investigation: {
      evidence: evidence.map((text, index) => ({ id: `EVID-${String(index + 1).padStart(3, "0")}`, text })),
      assumptions: assumptionFactRecords,
      codebase_scouts: targetFileFactRecords.map((fact) => ({
        file: fact.file,
        surface: surfaceKindFromFile(fact.file),
        reason: fact.source,
        status: fact.status,
        message: fact.message,
      })),
      risks,
    },
    discussion: {
      rounds: buildRounds(input, questionTrace),
      decisions: decisions.map((text, index) => ({ id: `DEC-${String(index + 1).padStart(3, "0")}`, text })),
      open_questions: openQuestions.map((text, index) => ({ id: `OQ-${String(index + 1).padStart(3, "0")}`, text, blocking: true })),
      deferred: deferredItems,
      deferred_scope_confirmation: deferredConfirmation,
    },
    requirements: {
      active: requirements,
      constraints,
      out_of_scope: nonGoals,
    },
    context: {
      summary: clean(input.context || problem || objective),
      domain_terms: uniqueStrings(input.domain_terms || input.terms),
      current_state: statusQuo,
      constraints,
      visual_style_source: visualStyleSource,
    },
    roadmap: {
      mvp: roadmapItems.length > 0 ? roadmapItems : successCriteria.slice(0, 3),
      phases: roadmapItems.map((text, index) => ({ id: `P${index + 1}`, text })),
      later: uniqueStrings(input.later || input.future),
    },
    scenario_matrix: scenarioMatrix,
    approval: {
      approved: input.approved === true || input.approve === true || ["true", "yes", "approved", "confirm", "confirmed"].includes(clean(input.approval || input.approved || input.approve).toLowerCase()),
      approved_by: clean(input.approved_by || input.approvedBy || "user"),
      approved_at: clean(input.approved_at || input.approvedAt) || ((input.approved === true || input.approve === true || ["true", "yes", "approved", "confirm", "confirmed"].includes(clean(input.approval || input.approved || input.approve).toLowerCase())) ? now : null),
      reason: approvalReason,
      note: clean(input.approval_note || input.approvalNote),
    },
    playback: input.playback || null,
  });
  session.evidence_requirements = buildEvidenceRequirements(input, session);
  session.evidence_requirement_summary = evidenceRequirementSummary(session.evidence_requirements);
  session.readiness = inspectDemandReadiness(session, {
    phase: session.phase,
    projectRoot,
  });
  session.approval.effective_for_prd = session.approval.approved === true && session.readiness.executable_prd_ready === true;
  session.approval.blocked_by = session.approval.approved === true && !session.approval.effective_for_prd
    ? asArray(session.readiness.blockers).map((blocker) => ({
      code: blocker.code,
      message: blocker.message,
    }))
    : [];
  session.graph = buildDemandArtifactGraph(completedArtifacts(session));
  return session;
}

function linesList(values, fallback = "- TBD") {
  const lines = arrayOfStrings(values);
  return lines.length ? lines.map((item) => `- ${item}`).join("\n") : fallback;
}

function scenarioLines(requirement) {
  const scenarios = asArray(requirement.acceptance_scenarios || requirement.scenarios);
  if (scenarios.length === 0) return "- TBD";
  return scenarios.map((scenario) => [
    `#### Scenario: ${scenario.id || "Acceptance"}`,
    `- **WHEN** ${clean(scenario.when || "the user exercises this requirement")}`,
    `- **THEN** ${clean(scenario.then || scenario.text || requirement.text)}`,
  ].join("\n")).join("\n\n");
}

export function demandMarkdownArtifacts(session = Object()) {
  const reqs = asArray(session.requirements?.active);
  const decisions = asArray(session.discussion?.decisions).map((item) => item.text || item);
  const rounds = asArray(session.discussion?.rounds);
  return {
    "VISION.md": [
      `# ${session.project?.title || session.id} Vision`,
      "",
      "## Vision",
      session.vision?.statement || "TBD",
      "",
      "## Problem",
      session.vision?.problem || "TBD",
      "",
      "## Target Users",
      linesList(session.vision?.target_users),
      "",
      "## Status Quo",
      linesList(session.vision?.status_quo),
      "",
      "## Narrow Wedge",
      session.vision?.narrow_wedge || "TBD",
    ].join("\n"),
    "REFLECTION.md": [
      `# ${session.id} Reflection`,
      "",
      "## Premise Challenge",
      linesList(session.reflection?.premise_challenges),
      "",
      "## Assumptions",
      linesList(session.reflection?.assumptions),
      "",
      "## Alternatives",
      linesList(session.reflection?.alternatives),
    ].join("\n"),
    "INVESTIGATION.md": [
      `# ${session.id} Investigation`,
      "",
      "## Evidence",
      linesList(asArray(session.investigation?.evidence).map((item) => `${item.id}: ${item.text}`)),
      "",
      "## Assumptions / TBD",
      linesList(asArray(session.investigation?.assumptions).map((item) => `${item.id} [${item.status || "unknown"}]: ${item.text}${asArray(item.contradicted_by).length ? ` (contradicted by: ${asArray(item.contradicted_by).join(", ")})` : ""}`)),
      "",
      "## Codebase Scouts",
      linesList(asArray(session.investigation?.codebase_scouts).map((item) => `${item.file} [${item.status || "unknown"}] ${item.reason || ""}`)),
      "",
      "## Evidence Requirements",
      linesList(asArray(session.evidence_requirements).map((item) => `${item.id} [${item.status}] ${item.kind}: ${item.topic} - ${item.reason}`)),
      "",
      "## Risks",
      linesList(session.investigation?.risks),
    ].join("\n"),
    "SCENARIO_MATRIX.md": [
      `# ${session.id} Scenario Matrix`,
      "",
      "This artifact translates non-technical answers into engineering-facing slices.",
      "",
      "## Scenarios",
      asArray(session.scenario_matrix?.scenarios).length
        ? asArray(session.scenario_matrix.scenarios).map((scenario) => [
          `### ${scenario.id}: ${scenario.desired_behavior}`,
          `- Actor: ${scenario.actor}`,
          `- Touchpoint: ${scenario.touchpoint}`,
          `- Trigger: ${scenario.trigger}`,
          `- Current: ${scenario.current_behavior}`,
          `- Desired: ${scenario.desired_behavior}`,
          `- Proof: ${scenario.proof}`,
          `- Out of scope: ${arrayOfStrings(scenario.out_of_scope).join("; ") || "TBD"}`,
          "",
          "#### Surfaces",
          asArray(scenario.surfaces).map((surface) => [
            `- ${surface.id}: ${surface.label} (${surface.kind})`,
            `  - targets: ${arrayOfStrings(surface.target_files).join(", ") || "TBD from code scout"}`,
            `  - visual style: ${arrayOfStrings(surface.visual_style_source).join("; ") || "TBD"}`,
            `  - budget: ${surface.session_budget?.expected || "single_session"}, max_files=${surface.session_budget?.max_files || 1}`,
          ].join("\n")).join("\n"),
        ].join("\n")).join("\n\n")
        : "- TBD",
      "",
      "## Atomic Task Rule",
      session.scenario_matrix?.atomic_task_rule || "TBD",
    ].join("\n"),
    "DISCUSSION-LOG.md": [
      `# ${session.id} Discussion Log`,
      "",
      "## Questioning Rounds",
      rounds.length ? rounds.map((round) => [
        `### ${round.id}`,
        `- Question: ${round.question || "TBD"}`,
        `- Answer: ${round.answer || "TBD"}`,
      ].join("\n")).join("\n\n") : "- TBD",
      "",
      "## Decisions",
      linesList(decisions),
      "",
      "## Open Questions",
      linesList(asArray(session.discussion?.open_questions).map((item) => item.text || item)),
      "",
      "## Deferred",
      linesList(session.discussion?.deferred),
    ].join("\n"),
    "REQUIREMENTS.md": [
      `# ${session.id} Requirements`,
      "",
      "## Requirements",
      reqs.length ? reqs.map((requirement) => [
        `### Requirement: ${requirement.id}`,
        `${requirement.text}`,
        "",
        scenarioLines(requirement),
      ].join("\n")).join("\n\n") : "- TBD",
      "",
      "## Constraints",
      linesList(session.requirements?.constraints),
      "",
      "## Out of Scope",
      linesList(session.requirements?.out_of_scope),
    ].join("\n"),
    "CONTEXT.md": [
      `# ${session.id} Context`,
      "",
      "## Summary",
      session.context?.summary || "TBD",
      "",
      "## Domain Terms",
      linesList(session.context?.domain_terms),
      "",
      "## Current State",
      linesList(session.context?.current_state),
      "",
      "## Decisions",
      linesList(decisions),
      "",
      "## Constraints",
      linesList(session.context?.constraints),
      "",
      "## Visual Style Source",
      linesList(session.context?.visual_style_source),
      "",
      "## Verified Target Files",
      linesList(asArray(session.project_facts?.target_files).filter((item) => item.status === "verified").map((item) => item.file)),
      "",
      "## Candidate Target Files",
      linesList(session.project_facts?.candidate_target_files),
    ].join("\n"),
    "ROADMAP.md": [
      `# ${session.id} Roadmap`,
      "",
      "## MVP",
      linesList(session.roadmap?.mvp),
      "",
      "## Phases",
      asArray(session.roadmap?.phases).length
        ? asArray(session.roadmap.phases).map((phase) => `- ${phase.id}: ${phase.text}`).join("\n")
        : "- TBD",
      "",
      "## Later",
      linesList(session.roadmap?.later),
    ].join("\n"),
  };
}
