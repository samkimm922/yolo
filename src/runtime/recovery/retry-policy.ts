import { config as runtimeConfig } from "../../lib/config.js";

export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 2;

function parsePositiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function normalizeCircuitBreakerThreshold(value: unknown, { warn = null } = Object()): number {
  const parsed = parsePositiveInteger(value);
  if (parsed !== null) return parsed;
  if (typeof warn === "function") {
    warn(`[retry-policy] invalid runner.circuit_breaker=${String(value)}; using default ${DEFAULT_CIRCUIT_BREAKER_THRESHOLD}`);
  }
  return DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
}

export function circuitBreakerThreshold(source: any = runtimeConfig, { warn = console.warn } = Object()): number {
  return normalizeCircuitBreakerThreshold(source?.runner?.circuit_breaker, { warn });
}

export function hasRepeatedFailure(
  history = [],
  threshold: unknown = circuitBreakerThreshold(),
  sameFailureOrKey: (...items: any[]) => any = (entry) => entry,
): boolean {
  const normalizedThreshold = normalizeCircuitBreakerThreshold(threshold);
  const recent = history.slice(-normalizedThreshold);
  if (recent.length < normalizedThreshold) return false;
  const first = recent[0];
  if (sameFailureOrKey.length >= 2) {
    return recent.every((entry) => sameFailureOrKey(entry, first));
  }
  const firstKey = sameFailureOrKey(first);
  return recent.every((entry) => sameFailureOrKey(entry) === firstKey);
}
