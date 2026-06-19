import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inspectStoryAtomicityText, splitGenericStorySlices } from "../src/demand/story-atomicity.js";

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
  test("generic splitter slices four unrelated greenfield action enumerations", () => {
    const cases = [
      {
        text: "The local tool supports add/list/done/rm/stats flows; persisted state survives another run; invalid input returns clear errors.",
        expected: 7,
      },
      {
        text: "The REST service supports shorten/redirect/stats flows for generated URLs.",
        expected: 3,
      },
      {
        text: "The Markdown repository can parse/tag/index/search note files.",
        expected: 4,
      },
      {
        text: "The data pipeline can load/clean/aggregate/export CSV rows.",
        expected: 4,
      },
    ];

    for (const item of cases) {
      const slices = splitGenericStorySlices(item.text);
      assert.equal(slices.length, item.expected, item.text);
      for (const slice of slices) {
        assert.equal(inspectStoryAtomicityText(slice, { kind: "requirement", id: "REQ-SLICE" }).status, "pass", slice);
      }
    }
  });

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

  test("single cohesive action with internal operands is atomic", () => {
    const cases = [
      "Log in with email and password",
      "Filter and sort rows by date",
      "Validate the request with token and timestamp",
    ];

    for (const text of cases) {
      const result = inspectStoryAtomicityText(text, { kind: "task", id: "TASK-COHESIVE" });
      assert.equal(result.status, "pass", text);
      assert.equal(result.finding, null, text);
      assert.deepEqual(splitGenericStorySlices(text), [text], text);
    }
  });

  test("modal verb inside a normal sentence is not a command-list cue", () => {
    const result = inspectStoryAtomicityText(
      "A new project can initialize local files and produce its first executable artifact.",
      { kind: "requirement", id: "REQ-BOOTSTRAP" },
    );

    assert.equal(result.status, "pass");
  });

  test("hyphenated capability adjectives do not create extra stories", () => {
    const result = inspectStoryAtomicityText(
      "When a CSV export is provided, the data pipeline can export CSV rows and return report-ready metric JSON.",
      { kind: "requirement", id: "REQ-REPORT-READY" },
    );

    assert.equal(result.status, "pass");
  });

  test("data object nouns do not create capability warnings", () => {
    const result = inspectStoryAtomicityText(
      "An analyst can transform a CSV export into analysis-ready metric output and verify repeatable totals.",
      { kind: "requirement", id: "REQ-CSV-EXPORT-OBJECT" },
    );

    assert.equal(result.status, "pass");
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
