import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  friendlyPreflightSummary,
  normalizeMenuChoice,
  planToMarkdown,
} from "../tools/yolo-wizard.js";

describe("non-technical YOLO wizard helpers", () => {
  test("normalizes numeric and plain-language menu choices", () => {
    assert.equal(normalizeMenuChoice("1"), "init");
    assert.equal(normalizeMenuChoice("计划"), "plan");
    assert.equal(normalizeMenuChoice("3"), "check");
    assert.equal(normalizeMenuChoice("执行"), "run");
    assert.equal(normalizeMenuChoice("退出"), "quit");
    assert.equal(normalizeMenuChoice("wat"), "unknown");
  });

  test("planToMarkdown renders a readable plan without executing actions", () => {
    const markdown = planToMarkdown({
      status: "success",
      summary: "PI plan created; execution was not started.",
      artifacts: { prdPath: "/tmp/project/.yolo/plans/prd.json" },
      plan: {
        actions: [
          { id: "pi.intake", summary: "Turn requirement into atomic findings." },
          { id: "pi.prd.preflight", summary: "Validate PRD before implementation." },
        ],
      },
      next_actions: ["Review the generated action list."],
    });

    assert.match(markdown, /# YOLO Plan/);
    assert.match(markdown, /prdPath: \/tmp\/project\/\.yolo\/plans\/prd\.json/);
    assert.match(markdown, /pi\.prd\.preflight/);
    assert.match(markdown, /Review the generated action list/);
  });

  test("friendlyPreflightSummary explains pass and blocked states in plain language", () => {
    assert.equal(friendlyPreflightSummary({
      runner_readiness: { can_execute: true, next_actions: ["run"] },
    }).ok, true);

    const blocked = friendlyPreflightSummary({
      blocked_count: 2,
      runner_readiness: { can_execute: false, next_actions: ["fix PRD"] },
    });
    assert.equal(blocked.ok, false);
    assert.match(blocked.title, /2 个阻断项/);
  });
});
