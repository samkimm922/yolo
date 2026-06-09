import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeWarningFingerprint, validateWarningAck, buildWarningAckRequired } from "../src/lib/warning-ack.js";

describe("warning-ack fingerprint", () => {
  test("fingerprint is deterministic and order-independent", () => {
    const a = computeWarningFingerprint(["MISSING_ACCEPTANCE", "WEAK_SCOPE"]);
    const b = computeWarningFingerprint(["WEAK_SCOPE", "MISSING_ACCEPTANCE"]);
    assert.equal(a, b);
  });

  test("fingerprint is exactly 8 hex chars", () => {
    const fp = computeWarningFingerprint(["FOO"]);
    assert.match(fp, /^[0-9a-f]{8}$/);
  });

  test("empty codes produce stable fingerprint", () => {
    const fp = computeWarningFingerprint([]);
    assert.match(fp, /^[0-9a-f]{8}$/);
  });

  test("validateWarningAck returns true for empty warnings (no ack needed)", () => {
    assert.equal(validateWarningAck([], undefined), true);
  });

  test("validateWarningAck returns false when ack is missing", () => {
    assert.equal(validateWarningAck([{ code: "WEAK_SCOPE" }], undefined), false);
  });

  test("validateWarningAck returns false when ack is wrong", () => {
    assert.equal(validateWarningAck([{ code: "WEAK_SCOPE" }], "deadbeef"), false);
  });

  test("validateWarningAck returns true when ack matches fingerprint", () => {
    const warnings = [{ code: "MISSING_ACCEPTANCE" }, { code: "WEAK_SCOPE" }];
    const fp = computeWarningFingerprint(warnings.map((w) => w.code));
    assert.equal(validateWarningAck(warnings, fp), true);
  });

  test("buildWarningAckRequired returns blocked status with correct fingerprint", () => {
    const warnings = [{ code: "FOO" }, { code: "BAR" }];
    const result = buildWarningAckRequired(warnings);
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "WARNING_ACK_REQUIRED");
    assert.match(result.ack_required, /^[0-9a-f]{8}$/);
    assert.ok(result.message.includes(result.ack_required));
    // verify ack_required is correct fingerprint
    assert.equal(result.ack_required, computeWarningFingerprint(["FOO", "BAR"]));
  });
});
