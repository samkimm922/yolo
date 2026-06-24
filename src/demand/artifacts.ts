import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildDemandArtifactGraph, type DemandArtifactId } from "./graph.js";
import { inspectDemandReadiness } from "./gate.js";
import { buildUnderstandingPlayback } from "./understanding-playback.js";
import { targetUserRoleItems } from "./interview.js";
import {
  buildEvidenceRequirements,
  evidenceRequirementSummary,
} from "./evidence-requirements.js";
import { splitGenericStorySlices } from "./story-atomicity.js";

export const DEMAND_SESSION_SCHEMA_VERSION = "1.0";
export const DEMAND_SESSION_SCHEMA = "yolo.demand.session.v1";
export const DEMAND_GROUNDING_SCHEMA_VERSION = "1.0";
export const DEMAND_GROUNDING_SCHEMA = "yolo.demand.grounding.v1";

// Loose input/session/options records (N4 pattern): the demand artifact
// compiler reads deeply nested session/input data as `Record<string, unknown>`,
// narrowed at each touch point, never widened to `any`.
type Loose = Record<string, unknown>;

function asArray<T = unknown>(value: unknown): T[] {
  if (value == null) return [] as T[];
  return (Array.isArray(value) ? value : [value]) as T[];
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function arrayOfStrings(value: unknown): string[] {
  return asArray(value)
    .flatMap((item) => String(item ?? "").split(/\r?\n/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(value: unknown): string[] {
  return [...new Set(arrayOfStrings(value))];
}

function isPlainObject(value: unknown): boolean {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function nowIso(options: Loose = Object()): string {
  return clean(options.now) || new Date().toISOString();
}

function slug(value: unknown, fallback: string = "DEMAND"): string {
  const text = clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return text || fallback;
}

function idDate(now: unknown): string {
  return clean(now).slice(0, 10).replace(/-/g, "") || "00000000";
}

function demandId(input: Loose = Object(), now: unknown): string {
  return clean(input.id || input.demand_id || input.demandId)
    || `DEMAND-${idDate(now)}-${slug(input.title || input.idea || input.objective || input.requirement || "PROJECT")}`;
}

const LABELS: Record<string, string[]> = {
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

const ALL_LABELS: string[] = Object.values(LABELS).flat().sort((a, b) => b.length - a.length);

function labelPattern(labels: string[]): string {
  return labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

function extractLabel(text: unknown, labels: string[]): string {
  const source = clean(text);
  if (!source) return "";
  const current = labelPattern(labels);
  const all = labelPattern(ALL_LABELS);
  const pattern = new RegExp(`(?:^|[\\n.;])\\s*(?:${current})\\s*[:：]\\s*([\\s\\S]*?)(?=(?:[\\n.;]\\s*(?:${all})\\s*[:：])|$)`, "i");
  return clean(source.match(pattern)?.[1] || "");
}

const LIST_ITEM_PREFIX = /^(?:[-*•]\s+|\d{1,3}[.)、](?!\d)\s*|[（(]\d{1,3}[）)]\s*|[一二三四五六七八九十]{1,4}[.)、]\s*)/u;
const INLINE_NUMBERED_ITEM = /\s+(?=(?:\d{1,3}[.)、](?!\d)\s*|[（(]\d{1,3}[）)]\s*|[一二三四五六七八九十]{1,4}[.)、]\s*))/u;

function splitStructuredListItem(value: unknown): string[] {
  return clean(value)
    .split(INLINE_NUMBERED_ITEM)
    .flatMap((item) => item.split(/;\s+|\s+\|\s+/))
    .map((item) => clean(item).replace(LIST_ITEM_PREFIX, "").trim())
    .filter(Boolean);
}

function splitList(value: unknown): string[] {
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

function extname(path: unknown): string {
  const match = String(path || "").match(/(\.[^.\/]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function collectProjectFiles(projectRoot: unknown, options: Loose = Object()): string[] {
  const root = resolve(clean(projectRoot) || process.cwd());
  const maxFiles = Number(options.maxFiles || 600);
  if (!existsSync(root)) return [];
  const files: string[] = [];
  function visit(dir: string) {
    if (files.length >= maxFiles) return;
    let entries: import("node:fs").Dirent[] = [];
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

function tokens(value: unknown): string[] {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}

function surfaceKindFromFile(file: unknown): string {
  const path = clean(file).toLowerCase();
  if (/(^|\/)(__tests__|tests?|specs?)\//.test(path) || /\.(test|spec)\./.test(path)) return "test";
  if (/(^|\/)(pages?|views?|screens?|components?|ui)\//.test(path)) return "ui";
  if (/(^|\/)(routes?|api|controllers?|server)\//.test(path)) return "api";
  if (/(^|\/)(models?|repositories|migrations?|database|db)\//.test(path)) return "data";
  if (/(^|\/)(services?|hooks?|stores?|lib|utils|domain)\//.test(path)) return "service";
  if (/(^|\/)(docs?|specs?)\//.test(path) || path.endsWith(".md")) return "doc";
  return "code";
}

function inferSurfaceKinds(text: unknown, files: string[] = []): string[] {
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

function surfaceLabel(kind: string): string {
  return ({
    ui: "用户可见界面",
    api: "接口/服务入口",
    service: "业务规则/服务逻辑",
    data: "数据/持久化",
    test: "测试/验证",
    doc: "文档/说明",
    code: "代码实现",
  } as Record<string, string>)[kind] || "代码实现";
}

function scoreCandidateFile(file: string, tokenList: string[], kind: string): number {
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

function inferTargetFiles({ projectRoot, text, explicitFiles = [], maxPerKind = 2 } = Object() as { projectRoot?: unknown; text?: unknown; explicitFiles?: unknown[]; maxPerKind?: number }): string[] {
  const explicit = uniqueStrings(explicitFiles);
  if (explicit.length > 0) return explicit;
  const files = collectProjectFiles(projectRoot);
  if (files.length === 0) return [];
  const tokenList = tokens(text);
  const kinds = inferSurfaceKinds(text);
  const selected: string[] = [];
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

function resolveProjectFile(projectRoot: unknown, file: unknown): string {
  const root = resolve(clean(projectRoot) || process.cwd());
  const path = clean(file);
  return isAbsolute(path) ? path : resolve(root, path);
}

function scopedProjectFile(projectRoot: unknown, file: unknown) {
  const root = resolve(clean(projectRoot) || process.cwd());
  const declared = clean(file);
  const absolute = isAbsolute(declared) ? resolve(declared) : resolve(root, declared);
  const relativePath = relative(root, absolute);
  const insideRoot = relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
  return {
    declared,
    absolute,
    relative: relativePath,
    insideRoot,
  };
}

function evidenceText(evidence: unknown[] = []): string {
  return uniqueStrings(evidence).join("\n");
}

function evidenceMentionsFile(evidence: unknown[] = [], file: unknown = ""): boolean {
  const target = clean(file);
  return Boolean(target) && evidenceText(evidence).includes(target);
}

interface TargetFileFact {
  file: string;
  declared_file?: string;
  status: string;
  source: string;
  evidence: string[];
  message: string;
}

function targetFileFacts({ projectRoot, explicitFiles = [], inferredFiles = [], evidence = [], verifiedFiles = [] } = Object() as { projectRoot?: unknown; explicitFiles?: unknown[]; inferredFiles?: unknown[]; evidence?: unknown[]; verifiedFiles?: unknown[] }): TargetFileFact[] {
  const verifiedSet = new Set(uniqueStrings(verifiedFiles));
  const explicit = uniqueStrings(explicitFiles);
  const inferred = uniqueStrings(inferredFiles).filter((file) => !explicit.includes(file));
  const facts: TargetFileFact[] = [];
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

function targetFilesFromFacts(facts: TargetFileFact[] = []): string[] {
  return facts
    .filter((fact) => ["verified", "needs_verification"].includes(fact.status))
    .map((fact) => fact.file);
}

function candidateFilesFromFacts(facts: TargetFileFact[] = []): string[] {
  return facts
    .filter((fact) => fact.status === "candidate")
    .map((fact) => fact.file);
}

function cloneDemandObject<T>(value: T): T {
  return JSON.parse(JSON.stringify(value || {})) as T;
}

function repoRelative(projectRoot: unknown, file: unknown): string {
  const root = resolve(clean(projectRoot) || process.cwd());
  const target = clean(file);
  if (!target || isAbsolute(target)) return "";
  const absolute = resolve(root, target);
  const rel = relative(root, absolute).replace(/\\/g, "/");
  if (!rel || rel === "." || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return "";
  return rel;
}

const GROUNDING_EXCLUDED_ROOTS = new Set([".git", ".yolo", "dist", "node_modules", "coverage", ".next", ".nuxt", "build"]);

function safeRepoFile(projectRoot: unknown, file: unknown): string {
  const rel = repoRelative(projectRoot, file).replace(/^\.\/+/, "");
  if (!rel) return "";
  if (rel.split("/").some((part) => !part || part === "." || part === "..")) return "";
  if (GROUNDING_EXCLUDED_ROOTS.has(rel.split("/")[0])) return "";
  return rel;
}

function groundingAsciiSlug(value: unknown, fallback: string = "feature"): string {
  const text = clean(value)
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (text) return text;
  return `${fallback}-${createHash("sha1").update(clean(value) || fallback).digest("hex").slice(0, 8)}`;
}

function demandText(session: Loose = Object()): string {
  const sessionRequirements = session.requirements as Loose | undefined;
  const requirements = asArray<Loose>(sessionRequirements?.active || session.requirements);
  const scenarioMatrixField = session.scenario_matrix as Loose | undefined;
  const scenarios = asArray<Loose>(scenarioMatrixField?.scenarios || session.scenarios);
  const project = session.project as Loose | undefined;
  const vision = session.vision as Loose | undefined;
  const prdIntake = session.prd_intake as Loose | undefined;
  const context = session.context as Loose | undefined;
  const discussion = session.discussion as Loose | undefined;
  return [
    project?.title,
    session.title,
    vision?.statement,
    vision?.idea,
    session.objective,
    session.idea,
    session.problem,
    prdIntake?.plain_language_problem,
    prdIntake?.desired_outcomes,
    prdIntake?.success_proof,
    prdIntake?.boundaries,
    sessionRequirements?.constraints,
    sessionRequirements?.out_of_scope,
    context?.summary,
    requirements.map((item) => [
      item.id,
      item.title,
      item.text,
      item.acceptance_criteria,
      item.acceptance_scenarios,
      item.scenarios,
    ]),
    scenarios.map((item) => [
      item.id,
      item.desired_behavior,
      item.proof,
      item.acceptance,
      item.trigger,
      item.touchpoint,
    ]),
    asArray<Loose>(session.question_trace).map((item) => [item.question, item.answer]),
    asArray<Loose>(discussion?.decisions).map((item) => item?.text || item),
  ].flat(Infinity).map(clean).filter(Boolean).join("\n");
}

function requirementRefs(session: Loose = Object()) {
  const sessionRequirements = session.requirements as Loose | undefined;
  return asArray<Loose>(sessionRequirements?.active || session.requirements)
    .map((item) => ({
      id: clean(item?.id),
      text: clean(item?.text || item?.title),
    }))
    .filter((item) => item.id || item.text);
}

function hasConfirmedRequirements(session: Loose = Object()): boolean {
  return requirementRefs(session).some((item) => item.text.length >= 10);
}

function commandNameFromText(text: unknown): string {
  const source = clean(text);
  const backticked = source.match(/`([a-z][a-z0-9-]{2,})`/i)?.[1];
  if (backticked) return groundingAsciiSlug(backticked, "app");
  const cliNamed = source.match(/\b([a-z][a-z0-9-]*(?:cli|cmd))\b/i)?.[1];
  if (cliNamed) return groundingAsciiSlug(cliNamed, "cli");
  const namedCommand = source.match(/\b(?:command|binary|tool|命令)\s+([a-z][a-z0-9-]{2,})\b/i)?.[1];
  if (namedCommand) return groundingAsciiSlug(namedCommand, "cli");
  return "";
}

function projectNameSlug(session: Loose = Object(), text: unknown = ""): string {
  const commandName = commandNameFromText(text);
  if (commandName) return commandName;
  const project = session.project as Loose | undefined;
  const vision = session.vision as Loose | undefined;
  const title = clean(project?.title || session.title || vision?.idea || session.objective || session.idea);
  const firstClause = title.split(/[:：.;。]/)[0];
  return groundingAsciiSlug(firstClause, "feature");
}

function targetKind(text: unknown = ""): string {
  const source = clean(text).toLowerCase();
  if (/\b(cli|command line|terminal|argv|commander|node\b|taskcli)\b|命令行|终端/.test(source)) return "cli";
  if (/\b(api|endpoint|route|server|controller)\b|接口|路由/.test(source)) return "api";
  if (/\b(page|screen|component|button|form|view|ui)\b|页面|界面|按钮|组件|表单/.test(source)) return "ui";
  if (/\b(database|db|repository|store|storage|json|persist|persistence)\b|数据库|持久|存储/.test(source)) return "service";
  return "code";
}

function defaultTargetForKind(kind: string, name: string): string {
  if (kind === "cli") return `src/${name}.ts`;
  if (kind === "api") return `src/api/${name}.ts`;
  if (kind === "ui") return `src/components/${name}.tsx`;
  if (kind === "service") return `src/${name}.ts`;
  return `src/${name}.ts`;
}

function explicitGroundingTargets(input: Loose = Object()): string[] {
  return uniqueStrings(input.target_files || input.targetFiles || input.targets || input.target || input.files || input.file);
}

export function inferGreenfieldTargetFiles(session: Loose = Object(), options: Loose = Object()) {
  const projectRoot = resolve(clean(options.projectRoot || options.project_root || options.cwd) || process.cwd());
  const text = demandText(session);
  const explicit = explicitGroundingTargets(options);
  const source = explicit.length > 0
    ? explicit
    : [defaultTargetForKind(targetKind(text), projectNameSlug(session, text))];
  const files = uniqueStrings(source)
    .map((file) => safeRepoFile(projectRoot, file))
    .filter(Boolean)
    .slice(0, Number(options.maxTargetFiles || options.max_target_files || 2));
  return files.map((file) => {
    const exists = existsSync(resolve(projectRoot, file));
    return {
      file,
      exists,
      status: exists ? "verified" : "planned_new_file",
      kind: targetKind(`${text}\n${file}`),
      source: explicit.length > 0 ? "explicit_target" : "demand_greenfield_inference",
    };
  });
}

function executionScopeFiles(session: Loose = Object()): string[] {
  const project = session.project as Loose | undefined;
  return uniqueStrings(project?.target_files || session.target_files);
}

function candidateFiles(session: Loose = Object()): string[] {
  const project = session.project as Loose | undefined;
  const projectFacts = session.project_facts as Loose | undefined;
  return uniqueStrings([
    ...asArray(project?.candidate_target_files),
    ...asArray(projectFacts?.candidate_target_files),
    ...asArray<Loose>(projectFacts?.target_files)
      .filter((fact) => fact?.status === "candidate")
      .map((fact) => clean(fact.file || fact.path)),
  ]);
}

function candidatePromotionBlockers(candidates: string[] = [], targets: Loose[] = []): string[] {
  const candidateSet = new Set(candidates);
  return targets
    .filter((target) => target?.exists === true && candidateSet.has(clean(target.file)))
    .map((target) => clean(target.file));
}

function plannedNewFileConflicts(projectRoot: unknown, targets: Loose[] = []): string[] {
  return targets
    .filter((target) => target?.status === "planned_new_file" && existsSync(resolve(clean(projectRoot), clean(target.file))))
    .map((target) => clean(target.file));
}

function shouldBlockCandidatePromotion(candidates: string[] = [], targets: Loose[] = [], explicit: string[] = [], projectRoot: string = process.cwd()): boolean {
  if (explicit.length > 0) return false;
  if (plannedNewFileConflicts(projectRoot, targets).length > 0) return true;
  return candidates.length > 0 && candidatePromotionBlockers(candidates, targets).length > 0;
}

function existingTargetFacts(session: Loose = Object()): string[] {
  const projectFacts = session.project_facts as Loose | undefined;
  return asArray<Loose>(projectFacts?.target_files)
    .filter((fact) => fact && typeof fact === "object")
    .map((fact) => clean(fact.file || fact.path))
    .filter(Boolean);
}

function filesForSurface(surface: Loose = Object(), files: string[] = []): string[] {
  const kind = clean(surface.kind).toLowerCase();
  const matching = files.filter((file) => {
    const fileKind = surfaceKindFromFile(file);
    return fileKind === kind || (kind === "service" && fileKind === "code") || (kind === "code" && fileKind === "service");
  });
  return matching.length ? matching : files;
}

function applyFilesToScenarios(session: Loose = Object(), files: string[] = []): void {
  const scenarioMatrixField = session.scenario_matrix as Loose | undefined;
  const scenarios = asArray<Loose>(scenarioMatrixField?.scenarios || session.scenarios);
  if (scenarios.length === 0) return;
  for (const scenario of scenarios) {
    const surfaces = asArray<Loose>(scenario.surfaces);
    if (surfaces.length === 0) {
      const kind = surfaceKindFromFile(files[0] || "");
      scenario.surfaces = [{
        id: `${clean(scenario.id) || "SCN"}-SFC-001`,
        kind,
        label: surfaceLabel(kind),
        user_visible: kind === "ui",
        target_files: files,
        readonly_files: [],
        allow_new_files: true,
        session_budget: {
          expected: "single_session",
          max_files: Math.max(1, Math.min(2, files.length || 1)),
          max_lines_per_file: 120,
        },
        grounding_source: "demand_greenfield_execution_scope",
      }];
      continue;
    }
    for (const surface of surfaces) {
      const current = uniqueStrings(surface.target_files);
      if (current.length > 0) continue;
      const scopedFiles = filesForSurface(surface, files);
      const groundedKind = surfaceKindFromFile(scopedFiles[0] || files[0] || "");
      surface.target_files = scopedFiles;
      surface.kind = groundedKind;
      surface.label = surfaceLabel(groundedKind);
      surface.user_visible = groundedKind === "ui";
      if (groundedKind !== "ui") surface.visual_style_source = [];
      surface.allow_new_files = true;
      const sessionBudget = (surface.session_budget as Loose) || {};
      surface.session_budget = {
        ...sessionBudget,
        expected: sessionBudget.expected || "single_session",
        max_files: Math.max(1, Math.min(2, scopedFiles.length || 1)),
        max_lines_per_file: Number(sessionBudget.max_lines_per_file || 120),
      };
      surface.grounding_source = "demand_greenfield_execution_scope";
    }
  }
}

function groundingReason(session: Loose = Object(), file: unknown = ""): string {
  const refs = requirementRefs(session);
  const vision = session.vision as Loose | undefined;
  const project = session.project as Loose | undefined;
  const primary = refs[0]?.text || clean(vision?.idea || session.objective || project?.title);
  return `Plan ${clean(file)} as a new execution-scope file from approved demand requirement: ${primary}`;
}

function plannedTargetFact(session: Loose = Object(), target: Loose = Object(), groundingId: unknown, generatedAt: unknown) {
  const refs = requirementRefs(session);
  return {
    file: clean(target.file),
    status: clean(target.status),
    source: target.exists ? "project_read" : clean(target.source),
    new_file: !target.exists,
    allow_new_files: !target.exists,
    grounding_id: clean(groundingId),
    grounded_at: clean(generatedAt),
    requirement_ids: refs.map((item) => item.id).filter(Boolean),
    evidence: [
      target.exists
        ? `${clean(target.file)} already exists in project root.`
        : `${clean(target.file)} does not exist yet; it is planned as a new file from approved demand scope.`,
      groundingReason(session, target.file),
    ],
    message: target.exists
      ? "Target file is verified enough to enter execution scope."
      : "Target file is grounded as a planned new file; scope.allow_new_files must be true for generated tasks.",
  };
}

export function groundDemandExecutionScope(session: Loose = Object(), options: Loose = Object()) {
  const storyNormalization = normalizeDemandStoryAtomicity(session);
  session = storyNormalization.session as Loose;
  const projectRoot = resolve(clean(options.projectRoot || options.project_root || options.cwd) || process.cwd());
  const existingScope = executionScopeFiles(session);
  const explicit = explicitGroundingTargets(options);
  const candidates = candidateFiles(session);
  const generatedAt = nowIso(options);
  const groundingId = clean(options.groundingId || options.grounding_id)
    || `GRD-${createHash("sha1").update(`${session.id || ""}\n${demandText(session)}`).digest("hex").slice(0, 10).toUpperCase()}`;

  if (existingScope.length > 0) {
    return {
      schema_version: DEMAND_GROUNDING_SCHEMA_VERSION,
      schema: DEMAND_GROUNDING_SCHEMA,
      id: groundingId,
      status: "unchanged",
      applied: false,
      reason: "execution_scope_already_present",
      generated_at: generatedAt,
      target_files: existingScope,
      story_normalization: storyNormalizationSummary(storyNormalization),
      session,
    };
  }

  if (!hasConfirmedRequirements(session)) {
    return {
      schema_version: DEMAND_GROUNDING_SCHEMA_VERSION,
      schema: DEMAND_GROUNDING_SCHEMA,
      id: groundingId,
      status: "unchanged",
      applied: false,
      reason: "requirements_not_confirmed",
      generated_at: generatedAt,
      target_files: [],
      story_normalization: storyNormalizationSummary(storyNormalization),
      session,
    };
  }

  const inferred = inferGreenfieldTargetFiles(session, { ...options, projectRoot });
  const groundedTargets = inferred.filter((item) => item.file);

  if (shouldBlockCandidatePromotion(candidates, groundedTargets, explicit, projectRoot)) {
    const blockers = uniqueStrings([
      ...candidatePromotionBlockers(candidates, groundedTargets),
      ...plannedNewFileConflicts(projectRoot, groundedTargets),
    ]);
    return {
      schema_version: DEMAND_GROUNDING_SCHEMA_VERSION,
      schema: DEMAND_GROUNDING_SCHEMA,
      id: groundingId,
      status: "blocked",
      applied: false,
      reason: "candidate_files_require_explicit_confirmation",
      generated_at: generatedAt,
      candidate_target_files: blockers,
      target_files: [] as string[],
      next_actions: blockers.map((file) => `Confirm ${file} explicitly before promoting it into execution scope.`),
      story_normalization: storyNormalizationSummary(storyNormalization),
      session,
    };
  }

  if (groundedTargets.length === 0) {
    return {
      schema_version: DEMAND_GROUNDING_SCHEMA_VERSION,
      schema: DEMAND_GROUNDING_SCHEMA,
      id: groundingId,
      status: "blocked",
      applied: false,
      reason: "unable_to_infer_execution_scope",
      generated_at: generatedAt,
      target_files: [] as string[],
      next_actions: ["Pass an explicit repo-relative target file, for example: yolo spec --demand <session.json|dir> --target src/<feature>.ts"],
      story_normalization: storyNormalizationSummary(storyNormalization),
      session,
    };
  }

  const grounded = cloneDemandObject(session);
  const groundedProjectFacts = grounded.project_facts as Loose | undefined;
  const groundedReflection = grounded.reflection as Loose | undefined;
  grounded.project = {
    ...((grounded.project as Loose) || {}),
    target_files: groundedTargets.map((item) => clean(item.file)),
    candidate_target_files: [],
  };
  const priorFacts = asArray<Loose>(groundedProjectFacts?.target_files)
    .filter((fact) => fact && typeof fact === "object")
    .filter((fact) => clean(fact.status) !== "candidate")
    .filter((fact) => !groundedTargets.some((target) => clean(target.file) === clean(fact.file || fact.path)));
  grounded.project_facts = {
    ...(groundedProjectFacts || {}),
    schema: groundedProjectFacts?.schema || "yolo.demand.project_facts.v1",
    target_files: [
      ...priorFacts,
      ...groundedTargets.map((target) => plannedTargetFact(grounded, target, groundingId, generatedAt)),
    ],
    candidate_target_files: [],
    assumptions: asArray(groundedProjectFacts?.assumptions || groundedReflection?.assumption_records),
    policy: {
      ...((groundedProjectFacts?.policy as Loose) || {}),
      inferred_files_are_execution_scope: false,
      greenfield_new_files_are_execution_scope: true,
      unverified_project_facts_block_prd: true,
      user_approval_cannot_override_fact_conflicts: true,
    },
  };
  grounded.grounding = {
    schema_version: DEMAND_GROUNDING_SCHEMA_VERSION,
    schema: DEMAND_GROUNDING_SCHEMA,
    id: groundingId,
    status: "applied",
    applied: true,
    generated_at: generatedAt,
    mode: explicit.length > 0 ? "explicit_target" : "greenfield_inferred",
    project_root: projectRoot,
    target_files: groundedTargets.map((item) => ({
      file: item.file,
      status: item.status,
      allow_new_files: !item.exists,
      reason: groundingReason(grounded, item.file),
    })),
    source_requirements: requirementRefs(grounded),
    source_text_hash: createHash("sha1").update(demandText(grounded)).digest("hex"),
    story_normalization: storyNormalizationSummary(storyNormalization) || null,
  };
  (grounded.project_facts as Loose).grounding = grounded.grounding;
  const existingFactFiles = new Set(existingTargetFacts(grounded));
  for (const target of groundedTargets) existingFactFiles.add(clean(target.file));
  applyFilesToScenarios(grounded, groundedTargets.map((item) => clean(item.file)));

  return {
    ...((grounded.grounding as Loose) || {}),
    reason: "greenfield_execution_scope_grounded",
    directories: [...new Set(groundedTargets.map((item) => dirname(clean(item.file))).filter(Boolean))],
    fact_files: [...existingFactFiles],
    session: grounded,
  };
}

function projectFactIdentifiers(text: unknown = ""): string[] {
  const source = clean(text);
  const camelOrSnake = source.match(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:Threshold|Quantity|Qty|Units|Available|Stock|Floor|Replenishment)[A-Za-z0-9_$]*\b|[a-z]+_[a-z0-9_]*(?:threshold|quantity|qty|units|available|stock|floor|replenishment)[a-z0-9_]*/g) || [];
  const dotted = source.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\[\]\.[A-Za-z_$][A-Za-z0-9_$]*|\b[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$]*/g) || [];
  const simple = source.match(/\b(threshold|quantity|qty|stock|floor|replenishment)\b/gi) || [];
  return uniqueStrings([...camelOrSnake, ...dotted.flatMap((item) => item.split(".")).filter((part) => !part.endsWith("[]")), ...simple]);
}

function assumptionRecords({ assumptions = [], evidence = [], targetFacts = [], projectRoot = "" } = Object() as { assumptions?: unknown[]; evidence?: unknown[]; targetFacts?: TargetFileFact[]; projectRoot?: unknown }) {
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
  input = Object() as Loose,
  objective = "",
  problem = "",
  targetUsers = [] as string[],
  statusQuo = [] as string[],
  successCriteria = [] as string[],
  constraints = [] as string[],
  nonGoals = [] as string[],
  evidence = [] as string[],
  assumptions = [] as string[],
  targetFiles = [] as string[],
  candidateTargetFiles = [] as string[],
  visualStyleSource = [] as string[],
} = Object() as { input?: Loose; objective?: string; problem?: string; targetUsers?: string[]; statusQuo?: string[]; successCriteria?: string[]; constraints?: string[]; nonGoals?: string[]; evidence?: string[]; assumptions?: string[]; targetFiles?: string[]; candidateTargetFiles?: string[]; visualStyleSource?: string[] }) {
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

function readObjectField(source: unknown, keys: string[] = []): unknown {
  if (!isPlainObject(source)) return undefined;
  const s = source as Loose;
  for (const key of keys) {
    if (s[key] != null) return s[key];
  }
  return undefined;
}

function questionId(value: unknown, index: number): string {
  const id = clean(value)
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return id || `Q${index + 1}`;
}

function questionTraceIds(value: unknown): string[] {
  return [...new Set(asArray<Loose>(value)
    .map((item) => {
      if (isPlainObject(item)) return clean(item.id || item.question_id || item.questionId);
      return clean(item);
    })
    .filter(Boolean))];
}

function traceEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) {
    return Object.entries(value as Loose).map(([key, item]) => (
      isPlainObject(item)
        ? Object.assign(Object() as Loose, { id: key }, item as Loose)
        : { id: key, question: key, answer: item }
    ));
  }
  return clean(value) ? [value] : [];
}

function normalizeTraceItem(item: unknown, index: number, input: Loose = Object(), source: unknown = "interview") {
  const fallbackQuestion = asArray(input.questions || input.question)[index];
  if (isPlainObject(item)) {
    const i = item as Loose;
    const answerValue = i.answer ?? i.response ?? i.value ?? i.result ?? i.content;
    const answer = Array.isArray(answerValue) ? arrayOfStrings(answerValue).join("; ") : clean(answerValue);
    const question = clean(i.question || i.prompt || i.label || i.text || fallbackQuestion);
    const reason = clean(i.reason || i.why || i.intent);
    if (!question && !answer && !reason) return null;
    return {
      id: questionId(i.id || i.question_id || i.questionId || i.key, index),
      question,
      answer,
      source: clean(i.source || source),
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

function normalizeInterviewContext(input: Loose = Object()) {
  const interview = input.interview;
  const interviewObject = isPlainObject(interview) ? interview as Loose : {};
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

function buildPrdIntake({ nontechnicalIntake = Object() as Loose, interviewContext = Object() as Loose } = Object() as { nontechnicalIntake?: Loose; interviewContext?: Loose }) {
  const raw = interviewContext.prd_intake_source;
  const rawObject = isPlainObject(raw) ? raw as Loose : {};
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

function groupFilesBySurface(files: unknown[] = []): Loose[] {
  const groups = new Map<string, string[]>();
  for (const file of uniqueStrings(files)) {
    const kind = surfaceKindFromFile(file);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind)!.push(file);
  }
  return [...groups.entries()].map(([kind, targetFiles], index) => ({
    id: `SFC-${String(index + 1).padStart(3, "0")}`,
    kind,
    label: surfaceLabel(kind),
    user_visible: kind === "ui",
    target_files: targetFiles,
    readonly_files: [] as string[],
    session_budget: {
      expected: "single_session",
      max_files: Math.max(1, Math.min(2, targetFiles.length || 1)),
      max_lines_per_file: 120,
    },
  }));
}

function buildScenarioMatrix({
  input = Object() as Loose,
  objective = "",
  requirements = [] as Loose[],
  targetUsers = [] as string[],
  statusQuo = [] as string[],
  constraints = [] as string[],
  nonGoals = [] as string[],
  targetFiles = [] as string[],
  visualStyleSource = [] as string[],
  questionTrace = [] as unknown[],
} = Object() as { input?: Loose; objective?: string; requirements?: Loose[]; targetUsers?: string[]; statusQuo?: string[]; constraints?: string[]; nonGoals?: string[]; targetFiles?: string[]; visualStyleSource?: string[]; questionTrace?: unknown[] }) {
  const touchpoints = mergeField(input, "touchpoints", LABELS.touchpoint, objective);
  const triggers = mergeField(input, "triggers", LABELS.trigger, objective);
  const exceptions = mergeField(input, "exceptions", LABELS.exception, objective);
  const proof = mergeField(input, "proof", LABELS.proof, objective);
  const actor = targetUsers[0] || "target user";
  const sourceQuestionIds = questionTraceIds(questionTrace);
  const baseSurfaces = groupFilesBySurface(targetFiles);
  const inferredKinds = inferSurfaceKinds(`${objective}\n${requirements.map((item) => clean(item.text)).join("\n")}`, targetFiles);
  const fallbackSurfaces = inferredKinds.map((kind, index) => ({
    id: `SFC-${String(index + 1).padStart(3, "0")}`,
    kind,
    label: surfaceLabel(kind),
    user_visible: kind === "ui",
    target_files: [] as string[],
    readonly_files: [] as string[],
    session_budget: {
      expected: "single_session",
      max_files: 1,
      max_lines_per_file: 120,
    },
  }));
  const surfaces = baseSurfaces.length ? baseSurfaces : fallbackSurfaces;
  const scenarios = requirements.map((requirement, index) => {
    const requirementScenarios = asArray<Loose>(requirement.acceptance_scenarios || requirement.scenarios);
    const firstScenario: Loose = requirementScenarios[0] || {};
    const storyAtomicity = requirement.story_atomicity as Loose | undefined;
    const scenarioProof = storyAtomicity?.split
      ? clean(requirement.text)
      : proof[index] || proof[0] || clean(firstScenario.then || firstScenario.text) || clean(requirement.text);
    return {
      id: `SCN-${String(index + 1).padStart(3, "0")}`,
      requirement_id: requirement.id,
      actor,
      touchpoint: touchpoints[index] || touchpoints[0] || "primary user workflow",
      trigger: clean(firstScenario.when) || triggers[index] || triggers[0] || "the user reaches this scenario",
      current_behavior: statusQuo[index] || statusQuo[0] || "Captured in demand context.",
      desired_behavior: clean(requirement.text),
      proof: scenarioProof,
      out_of_scope: nonGoals,
      constraints,
      exceptions,
      surfaces: surfaces.map((surface, surfaceIndex) => ({
        ...surface,
        id: `SCN-${String(index + 1).padStart(3, "0")}-${clean(surface.id) || `SFC-${surfaceIndex + 1}`}`,
        proof: scenarioProof,
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

function mergeField(input: Loose, key: string, labels: string[], text: unknown): string[] {
  const explicit = input[key] ?? input[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
  const extracted = extractLabel(text, labels);
  return splitList([...arrayOfStrings(explicit), extracted]);
}

function firstField(input: Loose, keys: string[], text: unknown, labels: string[]): string {
  for (const key of keys) {
    const value = clean(input[key]);
    if (value) return value;
  }
  return clean(extractLabel(text, labels));
}

function requirementRecord(text: unknown, index: number, input: Loose = Object()) {
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

function normalizeStoryText(value: unknown): string {
  return clean(value)
    .replace(/\s+/g, " ")
    .replace(/^[,，;；\s]+|[,，;；\s]+$/g, "");
}

function splitRepeatedUserStories(text: unknown): string[] {
  const source = clean(text);
  const matches = [...source.matchAll(/当用户/g)];
  if (matches.length <= 1) return [];
  const parts = matches.map((match, index) => {
    const start = match.index || 0;
    const end = index + 1 < matches.length ? matches[index + 1].index! : source.length;
    return normalizeStoryText(source.slice(start, end));
  }).filter((part) => part.length >= 8);
  return parts.length > 1 ? parts : [];
}

function storySlicesForRequirement(text: unknown): string[] {
  const source = clean(text);
  const repeated = splitRepeatedUserStories(source);
  if (repeated.length > 1) return repeated.flatMap(storySlicesForRequirement);
  const generic = splitGenericStorySlices(source).map(normalizeStoryText).filter(Boolean);
  if (generic.length > 1) return generic.flatMap(storySlicesForRequirement);
  return [source].filter(Boolean);
}

function concreteStoryText(story: unknown): string {
  const text = normalizeStoryText(story);
  return text.length >= 10 ? text : `Requirement outcome: ${text}`;
}

function expandRequirementStories(requirements: Loose[] = []): Loose[] {
  const expanded: Loose[] = [];
  for (const requirement of requirements) {
    const stories = storySlicesForRequirement(requirement.text);
    if (stories.length <= 1) {
      expanded.push(requirement);
      continue;
    }
    stories.forEach((story, storyIndex) => {
      const storyText = concreteStoryText(story);
      const id = `${clean(requirement.id)}-S${String(storyIndex + 1).padStart(2, "0")}`;
      expanded.push({
        ...requirement,
        id,
        text: storyText,
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
        acceptance_scenarios: asArray<Loose>(requirement.acceptance_scenarios || requirement.scenarios).map((scenario, scenarioIndex) => ({
          ...scenario,
          id: `SCN-${String(expanded.length + 1).padStart(3, "0")}-${String(scenarioIndex + 1).padStart(2, "0")}`,
          then: storyText,
          text: storyText,
        })),
      });
    });
  }
  return expanded;
}

function scenarioForRequirement(sourceScenarios: Loose[] = [], originalRequirements: Loose[] = [], requirement: Loose = Object() as Loose, index: number = 0): Loose {
  const sourceId = clean(requirement.source_requirement_id || requirement.id);
  const originalIndex = originalRequirements.findIndex((item) => clean(item.id) === sourceId);
  return sourceScenarios.find((scenario) => clean(scenario.requirement_id) === sourceId)
    || sourceScenarios[originalIndex >= 0 ? originalIndex : index]
    || {};
}

function atomicScenarioSurfaces(sourceScenario: Loose = Object() as Loose, scenarioId: string = "", proof: string = "", session: Loose = Object()): Loose[] {
  const sourceSurfaces = asArray<Loose>(sourceScenario.surfaces);
  const project = session.project as Loose | undefined;
  const fallbackFiles = uniqueStrings(project?.target_files || session.target_files);
  const surfaces: Loose[] = sourceSurfaces.length > 0
    ? sourceSurfaces
    : fallbackFiles.length > 0
      ? [{
        kind: surfaceKindFromFile(fallbackFiles[0]),
        target_files: fallbackFiles,
        readonly_files: [] as string[],
        session_budget: {
          expected: "single_session",
          max_files: Math.max(1, Math.min(2, fallbackFiles.length || 1)),
          max_lines_per_file: 120,
        },
      }]
      : [];
  return surfaces.map((surface, surfaceIndex) => {
    const surfaceTargetFiles = asArray(surface.target_files);
    const kind = clean(surface.kind) || surfaceKindFromFile(clean(surfaceTargetFiles[0]) || "");
    return {
      ...surface,
      id: `${scenarioId}-SFC-${String(surfaceIndex + 1).padStart(3, "0")}`,
      kind,
      label: clean(surface.label) || surfaceLabel(kind),
      proof,
    };
  });
}

function rebuildAtomicScenarioMatrix(session: Loose = Object(), originalRequirements: Loose[] = [], expandedRequirements: Loose[] = []) {
  const matrix = (session.scenario_matrix as Loose) || {};
  const sourceScenarios = asArray<Loose>(matrix.scenarios || session.scenarios);
  const scenarios = expandedRequirements.map((requirement, index) => {
    const sourceScenario = scenarioForRequirement(sourceScenarios, originalRequirements, requirement, index);
    const scenarioId = `SCN-${String(index + 1).padStart(3, "0")}`;
    const proof = clean(requirement.text);
    return {
      ...sourceScenario,
      id: scenarioId,
      requirement_id: requirement.id,
      desired_behavior: clean(requirement.text),
      proof,
      surfaces: atomicScenarioSurfaces(sourceScenario, scenarioId, proof, session),
      story_atomicity: requirement.story_atomicity || (sourceScenario as Loose).story_atomicity || null,
    };
  });
  return {
    ...matrix,
    schema: matrix.schema || "yolo.demand.scenario_matrix.v1",
    generated_from: matrix.generated_from || "story_atomicity_normalization",
    nontechnical_user_safe: matrix.nontechnical_user_safe !== false,
    scenarios,
    atomic_task_rule: matrix.atomic_task_rule || "one user-visible story with one proof becomes one task; file and surface budgets only bound implementation scope",
  };
}

function normalizeDemandStoryAtomicity(session: Loose = Object()) {
  const sessionRequirements = session.requirements as Loose | undefined;
  const originalRequirements = cloneDemandObject(asArray<Loose>(sessionRequirements?.active || session.requirements));
  if (originalRequirements.length === 0) return { session, changed: false, split_count: 0 };
  const expandedRequirements = expandRequirementStories(originalRequirements);
  const changed = expandedRequirements.length !== originalRequirements.length
    || expandedRequirements.some((requirement, index) => clean(requirement.id) !== clean(originalRequirements[index]?.id));
  if (!changed) return { session, changed: false, split_count: 0 };
  const normalized = cloneDemandObject(session);
  if (Array.isArray(normalized.requirements)) {
    normalized.requirements = expandedRequirements;
  } else {
    normalized.requirements = {
      ...((normalized.requirements as Loose) || {}),
      active: expandedRequirements,
    };
  }
  normalized.scenario_matrix = rebuildAtomicScenarioMatrix(normalized, originalRequirements, expandedRequirements);
  normalized.story_atomicity = {
    schema: "yolo.demand.story_atomicity_normalization.v1",
    status: "applied",
    source_requirement_count: originalRequirements.length,
    normalized_requirement_count: expandedRequirements.length,
    split_count: expandedRequirements.length - originalRequirements.length,
  };
  return {
    session: normalized,
    changed: true,
    split_count: expandedRequirements.length - originalRequirements.length,
  };
}

function storyNormalizationSummary(storyNormalization: Loose = Object()) {
  return storyNormalization.changed ? {
    status: "applied",
    split_count: storyNormalization.split_count,
  } : undefined;
}

function buildRounds(input: Loose = Object(), questionTrace: unknown[] = []): Loose[] {
  const rounds = asArray<Loose>(input.rounds || input.discussion_rounds || input.questions || input.question).filter(Boolean);
  if (rounds.length > 0) {
    return rounds.map((item, index) => {
      if (typeof item === "object") return { id: clean(item.id) || `Q${index + 1}`, ...item };
      return { id: `Q${index + 1}`, question: clean(item), answer: clean(asArray(input.answers || input.answer)[index]) };
    });
  }
  if (asArray(questionTrace).length > 0) {
    return asArray<Loose>(questionTrace).map((item, index) => ({
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

function hasImplementationDetailSignal(text: unknown = ""): boolean {
  return /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b/.test(clean(text))
    || /\b[A-Za-z_$][A-Za-z0-9_$]*(?:Threshold|Quantity|Qty|Stock|Badge)[A-Za-z0-9_$]*\b/.test(clean(text))
    || /(<=|>=|<|>|less than|greater than|at or below|at or above)/i.test(clean(text));
}

function shouldPreserveDottedIdentifier(source: string = "", match: string = "", offset: number = 0): boolean {
  const before = source[offset - 1] || "";
  const after = source[offset + match.length] || "";
  if (before === "/" || before === "\\" || after === "/" || after === "\\") return true;
  return /\.(?:[cm]?[jt]sx?|json|md|mdx|css|scss|sass|html|ya?ml|toml|txt)$/i.test(match);
}

function executionSafeDecisionText(text: unknown = ""): string {
  const source = clean(text);
  if (!hasImplementationDetailSignal(source)) return source;
  return normalizeStoryText(source
    .replace(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+\b/g, (match, offset) =>
      shouldPreserveDottedIdentifier(source, match, offset) ? match : "the approved field")
    .replace(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:Threshold|Quantity|Qty|Stock|Badge)[A-Za-z0-9_$]*\b/g, "the approved field")
    .replace(/\b(?:less than or equal|greater than or equal|less than|greater than|at or below|at or above)\b/gi, "the approved comparison")
    .replace(/\s*(?:<=|>=|<|>)\s*/g, " the approved comparison "));
}

function implementationDecisionEvidence(decisions: unknown[] = []): string[] {
  return uniqueStrings(decisions)
    .filter(hasImplementationDetailSignal)
    .map((decision) => `Approved implementation detail from decision: ${clean(decision)}`);
}

function truthyConfirmation(value: unknown): boolean {
  if (value === true) return true;
  const text = clean(value).toLowerCase();
  return ["true", "yes", "approved", "confirm", "confirmed", "ok", "确认", "批准", "同意"].includes(text);
}

function deferredScopeConfirmation(input: Loose = Object(), deferredItems: unknown[] = [], now: unknown = "") {
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

function completedArtifacts(session: Loose = Object()): DemandArtifactId[] {
  const completed: DemandArtifactId[] = [];
  const vision = session.vision as Loose | undefined;
  const reflection = session.reflection as Loose | undefined;
  const investigation = session.investigation as Loose | undefined;
  const discussion = session.discussion as Loose | undefined;
  const requirements = session.requirements as Loose | undefined;
  const context = session.context as Loose | undefined;
  const roadmap = session.roadmap as Loose | undefined;
  const approval = session.approval as Loose | undefined;
  if (clean(vision?.statement || vision?.idea).length >= 10) completed.push("vision");
  if ((reflection?.assumptions as unknown[])?.length || (reflection?.alternatives as unknown[])?.length || clean(reflection?.summary)) completed.push("reflection");
  if ((investigation?.evidence as unknown[])?.length || (reflection?.assumptions as unknown[])?.length) completed.push("investigation");
  if ((discussion?.rounds as unknown[])?.length || (discussion?.decisions as unknown[])?.length) completed.push("questioning_rounds");
  if (session.readiness) completed.push("depth_verification");
  if ((requirements?.active as unknown[])?.length) completed.push("requirements_confirmation");
  if (context?.summary || (context?.domain_terms as unknown[])?.length) completed.push("context");
  if ((roadmap?.mvp as unknown[])?.length || (roadmap?.phases as unknown[])?.length) completed.push("roadmap");
  if (approval?.approved) completed.push("approval");
  return completed;
}

export function buildDemandSession(input: Loose = Object(), options: Loose = Object()): Loose {
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
  const rawDecisions = uniqueStrings(input.decisions || input.decision);
  const decisions = rawDecisions.map(executionSafeDecisionText);
  const evidenceWithDecisionDetails = uniqueStrings([...evidence, ...implementationDecisionEvidence(rawDecisions)]);
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
    evidence: evidenceWithDecisionDetails,
    verifiedFiles: (input.verified_target_files || input.verifiedTargetFiles) as unknown[],
  });
  const targetFiles = targetFilesFromFacts(targetFileFactRecords);
  const candidateTargetFiles = candidateFilesFromFacts(targetFileFactRecords);
  const assumptionFactRecords = assumptionRecords({
    assumptions,
    evidence: evidenceWithDecisionDetails,
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
    .map((text, index) => requirementRecord(text, index, { ...input, evidence: evidenceWithDecisionDetails, decisions, questionTrace }));
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
    evidence: evidenceWithDecisionDetails,
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
      evidence: evidenceWithDecisionDetails.map((text, index) => ({ id: `EVID-${String(index + 1).padStart(3, "0")}`, text })),
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
  const sessionApproval = session.approval as Loose;
  sessionApproval.effective_for_prd = sessionApproval.approved === true && session.readiness.executable_prd_ready === true;
  sessionApproval.blocked_by = sessionApproval.approved === true && !sessionApproval.effective_for_prd
    ? asArray<Loose>(session.readiness.blockers).map((blocker) => ({
      code: blocker.code,
      message: blocker.message,
    }))
    : [];
  session.graph = buildDemandArtifactGraph(completedArtifacts(session));
  return session;
}

function linesList(values: unknown, fallback: string = "- TBD"): string {
  const lines = arrayOfStrings(values);
  return lines.length ? lines.map((item) => `- ${item}`).join("\n") : fallback;
}

function scenarioLines(requirement: Loose): string {
  const scenarios = asArray<Loose>(requirement.acceptance_scenarios || requirement.scenarios);
  if (scenarios.length === 0) return "- TBD";
  return scenarios.map((scenario) => [
    `#### Scenario: ${clean(scenario.id) || "Acceptance"}`,
    `- **WHEN** ${clean(scenario.when || "the user exercises this requirement")}`,
    `- **THEN** ${clean(scenario.then || scenario.text || requirement.text)}`,
  ].join("\n")).join("\n\n");
}

export function demandMarkdownArtifacts(session: Loose = Object()) {
  const sessionRequirements = session.requirements as Loose | undefined;
  const discussion = session.discussion as Loose | undefined;
  const reqs = asArray<Loose>(sessionRequirements?.active);
  const decisions = asArray<Loose>(discussion?.decisions).map((item) => clean(item.text) || item);
  const rounds = asArray<Loose>(discussion?.rounds);
  const project = session.project as Loose | undefined;
  const vision = session.vision as Loose | undefined;
  const reflection = session.reflection as Loose | undefined;
  const investigation = session.investigation as Loose | undefined;
  const context = session.context as Loose | undefined;
  const roadmap = session.roadmap as Loose | undefined;
  return {
    "VISION.md": [
      `# ${clean(project?.title) || clean(session.id)} Vision`,
      "",
      "## Vision",
      vision?.statement || "TBD",
      "",
      "## Problem",
      vision?.problem || "TBD",
      "",
      "## Target Users",
      linesList(vision?.target_users),
      "",
      "## Status Quo",
      linesList(vision?.status_quo),
      "",
      "## Narrow Wedge",
      vision?.narrow_wedge || "TBD",
    ].join("\n"),
    "REFLECTION.md": [
      `# ${clean(session.id)} Reflection`,
      "",
      "## Premise Challenge",
      linesList(reflection?.premise_challenges),
      "",
      "## Assumptions",
      linesList(reflection?.assumptions),
      "",
      "## Alternatives",
      linesList(reflection?.alternatives),
    ].join("\n"),
    "INVESTIGATION.md": [
      `# ${clean(session.id)} Investigation`,
      "",
      "## Evidence",
      linesList(asArray<Loose>(investigation?.evidence).map((item) => `${clean(item.id)}: ${clean(item.text)}`)),
      "",
      "## Assumptions / TBD",
      linesList(asArray<Loose>(investigation?.assumptions).map((item) => `${clean(item.id)} [${clean(item.status) || "unknown"}]: ${clean(item.text)}${asArray(item.contradicted_by).length ? ` (contradicted by: ${asArray(item.contradicted_by).join(", ")})` : ""}`)),
      "",
      "## Codebase Scouts",
      linesList(asArray<Loose>(investigation?.codebase_scouts).map((item) => `${clean(item.file)} [${clean(item.status) || "unknown"}] ${clean(item.reason) || ""}`)),
      "",
      "## Evidence Requirements",
      linesList(asArray<Loose>(session.evidence_requirements).map((item) => `${clean(item.id)} [${clean(item.status)}] ${clean(item.kind)}: ${clean(item.topic)} - ${clean(item.reason)}`)),
      "",
      "## Risks",
      linesList(investigation?.risks),
    ].join("\n"),
    "SCENARIO_MATRIX.md": [
      `# ${clean(session.id)} Scenario Matrix`,
      "",
      "This artifact translates non-technical answers into engineering-facing slices.",
      "",
      "## Scenarios",
      asArray<Loose>((session.scenario_matrix as Loose)?.scenarios).length
        ? asArray<Loose>((session.scenario_matrix as Loose).scenarios).map((scenario) => [
          `### ${clean(scenario.id)}: ${clean(scenario.desired_behavior)}`,
          `- Actor: ${clean(scenario.actor)}`,
          `- Touchpoint: ${clean(scenario.touchpoint)}`,
          `- Trigger: ${clean(scenario.trigger)}`,
          `- Current: ${clean(scenario.current_behavior)}`,
          `- Desired: ${clean(scenario.desired_behavior)}`,
          `- Proof: ${clean(scenario.proof)}`,
          `- Out of scope: ${arrayOfStrings(scenario.out_of_scope).join("; ") || "TBD"}`,
          "",
          "#### Surfaces",
          asArray<Loose>(scenario.surfaces).map((surface) => {
            const sessionBudget = surface.session_budget as Loose | undefined;
            return [
              `- ${clean(surface.id)}: ${clean(surface.label)} (${clean(surface.kind)})`,
              `  - targets: ${arrayOfStrings(surface.target_files).join(", ") || "TBD from code scout"}`,
              `  - visual style: ${arrayOfStrings(surface.visual_style_source).join("; ") || "TBD"}`,
              `  - budget: ${sessionBudget?.expected || "single_session"}, max_files=${sessionBudget?.max_files || 1}`,
            ].join("\n");
          }).join("\n"),
        ].join("\n")).join("\n\n")
        : "- TBD",
      "",
      "## Atomic Task Rule",
      (session.scenario_matrix as Loose)?.atomic_task_rule || "TBD",
    ].join("\n"),
    "DISCUSSION-LOG.md": [
      `# ${clean(session.id)} Discussion Log`,
      "",
      "## Questioning Rounds",
      rounds.length ? rounds.map((round) => [
        `### ${clean(round.id)}`,
        `- Question: ${clean(round.question) || "TBD"}`,
        `- Answer: ${clean(round.answer) || "TBD"}`,
      ].join("\n")).join("\n\n") : "- TBD",
      "",
      "## Decisions",
      linesList(decisions),
      "",
      "## Open Questions",
      linesList(asArray<Loose>(discussion?.open_questions).map((item) => clean(item.text) || item)),
      "",
      "## Deferred",
      linesList(discussion?.deferred),
    ].join("\n"),
    "REQUIREMENTS.md": [
      `# ${clean(session.id)} Requirements`,
      "",
      "## Requirements",
      reqs.length ? reqs.map((requirement) => [
        `### Requirement: ${clean(requirement.id)}`,
        `${clean(requirement.text)}`,
        "",
        scenarioLines(requirement),
      ].join("\n")).join("\n\n") : "- TBD",
      "",
      "## Constraints",
      linesList(sessionRequirements?.constraints),
      "",
      "## Out of Scope",
      linesList(sessionRequirements?.out_of_scope),
    ].join("\n"),
    "CONTEXT.md": [
      `# ${clean(session.id)} Context`,
      "",
      "## Summary",
      context?.summary || "TBD",
      "",
      "## Domain Terms",
      linesList(context?.domain_terms),
      "",
      "## Current State",
      linesList(context?.current_state),
      "",
      "## Decisions",
      linesList(decisions),
      "",
      "## Constraints",
      linesList(context?.constraints),
      "",
      "## Visual Style Source",
      linesList(context?.visual_style_source),
      "",
      "## Verified Target Files",
      linesList(asArray<Loose>((session.project_facts as Loose)?.target_files).filter((item) => clean(item.status) === "verified").map((item) => clean(item.file))),
      "",
      "## Candidate Target Files",
      linesList((session.project_facts as Loose)?.candidate_target_files),
    ].join("\n"),
    "ROADMAP.md": [
      `# ${clean(session.id)} Roadmap`,
      "",
      "## MVP",
      linesList(roadmap?.mvp),
      "",
      "## Phases",
      asArray<Loose>(roadmap?.phases).length
        ? asArray<Loose>(roadmap?.phases).map((phase) => `- ${clean(phase.id)}: ${clean(phase.text)}`).join("\n")
        : "- TBD",
      "",
      "## Later",
      linesList(roadmap?.later),
    ].join("\n"),
  };
}
