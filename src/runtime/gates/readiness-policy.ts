export function clean(value) {
  return String(value ?? "").trim();
}

export function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === "") return [];
  return [value];
}

export function normalizeFile(value) {
  return clean(value).replace(/\\/g, "/").replace(/^\.\//, "").replace(/:\d+(?:-\d+)?$/, "");
}

export function taskFiles(task = Object()) {
  return [
    ...asArray(task.scope?.targets).map((target) => normalizeFile(target.file || target.path || target)),
    ...asArray(task.files).map(normalizeFile),
  ].filter(Boolean);
}

export function isPureConfigTarget(file) {
  const normalized = normalizeFile(file);
  return (
    normalized === "package.json"
    || normalized === "package-lock.json"
    || normalized === "pnpm-lock.yaml"
    || normalized === "yarn.lock"
    || normalized === "bun.lockb"
    || normalized === "tsconfig.json"
    || normalized === "tsconfig.build.json"
    || normalized === "jsconfig.json"
    || normalized === ".npmrc"
    || normalized === ".yolo/config.json"
    || /(^|\/)(eslint|prettier|vitest|vite|jest|tsup|rollup|webpack|babel|postcss|tailwind)\.config\.[cm]?[jt]s$/.test(normalized)
  );
}

export function taskTargetFiles(task = Object()) {
  return taskFiles(task);
}

export function isPureConfigTask(task = Object()) {
  const files = taskTargetFiles(task);
  return files.length > 0 && files.every(isPureConfigTarget);
}

export function atomicityExemptionReason(task = Object()) {
  if (clean(task.task_kind) === "greenfield_scaffold") return "greenfield_scaffold";
  if (isPureConfigTask(task)) return "pure_config";
  return "";
}

export function isAtomicityExempt(task = Object()) {
  return Boolean(atomicityExemptionReason(task));
}

export function taskText(task = Object()) {
  return [
    task.id,
    task.title,
    task.description,
    task.type,
    task.task_kind,
    task.surface,
    task.ui_surface,
    JSON.stringify(task.acceptance_criteria || ""),
  ].filter(Boolean).join(" ").toLowerCase();
}

function fileLooksUi(file) {
  return /\.(tsx|jsx|vue|svelte)$/.test(file) || /(^|\/)(pages|components|screens)\//.test(file);
}

function textLooksUi(value) {
  const text = clean(value).toLowerCase();
  return Boolean(text)
    && (fileLooksUi(text)
      || /\b(ui|page|screen|component|visual|browser|frontend)\b/.test(text)
      || /页面|组件|界面|前端/.test(text));
}

function hasHardUiSignal(task = Object()) {
  if (task.ui_surface || task.ui?.surface) return true;
  return taskFiles(task).some(fileLooksUi) || textLooksUi(task.surface);
}

function manifestSignals(manifest = Object()) {
  return new Set([
    ...asArray(manifest.applies_to),
    ...asArray(manifest.capabilities),
    ...asArray(manifest.evidence),
  ].map((value) => clean(value).toLowerCase()).filter(Boolean));
}

function resolverAcceptanceAdapter(resolver = Object()) {
  const adapter = resolver?.selected?.acceptance_adapter;
  return adapter?.id && adapter.id !== "unknown/custom" ? adapter : null;
}

export function isUiTask(task = Object(), context = Object()) {
  const files = taskFiles(task);
  if (hasHardUiSignal(task)) return true;
  if (task.ui === false || task.interface === false) return false;
  if (task.ui === true || task.interface === "ui") return true;

  const adapterSignals = manifestSignals(context.acceptanceManifest || resolverAcceptanceAdapter(context.resolver) || {});
  if (adapterSignals.has("ui") || adapterSignals.has("frontend") || adapterSignals.has("browser") || adapterSignals.has("screenshot")) {
    const text = taskText(task);
    if (/\b(page|screen|component|visual|browser|frontend|ui)\b/.test(text) || /页面|组件|界面|前端/.test(text)) return true;
  }

  const text = taskText(task);
  return files.some(fileLooksUi)
    || /\b(ui|page|screen|component|visual|browser|frontend)\b/.test(text)
    || /页面|组件|界面|前端/.test(text);
}

export function uiTasks(prd = Object(), context = Object()) {
  const source = prd || {};
  return asArray(source.tasks).filter((task) => isUiTask(task, context));
}

export function hasTaskAcceptance(task = Object()) {
  return asArray(task.acceptance_criteria).length > 0
    || Boolean(clean(task.acceptance))
    || Boolean(clean(task.success_criteria))
    || asArray(task.post_conditions).length > 0;
}

export function uiSurface(task = Object()) {
  return clean(task.surface || task.ui?.surface || task.ui_surface)
    || taskFiles(task).find((file) => file.includes("/pages/") || file.includes("/screens/") || file.includes("/components/"))
    || "";
}

export function hasStateMatrix(task = Object(), prd = Object(), manifest = Object()) {
  return Boolean(task.state_matrix || task.handoff?.state_matrix || task.ui?.state_matrix || prd.state_matrix || prd.ui_state_matrix || manifest.state_matrix || manifest.ui_state_matrix);
}

export function hasEvidencePlan(task = Object(), prd = Object(), manifest = Object()) {
  const evidenceTypes = new Set(["screenshot_exists", "playwright_check", "visual_regression", "ui_state_assertion", "runtime_log_absent"]);
  return Boolean(task.evidence_plan || task.ui_evidence_plan || task.handoff?.evidence_plan || task.ui?.evidence_plan || prd.evidence_plan || manifest.evidence_plan)
    || asArray(task.post_conditions).some((condition) => evidenceTypes.has(condition.type));
}

export function selectedAcceptanceAdapter(resolver = Object()) {
  return resolverAcceptanceAdapter(resolver);
}

export function hasAcceptanceAdapter({ options = Object(), manifest = Object(), resolver = Object() } = Object()) {
  return Boolean(
    selectedAcceptanceAdapter(resolver) ||
    options.acceptanceAdapter ||
    options.acceptance_adapter ||
    options.adapterManifest ||
    options.adapter_manifest ||
    manifest.adapter ||
    manifest.adapter_manifest ||
    manifest.acceptance_adapter,
  );
}

export function summarizeTaskSurfaces(prd = Object(), context = Object()) {
  const source = prd || {};
  const tasks = asArray(source.tasks);
  const ui = tasks.filter((task) => isUiTask(task, context));
  return {
    task_count: tasks.length,
    ui_task_count: ui.length,
    ui_task_ids: ui.map((task) => task.id || null).filter(Boolean),
  };
}
