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
      "An analyst can transform a CSV export into analysis-ready metric output.",
      { kind: "requirement", id: "REQ-CSV-EXPORT-OBJECT" },
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

  test("register-and-verify is non-atomic (deliverable verb gap)", () => {
    const result = inspectStoryAtomicityText(
      "Allow users to register and verify their email.",
      { kind: "requirement", id: "REQ-REGISTER-VERIFY" },
    );
    assert.equal(result.status, "blocked");
    assert.equal(result.story_count, 2);
    assert.ok(result.finding);
    assert.equal(result.finding.code, "STORY_ATOMICITY_MULTI_STORY");
  });

  test("accept-or-decline invitations is non-atomic", () => {
    const result = inspectStoryAtomicityText(
      "Allow users to accept or decline invitations.",
      { kind: "requirement", id: "REQ-ACCEPT-DECLINE" },
    );
    assert.equal(result.status, "blocked");
    assert.deepEqual(
      result.story_signatures.map((signature) => signature.label),
      ["independent action: accept", "independent action: decline"],
    );
  });

  test("English multi-word connectors now split multi-action stories", () => {
    const cases = [
      { text: "Admins can create users as well as assign roles.", verbs: "create-assign" },
      { text: "The system should create the order as well as send the email.", verbs: "create-send" },
      { text: "Generate the report as well as send it to the team.", verbs: "generate-send" },
      { text: "The system should create the order along with sending the email.", verbs: "create-send" },
      { text: "Users can filter tasks in addition to exporting them.", verbs: "filter-export" },
      { text: "The workflow creates an invoice followed by sending a receipt.", verbs: "create-send" },
    ];

    for (const item of cases) {
      const result = inspectStoryAtomicityText(item.text, { kind: "requirement", id: `REQ-${item.verbs.toUpperCase()}` });
      assert.equal(result.status, "blocked", item.text);
      assert.ok(result.finding, item.text);
      assert.equal(result.finding!.code, "STORY_ATOMICITY_MULTI_STORY", item.text);
    }
  });

  test("multi-word connectors do not falsely split single-action phrases", () => {
    const cases = [
      "Validate the form as well as the inputs.",
      "Filter rows by date as well as time.",
      "Log in with email as well as password.",
    ];

    for (const text of cases) {
      const result = inspectStoryAtomicityText(text, { kind: "requirement", id: "REQ-NEG" });
      assert.equal(result.status, "pass", text);
      assert.equal(result.finding, null, text);
    }
  });

  // P2.18 — missing deliverable verbs (invite, track, publish, request, book, alert, cache, retry)
  test("previously missing deliverable verbs now split multi-action stories", () => {
    const cases = [
      { text: "Managers can create teams and invite members.", verb: "invite" },
      { text: "Editors can publish an article and schedule social posts.", verb: "publish" },
      { text: "The app should cache results and retry failed requests.", verb: "cache/retry" },
      { text: "The system tracks shipments and alerts customers of delays.", verb: "track/alert" },
      { text: "Users can request time off and managers approve it.", verb: "request" },
      { text: "Customers can book a room and cancel the reservation.", verb: "book" },
    ];

    for (const item of cases) {
      const result = inspectStoryAtomicityText(item.text, { kind: "requirement", id: `REQ-${item.verb.toUpperCase()}` });
      assert.equal(result.status, "blocked", item.text);
      assert.ok(result.finding, item.text);
      assert.equal(result.finding!.code, "STORY_ATOMICITY_MULTI_STORY", item.text);
    }
  });

  // P2.19 — missing deliverable verbs (share, review, compose, decrypt, receive)
  test("previously missing deliverable verbs now split multi-action stories", () => {
    const cases = [
      { text: "As a user, I want to upload a document and share it with my team.", verb: "share" },
      { text: "The admin can review submissions and publish approved articles.", verb: "review" },
      { text: "The user can compose a message and send it to multiple recipients.", verb: "compose" },
      { text: "The system must encrypt data at rest and decrypt it on access.", verb: "decrypt" },
      { text: "Customers can book tickets and receive digital receipts.", verb: "receive" },
    ];

    for (const item of cases) {
      const result = inspectStoryAtomicityText(item.text, { kind: "requirement", id: `REQ-${item.verb.toUpperCase()}` });
      assert.equal(result.status, "blocked", item.text);
      assert.ok(result.finding, item.text);
      assert.equal(result.finding!.code, "STORY_ATOMICITY_MULTI_STORY", item.text);
    }
  });
});
