import {
  PROVIDER_CAPABILITY_FIELDS,
  type ProviderCapabilityField,
  buildProviderCapabilityBits,
} from "../adapters/provider-capability-bits.js";
import { normalizeAgentProvider } from "../adapters/agent-contract.js";

export const PROVIDER_CAPABILITY_GATE_SCHEMA_VERSION = "1.0";

type ProviderCapabilityPrd = {
  required_capabilities?: unknown;
  tasks?: Array<{ required_capabilities?: unknown }>;
  [key: string]: unknown;
};

type ProviderCapabilityOptions = {
  prd?: ProviderCapabilityPrd;
  config?: {
    ai?: {
      executor?: unknown;
      provider?: unknown;
      capability_overrides?: Record<string, boolean>;
    };
  };
  provider?: unknown;
};

type CapabilityBlocker = {
  code: string;
  provider: string;
  capability: string;
  message: string;
};

type CapabilityWarning = {
  code: string;
  provider: string;
  message: string;
};

function isProviderCapabilityField(value: string): value is ProviderCapabilityField {
  return (PROVIDER_CAPABILITY_FIELDS as readonly string[]).includes(value);
}

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function arrayItems(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => String(item));
  if (typeof value === "string") return value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function requiredCapabilitiesFromPrd(prd: ProviderCapabilityPrd = Object()): string[] {
  const explicit = arrayItems(prd.required_capabilities);
  if (explicit.length > 0) return explicit;

  const fromTasks: string[] = [];
  for (const task of prd.tasks || []) {
    const taskCaps = arrayItems(task.required_capabilities);
    for (const cap of taskCaps) {
      if (!fromTasks.includes(cap)) fromTasks.push(cap);
    }
  }
  return fromTasks;
}

export function inspectProviderCapabilityGate(options: ProviderCapabilityOptions = Object()) {
  const prd = options.prd || {};
  const config = options.config || {};
  const provider = normalizeAgentProvider(options.provider || config.ai?.executor || config.ai?.provider) || "claude";
  const capabilities = buildProviderCapabilityBits(provider, config.ai?.capability_overrides);
  const required = requiredCapabilitiesFromPrd(prd);

  const blockers: CapabilityBlocker[] = [];
  const warnings: CapabilityWarning[] = [];

  if (required.length === 0) {
    return {
      status: "pass",
      blocks_execution: false,
      provider,
      required,
      capabilities,
      blockers,
      warnings,
      message: "No capability requirements declared; gate passes.",
    };
  }

  for (const cap of required) {
    const normalizedCap = cleanString(cap).toLowerCase().replace(/-/g, "_");
    const supported = isProviderCapabilityField(normalizedCap)
      ? capabilities[normalizedCap] === true
      : false;
    if (!supported) {
      blockers.push({
        code: "PROVIDER_CAPABILITY_MISSING",
        provider,
        capability: normalizedCap,
        message: `Provider "${provider}" does not support required capability "${normalizedCap}"`,
      });
    }
  }

  if (provider === "custom" && required.length > 0) {
    warnings.push({
      code: "PROVIDER_CAPABILITY_CUSTOM_UNVERIFIED",
      provider,
      message: "custom provider required capabilities cannot be verified automatically",
    });
  }

  return {
    status: blockers.length > 0 ? "blocked" : (warnings.length > 0 ? "warning" : "pass"),
    blocks_execution: blockers.length > 0,
    provider,
    required,
    capabilities,
    blockers,
    warnings,
    message: blockers.length > 0
      ? `Provider "${provider}" is missing ${blockers.length} required capability(s)`
      : "All required capabilities are supported.",
  };
}
