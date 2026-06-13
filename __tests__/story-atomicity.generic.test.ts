import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectStoryAtomicityText } from "../src/demand/story-atomicity.js";

interface StoryAtomicityFinding {
  code: string;
  severity: string;
  kind: string;
  item_id: string | null;
  task_id: string | null;
  requirement_id: string | null;
  scenario_id: string | null;
  message: string;
  text_excerpt: string;
  story_count: number;
  story_signatures: { id: string; label: string }[];
  split_suggestions?: string[];
  capability_nouns?: string[];
}

function hasFindingProps(
  finding: StoryAtomicityFinding | null,
  _props: string[],
): finding is StoryAtomicityFinding & Record<string, unknown> {
  return finding !== null;
}

describe("story atomicity generic (domain-agnostic) detection", () => {
  test("auth + email verification + OAuth is non-atomic", () => {
    const result = inspectStoryAtomicityText(
      "Implement user authentication with email verification and OAuth login via Google",
      { kind: "requirement", id: "REQ-AUTH" },
    );
    assert.equal(result.status, "blocked");
    assert.ok(result.finding);
    assert.ok(result.finding && "split_suggestions" in result.finding && result.finding.split_suggestions!.length > 0);
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

  // P2.17 — capability noun signals with single verb → warn (investigate_then_patch)
  test("single verb + 支付 capability noun warns instead of passing", () => {
    const result = inspectStoryAtomicityText(
      "实现支付功能",
      { kind: "task", id: "TASK-PAYMENT" },
    );
    assert.equal(result.status, "warn");
    assert.ok(result.finding);
    assert.equal(result.finding.code, "STORY_ATOMICITY_CAPABILITY_NOUN");
    assert.ok(result.finding && "capability_nouns" in result.finding && (result.finding as { capability_nouns: string[] }).capability_nouns.includes("支付"));
  });

  test("single verb + 权限 capability noun warns", () => {
    const result = inspectStoryAtomicityText(
      "添加权限控制",
      { kind: "requirement", id: "REQ-PERMISSION" },
    );
    assert.equal(result.status, "warn");
    assert.equal(result.finding.code, "STORY_ATOMICITY_CAPABILITY_NOUN");
    assert.ok(result.finding && "capability_nouns" in result.finding && (result.finding as { capability_nouns: string[] }).capability_nouns.some((n: string) => n.includes("权限") || n.includes("permission")));
  });

  test("single verb without capability noun still passes", () => {
    const result = inspectStoryAtomicityText(
      "修复按钮点击后颜色不变化的问题",
      { kind: "task", id: "TASK-BUTTON-COLOR" },
    );
    assert.equal(result.status, "pass");
    assert.equal(result.finding, null);
  });

  test("single verb + English payment capability noun warns", () => {
    const result = inspectStoryAtomicityText(
      "Implement payment processing",
      { kind: "task", id: "TASK-PAY-EN" },
    );
    assert.equal(result.status, "warn");
    assert.equal(result.finding.code, "STORY_ATOMICITY_CAPABILITY_NOUN");
    assert.ok(result.finding && "capability_nouns" in result.finding && (result.finding as { capability_nouns: string[] }).capability_nouns.includes("payment"));
  });

  test("single verb + 配置 capability noun warns", () => {
    const result = inspectStoryAtomicityText(
      "添加系统配置功能",
      { kind: "task", id: "TASK-CONFIG" },
    );
    assert.equal(result.status, "warn");
    assert.equal(result.finding.code, "STORY_ATOMICITY_CAPABILITY_NOUN");
    assert.ok(result.finding && "capability_nouns" in result.finding && (result.finding as { capability_nouns: string[] }).capability_nouns.some((n: string) => n.includes("配置") || n.includes("config")));
  });

  test("capability noun with zero verbs does not warn (no verb to flag)", () => {
    const result = inspectStoryAtomicityText(
      "支付系统权限配置",
      { kind: "requirement", id: "REQ-NOUNS-ONLY" },
    );
    // No deliverable verb → no single-verb signal → passes atomicity
    assert.equal(result.status, "pass");
    assert.equal(result.finding, null);
  });

  test("multiple verbs with capability noun still blocked by existing multi-story detection", () => {
    const result = inspectStoryAtomicityText(
      "实现支付功能并添加退款处理",
      { kind: "task", id: "TASK-MULTI-PAY" },
    );
    // Two verbs (实现 + 添加) → blocked by multi-story detection, not warn
    assert.equal(result.status, "blocked");
  });

  test("single verb + search capability noun warns", () => {
    const result = inspectStoryAtomicityText(
      "实现全文搜索功能",
      { kind: "task", id: "TASK-SEARCH" },
    );
    assert.equal(result.status, "warn");
    assert.equal(result.finding.code, "STORY_ATOMICITY_CAPABILITY_NOUN");
  });
});
