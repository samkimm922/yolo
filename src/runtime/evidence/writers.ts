import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { inspectPrdContract } from "../gates/prd-contract-doctor.js";
import { gateFailureFingerprint } from "../gates/failure-analysis.js";
import { buildEvidenceArtifact, writeJsonArtifact } from "./ledger.js";
import { isSafePathComponent } from "../../lib/security/path-guard.js";

export { evidenceArtifactDigest } from "./ledger.js";

export function normalizeRepoPath(filePath, projectRoot) {
  const rootPrefix = projectRoot ? `${projectRoot}/` : "";
  return String(filePath || "").replace(rootPrefix, "").replace(/^\.\//, "");
}

export function stripYoloPrefix(filePath) {
  return String(filePath || "").replace(/^scripts\/yolo\//, "");
}

export function taskEvidenceDir(taskId, { yoloRoot }) {
  const id = String(taskId || "");
  if (!isSafePathComponent(id)) {
    throw new Error(`taskEvidenceDir rejected unsafe taskId: ${taskId}`);
  }
  const dir = join(yoloRoot, "state", "evidence", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonEvidence(filePath, evidence) {
  return writeJsonArtifact(filePath, evidence);
}

export function writeTaskEvidence(taskId, fileName, evidence, { yoloRoot, projectRoot }) {
  const evidenceFile = join(taskEvidenceDir(taskId, { yoloRoot }), fileName);
  writeJsonEvidence(evidenceFile, evidence);
  return {
    evidence,
    evidence_path: evidenceFile,
    evidence_file: normalizeRepoPath(evidenceFile, projectRoot),
  };
}

export function buildSplitAppliedEvidence({ parentTask, doctor, childIds, children, now = new Date().toISOString() }) {
  return buildEvidenceArtifact("task.split_applied", {
    task_id: parentTask.id,
    status: "split_applied",
    reason: "atomic_task_must_split",
    source_evidence: doctor.evidence_file || null,
    split_into: childIds,
    children,
  }, { now, source: "runner" });
}

export function writeSplitAppliedEvidence(input, options) {
  const evidence = buildSplitAppliedEvidence(input);
  return writeTaskEvidence(input.parentTask.id, "split-applied.json", evidence, options);
}

export function buildContractSuspectEvidence({
  task,
  prdPath,
  failures,
  history,
  gateExitCode,
  projectRoot,
  now = new Date().toISOString(),
}) {
  const contractQuality = inspectPrdContract({
    version: "2.0",
    id: "PRD-CONTRACT-SUSPECT-TASK",
    tasks: [task],
  });

  return buildEvidenceArtifact("task.contract_suspect", {
    task_id: task.id,
    status: "needs_contract_review",
    reason: "same_contract_condition_failed_repeatedly",
    gate_exit_code: gateExitCode,
    fingerprint: gateFailureFingerprint(failures),
    failed_conditions: failures.map((failure) => ({
      id: failure.id || null,
      type: failure.type || null,
      severity: failure.severity || null,
      detail: failure.detail || null,
    })),
    history: history.slice(-5),
    contract_quality: contractQuality,
    suggested_contract_patches: (contractQuality.failures || [])
      .filter((failure) => failure.task_id === task.id && failure.suggestion)
      .map((failure) => ({
        failed_condition_id: failure.condition_id || null,
        replace_with: failure.suggestion,
    })),
    current_prd: stripYoloPrefix(normalizeRepoPath(prdPath, projectRoot)),
    next_action: "review_contract_before_rerun",
  }, { now, source: "runner" });
}

export function writeContractSuspectEvidence(input, options) {
  const evidence = buildContractSuspectEvidence({ ...input, projectRoot: options.projectRoot });
  return writeTaskEvidence(input.task.id, "contract-suspect.json", evidence, options);
}

export function buildPrdContractDoctorEvidence({
  prd,
  prdPath,
  result,
  projectRoot,
  now = new Date().toISOString(),
}) {
  return buildEvidenceArtifact("prd.contract_doctor", {
    prd: stripYoloPrefix(normalizeRepoPath(prdPath, projectRoot)),
    ...result,
  }, { now, source: "runner" });
}

export function writePrdContractDoctorEvidence(input, { stateDir, projectRoot }) {
  const evidence = buildPrdContractDoctorEvidence({ ...input, projectRoot });
  const evidenceFile = join(stateDir, "evidence", "prd-contract-doctor", `${input.prd.id || "prd"}-${Date.now()}.json`);
  writeJsonEvidence(evidenceFile, evidence);
  return {
    evidence,
    evidence_path: evidenceFile,
    evidence_file: normalizeRepoPath(evidenceFile, projectRoot),
  };
}
