import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runAgentIntegrationDoctor } from "./agent-integration-doctor.js";
import { buildDogfoodMatrixPlan, buildDogfoodMatrixReport } from "./dogfood-matrix.js";

export const REAL_PROJECT_DOGFOOD_SCHEMA_VERSION = "1.0";

const DOGFOOD_MODES = ["plan", "check", "review"];
export const REAL_PROJECT_DOGFOOD_V2_MODES = ["idea", "discovery", "plan", "prd", "check", "review", "accept", "controlled_run"];

function asArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null || value === "") return [];
  return [value];
}

function unique(values = []) {
  return [...new Set(asArray(values).map(String).filter(Boolean))];
}

function commandForMode(mode) {
  if (mode === "idea") return "/yolo";
  if (mode === "discovery") return "/yolo-demand";
  if (mode === "plan") return "/yolo-plan";
  if (mode === "prd") return "/yolo-prd";
  if (mode === "check") return "/yolo-check";
  if (mode === "review") return "/yolo-review";
  if (mode === "accept") return "/yolo-accept";
  if (mode === "controlled_run") return "/yolo-run";
  return `/yolo-${mode.replace(/_/g, "-")}`;
}

function check(code, passed, message, extra = Object()) {
  return { code, passed, message, ...extra };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function evidencePresent(value = Object()) {
  return Boolean(value.artifact_path)
    || Boolean(value.report_path)
    || Boolean(value.public_url)
    || (Array.isArray(value.evidence_files) && value.evidence_files.length > 0)
    || (Array.isArray(value.evidence) && value.evidence.length > 0);
}

function noExecutionSideEffects(value = Object()) {
  return value.writes_workspace !== true
    && value.mutates_workspace !== true
    && value.edits_code !== true
    && value.provider_execution !== true
    && value.executes_provider !== true
    && value.billable_provider_execution !== true
    && value.executed_by_sdk !== true;
}

function evidenceForMode(mode, options = Object()) {
  const dogfoodEvidence = options.dogfoodEvidence || options.dogfood_evidence || {};
  if (isObject(dogfoodEvidence[mode])) return dogfoodEvidence[mode];
  if (mode === "plan") return options.planEvidence || options.plan_evidence || null;
  if (mode === "check") return options.checkEvidence || options.check_evidence || null;
  if (mode === "review") return options.reviewEvidence || options.review_evidence || null;
  return null;
}

function dogfoodModePassed(mode, evidence) {
  if (!isObject(evidence)) return false;
  const evidenceMode = evidence.mode || evidence.workflow || evidence.command_mode || mode;
  return evidence.status === "pass"
    && evidenceMode === mode
    && evidencePresent(evidence)
    && noExecutionSideEffects(evidence);
}

export function buildRealProjectDogfoodPlan(options = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const projectRoot = resolve(options.projectRoot || options.project_root || process.cwd());
  const modes = unique(options.modes || DOGFOOD_MODES);
  const dogfoodMatrix = options.dogfoodMatrixPlan || options.dogfood_matrix_plan || buildDogfoodMatrixPlan({ yoloRoot, projectRoot });
  return {
    schema_version: REAL_PROJECT_DOGFOOD_SCHEMA_VERSION,
    schema: "yolo.release.real_project_dogfood_plan.v1",
    yolo_root: yoloRoot,
    project_root: projectRoot,
    modes,
    dogfood_matrix: dogfoodMatrix,
    writes_workspace: false,
    publishes: false,
    reads_credentials: false,
    spawns_provider: false,
    executes_billable_provider: false,
    required_evidence: [
      "a real external project root that is not the YOLO package root",
      "native Codex/Claude YOLO integration doctor pass for the requested scope",
      ...modes.map((mode) => `chat-driven ${commandForMode(mode)} evidence with no workspace mutation or provider execution`),
      "generic dogfood matrix report covering node-basic, frontend-vite, backend-api, python-service, monorepo, dirty-tree, and failing-baseline",
    ],
    stop_conditions: [
      "dogfood evidence comes only from the YOLO repository itself",
      "plan/check/review evidence is missing, failed, or unlinked",
      "generic dogfood matrix evidence is missing or any scenario fails its expected outcome",
      "dirty-tree or failing-baseline is accepted as a smooth pass instead of fail-closed",
      "any dogfood evidence claims code edits, provider execution, or billable execution",
    ],
  };
}

export function runRealProjectDogfoodGate(options = Object()) {
  const yoloRoot = resolve(options.yoloRoot || options.cwd || process.cwd());
  const projectRoot = resolve(options.projectRoot || options.project_root || process.cwd());
  const plan = options.plan || buildRealProjectDogfoodPlan({ yoloRoot, projectRoot });
  const modes = unique(options.modes || plan.modes || DOGFOOD_MODES);
  const agentIntegration = options.agentIntegration
    || options.agent_integration
    || runAgentIntegrationDoctor({
      yoloRoot,
      projectRoot,
      homeDir: options.homeDir || options.home_dir,
      targets: options.targets || "both",
      scopes: options.scopes,
      scope: options.scope || options.installScope || options.install_scope || "project",
    });
  const modeEvidence = Object.fromEntries(modes.map((mode) => [mode, evidenceForMode(mode, options)]));
  const modeResults = modes.map((mode) => ({
    mode,
    status: dogfoodModePassed(mode, modeEvidence[mode]) ? "pass" : "blocked",
    evidence: modeEvidence[mode],
  }));
  const dogfoodMatrix = options.dogfoodMatrixReport
    || options.dogfood_matrix_report
    || buildDogfoodMatrixReport({
      plan: options.dogfoodMatrixPlan || options.dogfood_matrix_plan || plan.dogfood_matrix,
      evidenceByScenario: options.dogfoodMatrixEvidence || options.dogfood_matrix_evidence,
      yoloRoot,
      projectRoot,
    });

  const checks = [
    check(
      "REAL_PROJECT_DOGFOOD_NO_SIDE_EFFECTS",
      plan.writes_workspace === false
        && plan.publishes === false
        && plan.reads_credentials === false
        && plan.spawns_provider === false
        && plan.executes_billable_provider === false,
      "real-project dogfood gate must validate evidence only; it must not edit code, publish, read credentials, or execute providers",
    ),
    check(
      "REAL_PROJECT_DOGFOOD_PROJECT_EXISTS",
      existsSync(projectRoot),
      "dogfood project root must exist",
      { project_root: projectRoot },
    ),
    check(
      "REAL_PROJECT_DOGFOOD_EXTERNAL_PROJECT",
      projectRoot !== yoloRoot,
      "dogfood must run against a real target project, not the YOLO package root",
      { project_root: projectRoot, yolo_root: yoloRoot },
    ),
    check(
      "REAL_PROJECT_DOGFOOD_AGENT_INTEGRATION_PASS",
      agentIntegration.status === "pass",
      "native Codex/Claude YOLO integration must pass before real-project dogfood is accepted",
      { agent_integration_status: agentIntegration.status, agent_integration_blockers: (agentIntegration.blockers || []).map((item) => item.code) },
    ),
    check(
      "REAL_PROJECT_DOGFOOD_GENERIC_MATRIX_PASS",
      dogfoodMatrix.status === "pass",
      "generic dogfood matrix must pass with failure scenarios fail-closed",
      {
        matrix_status: dogfoodMatrix.status,
        matrix_blockers: (dogfoodMatrix.blocked_reasons || []).map((item) => item.code),
        missing_evidence: dogfoodMatrix.missing_evidence || [],
      },
    ),
    ...modeResults.map((entry) => check(
      `REAL_PROJECT_DOGFOOD_${entry.mode.toUpperCase()}_PASS`,
      entry.status === "pass",
      `${commandForMode(entry.mode)} dogfood evidence must pass, be linked, and remain no-code/no-provider`,
      { evidence: entry.evidence || null },
    )),
  ];
  const blockers = checks.filter((item) => item.passed !== true);

  return {
    schema_version: REAL_PROJECT_DOGFOOD_SCHEMA_VERSION,
    schema: "yolo.release.real_project_dogfood_result.v1",
    status: blockers.length === 0 ? "pass" : "blocked",
    yolo_root: yoloRoot,
    project_root: projectRoot,
    checks,
    blockers,
    evidence: modeEvidence,
    components: {
      agent_integration: agentIntegration,
      mode_results: modeResults,
      dogfood_matrix: dogfoodMatrix,
    },
    plan,
    guarantees: {
      writes_workspace: false,
      code_edited: false,
      published: false,
      credential_access: false,
      provider_execution: false,
      billable_provider_execution: false,
      dogfood_report_published: false,
    },
    next_actions: blockers.length === 0
      ? ["Promote this real-project lifecycle evidence into the public beta evidence bundle."]
      : [`Run ${modes.map(commandForMode).join(", ")} from an agent chat on a real external project and attach their evidence artifacts.`],
  };
}
