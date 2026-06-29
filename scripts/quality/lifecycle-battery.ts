import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { inspectLifecycleGuard } from "../../src/lifecycle/guard.js";
import { initLifecycleState } from "../../src/lifecycle/state.js";
import { writeLifecycleStageReport } from "../../src/lifecycle/progress.js";
import { signApproval } from "../../src/lib/security/approval-signing.js";
import { isStructuredManualAcceptanceEvidence } from "../../src/lifecycle/manual-acceptance.js";
import { manualAcceptanceSignable } from "../../src/lifecycle/manual-acceptance-keys.js";

type LifecycleBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

// Repo root (where the committed dev keypair lives under state/keys/).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function writeText(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

function lifecycleOptions(root: string) {
  return {
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    source: "lifecycle-battery",
    writeSessionMemory: false,
    skipSequenceCheck: true,
  };
}

function setupReadyForDelivery(root: string) {
  initLifecycleState({ projectRoot: root });
  writeText(join(root, "state", "run", "run-evidence.json"), "{\"ok\":true}\n");
  writeText(join(root, "state", "review", "review-evidence.json"), "{\"ok\":true}\n");
  writeText(join(root, "state", "acceptance", "evidence.json"), "{\"ok\":true}\n");
  writeLifecycleStageReport("run", {
    status: "success",
    evidence: [{ path: "state/run/run-evidence.json" }],
  }, lifecycleOptions(root));
  writeLifecycleStageReport("review-fix", {
    status: "success",
    findings: [],
    evidence: [{ path: "state/review/review-evidence.json" }],
  }, lifecycleOptions(root));
}

export function runLifecycleBattery(): LifecycleBatteryResult[] {
  const results: LifecycleBatteryResult[] = [];
  const root = mkdtempSync(join(tmpdir(), "yolo-lifecycle-battery-"));
  try {
    setupReadyForDelivery(root);
    writeLifecycleStageReport("acceptance", {
      status: "pass",
      summary: "forged manual acceptance should not satisfy delivery",
      evidence: [
        { path: "state/acceptance/evidence.json" },
        {
          type: "manual_acceptance",
          task_id: "T1",
          condition_id: "AC-1",
          path: "state/acceptance/evidence.json",
        },
      ],
      manual_criteria: [{ task_id: "T1", condition_id: "AC-1", text: "Product owner signs off." }],
    }, lifecycleOptions(root));

    const result = inspectLifecycleGuard({
      command: "yolo-ship",
      projectRoot: root,
      stateRoot: join(root, ".yolo"),
    }) as { status?: string };
    const status = result.status === "pass" ? "pass" : "blocked";
    results.push({
      id: "manual_acceptance_requires_signature_fields",
      category: "lifecycle_manual_acceptance_safety",
      expect: "blocked",
      actualExit: status === "pass" ? 0 : 1,
      actualStatus: status,
      correct: status === "blocked",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // CR1: a 1-char (garbage) signature must NOT satisfy manual acceptance —
  // real ed25519 verification against the committed key is required.
  results.push(runGarbageSignatureCase());
  // CR1 negative: a real signed manual-acceptance entry over the canonical
  // payload must pass verification (and lift the manual-criteria block).
  results.push(runRealSignedEvidenceCase());

  return results;
}

// CR1 direct checks against the verifier (no full lifecycle needed): isolate
// the cryptographic gate so the battery is fast and unambiguous.
function committedDevPrivateKey(): string {
  // The committed dev private key signs test evidence; the matching public key
  // is what the verifier trusts (project-rooted, committed).
  return readFileSync(join(REPO_ROOT, "state", "keys", "manual-acceptance.dev.key"), "utf8");
}

function installTrustedPublicKey(root: string) {
  const pub = readFileSync(join(REPO_ROOT, "state", "keys", "manual-acceptance.pub"), "utf8");
  writeText(join(root, ".yolo", "keys", "manual-acceptance.pub"), pub);
}

function runGarbageSignatureCase(): LifecycleBatteryResult {
  const root = mkdtempSync(join(tmpdir(), "yolo-lifecycle-garbage-"));
  try {
    installTrustedPublicKey(root);
    const entry = {
      type: "manual_acceptance",
      status: "accepted",
      task_id: "T1",
      condition_id: "AC-1",
      accepted_by: "owner",
      accepted_at: "2026-06-29T00:00:00Z",
      signature: "x", // garbage 1-char signature — must NOT verify
      digest: "deadbeef",
    };
    const verified = isStructuredManualAcceptanceEvidence(entry, { projectRoot: root, stateRoot: join(root, ".yolo") });
    const status = verified ? "pass" : "blocked";
    return {
      id: "manual_acceptance_garbage_signature_blocks",
      category: "lifecycle_manual_acceptance_safety",
      expect: "blocked",
      actualExit: verified ? 0 : 1,
      actualStatus: status,
      correct: status === "blocked",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runRealSignedEvidenceCase(): LifecycleBatteryResult {
  const root = mkdtempSync(join(tmpdir(), "yolo-lifecycle-signed-"));
  try {
    installTrustedPublicKey(root);
    const entry: Record<string, unknown> = {
      type: "manual_acceptance",
      status: "accepted",
      task_id: "T2",
      condition_id: "AC-2",
      accepted_by: "owner",
      accepted_at: "2026-06-29T00:00:00Z",
    };
    const payload = manualAcceptanceSignable(entry)!;
    const signature = signApproval(payload, committedDevPrivateKey());
    entry.signature = signature;
    const verified = isStructuredManualAcceptanceEvidence(entry, { projectRoot: root, stateRoot: join(root, ".yolo") });
    const status = verified ? "pass" : "blocked";
    return {
      id: "manual_acceptance_real_signed_passes",
      category: "lifecycle_manual_acceptance_safety",
      expect: "pass",
      actualExit: verified ? 0 : 1,
      actualStatus: status,
      correct: status === "pass",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
