export const PROVIDER_CAPABILITY_BITS_SCHEMA_VERSION = "1.0";

export const PROVIDER_CAPABILITY_FIELDS = [
  "supports_tools",
  "supports_vision",
  "supports_streaming",
  "supports_long_context",
  "supports_parallel",
  "supports_reasoning",
] as const;

export type ProviderCapabilityField = (typeof PROVIDER_CAPABILITY_FIELDS)[number];

export const PROVIDER_CAPABILITY_BIT_DEFAULTS: Record<string, Record<ProviderCapabilityField, boolean>> = {
  claude: {
    supports_tools: true,
    supports_vision: true,
    supports_streaming: true,
    supports_long_context: true,
    supports_parallel: false,
    supports_reasoning: true,
  },
  codex: {
    supports_tools: true,
    supports_vision: false,
    supports_streaming: true,
    supports_long_context: true,
    supports_parallel: true,
    supports_reasoning: false,
  },
  custom: {
    supports_tools: false,
    supports_vision: false,
    supports_streaming: false,
    supports_long_context: false,
    supports_parallel: false,
    supports_reasoning: false,
  },
};

export function buildProviderCapabilityBits(provider: string, overrides: Record<string, boolean> = {}) {
  const normalized = String(provider ?? "").trim().toLowerCase();
  const defaults = PROVIDER_CAPABILITY_BIT_DEFAULTS[normalized] || PROVIDER_CAPABILITY_BIT_DEFAULTS.custom;
  return {
    provider: normalized,
    ...defaults,
    ...overrides,
  };
}

export function buildProviderParityMatrix(options: { providers?: string[]; overrides?: Record<string, Record<string, boolean>> } = {}) {
  const providers = options.providers || Object.keys(PROVIDER_CAPABILITY_BIT_DEFAULTS);
  const overrides = options.overrides || {};

  const entries = providers.map((provider) => buildProviderCapabilityBits(provider, overrides[provider]));

  return {
    schema_version: PROVIDER_CAPABILITY_BITS_SCHEMA_VERSION,
    schema: "yolo.runtime.provider_parity_matrix.v1",
    providers: entries,
    fields: [...PROVIDER_CAPABILITY_FIELDS],
  };
}

export function inspectProviderParityMatrix(options: { providers?: string[]; overrides?: Record<string, Record<string, boolean>> } = {}) {
  const matrix = buildProviderParityMatrix(options);
  const warnings: Array<{ code: string; provider: string; message: string }> = [];

  for (const entry of matrix.providers) {
    if (entry.provider === "custom") {
      warnings.push({
        code: "PARITY_CUSTOM_ADAPTER_UNVERIFIED",
        provider: entry.provider,
        message: "custom provider capabilities are defaults; caller must verify actual model support",
      });
    }
  }

  return {
    status: warnings.length > 0 ? "warning" : "pass",
    matrix,
    warnings,
  };
}
