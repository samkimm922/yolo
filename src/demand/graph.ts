export const DEMAND_GRAPH_SCHEMA_VERSION = "1.0";
export const DEMAND_GRAPH_SCHEMA = "yolo.demand.artifact_graph.v1";

export const DEMAND_ARTIFACTS = [
  {
    id: "vision",
    generates: "VISION.md",
    description: "Initial product vision, target user, problem, status quo, and opportunity hypothesis.",
    requires: [],
  },
  {
    id: "reflection",
    generates: "REFLECTION.md",
    description: "Premise challenge, assumptions, alternatives, and why this should continue.",
    requires: ["vision"],
  },
  {
    id: "investigation",
    generates: "INVESTIGATION.md",
    description: "Evidence, codebase scout, existing behavior, risks, and validation gaps.",
    requires: ["reflection"],
  },
  {
    id: "questioning_rounds",
    generates: "DISCUSSION-LOG.md",
    description: "Questioning rounds, answers, decisions, unresolved questions, and deferred ideas.",
    requires: ["investigation"],
  },
  {
    id: "depth_verification",
    generates: "READINESS.json",
    description: "Demand quality gate, depth verification, and readiness level.",
    requires: ["questioning_rounds"],
  },
  {
    id: "requirements_confirmation",
    generates: "REQUIREMENTS.md",
    description: "Confirmed requirements, acceptance scenarios, constraints, and out-of-scope boundaries.",
    requires: ["depth_verification"],
  },
  {
    id: "context",
    generates: "CONTEXT.md",
    description: "Domain language, project context, current state, constraints, and durable decisions.",
    requires: ["requirements_confirmation"],
  },
  {
    id: "roadmap",
    generates: "ROADMAP.md",
    description: "MVP, sequencing, later phases, dependencies, and risk-driven ordering.",
    requires: ["requirements_confirmation"],
  },
  {
    id: "approval",
    generates: "APPROVAL.json",
    description: "Explicit human approval for PRD compilation and execution readiness.",
    requires: ["requirements_confirmation", "context", "roadmap"],
  },
  {
    id: "executable_prd",
    generates: "prd.json",
    description: "Executable PRD compiled from approved demand artifacts.",
    requires: ["approval"],
  },
];

function artifactMap(artifacts = DEMAND_ARTIFACTS) {
  return new Map(artifacts.map((artifact) => [artifact.id, artifact]));
}

export function demandBuildOrder(artifacts = DEMAND_ARTIFACTS) {
  const byId = artifactMap(artifacts);
  const inDegree = new Map();
  const dependents = new Map();
  for (const artifact of artifacts) {
    inDegree.set(artifact.id, artifact.requires.length);
    dependents.set(artifact.id, []);
  }
  for (const artifact of artifacts) {
    for (const required of artifact.requires) {
      if (!byId.has(required)) continue;
      dependents.get(required).push(artifact.id);
    }
  }

  const queue = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort();
  const order = [];
  while (queue.length > 0) {
    const current = queue.shift();
    order.push(current);
    for (const dependent of dependents.get(current) || []) {
      const degree = inDegree.get(dependent) - 1;
      inDegree.set(dependent, degree);
      if (degree === 0) queue.push(dependent);
    }
    queue.sort();
  }
  return order;
}

export function demandReadyArtifacts(completed = [], artifacts = DEMAND_ARTIFACTS) {
  const done = completed instanceof Set ? completed : new Set(completed);
  return artifacts
    .filter((artifact) => !done.has(artifact.id) && artifact.requires.every((id) => done.has(id)))
    .map((artifact) => artifact.id)
    .sort();
}

export function demandBlockedArtifacts(completed = [], artifacts = DEMAND_ARTIFACTS) {
  const done = completed instanceof Set ? completed : new Set(completed);
  const blocked = {};
  for (const artifact of artifacts) {
    if (done.has(artifact.id)) continue;
    const missing = artifact.requires.filter((id) => !done.has(id));
    if (missing.length > 0) blocked[artifact.id] = missing.sort();
  }
  return blocked;
}

export function buildDemandArtifactGraph(completed = []) {
  const done = completed instanceof Set ? completed : new Set(completed);
  const artifacts = DEMAND_ARTIFACTS.map((artifact) => {
    const missing = artifact.requires.filter((id) => !done.has(id));
    return {
      ...artifact,
      status: done.has(artifact.id) ? "done" : missing.length === 0 ? "ready" : "blocked",
      missing_dependencies: missing,
    };
  });
  return {
    schema_version: DEMAND_GRAPH_SCHEMA_VERSION,
    schema: DEMAND_GRAPH_SCHEMA,
    build_order: demandBuildOrder(),
    completed: [...done].sort(),
    ready: demandReadyArtifacts(done),
    blocked: demandBlockedArtifacts(done),
    artifacts,
  };
}
