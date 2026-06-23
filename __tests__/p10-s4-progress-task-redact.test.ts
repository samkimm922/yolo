// P10.S4 adversarial test — progress server task data redaction
// Asserts that failReason, phaseDetail, and description fields containing
// credential patterns are masked by redactDeep before being served through
// the progress API.
//
// The fix applies redactDeep to task objects in readPrd() and
// findCurrentRunning() in server.ts. This test verifies the redactDeep
// behavior on the exact data shapes those functions produce.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { redactDeep } from "../src/lib/security/redact.js";

// Shape matches the mapped task objects from readPrd() and findCurrentRunning().
interface TaskShape {
  id: string;
  status: string;
  priority: string;
  description?: string;
  phase: string;
  phaseDetail: string;
  retry: number;
  failReason: string;
  time: string;
  elapsed: number | null;
  [key: string]: unknown;
}

function makeTask(overrides: Partial<TaskShape> = {}): TaskShape {
  return {
    id: "test-task-001",
    status: "failed",
    priority: "P1",
    description: "Some task description",
    phase: "execute",
    phaseDetail: "",
    retry: 0,
    failReason: "",
    time: "2026-06-22T00:00:00.000Z",
    elapsed: null,
    ...overrides,
  };
}

describe("P10.S4 progress server task redact", () => {
  test("redactDeep masks sk- API key in failReason", () => {
    const task = makeTask({
      failReason: "API request failed: sk-test1234567890abcdefghij",
    });
    const safe = redactDeep(task);
    assert.ok(
      !safe.failReason.includes("sk-test1234567890abcdefghij"),
      "sk- key must be redacted in failReason",
    );
    assert.ok(safe.failReason.includes("[REDACTED"));
  });

  test("redactDeep masks Bearer token in phaseDetail", () => {
    const task = makeTask({
      phaseDetail: "Authorization: Bearer s3cretTokenValue12345",
    });
    const safe = redactDeep(task);
    assert.ok(
      !safe.phaseDetail.includes("s3cretTokenValue12345"),
      "Bearer token must be redacted in phaseDetail",
    );
  });

  test("redactDeep masks GitHub token in description", () => {
    const task = makeTask({
      description: "fix: remove ghp_test1234567890abcdefghijklmnopqrstuvwxyz",
    });
    const safe = redactDeep(task);
    assert.ok(
      !safe.description.includes("ghp_test1234567890abcdefghijklmnopqrstuvwxyz"),
      "GitHub token must be redacted in description",
    );
  });

  test("redactDeep masks credential across multiple fields simultaneously", () => {
    const task = makeTask({
      failReason: "invalid sk-key: sk-test9999888877776666",
      phaseDetail: "credential: token=plaintexttokensecret123",
      description: "setup AWS prod with AKIAIOSFODNN7EXAMPLE key",
    });
    const safe = redactDeep(task);
    assert.ok(!safe.failReason.includes("sk-test9999888877776666"));
    assert.ok(!safe.phaseDetail.includes("plaintexttokensecret123"));
    assert.ok(!safe.description.includes("AKIAIOSFODNN7EXAMPLE"));
    assert.ok(safe.failReason.includes("[REDACTED"));
    assert.ok(safe.phaseDetail.includes("[REDACTED"));
    assert.ok(safe.description.includes("[REDACTED"));
  });

  test("redactDeep preserves non-secret fields unchanged", () => {
    const task = makeTask({
      id: "task-42",
      status: "running",
      priority: "P2",
      phase: "review",
      retry: 1,
      failReason: "",
      phaseDetail: "running precheck tests",
      description: "Add user authentication module",
    });
    const safe = redactDeep(task);
    assert.equal(safe.id, "task-42");
    assert.equal(safe.status, "running");
    assert.equal(safe.priority, "P2");
    assert.equal(safe.phase, "review");
    assert.equal(safe.retry, 1);
    assert.equal(safe.description, "Add user authentication module");
    assert.equal(safe.phaseDetail, "running precheck tests");
    assert.equal(safe.failReason, "");
  });

  test("redactDeep handles array of task objects", () => {
    const tasks = [
      makeTask({ failReason: "sk-first1234567890abcdefghij" }),
      makeTask({ phaseDetail: "Bearer secondTokenValue987654321" }),
      makeTask({ description: "use ghp_thirdTokenValueabcdefghijklmnopqrstuvwxyz" }),
    ];
    const safe = redactDeep(tasks);
    for (const t of safe) {
      const json = JSON.stringify(t);
      assert.ok(!json.includes("sk-first1234567890abcdefghij"));
      assert.ok(!json.includes("secondTokenValue987654321"));
      assert.ok(!json.includes("ghp_thirdTokenValueabcdefghijklmnopqrstuvwxyz"));
    }
  });

  test("redactDeep handles raw PRD task shape (nested objects)", () => {
    // This matches the shape of etData.tasks from expanded-tasks.json
    const rawTask = {
      id: "raw-task-001",
      title: "Implement feature X",
      status: "failed",
      phase: "claude",
      phaseDetail: "token=rawtokensecret123",
      failReason: "sk-rawkey1234567890abcdefghij",
      priority: "P0",
      retry: 2,
      updatedAt: "2026-06-22T00:00:00.000Z",
      scope: { targets: [{ file: "src/index.ts" }] },
    };
    const safe = redactDeep(rawTask);
    assert.ok(!safe.phaseDetail.includes("rawtokensecret123"));
    assert.ok(!safe.failReason.includes("sk-rawkey1234567890abcdefghij"));
  });

  test("redactDeep leaves null/undefined tasks unchanged", () => {
    assert.equal(redactDeep(null), null);
    assert.equal(redactDeep(undefined), undefined);
    assert.deepEqual(redactDeep([]), []);
  });
});
