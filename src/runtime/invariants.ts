export const RUNTIME_INVARIANT_PREFIX = "RUNTIME_INVARIANT_VIOLATED";

export function runtimeInvariantCode(name) {
  return `${RUNTIME_INVARIANT_PREFIX}:${String(name || "unknown").trim() || "unknown"}`;
}

export function runtimeInvariantBlocker(name, message, extra = Object()) {
  return {
    ...extra,
    code: runtimeInvariantCode(name),
    invariant: name,
    message,
  };
}

export function withRuntimeInvariantCode(record = Object(), name, extra = Object()) {
  return {
    ...record,
    ...extra,
    invariant: name,
    invariant_code: runtimeInvariantCode(name),
  };
}

export class RuntimeInvariantViolation extends Error {
  code;
  exitCode;
  invariant;
  blockers;

  constructor(name, message, extra = Object()) {
    super(message);
    this.name = "RuntimeInvariantViolation";
    this.code = runtimeInvariantCode(name);
    this.exitCode = 2;
    this.invariant = name;
    this.blockers = [runtimeInvariantBlocker(name, message, extra)];
  }
}

export function isRuntimeInvariantViolation(error) {
  return Boolean(error && typeof error === "object" && String(error.code || "").startsWith(`${RUNTIME_INVARIANT_PREFIX}:`));
}
