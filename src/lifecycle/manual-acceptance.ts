// manual-acceptance.ts — structured manual-acceptance evidence validation.
//
// CR1 fix: this used to accept any evidence whose `signature`/`digest` fields
// were merely non-empty (zero cryptography). A hand-edited acceptance report
// with a 1-char "signature" satisfied delivery. We now perform REAL ed25519
// verification of the signature over the canonical payload
// {task_id, condition_id, accepted_by, accepted_at} against the project-rooted
// committed public key. Failure (bad signature, missing key, missing payload
// fields) → return false (fail-closed). The canonicalize+verify logic lives in
// the shared sibling manual-acceptance-keys.ts so release approvals (CR2) reuse
// the exact same verifier and key.

import {
  verifyManualAcceptanceSignature,
} from "./manual-acceptance-keys.js";

export interface ManualAcceptanceOptions {
  // Project root — used to locate <stateRoot>/keys/manual-acceptance.pub.
  // When omitted, signature verification cannot run and the entry is rejected
  // (fail-closed): we cannot prove a signature is valid without a verifier key.
  projectRoot?: string;
  // State root (defaults to <projectRoot>/.yolo). Carried explicitly so the
  // verifier is independent of process.cwd()/env.
  stateRoot?: string;
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function isStructuredManualAcceptanceEvidence(
  entry: unknown,
  options: ManualAcceptanceOptions = Object(),
): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (record.type !== "manual_acceptance") return false;
  const status = clean(record.status).toLowerCase().replace(/[\s-]+/g, "_");
  // Structural preconditions: the metadata fields must be present and well-formed
  // before we even attempt crypto. These alone are NOT sufficient.
  const structurallyValid = Boolean(
    clean(record.task_id)
    && clean(record.condition_id)
    && clean(record.accepted_by)
    && clean(record.accepted_at)
    && ["accepted", "approved", "pass", "passed"].includes(status),
  );
  if (!structurallyValid) return false;

  // CR1: REAL cryptographic verification. A non-empty signature/digest is no
  // longer enough — the signature must verify against the committed key over the
  // canonical payload. No env-var opt-out: the key is project-rooted and
  // committed, so verification is mandatory whenever manual-acceptance evidence
  // is offered. Any failure → false (the caller blocks delivery).
  const projectRoot = options.projectRoot ? String(options.projectRoot) : "";
  if (!projectRoot) return false;
  const signature = clean(record.signature);
  if (!signature) return false;
  const verify = verifyManualAcceptanceSignature(record, signature, projectRoot, options.stateRoot);
  return verify.verified;
}
