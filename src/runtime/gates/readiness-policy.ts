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

export function taskFiles(task = {}) {
  return [
    ...asArray(task.scope?.targets).map((target) => normalizeFile(target.file || target.path || target)),
    ...asArray(task.files).map(normalizeFile),
  ].filter(Boolean);
}

export function taskText(task = {}) {
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

function manifestSignals(manifest = {}) {
  return new Set([
    ...asArray(manifest.applies_to),
    ...asArray(manifest.capabilities),
    ...asArray(manifest.evidence),
  ].map((value) => clean(value).toLowerCase()).filter(Boolean));
}

function resolverAcceptanceAdapter(resolver = {}) {
  const adapter = resolver?.selected?.acceptance_adapter;
  return adapter?.id && adapter.id !== "unknown/custom" ? adapter : null;
}

export function isUiTask(task = {}, context = {}) {
  if (task.ui === false || task.interface === false) return false;
  if (task.ui === true || task.interface === "ui" || task.surface || task.ui_surface || task.ui?.surface) return true;

  const adapterSignals = manifestSignals(context.acceptanceManifest || resolverAcceptanceAdapter(context.resolver) || {});
  if (adapterSignals.has("ui") || adapterSignals.has("frontend") || adapterSignals.has("browser") || adapterSignals.has("screenshot")) {
    const text = taskText(task);
    if (/\b(page|screen|component|visual|browser|frontend|ui)\b/.test(text) || /页面|组件|界面|前端/.test(text)) return true;
  }

  const files = taskFiles(task);
  const text = taskText(task);
  return files.some((file) => /\.(tsx|jsx|vue|svelte)$/.test(file) || file.includes("/pages/") || file.includes("/components/") || file.includes("/screens/"))
    || /\b(ui|page|screen|component|visual|browser|frontend)\b/.test(text)
    || /页面|组件|界面|前端/.test(text);
}

export function uiTasks(prd = {}, context = {}) {
  const source = prd || {};
  return asArray(source.tasks).filter((task) => isUiTask(task, context));
}

export function hasTaskAcceptance(task = {}) {
  return asArray(task.acceptance_criteria).length > 0
    || Boolean(clean(task.acceptance))
    || Boolean(clean(task.success_criteria))
    || asArray(task.post_conditions).length > 0;
}

export function uiSurface(task = {}) {
  return clean(task.surface || task.ui?.surface || task.ui_surface)
    || taskFiles(task).find((file) => file.includes("/pages/") || file.includes("/screens/") || file.includes("/components/"))
    || "";
}

export function hasStateMatrix(task = {}, prd = {}, manifest = {}) {
  return Boolean(task.state_matrix || task.ui?.state_matrix || prd.state_matrix || prd.ui_state_matrix || manifest.state_matrix || manifest.ui_state_matrix);
}

export function hasEvidencePlan(task = {}, prd = {}, manifest = {}) {
  const evidenceTypes = new Set(["screenshot_exists", "playwright_check", "visual_regression", "ui_state_assertion", "runtime_log_absent"]);
  return Boolean(task.evidence_plan || task.ui_evidence_plan || task.ui?.evidence_plan || prd.evidence_plan || manifest.evidence_plan)
    || asArray(task.post_conditions).some((condition) => evidenceTypes.has(condition.type));
}

export function selectedAcceptanceAdapter(resolver = {}) {
  return resolverAcceptanceAdapter(resolver);
}

export function hasAcceptanceAdapter({ options = {}, manifest = {}, resolver = {} } = {}) {
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

export function summarizeTaskSurfaces(prd = {}, context = {}) {
  const source = prd || {};
  const tasks = asArray(source.tasks);
  const ui = tasks.filter((task) => isUiTask(task, context));
  return {
    task_count: tasks.length,
    ui_task_count: ui.length,
    ui_task_ids: ui.map((task) => task.id || null).filter(Boolean),
  };
}
