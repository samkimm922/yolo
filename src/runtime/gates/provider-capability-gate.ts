import { buildProviderCapabilityBits } from "../adapters/provider-capability-bits.js";
import { normalizeAgentProvider } from "../adapters/agent-contract.js";

export const PROVIDER_CAPABILITY_GATE_SCHEMA_VERSION = "1.0";

function cleanString(value) {
  return String(value ?? "").trim();
}

function arrayItems(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string") return value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function uniqueItems(values = []) {
  return [...new Set(values.map((value) => cleanString(value)).filter(Boolean))];
}

function taskInstructionsText(task = Object()) {
  return [
    task.instructions,
    task.instruction,
    task.handoff?.instructions,
  ].flatMap((item) => arrayItems(item)).map(cleanString).filter(Boolean).join("\n");
}

function instructionsRequireShell(text = "") {
  const source = cleanString(text);
  if (!source) return false;
  return /\b(?:npm\s+(?:install|i|run|test|exec|x)|npx|pnpm\s+(?:install|add|run|test|exec|x)|yarn\s+(?:install|add|run|test|exec)|bun\s+(?:install|add|run|test|x)|node\s+--test|tsx|tsc|git\s+)\b/i.test(source)
    || /\b(?:run|execute)\s+(?:the\s+)?(?:shell\s+)?(?:command|script)\b/i.test(source)
    || /\binstall\s+(?:dependencies|packages?|dev dependencies|toolchain)\b/i.test(source);
}

function inferredTaskCapabilities(task = Object()) {
  const caps = [];
  if (cleanString(task.task_kind) === "greenfield_scaffold") caps.push("shell");
  if (instructionsRequireShell(taskInstructionsText(task))) caps.push("shell");
  return caps;
}

function requiredCapabilitiesFromPrd(prd = Object()) {
  const explicit = arrayItems(prd.required_capabilities);
  const fromTasks = [];
  for (const task of prd.tasks || []) {
    const taskCaps = [...arrayItems(task.required_capabilities), ...inferredTaskCapabilities(task)];
    for (const cap of taskCaps) {
      if (!fromTasks.includes(cap)) fromTasks.push(cap);
    }
  }
  return uniqueItems([...explicit, ...fromTasks]);
}

// Fail-closed (M1): an undeclared capability requirement used to silently pass,
// which lets a PRD run on a provider that may be incapable of executing it. With
// no declaration we now block unless the operator has accepted the
// unverified-provider risk. Acceptance is signaled by EITHER:
//   (a) an explicit `provider_capability.opt_out: true` on the PRD, OR
//   (b) an approved, PRD-effective demand contract — the operator already
//       approved the work through the demand pipeline, so the capability gap is
//       an accepted risk (this is the "global opt-out" for legitimate pipeline
//       runs: matrix/CI fixtures and operator-driven runs that always carry an
//       approved demand). A PRD with no demand approval and no opt-out is the
//       degenerate/unverified case the gate must block.
function providerCapabilityOptOut(prd = Object()) {
  const declared = Object.prototype.hasOwnProperty.call(prd, "required_capabilities");
  const block = prd.provider_capability || prd.provider_capabilities;
  const explicit = block && typeof block === "object" ? block.opt_out : undefined;
  if (explicit === true) return true;
  if (declared && Array.isArray(prd.required_capabilities) && prd.required_capabilities.length === 0 && explicit === true) return true;
  // Implicit/global opt-out: an approved, PRD-effective demand contract means
  // the operator accepted the work (and its provider risk) upstream.
  const demand = prd.demand;
  if (demand && typeof demand === "object") {
    const approval = demand.approval;
    if (approval && typeof approval === "object" && approval.approved === true && approval.effective_for_prd === true) {
      return true;
    }
  }
  return false;
}

export function inspectProviderCapabilityGate(options = Object()) {
  const prd = options.prd || {};
  const config = options.config || {};
  const provider = normalizeAgentProvider(options.provider || config.ai?.executor || config.ai?.provider) || "claude";
  const capabilities = buildProviderCapabilityBits(provider, config.ai?.capability_overrides, { config });
  const required = requiredCapabilitiesFromPrd(prd);

  const blockers = [];
  const warnings = [];

  if (required.length === 0) {
    if (providerCapabilityOptOut(prd)) {
      return {
        status: "pass",
        blocks_execution: false,
        provider,
        required,
        capabilities,
        blockers,
        warnings: [{
          code: "PROVIDER_CAPABILITY_OPT_OUT",
          provider,
          message: "No capability requirements declared; gate passed via opt-out (explicit provider_capability.opt_out or an approved demand contract — provider risk accepted).",
        }],
        message: "No capability requirements declared; gate passed via opt-out (provider risk accepted).",
      };
    }
    // Fail-closed: an undeclared capability requirement must not silently pass.
    blockers.push({
      code: "PROVIDER_CAPABILITY_NOT_DECLARED",
      provider,
      message: `PRD declares no required_capabilities and no explicit provider_capability.opt_out. The provider's fitness to execute this task is unverified — declare required_capabilities or set provider_capability.opt_out=true to accept the risk.`,
    });
    return {
      status: "blocked",
      blocks_execution: true,
      provider,
      required,
      capabilities,
      blockers,
      warnings,
      message: "Provider capability requirement is undeclared; gate blocked (fail-closed).",
    };
  }

  for (const cap of required) {
    const normalizedCap = cleanString(cap).toLowerCase().replace(/-/g, "_");
    if (capabilities[normalizedCap] !== true) {
      blockers.push({
        code: "PROVIDER_CAPABILITY_MISSING",
        provider,
        capability: normalizedCap,
        message: missingCapabilityMessage(provider, normalizedCap),
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
      ? blockers.map((blocker) => blocker.message).filter(Boolean).join(" ")
      : "All required capabilities are supported.",
  };
}

export function providerCapabilityExecutionBlock(capability = Object()) {
  if (!capability || capability.status === "pass") return null;
  const warning = capability.status === "warning";
  const details = [
    ...(Array.isArray(capability.blockers) ? capability.blockers : []),
    ...(Array.isArray(capability.warnings) ? capability.warnings : []),
  ].map((item) => item.message).filter(Boolean);
  const message = details.length > 0 ? details.join(" ") : capability.message;
  return {
    status: "blocked",
    stage: "capability",
    code: warning ? "PROVIDER_CAPABILITY_WARNING_BLOCKED" : "PROVIDER_CAPABILITY_BLOCKED",
    exit_code: warning ? 2 : 1,
    message,
    messages: [`[provider-capability] ${warning ? "warning-blocked" : "blocked"}\n${message}`],
    warning_blocked: warning,
  };
}

function missingCapabilityMessage(provider, capability) {
  if (capability === "shell") {
    if (provider === "claude") {
      return "Provider \"claude\" is missing required capability \"shell\". Set config.ai.settings to \"settings-minimal.json\" (or leave config.ai.settings empty to use YOLO's default settings) and do not exclude Bash, or include Bash in config.ai.claude_allowed_tools.";
    }
    if (provider === "custom") {
      return "Provider \"custom\" is missing required capability \"shell\". Verify the custom executor can run shell commands, then set config.ai.capability_overrides.shell=true.";
    }
    return `Provider "${provider}" is missing required capability "shell". Use an executor configuration with shell access, or set config.ai.capability_overrides.shell=true after verifying it.`;
  }
  return `Provider "${provider}" does not support required capability "${capability}"`;
}
