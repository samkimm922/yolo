import { createHash } from "node:crypto";

export const WARNING_ACK_SCHEMA = "yolo.warning_ack.v1";

export function computeWarningFingerprint(codes: string[]): string {
  return createHash("sha256")
    .update([...codes].sort().join(","))
    .digest("hex")
    .slice(0, 8);
}

export function validateWarningAck(warnings: Array<{ code: string }>, ack: string | undefined): boolean {
  if (!warnings.length) return true;
  if (!ack) return false;
  return computeWarningFingerprint(warnings.map((w) => w.code)) === ack;
}

export function buildWarningAckRequired(warnings: Array<{ code: string }>): {
  status: "blocked";
  code: "WARNING_ACK_REQUIRED";
  ack_required: string;
  message: string;
} {
  const fp = computeWarningFingerprint(warnings.map((w) => w.code));
  return {
    status: "blocked",
    code: "WARNING_ACK_REQUIRED",
    ack_required: fp,
    message: `Warnings require explicit acknowledgment. Pass ack_warnings="${fp}" to proceed.`,
  };
}
