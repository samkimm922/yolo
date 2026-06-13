import { inspectPrdContract } from "./prd-contract-doctor.js";
import { createPrdMigrationAdvice } from "../../prd/migration.js";
import {
  normalizeRepoPath,
  stripYoloPrefix,
  writePrdContractDoctorEvidence,
} from "../evidence/writers.js";

function prdRef(prdPath, projectRoot) {
  return stripYoloPrefix(normalizeRepoPath(prdPath, projectRoot));
}

export function inspectPrdContractDoctorGate({ prd, prdPath, stateDir, projectRoot }) {
  const ref = prdRef(prdPath, projectRoot);

  if (prd.execution_mode === "planning_only") {
    return {
      status: "blocked",
      code: "PLANNING_ONLY_PRD",
      exit_code: 1,
      message: `[prd-contract-doctor] BLOCKED planning_only PRD cannot be executed: ${normalizeRepoPath(prdPath, projectRoot)}`,
      doctor: null,
      migration: null,
      evidence_file: null,
      evidence_path: null,
      messages: [],
    };
  }

  const doctor = inspectPrdContract(prd, {
    mode: "runner",
    strictExecution: true,
    requireDemandContract: true,
    projectRoot,
  });
  let evidenceFile = null;
  let evidencePath = null;
  try {
    const evidenceResult = writePrdContractDoctorEvidence({ prd, prdPath, result: doctor }, {
      stateDir,
      projectRoot,
    });
    evidenceFile = evidenceResult.evidence_file;
    evidencePath = evidenceResult.evidence_path;
  } catch {
    evidenceFile = null;
    evidencePath = null;
  }

  if (doctor.blocks_execution) {
    const migration = createPrdMigrationAdvice(prd, ref);
    return {
      status: "blocked",
      code: "PRD_CONTRACT_BLOCKED",
      exit_code: 1,
      message: "PRD contract doctor blocked execution",
      doctor,
      migration,
      evidence_file: evidenceFile,
      evidence_path: evidencePath,
      messages: formatPrdContractDoctorGateMessages({ doctor, migration, evidenceFile }),
    };
  }

  if (doctor.warning_count > 0) {
    return {
      status: "warning",
      code: "PRD_CONTRACT_WARNING",
      exit_code: 0,
      message: `PRD contract doctor passed with ${doctor.warning_count} warning(s)`,
      doctor,
      migration: null,
      evidence_file: evidenceFile,
      evidence_path: evidencePath,
      messages: [`[prd-contract-doctor] warning=${doctor.warning_count} evidence=${evidenceFile || "(evidence write failed)"}`],
    };
  }

  return {
    status: "pass",
    code: "PRD_CONTRACT_PASS",
    exit_code: 0,
    message: "PRD contract doctor passed",
    doctor,
    migration: null,
    evidence_file: evidenceFile,
    evidence_path: evidencePath,
    messages: [],
  };
}

export function formatPrdContractDoctorGateMessages({ doctor, migration, evidenceFile }) {
  const lines = [`[prd-contract-doctor] BLOCKED ${doctor.failure_count} contract quality failures`];
  for (const failure of doctor.failures.slice(0, 8)) {
    lines.push(`  - ${failure.task_id}: ${failure.code} ${failure.detail}`);
    if (failure.suggestion) lines.push(`    suggestion: ${JSON.stringify(failure.suggestion)}`);
  }
  if (migration?.available) {
    lines.push(`  migration dry-run: ${migration.dry_run_command}`);
    lines.push(`  migration apply: ${migration.apply_command}`);
    lines.push(`  migration would_fix_contract=${migration.would_fix_contract} added=${migration.added_count}`);
  }
  lines.push(`  evidence: ${evidenceFile || "(evidence write failed)"}`);
  return lines;
}
