import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStoryAtomicityPrompt,
  parseStoryAtomicityResponse,
  combineStoryCounts,
  llmInspectStories,
} from "../src/demand/llm-atomicity.js";

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

  test("buildStoryAtomicityPrompt numbers the stories and asks for a JSON array", () => {
    const prompt = buildStoryAtomicityPrompt(["A.", "B."]);
    assert.match(prompt, /1\. A\./);
    assert.match(prompt, /2\. B\./);
    assert.match(prompt, /JSON array/);
  });
});
