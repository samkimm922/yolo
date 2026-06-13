import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildUnderstandingPlayback } from "../src/demand/understanding-playback.js";

describe("understanding playback (mutual-understanding alignment before PRD)", () => {
  test("restates collected slots and requires confirmation", () => {
    const session = {
      answers: {
        Q1: { slot: "pain_points", answer: "Deploys take 40 minutes and block the release team every Friday" },
        Q2: { slot: "scope_boundaries", answer: "Do not touch authentication or billing in this change" },
        Q3: { slot: "execution_approval", answer: "批准" },
      },
    };
    const playback = buildUnderstandingPlayback(session);
    assert.equal(playback.confirmation_required, true);
    assert.ok(playback.summary.includes("Deploys take 40 minutes"));
    assert.ok(playback.summary.includes("authentication or billing"));
    // approval is not part of the understanding restatement
    assert.ok(!playback.items.some((item) => item.slot === "execution_approval"));
    assert.match(playback.prompt, /确认|纠正/);
  });

  test("empty session requires no confirmation and prompts for answers", () => {
    const playback = buildUnderstandingPlayback({});
    assert.equal(playback.confirmation_required, false);
    assert.equal(playback.items.length, 0);
  });
});
