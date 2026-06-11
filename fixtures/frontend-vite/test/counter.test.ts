import { test } from "node:test";
import assert from "node:assert/strict";
import { counterLabel } from "../src/counter.js";

test("counterLabel formats the count", () => {
  assert.equal(counterLabel(3), "Count: 3");
});
