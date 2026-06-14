import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectLifecycleHookInstallGuard } from "../scripts/ci-guard.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_BRIDGE_PATH = resolve(ROOT, "tools/install-agent-bridge.ts");

describe("ci-guard: BUG-C4 lifecycle-hook install guard", () => {
  test("passes against the committed install-agent-bridge.ts", () => {
    // The committed tools/install-agent-bridge.ts emits PreToolUse + matcher +
    // settings.json + pre-tool-lifecycle-gate reference (BUG-C1).
    const result = inspectLifecycleHookInstallGuard();
    assert.equal(result.status, "pass");
    assert.deepEqual(result.findings, []);
  });

  // Mutation sanity: for each required token, removing it must turn the guard red.
  const REQUIRED_TOKENS = [
    "pre-tool-lifecycle-gate",
    "PreToolUse",
    "Write|Edit|MultiEdit|Bash",
    ".claude/settings.json",
  ];

  for (const token of REQUIRED_TOKENS) {
    test(`mutation sanity: removing "${token}" fails the guard`, () => {
      const original = readFileSync(INSTALL_BRIDGE_PATH, "utf8");
      // Replace the token with an equal-length dummy so the mutation only
      // removes the token, not the surrounding structure.
      const dummy = token.replace(/./g, "X");
      const mutated = original.split(token).join(dummy);
      assert.ok(
        mutated !== original,
        `Test setup failure: token "${token}" not present in committed install-agent-bridge.ts`,
      );
      const result = inspectLifecycleHookInstallGuard({ text: mutated });
      assert.equal(result.status, "fail");
      assert.ok(
        result.findings.some((f) => f.code === "LIFECYCLE_HOOK_INSTALL_TOKEN_MISSING" && f.message.includes(token)),
        `Expected finding for missing token "${token}", got: ${JSON.stringify(result.findings)}`,
      );
    });
  }
});
