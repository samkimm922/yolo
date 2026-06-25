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

interface ManifestInput {
  schema_version?: unknown;
  schema?: unknown;
  id?: unknown;
  kind?: unknown;
  label?: unknown;
  name?: unknown;
  description?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  commands?: unknown;
  evidence?: unknown;
  capabilities?: unknown;
  applies_to?: unknown;
  source_path?: unknown;
}

type ManifestCommand = string | { command: string; [key: string]: unknown };

export interface NormalizedManifest {
  schema_version: string;
  schema: string;
  id: string;
  kind: string;
  label: string;
  description: string;
  inputs: string[];
  outputs: string[];
  commands: ManifestCommand[];
  evidence: string[];
  capabilities: string[];
  applies_to: string[];
  source_path: string;
}

export interface ManifestValidationError {
  code: string;
  message: string;
}

interface ManifestValidationResult {
  status: "invalid" | "warning" | "pass";
  valid: boolean;
  errors: ManifestValidationError[];
  warnings: ManifestValidationError[];
  manifest: NormalizedManifest;
}

interface DiscoverPackManifestsOptions {
  projectRoot?: unknown;
  project_root?: unknown;
  cwd?: unknown;
  stateRoot?: unknown;
  state_root?: unknown;
  roots?: unknown;
  manifestRoots?: unknown;
  manifest_roots?: unknown;
}

export interface DiscoveredManifest {
  path: string;
  manifest: NormalizedManifest;
  validation: ManifestValidationResult;
}

export interface DiscoverPackManifestsResult {
  schema_version: string;
  status: "ok" | "warning";
  project_root: string;
  state_root: string;
  roots: string[];
  missing_roots: string[];
  manifests: DiscoveredManifest[];
  errors: Array<{ path: string; code: string; message: string }>;
}

const ADAPTER_REQUIRED_FIELDS = ["inputs", "outputs", "commands", "evidence", "capabilities"] as const;

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value.filter(Boolean) as T[];
  if (value == null || value === "") return [];
  return [value as T];
}

function normalizeManifest(manifest: ManifestInput = {}, sourcePath = ""): NormalizedManifest {
  return {
    schema_version: clean(manifest.schema_version) || PACK_MANIFEST_SCHEMA_VERSION,
    schema: clean(manifest.schema) || PACK_MANIFEST_SCHEMA,
    id: clean(manifest.id),
    kind: clean(manifest.kind),
    label: clean(manifest.label || manifest.name),
    description: clean(manifest.description),
    inputs: asArray(manifest.inputs).map(String),
    outputs: asArray(manifest.outputs).map(String),
    commands: asArray<unknown>(manifest.commands).map((command) => typeof command === "string" ? { command } : command as ManifestCommand),
    evidence: asArray(manifest.evidence).map(String),
    capabilities: asArray(manifest.capabilities).map(String),
    applies_to: asArray(manifest.applies_to).map(String),
    source_path: sourcePath,
  };
}

export function validatePackManifest(manifest: ManifestInput = {}): ManifestValidationResult {
  const normalized = normalizeManifest(manifest, String(manifest.source_path || ""));
  const errors: ManifestValidationError[] = [];
  const warnings: ManifestValidationError[] = [];
  if (normalized.schema !== PACK_MANIFEST_SCHEMA) errors.push({ code: "MANIFEST_SCHEMA_INVALID", message: `schema must be ${PACK_MANIFEST_SCHEMA}` });
  if (!normalized.id) errors.push({ code: "MANIFEST_ID_MISSING", message: "manifest id is required" });
  if (!PACK_MANIFEST_KINDS.includes(normalized.kind)) errors.push({ code: "MANIFEST_KIND_INVALID", message: `kind must be one of ${PACK_MANIFEST_KINDS.join(", ")}` });
  if (ADAPTER_KINDS.has(normalized.kind)) {
    const requiredFields: ReadonlyArray<keyof NormalizedManifest> = ADAPTER_REQUIRED_FIELDS;
    for (const field of requiredFields) {
      if (normalized[field].length === 0) {
        errors.push({ code: `MANIFEST_${String(field).toUpperCase()}_MISSING`, message: `${normalized.kind} must declare ${String(field)}` });
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

export function readPackManifest(filePath: string): DiscoveredManifest {
  const path = resolve(filePath);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ManifestInput;
  const validation = validatePackManifest({ ...parsed, source_path: path });
  return {
    path,
    manifest: validation.manifest,
    validation,
  };
}

export function discoverPackManifests(options: DiscoverPackManifestsOptions = {}): DiscoverPackManifestsResult {
  const projectRoot = resolve(String(options.projectRoot || options.project_root || options.cwd || process.cwd()));
  const stateRoot = resolve(String(options.stateRoot || options.state_root || join(projectRoot, ".yolo")));
  const configuredRoots = asArray<unknown>(options.roots || options.manifestRoots || options.manifest_roots).map((item) => String(item ?? ""));
  const roots: string[] = configuredRoots.length
    ? configuredRoots
    : [join(stateRoot, "packs"), join(stateRoot, "adapters")];
  const manifests: DiscoveredManifest[] = [];
  const missing_roots: string[] = [];
  const errors: Array<{ path: string; code: string; message: string }> = [];
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
        errors.push({ path, code: "MANIFEST_READ_FAILED", message: error instanceof Error ? error.message : String(error) });
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
