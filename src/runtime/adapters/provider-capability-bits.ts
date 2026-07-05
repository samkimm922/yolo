export const PROVIDER_CAPABILITY_BITS_SCHEMA_VERSION = "1.0";
const SHELL_CAPABILITY = "shell";

export const PROVIDER_CAPABILITY_FIELDS = [
  "supports_tools",
  "supports_vision",
  "supports_streaming",
  "supports_long_context",
  "supports_parallel",
  "supports_reasoning",
  SHELL_CAPABILITY,
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
    [SHELL_CAPABILITY]: true,
  },
  codex: {
    supports_tools: true,
    supports_vision: false,
    supports_streaming: true,
    supports_long_context: true,
    supports_parallel: true,
    supports_reasoning: false,
    [SHELL_CAPABILITY]: true,
  },
  custom: {
    supports_tools: false,
    supports_vision: false,
    supports_streaming: false,
    supports_long_context: false,
    supports_parallel: false,
    supports_reasoning: false,
    [SHELL_CAPABILITY]: false,
  },
};

const DEFAULT_CLAUDE_SETTINGS_FILE = "settings-minimal.json";

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function aiConfig(options: { config?: Record<string, unknown>; ai?: Record<string, unknown> } = Object()): Record<string, unknown> {
  return options.ai || ((options.config?.ai as Record<string, unknown>) || {});
}

function toolTokens(value: unknown): string[] {
  return cleanString(value)
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function includesBashTool(value: unknown): boolean {
  return toolTokens(value).some((tool) => /^bash(?:\(|$)/i.test(tool));
}

function firstConfigValue(ai: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (ai[key] !== undefined && ai[key] !== null && cleanString(ai[key])) return ai[key];
  }
  return "";
}

function inlineSettings(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[");
}

function inlineSettingsAllowsBash(settings: string): boolean {
  try {
    const parsed = JSON.parse(settings);
    const allow = parsed?.permissions?.allow;
    return Array.isArray(allow) && allow.some((tool) => /^bash(?:\(|$)/i.test(cleanString(tool)));
  } catch {
    return false;
  }
}

function inferClaudeShellCapability(ai: Record<string, unknown>): boolean {
  if (cleanString(ai.claude_permission_mode).toLowerCase() === "read-only") return false;

  const disallowedTools = firstConfigValue(ai, [
    "claude_disallowed_tools",
    "claudeDisallowedTools",
    "disallowed_tools",
    "disallowedTools",
  ]);
  if (includesBashTool(disallowedTools)) return false;

  const allowedTools = firstConfigValue(ai, [
    "claude_allowed_tools",
    "claudeAllowedTools",
    "allowed_tools",
    "allowedTools",
    "claude_tools",
    "claudeTools",
  ]);
  if (cleanString(allowedTools)) return includesBashTool(allowedTools);

  const settings = cleanString(ai.settings);
  if (!settings || settings === DEFAULT_CLAUDE_SETTINGS_FILE) return true;
  if (inlineSettings(settings)) return inlineSettingsAllowsBash(settings);
  return true;
}

function inferCodexShellCapability(ai: Record<string, unknown>): boolean {
  return cleanString(ai.codex_sandbox || "workspace-write").toLowerCase() !== "read-only";
}

function inferExecutorCapabilities(provider: string, ai: Record<string, unknown>): Record<string, boolean> {
  if (provider === "claude") return { [SHELL_CAPABILITY]: inferClaudeShellCapability(ai) };
  if (provider === "codex") return { [SHELL_CAPABILITY]: inferCodexShellCapability(ai) };
  return {};
}

export function buildProviderCapabilityBits(
  provider: string,
  overrides: Record<string, boolean> = Object(),
  options: { config?: Record<string, unknown>; ai?: Record<string, unknown> } = Object(),
) {
  const normalized = String(provider ?? "").trim().toLowerCase();
  const defaults = PROVIDER_CAPABILITY_BIT_DEFAULTS[normalized] || PROVIDER_CAPABILITY_BIT_DEFAULTS.custom;
  const ai = aiConfig(options);
  return {
    provider: normalized,
    ...defaults,
    ...inferExecutorCapabilities(normalized, ai),
    ...(overrides || {}),
  };
}

export function buildProviderParityMatrix(options: { providers?: string[]; overrides?: Record<string, Record<string, boolean>> } = Object()) {
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

export function inspectProviderParityMatrix(options: { providers?: string[]; overrides?: Record<string, Record<string, boolean>> } = Object()) {
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
