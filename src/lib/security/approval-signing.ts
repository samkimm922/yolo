// security/approval-signing.ts — P12.I4: asymmetric signing for approval artifacts
//
// ed25519 signing for release approval artifacts. The public key is committed
// to the repo; the private key lives only in CI (GitHub Actions secret).
//
// Release mode (fail-closed): signature required and must verify.
// Dev mode (advisory): missing/invalid signature warns but does not block.
//
// Canonical JSON is used for stable serialization — sorted keys, no whitespace.
// The signed payload is the approval object WITHOUT the signature fields
// (signature, signature_alg), so signing is idempotent.

import { sign as cryptoSign, verify as cryptoVerify, generateKeyPairSync, createPublicKey, createPrivateKey } from "node:crypto";

export interface ApprovalSignatureResult {
  verified: boolean;
  reason?: string;
  detail?: string;
}

/**
 * Stable JSON serialization — sorted keys, no whitespace.
 * Ensures the signed bytes are identical across runs and runtimes.
 */
export function canonicalApprovalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalApprovalJson).join(",")}]`;
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter((key) => obj[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalApprovalJson(obj[key])}`).join(",")}}`;
}

/**
 * Extract the signable payload from an approval artifact — everything except
 * the signature fields themselves.
 */
export function approvalSignablePayload(approval: Record<string, unknown>): Record<string, unknown> {
  const { signature: _sig, signature_alg: _alg, signature_key_id: _kid, ...rest } = approval;
  void _sig; void _alg; void _kid;
  return rest;
}

/**
 * Sign an approval payload with an ed25519 private key.
 * Returns the hex-encoded signature.
 * Uses crypto.sign(null, ...) — ed25519 does not use a named hash algorithm.
 */
export function signApproval(payload: unknown, privateKeyPem: string): string {
  const data = Buffer.from(canonicalApprovalJson(payload), "utf8");
  const key = createPrivateKey(privateKeyPem);
  return cryptoSign(null, data, key).toString("hex");
}

/**
 * Verify an approval signature against an ed25519 public key.
 * Returns { verified: true } on success, or { verified: false, reason, detail } on failure.
 * Uses crypto.verify(null, ...) — ed25519 does not use a named hash algorithm.
 */
export function verifyApprovalSignature(
  payload: unknown,
  signature: string,
  publicKeyPem: string,
): ApprovalSignatureResult {
  if (!signature || typeof signature !== "string") {
    return { verified: false, reason: "missing_signature", detail: "approval signature is empty or missing" };
  }
  if (!publicKeyPem || typeof publicKeyPem !== "string") {
    return { verified: false, reason: "missing_public_key", detail: "approval public key is not configured" };
  }
  try {
    const data = Buffer.from(canonicalApprovalJson(payload), "utf8");
    const key = createPublicKey(publicKeyPem);
    const sigBuf = Buffer.from(signature, "hex");
    const valid = cryptoVerify(null, data, key, sigBuf);
    if (!valid) {
      return { verified: false, reason: "signature_mismatch", detail: "ed25519 signature does not match public key" };
    }
    return { verified: true };
  } catch (error) {
    return {
      verified: false,
      reason: "verification_error",
      detail: `ed25519 verification failed: ${(error as Error).message}`,
    };
  }
}

/**
 * Generate an ed25519 key pair for setup/testing.
 * Returns { privateKeyPem, publicKeyPem }.
 */
export function generateApprovalKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}
