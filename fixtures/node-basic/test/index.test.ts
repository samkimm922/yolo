import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/index.ts";

test("add returns the sum of two numbers", () => {
  assert.equal(add(2, 3), 5);
});
