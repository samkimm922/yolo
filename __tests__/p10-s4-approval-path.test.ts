// P10.S4 adversarial tests — approval artifact path containment
// Asserts that approvalArtifact paths resolving outside project/state root
// are rejected (not read), and that in-root approval artifacts still work.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

describe("P10.S4 approval artifact path containment", () => {
  let mod: any;
  let tmpRoot: string;
  let stateRoot: string;

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "yolo-p10-s4-approval-"));
    stateRoot = join(tmpRoot, ".yolo");
    mkdirSync(join(stateRoot, "lifecycle"), { recursive: true });
    // Write a legitimate approval artifact
    writeFileSync(
      join(stateRoot, "lifecycle", "acceptance-approval.json"),
      JSON.stringify({
        approval: { approved: true, approved_at: "2026-06-13T10:00:00Z", approver: "test" },
      }),
      "utf8",
    );
  });

  after(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  test.before(async () => {
    mod = await import("../src/runtime/acceptance/report.js");
  });

  test("happy path: in-root approval artifact is read", () => {
    const report = mod.buildAcceptanceReport({
      projectRoot: tmpRoot,
      stateRoot,
      mode: "ship",
      prd: { tasks: [] },
      runReport: { status: "success", run_id: "r1", summary: { planned: 1, completed: 1, failed: 0, blocked: 0 } },
      approvalArtifact: join(stateRoot, "lifecycle", "acceptance-approval.json"),
    });
    // Should not have the path-outside-root error
    const pathErrors = (report.issues || []).filter((i: any) => i.code === "ACCEPTANCE_WARNING_APPROVAL_PATH_OUTSIDE_ROOT");
    assert.equal(pathErrors.length, 0, "in-root approval artifact should not trigger path escape error");
  });

  test("rejects /etc/hosts as approval artifact path", () => {
    const report = mod.buildAcceptanceReport({
      projectRoot: tmpRoot,
      stateRoot,
      mode: "ship",
      prd: { tasks: [] },
      runReport: { status: "success", run_id: "r1", summary: { planned: 1, completed: 1, failed: 0, blocked: 0 } },
      approvalArtifact: "/etc/hosts",
    });
    const pathErrors = (report.issues || []).filter((i: any) => i.code === "ACCEPTANCE_WARNING_APPROVAL_PATH_OUTSIDE_ROOT");
    assert.ok(pathErrors.length > 0, "/etc/hosts must be rejected as out-of-root");
  });

  test("rejects ../../escape as approval artifact path", () => {
    const report = mod.buildAcceptanceReport({
      projectRoot: tmpRoot,
      stateRoot,
      mode: "ship",
      prd: { tasks: [] },
      runReport: { status: "success", run_id: "r1", summary: { planned: 1, completed: 1, failed: 0, blocked: 0 } },
      approvalArtifact: join(stateRoot, "../../../etc/hosts"),
    });
    const pathErrors = (report.issues || []).filter((i: any) => i.code === "ACCEPTANCE_WARNING_APPROVAL_PATH_OUTSIDE_ROOT");
    assert.ok(pathErrors.length > 0, "../../escape must be rejected");
  });
});
