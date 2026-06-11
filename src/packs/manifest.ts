import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PACK_MANIFEST_SCHEMA_VERSION = "1.0";
export const PACK_MANIFEST_SCHEMA = "yolo.manifest.v1";

export const PACK_MANIFEST_KINDS = [
  "platform_adapter",
  "stack_adapter",
  "component_adapter",
  "design_reference_pack",
  "quality_rule_pack",
  "acceptance_adapter",
];

const ADAPTER_KINDS = new Set(["platform_adapter", "stack_adapter", "component_adapter", "acceptance_adapter"]);

function clean(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === "") return [];
  return [value];
}

function normalizeManifest(manifest = Object(), sourcePath = "") {
  return {
    schema_version: clean(manifest.schema_version) || PACK_MANIFEST_SCHEMA_VERSION,
    schema: clean(manifest.schema) || PACK_MANIFEST_SCHEMA,
    id: clean(manifest.id),
    kind: clean(manifest.kind),
    label: clean(manifest.label || manifest.name),
    description: clean(manifest.description),
    inputs: asArray(manifest.inputs).map(String),
    outputs: asArray(manifest.outputs).map(String),
    commands: asArray(manifest.commands).map((command) => typeof command === "string" ? { command } : command),
    evidence: asArray(manifest.evidence).map(String),
    capabilities: asArray(manifest.capabilities).map(String),
    applies_to: asArray(manifest.applies_to).map(String),
    source_path: sourcePath,
  };
}

export function validatePackManifest(manifest = Object()) {
  const normalized = normalizeManifest(manifest, manifest.source_path || "");
  const errors = [];
  const warnings = [];
  if (normalized.schema !== PACK_MANIFEST_SCHEMA) errors.push({ code: "MANIFEST_SCHEMA_INVALID", message: `schema must be ${PACK_MANIFEST_SCHEMA}` });
  if (!normalized.id) errors.push({ code: "MANIFEST_ID_MISSING", message: "manifest id is required" });
  if (!PACK_MANIFEST_KINDS.includes(normalized.kind)) errors.push({ code: "MANIFEST_KIND_INVALID", message: `kind must be one of ${PACK_MANIFEST_KINDS.join(", ")}` });
  if (ADAPTER_KINDS.has(normalized.kind)) {
    for (const field of ["inputs", "outputs", "commands", "evidence", "capabilities"]) {
      if (normalized[field].length === 0) {
        errors.push({ code: `MANIFEST_${field.toUpperCase()}_MISSING`, message: `${normalized.kind} must declare ${field}` });
      }
    }
  }
  if (!normalized.description) warnings.push({ code: "MANIFEST_DESCRIPTION_MISSING", message: "manifest description is recommended" });
  return {
    status: errors.length > 0 ? "invalid" : warnings.length > 0 ? "warning" : "pass",
    valid: errors.length === 0,
    errors,
    warnings,
    manifest: normalized,
  };
}

export function readPackManifest(filePath) {
  const path = resolve(filePath);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const validation = validatePackManifest({ ...parsed, source_path: path });
  return {
    path,
    manifest: validation.manifest,
    validation,
  };
}

export function discoverPackManifests(options = Object()) {
  const projectRoot = resolve(options.projectRoot || options.project_root || options.cwd || process.cwd());
  const stateRoot = resolve(options.stateRoot || options.state_root || join(projectRoot, ".yolo"));
  const roots = asArray(options.roots || options.manifestRoots || options.manifest_roots).length
    ? asArray(options.roots || options.manifestRoots || options.manifest_roots)
    : [join(stateRoot, "packs"), join(stateRoot, "adapters")];
  const manifests = [];
  const missing_roots = [];
  const errors = [];
  for (const root of roots.map((item) => resolve(projectRoot, item))) {
    if (!existsSync(root)) {
      missing_roots.push(root);
      continue;
    }
    for (const file of readdirSync(root).filter((entry) => entry.endsWith(".manifest.json"))) {
      const path = join(root, file);
      try {
        manifests.push(readPackManifest(path));
      } catch (error) {
        errors.push({ path, code: "MANIFEST_READ_FAILED", message: error.message });
      }
    }
  }
  return {
    schema_version: PACK_MANIFEST_SCHEMA_VERSION,
    status: errors.length > 0 ? "warning" : "ok",
    project_root: projectRoot,
    state_root: stateRoot,
    roots,
    missing_roots,
    manifests,
    errors,
  };
}
