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

  test("synthesizes a day-in-the-life scene instead of echoing the raw answer", () => {
    const rawDay = "成员维护自己的待办；负责人查看所有人的任务。";
    const session = {
      objective: "让团队成员给待办分类，并在到期前收到提醒。",
      answers: {
        target: { slot: "target_users", answer: "每天维护待办的团队成员和项目负责人" },
        current: { slot: "status_quo", answer: "现在靠标题前缀分类，每天下班前人工翻日期" },
        pain: { slot: "pain_points", answer: "经常找不到同类任务，也会错过到期时间" },
        day: { slot: "day_in_life", answer: rawDay },
        outcome: { slot: "desired_outcome", answer: "按标签筛选，并在到期前看到提醒" },
      },
    };

    const playback = buildUnderstandingPlayback(session);
    assert.equal(playback.scene?.actor, "每天维护待办的团队成员和项目负责人");
    assert.match(playback.summary, /每天|打开|看到|然后/);
    assert.match(playback.summary, /标签|到期|提醒/);
    assert.notEqual(playback.summary.trim(), rawDay);
    assert.equal(playback.items.some((item) => item.understanding === rawDay), false);
  });

  test("keeps a sha256 confirmation contract bound to synthesized scene content", () => {
    const base = {
      objective: "给待办增加标签和到期提醒",
      answers: {
        target: { slot: "target_users", answer: "每天维护待办的团队成员" },
        outcome: { slot: "desired_outcome", answer: "按标签筛选并在到期前看到提醒" },
      },
    };
    const first = buildUnderstandingPlayback(base);
    const same = buildUnderstandingPlayback(structuredClone(base));
    const changed = buildUnderstandingPlayback({
      ...base,
      answers: {
        ...base.answers,
        outcome: { slot: "desired_outcome", answer: "按标签筛选并在到期当天看到提醒" },
      },
    });

    assert.match(first.content_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.confirmation_contract.algorithm, "sha256");
    assert.equal(first.confirmation_contract.expected_content_hash, first.content_hash);
    assert.equal(first.content_hash, same.content_hash);
    assert.notEqual(first.content_hash, changed.content_hash);
  });
});
