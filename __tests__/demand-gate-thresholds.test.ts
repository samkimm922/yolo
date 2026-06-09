import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectDemandQuality, inspectDemandReadiness } from "../src/demand/gate.js";

// 直接锁住 demand gate 的 fail-closed 阈值逻辑（block_score=70, pass_score=85），
// 防止未来阈值或维度评分被悄悄放松。运行时集成测试在 demand-runtime.test.ts。
describe("demand gate fail-closed thresholds", () => {
  test("an empty demand session is blocked with score below the block threshold", () => {
    const result = inspectDemandQuality({}, { phase: "prd", requireTasks: true });
    assert.equal(result.status, "blocked");
    assert.ok(result.total_score < result.block_score, `score ${result.total_score} must be < ${result.block_score}`);
    assert.equal(result.block_score, 70);
    assert.equal(result.pass_score, 85);
    assert.ok(result.blockers.length > 0);
  });

  test("block score and pass score are honored as overrides", () => {
    const result = inspectDemandQuality({}, { phase: "prd", blockScore: 75, passScore: 90 });
    assert.equal(result.block_score, 75);
    assert.equal(result.pass_score, 90);
  });

  test("a vague idea is not demand-ready (L0)", () => {
    const result = inspectDemandReadiness({ idea: "make it better" });
    assert.equal(result.demand_ready, false);
    assert.equal(result.readiness_level, "L0");
  });
});
