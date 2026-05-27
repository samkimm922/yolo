import { join, resolve } from "node:path";
import {
  discoverPackManifests,
  PACK_MANIFEST_KINDS,
  PACK_MANIFEST_SCHEMA_VERSION,
} from "./manifest.js";

export const PACK_RESOLVER_SCHEMA = "yolo.pack.resolver.v1";

function clean(value) {
  return String(value ?? "").trim();
}

function firstValidByKind(manifests, kind) {
  return manifests.find((entry) => entry.manifest.kind === kind && entry.validation.valid)?.manifest || null;
}

function unknownSelection(kind) {
  return {
    id: "unknown/custom",
    kind,
    status: "warning",
    reason: "No valid manifest was found; YOLO will not guess this project-specific context.",
    capabilities: [],
    source_path: "",
  };
}

export function resolveProjectContext(options = {}) {
  const projectRoot = resolve(options.projectRoot || options.project_root || options.cwd || process.cwd());
  const stateRoot = resolve(options.stateRoot || options.state_root || join(projectRoot, ".yolo"));
  const discovery = discoverPackManifests({ ...options, projectRoot, stateRoot });
  const invalid = discovery.manifests.filter((entry) => !entry.validation.valid);
  const selected = {};
  for (const kind of PACK_MANIFEST_KINDS) {
    selected[kind] = firstValidByKind(discovery.manifests, kind) || unknownSelection(kind);
  }

  const requiresAcceptanceAdapter = options.requiresAcceptanceAdapter === true || options.requires_acceptance_adapter === true;
  const blockers = invalid.flatMap((entry) => entry.validation.errors.map((error) => ({
    code: error.code,
    message: error.message,
    manifest_id: entry.manifest.id || null,
    path: entry.path,
  })));
  if (requiresAcceptanceAdapter && selected.acceptance_adapter.id === "unknown/custom") {
    blockers.push({
      code: "ACCEPTANCE_ADAPTER_MISSING",
      message: "Acceptance requires a valid acceptance_adapter manifest.",
    });
  }

  const warnings = [];
  for (const [kind, manifest] of Object.entries(selected)) {
    if (manifest.id === "unknown/custom") {
      warnings.push({ code: "RESOLVER_UNKNOWN_CONTEXT", kind, message: `${kind} resolved to unknown/custom.` });
    }
  }
  for (const entry of discovery.manifests) {
    warnings.push(...entry.validation.warnings.map((warning) => ({
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
    selected_packs: Object.values(selected).filter((manifest) => !String(manifest.kind).endsWith("_adapter")),
    selected_adapters: Object.values(selected).filter((manifest) => String(manifest.kind).endsWith("_adapter")),
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
