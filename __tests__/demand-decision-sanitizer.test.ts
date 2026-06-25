import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDemandDiscussRuntime } from "../src/demand/runtime.js";

describe("demand decision sanitizer", () => {
  test("preserves repo-relative file paths with dotted extensions", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-path-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/visible-result.ts"), "export const ready = true;\n", "utf8");

      const result: any = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Expose a visible readiness result for release operators.",
        target_users: ["release operator"],
        status_quo: ["Release readiness is checked with npm run typecheck."],
        evidence: ["The TypeScript project already verifies with npm run typecheck."],
        success_criteria: ["Release operators can verify the readiness helper in src/visible-result.ts."],
        proof: ["npm run typecheck exits 0 for src/visible-result.ts."],
        constraints: ["Keep the implementation in src/visible-result.ts."],
        non_goals: ["Do not change package publishing."],
        target_files: ["src/visible-result.ts"],
        decisions: ["Use src/visible-result.ts as the code surface for the readiness helper."],
        roadmap: ["MVP is the visible readiness helper."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: false,
      });

      const decisionText = result.session.discussion.decisions.map((decision) => decision.text).join("\n");
      assert.match(decisionText, /src\/visible-result\.ts/);
      assert.doesNotMatch(decisionText, /visible-the approved field/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
