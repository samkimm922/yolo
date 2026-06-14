// P12.I4 adversarial tests — ed25519 approval signature signing/verification
// Asserts:
//   1. signApproval produces a verifiable signature for the correct payload.
//   2. verifyApprovalSignature rejects tampered payloads.
//   3. verifyApprovalSignature rejects wrong-key signatures.
//   4. verifyApprovalSignature rejects missing/empty signatures.
//   5. canonicalApprovalJson is stable regardless of key insertion order.
//   6. approvalSignablePayload strips signature fields.

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import {
  signApproval,
  verifyApprovalSignature,
  canonicalApprovalJson,
  approvalSignablePayload,
  generateApprovalKeyPair,
} from "../src/lib/security/approval-signing.js";

describe("P12.I4 ed25519 approval signing", () => {
  let keyPair: { privateKeyPem: string; publicKeyPem: string };
  let otherKeyPair: { privateKeyPem: string; publicKeyPem: string };

  before(() => {
    keyPair = generateApprovalKeyPair();
    otherKeyPair = generateApprovalKeyPair();
  });

  test("happy path: sign and verify the same payload", () => {
    const payload = { approved: true, approver: "release-owner", approved_at: "2026-06-14T00:00:00Z" };
    const signature = signApproval(payload, keyPair.privateKeyPem);
    const result = verifyApprovalSignature(payload, signature, keyPair.publicKeyPem);
    assert.equal(result.verified, true);
  });

  test("rejects tampered payload (field changed)", () => {
    const original = { approved: true, approver: "release-owner" };
    const signature = signApproval(original, keyPair.privateKeyPem);
    const tampered = { approved: false, approver: "release-owner" };
    const result = verifyApprovalSignature(tampered, signature, keyPair.publicKeyPem);
    assert.equal(result.verified, false);
    assert.equal(result.reason, "signature_mismatch");
  });

  test("rejects tampered payload (extra field added)", () => {
    const original = { approved: true, approver: "release-owner" };
    const signature = signApproval(original, keyPair.privateKeyPem);
    const tampered = { approved: true, approver: "release-owner", injected: "evil" };
    const result = verifyApprovalSignature(tampered, signature, keyPair.publicKeyPem);
    assert.equal(result.verified, false);
  });

  test("rejects signature from a different private key", () => {
    const payload = { approved: true, approver: "release-owner" };
    const signature = signApproval(payload, otherKeyPair.privateKeyPem);
    const result = verifyApprovalSignature(payload, signature, keyPair.publicKeyPem);
    assert.equal(result.verified, false);
    assert.equal(result.reason, "signature_mismatch");
  });

  test("rejects empty signature", () => {
    const payload = { approved: true };
    const result = verifyApprovalSignature(payload, "", keyPair.publicKeyPem);
    assert.equal(result.verified, false);
    assert.equal(result.reason, "missing_signature");
  });

  test("rejects when public key is missing", () => {
    const payload = { approved: true };
    const signature = signApproval(payload, keyPair.privateKeyPem);
    const result = verifyApprovalSignature(payload, signature, "");
    assert.equal(result.verified, false);
    assert.equal(result.reason, "missing_public_key");
  });

  test("rejects malformed public key", () => {
    const payload = { approved: true };
    const signature = signApproval(payload, keyPair.privateKeyPem);
    const result = verifyApprovalSignature(payload, signature, "not-a-valid-key");
    assert.equal(result.verified, false);
    assert.equal(result.reason, "verification_error");
  });
});

describe("P12.I4 canonicalApprovalJson stability", () => {
  test("key insertion order does not change output", () => {
    const a = canonicalApprovalJson({ b: 2, a: 1, c: 3 });
    const b = canonicalApprovalJson({ c: 3, a: 1, b: 2 });
    assert.equal(a, b);
    assert.equal(a, `{"a":1,"b":2,"c":3}`);
  });

  test("nested objects are sorted", () => {
    const a = canonicalApprovalJson({ outer: { z: 1, a: 2 } });
    assert.equal(a, `{"outer":{"a":2,"z":1}}`);
  });

  test("arrays preserve order", () => {
    const a = canonicalApprovalJson([3, 1, 2]);
    assert.equal(a, `[3,1,2]`);
  });

  test("undefined fields are excluded", () => {
    const a = canonicalApprovalJson({ a: 1, b: undefined, c: 3 });
    assert.equal(a, `{"a":1,"c":3}`);
  });
});

describe("P12.I4 approvalSignablePayload strips signature fields", () => {
  test("removes signature, signature_alg, signature_key_id", () => {
    const approval = {
      approved: true,
      approver: "release-owner",
      signature: "abc123",
      signature_alg: "ed25519",
      signature_key_id: "approval-2026",
    };
    const payload = approvalSignablePayload(approval);
    assert.deepEqual(payload, { approved: true, approver: "release-owner" });
    assert.equal("signature" in payload, false);
    assert.equal("signature_alg" in payload, false);
    assert.equal("signature_key_id" in payload, false);
  });

  test("sign + verify round-trip through approvalSignablePayload", () => {
    const approval = {
      approved: true,
      approver: "release-owner",
      signature_alg: "ed25519",
    };
    const payload = approvalSignablePayload(approval);
    const signature = signApproval(payload, keyPairForRoundTrip.privateKeyPem);
    const result = verifyApprovalSignature(payload, signature, keyPairForRoundTrip.publicKeyPem);
    assert.equal(result.verified, true);
  });
});

// Shared key pair for round-trip test
const keyPairForRoundTrip = generateApprovalKeyPair();
