import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectStoryAtomicityText } from "../src/demand/story-atomicity.js";

describe("story atomicity generic (domain-agnostic) detection", () => {
  test("auth + email verification + OAuth is non-atomic", () => {
    const result = inspectStoryAtomicityText(
      "Implement user authentication with email verification and OAuth login via Google",
      { kind: "requirement", id: "REQ-AUTH" },
    );
    assert.equal(result.status, "blocked");
    assert.ok(result.finding);
    assert.ok(result.finding.split_suggestions.length > 0);
  });

  test("file parse + validate + upload is non-atomic", () => {
    const result = inspectStoryAtomicityText(
      "Parse the CSV file, validate each row, and upload valid rows to the database",
      { kind: "task", id: "TASK-CSV" },
    );
    assert.equal(result.status, "blocked");
  });

  test("single file read-and-return operation is atomic", () => {
    const result = inspectStoryAtomicityText(
      "Read the configuration file and return parsed JSON",
      { kind: "task", id: "TASK-READ" },
    );
    assert.equal(result.status, "pass");
    assert.equal(result.finding, null);
  });

  test("cross-layer UI+API+DB task is non-atomic", () => {
    const result = inspectStoryAtomicityText(
      "Add a submit button to the form, create a REST endpoint to receive it, and insert a row into the orders table",
      { kind: "task", id: "TASK-XLAYER" },
    );
    assert.equal(result.status, "blocked");
  });

  test("non-kanban single deliverable action passes", () => {
    const result = inspectStoryAtomicityText(
      "Add a retry wrapper around the existing fetch call",
      { kind: "task", id: "TASK-RETRY" },
    );
    assert.equal(result.status, "pass");
    assert.equal(result.finding, null);
  });

  test("non-kanban register-and-notify is non-atomic", () => {
    const result = inspectStoryAtomicityText(
      "Register the new user account and then send a welcome notification email",
      { kind: "task", id: "TASK-REG-NOTIFY" },
    );
    assert.equal(result.status, "blocked");
  });
});
