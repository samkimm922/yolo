import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStoryAtomicityPrompt,
  parseStoryAtomicityResponse,
  combineStoryCounts,
  llmInspectStories,
  augmentStoryAtomicityWithLlm,
} from "../src/demand/llm-atomicity.js";

// A minimal heuristic report: one story the heuristic judged atomic (pass).
function heuristicPassReport() {
  return {
    status: "pass",
    inspected: [{ kind: "requirement", id: "REQ-1", status: "pass", story_count: 1 }],
    findings: [],
    finding_count: 0,
    blockers: [],
    warnings: [],
  };
}
const multiVerdict = '[{"index":1,"story_count":2,"slices":["manage roles","manage permissions"]}]';

describe("llm-atomicity", () => {
  test("combineStoryCounts takes the stricter (max) — LLM can only add splits", () => {
    assert.equal(combineStoryCounts(1, 2), 2); // LLM catches a heuristic miss
    assert.equal(combineStoryCounts(3, 1), 3); // heuristic stricter — keep it
    assert.equal(combineStoryCounts(1, undefined), 1); // no LLM verdict — heuristic
    assert.equal(combineStoryCounts(2, 2), 2);
  });

  test("parseStoryAtomicityResponse extracts verdicts from a JSON array (even with prose around it)", () => {
    const stories = ["Allow users to sign up and log in.", "Show the order total."];
    const stdout = 'Here is my analysis:\n[{"index":1,"story_count":2,"slices":["sign up","log in"]},{"index":2,"story_count":1,"slices":[]}]\nDone.';
    const verdicts = parseStoryAtomicityResponse(stdout, stories);
    assert.ok(verdicts);
    assert.equal(verdicts![0].story_count, 2);
    assert.deepEqual(verdicts![0].slices, ["sign up", "log in"]);
    assert.equal(verdicts![1].story_count, 1);
  });

  test("parseStoryAtomicityResponse returns null on garbage / non-JSON", () => {
    assert.equal(parseStoryAtomicityResponse("no json here", ["x"]), null);
    assert.equal(parseStoryAtomicityResponse("[not valid json}", ["x"]), null);
    assert.equal(parseStoryAtomicityResponse("", ["x"]), null);
  });

  test("llmInspectStories: a stub provider lets the LLM catch a multi-story the heuristic could miss", async () => {
    const stories = ["Manage user roles and permissions."];
    const stubSpawn = async () => ({
      success: true,
      stdout: '[{"index":1,"story_count":2,"slices":["manage roles","manage permissions"]}]',
    });
    const verdicts = await llmInspectStories(stories, { spawnProviderPrompt: stubSpawn });
    assert.ok(verdicts);
    assert.equal(verdicts![0].story_count, 2);
    // Combined with a heuristic that judged it atomic (1), stricter-wins yields multi.
    assert.equal(combineStoryCounts(1, verdicts![0].story_count), 2);
  });

  test("llmInspectStories fails open: no provider, provider failure, or garbage → null", async () => {
    assert.equal(await llmInspectStories(["x"], {}), null); // no spawn
    assert.equal(await llmInspectStories(["x"], { spawnProviderPrompt: async () => ({ success: false }) }), null);
    assert.equal(await llmInspectStories(["x"], { spawnProviderPrompt: async () => ({ success: true, stdout: "nope" }) }), null);
    assert.equal(await llmInspectStories(["x"], { spawnProviderPrompt: async () => { throw new Error("boom"); } }), null);
  });

  const items = [{ kind: "requirement", id: "REQ-1", text: "Manage user roles and permissions." }];

  test("augment is a no-op when disabled (default off) — heuristic report returned unchanged", async () => {
    const report = heuristicPassReport();
    const stub = async () => ({ success: true, stdout: multiVerdict });
    const out = await augmentStoryAtomicityWithLlm(report, items, { spawnProviderPrompt: stub }); // enabled omitted
    assert.equal(out, report);
    assert.equal(out.status, "pass");
  });

  test("augment fails open: enabled but provider returns garbage → report unchanged", async () => {
    const report = heuristicPassReport();
    const stub = async () => ({ success: true, stdout: "no json" });
    const out = await augmentStoryAtomicityWithLlm(report, items, { enabled: true, spawnProviderPrompt: stub });
    assert.equal(out.status, "pass");
    assert.equal(out.blockers.length, 0);
  });

  test("augment upgrades a heuristic-pass item to blocked when the LLM catches a multi-story", async () => {
    const report = heuristicPassReport();
    const stub = async () => ({ success: true, stdout: multiVerdict });
    const out = await augmentStoryAtomicityWithLlm(report, items, { enabled: true, spawnProviderPrompt: stub });
    assert.equal(out.status, "blocked");
    assert.equal(out.blockers.length, 1);
    assert.equal((out.blockers[0] as { code?: string }).code, "STORY_ATOMICITY_MULTI_STORY_LLM");
    assert.equal(out.inspected[0].status, "blocked");
    assert.equal(out.inspected[0].story_count, 2);
    assert.equal(out.llm_upgraded_count, 1);
    // never mutates the input report (immutability)
    assert.equal(report.status, "pass");
    assert.equal(report.blockers.length, 0);
  });

  test("augment never downgrades or duplicates an already-blocked heuristic finding", async () => {
    const blocked = {
      status: "blocked",
      inspected: [{ kind: "requirement", id: "REQ-1", status: "blocked", story_count: 2 }],
      findings: [{ code: "STORY_ATOMICITY_MULTI_STORY" }],
      finding_count: 1,
      blockers: [{ code: "STORY_ATOMICITY_MULTI_STORY" }],
      warnings: [],
    };
    const stub = async () => ({ success: true, stdout: multiVerdict });
    const out = await augmentStoryAtomicityWithLlm(blocked, items, { enabled: true, spawnProviderPrompt: stub });
    assert.equal(out, blocked); // unchanged — no upgrade needed
    assert.equal(out.blockers.length, 1);
  });

  test("buildStoryAtomicityPrompt numbers the stories and asks for a JSON array", () => {
    const prompt = buildStoryAtomicityPrompt(["A.", "B."]);
    assert.match(prompt, /1\. A\./);
    assert.match(prompt, /2\. B\./);
    assert.match(prompt, /JSON array/);
  });
});
