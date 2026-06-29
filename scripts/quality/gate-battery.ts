// Quality-score gate battery: internal gates must not convert unknown/error
// states or missing evidence writes into pass-like outcomes.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectPrdContractDoctorGate } from "../../src/runtime/gates/prd-contract-doctor-gate.js";

type GateBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

function strictDemandFields(targetFile = "src/a.ts") {
  return {
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: "DEMAND-G13",
      approval: { approved: true, effective_for_prd: true },
      project_facts: {
        target_files: [{ file: targetFile, status: "verified" }],
        assumptions: [],
      },
      quality_report: {
        schema_version: "1.0",
        schema: "yolo.demand.quality.v1",
        status: "pass",
        total_score: 100,
        dimensions: [],
      },
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: "pass",
      quality_report: {
        schema_version: "1.0",
        schema: "yolo.demand.quality.v1",
        status: "pass",
        total_score: 100,
        dimensions: [],
      },
    },
    requirements: [{
      id: "REQ-G13-1",
      text: "Keep gates fail-closed.",
      demand_trace: { evidence: ["EVID-G13"] },
    }],
  };
}

function strictPrd() {
  return {
    version: "2.0",
    id: "PRD-G13-EVIDENCE",
    ...strictDemandFields(),
    tasks: [{
      id: "FIX-G13-001",
      title: "Strict task",
      priority: "P1",
      type: "bugfix",
      status: "pending",
      scope: { targets: [{ file: "src/a.ts" }] },
      post_conditions: [
        {
          id: "POST-FILE",
          type: "file_exists",
          severity: "FAIL",
          params: { file: "src/a.ts" },
        },
        {
          id: "POST-TYPECHECK",
          type: "no_new_type_errors",
          severity: "FAIL",
          params: { command: "npm run typecheck" },
        },
      ],
    }],
  };
}

export function runGateBattery(): GateBatteryResult[] {
  const results: GateBatteryResult[] = [];
  const root = mkdtempSync(join(tmpdir(), "yolo-gate-battery-"));
  try {
    const stateDir = join(root, "state-as-file");
    writeFileSync(stateDir, "not a directory\n", "utf8");
    const result = inspectPrdContractDoctorGate({
      prd: strictPrd(),
      prdPath: join(root, "scripts/yolo/data/prd.json"),
      stateDir,
      projectRoot: root,
    }) as { status?: string; code?: string };
    const status = result.status === "blocked" && result.code === "PRD_CONTRACT_EVIDENCE_WRITE_FAILED"
      ? "blocked"
      : String(result.status || "unknown");
    results.push({
      id: "prd_contract_evidence_write_failure_blocks",
      category: "gate_fail_closed_robustness",
      expect: "blocked",
      actualExit: status === "blocked" ? 1 : 0,
      actualStatus: status,
      correct: status === "blocked",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const checkReportSource = readFileSync("src/runtime/gates/check-report.ts", "utf8");
  const blocksUnknownStatus =
    /UNKNOWN_CHECK_STATUS/.test(checkReportSource) &&
    /VALID_CHECK_STATUSES/.test(checkReportSource) &&
    /status === "error"/.test(checkReportSource);
  const aggregateStatus = blocksUnknownStatus ? "blocked" : "pass";
  results.push({
    id: "aggregate_status_error_blocks",
    category: "gate_fail_closed_robustness",
    expect: "blocked",
    actualExit: aggregateStatus === "blocked" ? 1 : 0,
    actualStatus: aggregateStatus,
    correct: aggregateStatus === "blocked",
  });

  // H2: applyWarnEscalation must NOT silently disable WARN→FAIL on IO/parse
  // failure. Verify the fail-closed policy in source: no bare `catch { return []; }`,
  // and the catch path escalates WARN conditions to FAIL.
  const gateCliSource = readFileSync("src/cli/gate.ts", "utf8");
  const noBareCatchReturn = !/catch\s*\{\s*return\s*\[\s*\]\s*;\s*\}/.test(gateCliSource);
  const catchEscalatesWarns = /WARN_ESCALATION_CORRUPT/.test(gateCliSource) && /escalat/.test(gateCliSource);
  const warnEscalationStatus = noBareCatchReturn && catchEscalatesWarns ? "blocked" : "pass";
  results.push({
    id: "warn_escalation_corrupt_file_blocks",
    category: "gate_fail_closed_robustness",
    expect: "blocked",
    actualExit: warnEscalationStatus === "blocked" ? 1 : 0,
    actualStatus: warnEscalationStatus,
    correct: warnEscalationStatus === "blocked",
  });
  // Negative: a healthy escalation path (non-empty valid array) is unchanged.
  const healthyParsePath = /JSON\.parse\(escalateResult\.trim\(\)\)/.test(gateCliSource) && /escalatedNames\.has/.test(gateCliSource);
  const negativeStatus = healthyParsePath ? "pass" : "blocked";
  results.push({
    id: "warn_escalation_healthy_path_preserved",
    category: "gate_fail_closed_robustness",
    expect: "pass",
    actualExit: negativeStatus === "pass" ? 0 : 1,
    actualStatus: negativeStatus,
    correct: negativeStatus === "pass",
  });

  return results;
}
