import { join, resolve } from "node:path";
import { buildUiAcceptanceFollowUp } from "../demand/ui-acceptance.js";
import {
  discoverPackManifests,
  PACK_MANIFEST_KINDS,
  PACK_MANIFEST_SCHEMA_VERSION,
  type DiscoveredManifest,
  type ManifestValidationError,
  type NormalizedManifest,
} from "./manifest.js";

export const PACK_RESOLVER_SCHEMA = "yolo.pack.resolver.v1";

interface ResolveProjectContextOptions {
  projectRoot?: unknown;
  project_root?: unknown;
  cwd?: unknown;
  stateRoot?: unknown;
  state_root?: unknown;
  roots?: unknown;
  manifestRoots?: unknown;
  manifest_roots?: unknown;
  requiresAcceptanceAdapter?: unknown;
  requires_acceptance_adapter?: unknown;
}

type SelectionEntry = NormalizedManifest | {
  id: string;
  kind: string;
  status: "warning";
  reason: string;
  capabilities: never[];
  source_path: string;
};

type Selected = Record<string, SelectionEntry>;

export interface ResolverBlocker {
  code: string;
  message: string;
  manifest_id?: string | null;
  path?: string;
  follow_up?: { slot: string; plain_language_prompt: string };
}

export interface ResolverWarning {
  code: string;
  kind?: string;
  manifest_id?: string;
  message: string;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function firstValidByKind(manifests: DiscoveredManifest[], kind: string): NormalizedManifest | null {
  return manifests.find((entry) => entry.manifest.kind === kind && entry.validation.valid)?.manifest || null;
}

function unknownSelection(kind: string): SelectionEntry {
  return {
    id: "unknown/custom",
    kind,
    status: "warning",
    reason: "No valid manifest was found; YOLO will not guess this project-specific context.",
    capabilities: [],
    source_path: "",
  };
}

export function resolveProjectContext(options: ResolveProjectContextOptions = {}) {
  const projectRoot = resolve(String(options.projectRoot || options.project_root || options.cwd || process.cwd()));
  const stateRoot = resolve(String(options.stateRoot || options.state_root || join(projectRoot, ".yolo")));
  const discovery = discoverPackManifests({ ...options, projectRoot, stateRoot });
  const invalid = discovery.manifests.filter((entry) => !entry.validation.valid);
  const selected: Selected = {};
  for (const kind of PACK_MANIFEST_KINDS) {
    selected[kind] = firstValidByKind(discovery.manifests, kind) || unknownSelection(kind);
  }

  const requiresAcceptanceAdapter = options.requiresAcceptanceAdapter === true || options.requires_acceptance_adapter === true;
  const blockers: ResolverBlocker[] = invalid.flatMap((entry) => entry.validation.errors.map((error: ManifestValidationError) => ({
    code: error.code,
    message: error.message,
    manifest_id: entry.manifest.id || null,
    path: entry.path,
  })));
  if (requiresAcceptanceAdapter && selected.acceptance_adapter.id === "unknown/custom") {
    blockers.push({
      code: "ACCEPTANCE_ADAPTER_MISSING",
      message: "UI acceptance needs the user's declared acceptance method before execution.",
      manifest_id: "ui-acceptance",
      path: join(stateRoot, "adapters"),
      follow_up: buildUiAcceptanceFollowUp(),
    });
  }

  const warnings: ResolverWarning[] = [];
  for (const [kind, manifest] of Object.entries(selected)) {
    if (manifest.id === "unknown/custom") {
      warnings.push({ code: "RESOLVER_UNKNOWN_CONTEXT", kind, message: `${kind} resolved to unknown/custom.` });
    }
  }
  for (const entry of discovery.manifests) {
    warnings.push(...entry.validation.warnings.map((warning: ManifestValidationError) => ({
      code: warning.code,
      manifest_id: entry.manifest.id,
      message: warning.message,
    })));
  }

  return {
    schema_version: PACK_MANIFEST_SCHEMA_VERSION,
    schema: PACK_RESOLVER_SCHEMA,
    status: blockers.length > 0 ? "blocked" : warnings.length > 0 ? "warning" : "pass",
    project_root: projectRoot,
    state_root: stateRoot,
    manifest_roots: discovery.roots,
    selected,
    selected_packs: Object.values(selected).filter((manifest) => !manifest.kind.endsWith("_adapter")),
    selected_adapters: Object.values(selected).filter((manifest) => manifest.kind.endsWith("_adapter")),
    blockers,
    warnings,
    manifests: discovery.manifests.map((entry) => ({
      path: entry.path,
      id: entry.manifest.id,
      kind: entry.manifest.kind,
      status: entry.validation.status,
    })),
    next_actions: blockers.length > 0
      ? ["Add or fix the required `.manifest.json` adapter files before acceptance."]
      : warnings.some((warning) => warning.code === "RESOLVER_UNKNOWN_CONTEXT")
        ? ["Continue with unknown/custom only if the user accepts missing project-specific packs."]
        : ["Use the resolved adapter and pack context for check/acceptance."],
  };
}
