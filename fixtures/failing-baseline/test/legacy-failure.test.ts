import { test } from "node:test";
import assert from "node:assert/strict";

test("known legacy failure", () => {
  assert.equal("old bug", "fixed behavior");
});
