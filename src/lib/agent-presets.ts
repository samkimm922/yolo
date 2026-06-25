interface AgentPreset {
  id: string;
  label: string;
  purpose: string;
  phases: string[];
  sdk_namespaces: string[];
  gate_level: string;
}

interface AgentPlanStep {
  id: string;
  phase: string;
  status: string;
}

interface AgentPlan {
  preset: string;
  label: string;
  objective: string;
  task_id: string | null;
  gate_level: string;
  sdk_namespaces: string[];
  steps: AgentPlanStep[];
}

interface CreateAgentPlanInput {
  preset?: string;
  objective?: string;
  taskId?: string;
  task_id?: string;
}

const AGENT_PRESETS: Record<string, AgentPreset> = {
  pi: {
    id: "pi",
    label: "Product Implementation Agent",
    purpose: "Drive a feature from requirement intake through PRD, implementation, review, fix loops, and final gate.",
    phases: [
      "intake",
      "prd_contract",
      "task_breakdown",
      "implementation",
      "review",
      "fix_loop",
      "final_gate",
    ],
    sdk_namespaces: ["contract", "task", "review", "provider"],
    gate_level: "strict",
  },
  reviewer: {
    id: "reviewer",
    label: "Review Agent",
    purpose: "Inspect code, tests, contracts, and regressions without owning implementation.",
    phases: ["scan", "contract_check", "risk_report", "fix_recommendations"],
    sdk_namespaces: ["contract", "review"],
    gate_level: "strict",
  },
  gatekeeper: {
    id: "gatekeeper",
    label: "Gatekeeper Agent",
    purpose: "Fail closed on missing evidence, invalid contracts, broken checks, or unsafe diffs.",
    phases: ["preflight", "pre_conditions", "post_conditions", "quality_gate", "evidence_gate"],
    sdk_namespaces: ["contract", "task"],
    gate_level: "fail_closed",
  },
  implementer: {
    id: "implementer",
    label: "Implementation Agent",
    purpose: "Execute scoped implementation tasks against an existing PRD and explicit acceptance criteria.",
    phases: ["task_load", "scope_check", "implementation", "local_validation", "handoff"],
    sdk_namespaces: ["task", "provider"],
    gate_level: "normal",
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export function listAgentPresets(): AgentPreset[] {
  return Object.values(AGENT_PRESETS).map(clone);
}

export function getAgentPreset(id: string = "pi"): AgentPreset {
  const preset = AGENT_PRESETS[id];
  if (!preset) {
    const available = Object.keys(AGENT_PRESETS).join(", ");
    throw new Error(`Unknown YOLO agent preset "${id}". Available presets: ${available}`);
  }
  return clone(preset);
}

export function createAgentPlan(input: CreateAgentPlanInput = {}): AgentPlan {
  const preset = getAgentPreset(input.preset || "pi");
  const objective = input.objective || "";
  const taskId = input.taskId || input.task_id || null;

  return {
    preset: preset.id,
    label: preset.label,
    objective,
    task_id: taskId,
    gate_level: preset.gate_level,
    sdk_namespaces: preset.sdk_namespaces,
    steps: preset.phases.map((phase, index) => ({
      id: `${preset.id}.${index + 1}.${phase}`,
      phase,
      status: "pending",
    })),
  };
}

