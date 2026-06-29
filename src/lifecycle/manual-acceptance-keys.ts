// manual-acceptance-keys.ts — shared ed25519 verification for manual-acceptance
// evidence and release approvals (CR1 + CR2).
//
// Both surfaces must verify signatures against the SAME project-rooted,
// committed public key — never gated on an optional env var. The committed
// public key lives at <stateRoot>/keys/manual-acceptance.pub (a project-rooted,
// tracked secret). Fail-closed: if the key is missing/unreadable, verification
// fails (callers block), because we cannot prove a signature is valid without a
// trusted verifier key.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  canonicalApprovalJson,
  verifyApprovalSignature,
} from "../lib/security/approval-signing.js";

export const MANUAL_ACCEPTANCE_PUBKEY_REL = "keys/manual-acceptance.pub";

/**
 * Canonical, signed payload for a manual-acceptance evidence entry.
 * Only these four fields are integrity-protected; everything else (type,
 * status, path, signature, digest) is metadata that must not be trusted
 * without a valid signature over the canonical tuple.
 */
export interface ManualAcceptanceSignable {
  task_id: string;
  condition_id: string;
  accepted_by: string;
  accepted_at: string;
}

/**
 * Build the canonical signable payload from an arbitrary evidence record.
 * Returns null if any of the four required fields is empty/non-string.
 */
export function manualAcceptanceSignable(
  entry: Record<string, unknown>,
): ManualAcceptanceSignable | null {
  const taskId = cleanField(entry.task_id);
  const conditionId = cleanField(entry.condition_id);
  const acceptedBy = cleanField(entry.accepted_by);
  const acceptedAt = cleanField(entry.accepted_at);
  if (!taskId || !conditionId || !acceptedBy || !acceptedAt) return null;
  return { task_id: taskId, condition_id: conditionId, accepted_by: acceptedBy, accepted_at: acceptedAt };
}

/**
 * Canonical JSON form of a manual-acceptance signable payload. Stable across
 * runs/runtimes (sorted keys, no whitespace) so the signed bytes are identical
 * at sign time and verify time.
 */
export function canonicalManualAcceptancePayload(entry: Record<string, unknown>): string | null {
  const payload = manualAcceptanceSignable(entry);
  if (!payload) return null;
  return canonicalApprovalJson(payload);
}

/**
 * Resolve the committed public key for a given state root. Returns the PEM
 * string, or null if the key file is missing/unreadable (fail-closed: callers
 * treat null as "cannot verify → block").
 *
 * `stateRoot` defaults to <projectRoot>/.yolo so the key is project-rooted
 * regardless of where the verifier runs.
 */
export function resolveManualAcceptancePublicKey(projectRoot: string, stateRoot?: string): string | null {
  const root = resolve(stateRoot || `${projectRoot}/.yolo`);
  const pubPath = resolve(root, MANUAL_ACCEPTANCE_PUBKEY_REL);
  // Project-rooted: the key must live under the project state root.
  const canonical = pubPath.replace(/\\/g, "/");
  const canonicalRoot = root.replace(/\\/g, "/");
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}/`)) {
    return null;
  }
  if (!existsSync(pubPath)) return null;
  try {
    const pem = readFileSync(pubPath, "utf8").trim();
    if (!pem || !pem.includes("BEGIN PUBLIC KEY")) return null;
    return pem;
  } catch {
    return null;
  }
}

export interface ManualAcceptanceVerifyResult {
  verified: boolean;
  reason?: string;
  detail?: string;
}

/**
 * Verify a manual-acceptance signature over the canonical signable payload
 * against the project-rooted committed public key. Fail-closed on any error.
 */
export function verifyManualAcceptanceSignature(
  entry: Record<string, unknown>,
  signature: string,
  projectRoot: string,
  stateRoot?: string,
): ManualAcceptanceVerifyResult {
  const payload = manualAcceptanceSignable(entry);
  if (!payload) {
    return { verified: false, reason: "missing_payload_fields", detail: "manual-acceptance payload is missing one of task_id/condition_id/accepted_by/accepted_at" };
  }
  const publicKey = resolveManualAcceptancePublicKey(projectRoot, stateRoot);
  if (!publicKey) {
    return { verified: false, reason: "public_key_unavailable", detail: "project-rooted manual-acceptance public key is missing or unreadable" };
  }
  const result = verifyApprovalSignature(payload, signature, publicKey);
  return { verified: result.verified, reason: result.reason, detail: result.detail };
}

function cleanField(value: unknown): string {
  return String(value ?? "").trim();
}
