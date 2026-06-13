import { test } from "node:test";
import assert from "node:assert/strict";
import { appSummary } from "./src/index.js";

test("appSummary uses the shared utility", () => {
  assert.equal(appSummary(2, 4), "total=6");
});
