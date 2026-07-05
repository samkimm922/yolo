import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  circuitBreakerThreshold,
  hasRepeatedFailure,
} from "../src/runtime/recovery/retry-policy.js";

describe("runtime retry policy", () => {
  test("circuitBreakerThreshold parses positive integer config and warns on invalid values", () => {
    assert.equal(circuitBreakerThreshold({ runner: { circuit_breaker: 3 } }), 3);
    assert.equal(circuitBreakerThreshold({ runner: { circuit_breaker: "4" } }), 4);

    const warnings: string[] = [];
    const warn = (message: string) => warnings.push(message);
    assert.equal(circuitBreakerThreshold({ runner: { circuit_breaker: 0 } }, { warn }), DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
    assert.equal(circuitBreakerThreshold({ runner: { circuit_breaker: -1 } }, { warn }), DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
    assert.equal(circuitBreakerThreshold({ runner: { circuit_breaker: "abc" } }, { warn }), DEFAULT_CIRCUIT_BREAKER_THRESHOLD);
    assert.equal(warnings.length, 3);
    assert.ok(warnings.every((message) => message.includes("runner.circuit_breaker")));
  });

  test("hasRepeatedFailure uses the threshold over the latest consecutive entries", () => {
    const history = ["A", "A"];
    assert.equal(hasRepeatedFailure(history, 3), false);
    assert.equal(hasRepeatedFailure([...history, "A"], 3), true);
    assert.equal(hasRepeatedFailure(["A"], 1), true);
    assert.equal(hasRepeatedFailure(["A", "B", "A"], 2), false);
    assert.equal(hasRepeatedFailure([{ code: "x" }, { code: "x" }], 2, (entry) => entry.code), true);
    assert.equal(hasRepeatedFailure(history, "abc"), true);
  });
});
