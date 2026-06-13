import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runDemandStatusRuntime } from "../src/demand/runtime.js";
import {
  DEMAND_EVIDENCE_AGENT_PROTOCOLS,
  inspectDemandPrdReadiness,
  inspectDemandTriage,
  inspectEvidenceAgreement,
} from "../src/demand/router.js";

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface RoutedState {
  context_type: string;
  route: string;
  evidence_policy: string;
  stage: string;
  reason_codes: string[];
  missing_slots: string[];
  needed_evidence_agents: string[];
  next_question: { slot: string; text: string } | null;
  question_queue: { slot: string }[];
  next_action: string;
  prd_ready: boolean;
  submode: string;
}

function assertRoutedState(result: { state: unknown }): asserts result is { state: RoutedState } {
  if (typeof result.state !== "object" || result.state === null || !("context_type" in result.state)) {
    throw new Error("expected routed state with context_type");
  }
}

function projectEvidence(summary: string, why: string, overrides: Record<string, unknown> = {}) {
  return {
    path: "src/api/accounts.ts",
    line: "1",
    scope: "project",
    source: "project_code",
    summary,
    why,
    ...overrides,
  };
}

describe("demand router", () => {
  test("existing project field changes route to careful with cross-check evidence", () => {
    const result = runDemandStatusRuntime({
      objective: "Existing inventory API needs a new lowStockThreshold field on the product schema.",
      target_files: ["src/api/products.ts", "src/models/product.ts"],
      success_criteria: ["API returns lowStockThreshold for product responses."],
    });

    assertRoutedState(result);
    assert.equal(result.state.context_type, "hybrid");
    assert.equal(result.state.route, "careful");
    assert.equal(result.state.evidence_policy, "cross_check");
    assert.ok(result.state.reason_codes.includes("TECHNICAL_CONTRACT_OR_DATA_RISK"));
    assert.deepEqual(result.state.needed_evidence_agents, ["explorer", "cross-checker", "verifier"]);
  });

  test("new product idea stays fast and does not force code audit", () => {
    const result = runDemandStatusRuntime({
      objective: "New habit-tracking app idea for freelance designers.",
      target_users: ["freelance designer"],
      status_quo: ["They track habits in scattered notes."],
      success_criteria: ["They can see today's habit checklist."],
    });

    assertRoutedState(result);
    assert.equal(result.state.context_type, "greenfield");
    assert.equal(result.state.route, "fast");
    assert.equal(result.state.evidence_policy, "none");
    assert.deepEqual(result.state.needed_evidence_agents, []);
    assert.ok(result.state.reason_codes.includes("GREENFIELD_IDEA"));
  });

  test("vague greenfield demand asks target user first and does not jump to approval", () => {
    const result = runDemandStatusRuntime({
      objective: "我想优化库存预警，让它更智能",
    });

    assertRoutedState(result);
    assert.equal(result.state.context_type, "greenfield");
    assert.notEqual(result.state.stage, "approval");
    assert.equal(result.state.stage, "clarify");
    assert.equal(result.state.next_question.slot, "target_user");
    assert.match(result.state.next_question.text, /谁|用户|角色/);
    assert.equal(result.state.question_queue[0].slot, "target_user");
    assert.equal(result.state.question_queue.some((question) => question.slot === "approval"), false);
    assert.match(result.state.next_action, /用户|角色/);
  });

  test("approval stage appears only after other required PRD slots are satisfied", () => {
    const result = runDemandStatusRuntime({
      objective: "优化库存预警体验。",
      target_users: ["门店店长"],
      status_quo: ["店长每天手动看库存表，低库存发现不及时。"],
      desired_outcome: "店长能提前看到需要优先处理的低库存商品。",
      scope_in: ["低库存提醒列表"],
      scope_out: ["不做自动补货"],
      constraints: ["第一版只做人工确认后的提醒，不接入自动补货。"],
      acceptance_criteria: ["库存低于阈值时，店长能看到低库存提醒。"],
      risks: ["误报会让店长忽略真正缺货的商品。"],
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "库存预警需求可进入用户批准确认。",
          evidence: [projectEvidence("需求槽位齐全，等待用户批准。", "Router readiness test fixture.")],
          recommendation: "proceed",
          result: { verdict: "pass", notes: "Explorer fixture." },
        },
        {
          role: "verifier",
          status: "completed",
          claim: "库存预警需求可进入用户批准确认。",
          evidence: [projectEvidence("证据记录具备 project scope。", "Verifier fixture.")],
          recommendation: "proceed",
          result: { verdict: "pass", notes: "Verifier fixture." },
        },
      ],
    });

    assertRoutedState(result);
    assert.equal(result.state.stage, "approval");
    assert.deepEqual(result.state.missing_slots, ["approval"]);
    assert.equal(result.state.next_question.slot, "approval");
    assert.deepEqual(result.state.question_queue.map((question) => question.slot), ["approval"]);
  });

  test("missing scope acceptance and risk stay in requirements with answerable questions", () => {
    const result = runDemandStatusRuntime({
      objective: "优化库存预警体验。",
      target_users: ["门店店长"],
      status_quo: ["店长每天手动看库存表。"],
      desired_outcome: "店长能提前看到需要处理的低库存商品。",
    });

    assertRoutedState(result);
    assert.equal(result.state.stage, "requirements");
    assert.notEqual(result.state.stage, "approval");
    assert.equal(result.state.next_question.slot, "scope_in");
    assert.match(result.state.next_question.text, /范围|覆盖|能力|场景/);
    assert.ok(result.state.question_queue.some((question) => question.slot === "acceptance_criteria"));
    assert.ok(result.state.question_queue.some((question) => question.slot === "risks"));
    assert.equal(result.state.question_queue.some((question) => question.slot === "approval"), false);
  });

  test("new product idea ignores API-looking project paths during keyword routing", () => {
    const root = mkdtempSync(join(tmpdir(), "api-playground-"));
    try {
      const result = runDemandStatusRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo-api-state"),
        demandPath: "",
        objective: "New habit-tracking app idea for freelance designers.",
        target_users: ["freelance designer"],
        status_quo: ["They track habits in scattered notes."],
        success_criteria: ["They can see today's habit checklist."],
      });

      assertRoutedState(result);
      assert.equal(result.state.context_type, "greenfield");
      assert.equal(result.state.route, "fast");
      assert.equal(result.state.evidence_policy, "none");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("vague demand status asks the first concrete user question instead of requesting approval", () => {
    const result = runDemandStatusRuntime({
      objective: "我想优化库存预警，让它更智能",
    });

    assert.equal(result.status, "blocked");
    assertRoutedState(result);
    assert.ok(["clarify", "requirements"].includes(result.state.stage));
    assert.notEqual(result.state.stage, "approval");
    assert.equal(result.state.next_question.slot, "target_user");
    assert.match(result.state.next_question.text, /谁会使用|负责/);
    assert.match(result.state.next_action, /谁会使用|负责/);
    assert.equal(result.question_queue[0].slot, "target_user");
  });

  test("approval is only requested after all other PRD readiness slots are filled", () => {
    const result = runDemandStatusRuntime({
      objective: "Create a guided onboarding checklist for freelance designers.",
      target_users: ["Freelance designers who onboard new clients each week."],
      status_quo: ["They copy tasks from old notes and often miss a step."],
      desired_outcome: ["Designers can see the next onboarding step for each client."],
      scope_in: ["Checklist creation and step completion for one client workspace."],
      scope_out: ["No calendar sync, message sending, or template marketplace."],
      constraints: ["Keep the first version to a manual checklist."],
      acceptance_criteria: ["A designer can add a client and mark onboarding steps complete."],
      risks: ["Missing checklist steps can delay client onboarding."],
    });

    assertRoutedState(result);
    assert.equal(result.state.stage, "approval");
    assert.equal(result.state.next_question.slot, "approval");
    assert.match(result.state.next_question.text, /批准/);
    assert.deepEqual(result.state.missing_slots, ["approval"]);
  });

  test("requirements gaps ask a business-language question before approval", () => {
    const result = runDemandStatusRuntime({
      objective: "Improve stock alerts for store managers.",
      target_users: ["Store managers who check inventory every morning."],
      status_quo: ["Managers export spreadsheets and manually look for low stock."],
      desired_outcome: ["Managers see low-stock risk before an item sells out."],
      approve: true,
    });

    assertRoutedState(result);
    assert.equal(result.state.stage, "requirements");
    assert.equal(result.state.next_question.slot, "scope_in");
    assert.match(result.state.next_question.text, /覆盖|范围/);
    assert.ok(result.state.missing_slots.includes("approval") === false);
  });

  test("partial existing implementation is not classified as greenfield", () => {
    const result = runDemandStatusRuntime({
      objective: "There is already a half-built checkout implementation; finish the state handling.",
      target_files: ["src/checkout/state.ts"],
      success_criteria: ["Checkout state persists through refresh."],
    });

    assertRoutedState(result);
    assert.notEqual(result.state.context_type, "greenfield");
    assert.ok(["brownfield", "hybrid"].includes(result.state.context_type));
    assert.equal(result.state.route, "careful");
    assert.equal(result.state.evidence_policy, "cross_check");
  });

  test("API schema auth state data and migration requests require cross-check", () => {
    for (const objective of [
      "Change API schema for account roles.",
      "Add auth token refresh behavior.",
      "Fix UI state flow for onboarding.",
      "Document the data flow between orders and invoices.",
      "Create a database migration for customer table columns.",
    ]) {
      const triage = inspectDemandTriage({ objective });
      assert.equal(triage.route, "careful", objective);
      assert.equal(triage.evidence_policy, "cross_check", objective);
    }
  });

  test("missing acceptance criteria prevents PRD readiness", () => {
    const readiness = inspectDemandPrdReadiness({
      objective: "Implement a new reporting dashboard.",
      target_users: ["ops manager"],
      status_quo: ["Reports are exported manually."],
      scope_in: ["Dashboard MVP"],
      non_goals: ["No billing reports"],
      constraints: ["Use existing data"],
      risks: ["Wrong numbers could mislead users"],
      approve: true,
    });

    assert.equal(readiness.prd_ready, false);
    assert.ok(readiness.missing_slots.includes("acceptance_criteria"));
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "MISSING_ACCEPTANCE_CRITERIA"));
  });

  test("unconfirmed assumptions prevent ready state", () => {
    const readiness = inspectDemandPrdReadiness({
      objective: "New reporting dashboard for ops managers.",
      target_users: ["ops manager"],
      status_quo: ["Reports are exported manually."],
      success_criteria: ["Ops manager can see daily totals."],
      scope_in: ["Dashboard MVP"],
      non_goals: ["No billing reports"],
      constraints: ["Use existing data"],
      risks: ["Wrong numbers could mislead users"],
      assumptions: ["Daily totals are already stored in the warehouse."],
      approve: true,
    });

    assert.equal(readiness.prd_ready, false);
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "UNCONFIRMED_ASSUMPTION"));
  });

  test("cross-check PRD readiness requires every evidence agent result", () => {
    const base = {
      objective: "Change API schema for account roles.",
      target_users: ["account admin"],
      status_quo: ["Roles are manually inferred."],
      success_criteria: ["API returns account roles."],
      scope_in: ["Account role API schema."],
      scope_out: ["No billing changes."],
      constraints: ["Keep existing clients compatible."],
      risks: ["Wrong roles can grant access incorrectly."],
      approve: true,
    };

    const explorerOnly = inspectDemandPrdReadiness({
      ...base,
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Current response omits roles.", "Primary code read.")],
          recommendation: "proceed",
        },
      ],
    });

    assert.equal(explorerOnly.prd_ready, false);
    assert.ok(explorerOnly.blockers.some((blocker) => blocker.role === "cross-checker"));
    assert.ok(explorerOnly.blockers.some((blocker) => blocker.role === "verifier"));

    const complete = inspectDemandPrdReadiness({
      ...base,
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Current response omits roles.", "Primary code read.")],
          recommendation: "proceed",
        },
        {
          role: "cross-checker",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Independent route read agrees.", "Cross-check.", { path: "src/routes/accounts.ts" })],
          recommendation: "proceed",
        },
        {
          role: "verifier",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Evidence supports the acceptance criteria.", "Readiness verification.", { source: "project_docs", path: "docs/accounts.md" })],
          recommendation: "proceed",
        },
      ],
    });

    assert.equal(complete.prd_ready, true, JSON.stringify(complete.blockers, null, 2));
  });

  test("single-agent readiness upgrades to cross-checker when an agent requests cross_check", () => {
    const base = {
      objective: "Adjust existing admin settings copy.",
      target_users: ["account admin"],
      status_quo: ["Existing admin settings screen has unclear copy."],
      success_criteria: ["Settings copy clearly explains the action."],
      scope_in: ["Admin settings copy only."],
      scope_out: ["No permission, billing, or API changes."],
      constraints: ["Keep existing layout."],
      risks: ["Ambiguous copy can confuse admins."],
      approve: true,
    };

    const missingCrossChecker = inspectDemandPrdReadiness({
      ...base,
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "Existing settings copy is unclear.",
          evidence: [projectEvidence("Current copy is ambiguous.", "Primary code read.", { path: "src/settings.tsx" })],
          recommendation: "cross_check",
        },
        {
          role: "verifier",
          status: "completed",
          claim: "Explorer evidence is project-scoped and usable.",
          evidence: [projectEvidence("Evidence path is concrete.", "Readiness verification.", { source: "project_test", path: "__tests__/settings.test.ts" })],
          recommendation: "proceed",
        },
      ],
    }, { triage: { evidence_policy: "single_agent" } });

    assert.equal(missingCrossChecker.prd_ready, false);
    assert.ok(missingCrossChecker.required_evidence_agents.includes("cross-checker"));
    assert.ok(missingCrossChecker.blockers.some((blocker) => blocker.role === "cross-checker"));

    const complete = inspectDemandPrdReadiness({
      ...base,
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "Existing settings copy is unclear.",
          evidence: [projectEvidence("Current copy is ambiguous.", "Primary code read.", { path: "src/settings.tsx" })],
          recommendation: "cross_check",
        },
        {
          role: "cross-checker",
          status: "completed",
          claim: "Independent read confirms settings copy is unclear.",
          evidence: [projectEvidence("Independent file read confirms the same copy.", "Cross-check.", { path: "src/settings.tsx" })],
          recommendation: "proceed",
        },
        {
          role: "verifier",
          status: "completed",
          claim: "Explorer evidence is project-scoped and usable.",
          evidence: [projectEvidence("Evidence path is concrete.", "Readiness verification.", { source: "project_test", path: "__tests__/settings.test.ts" })],
          recommendation: "proceed",
        },
      ],
    }, { triage: { evidence_policy: "single_agent" } });

    assert.equal(complete.prd_ready, true, JSON.stringify(complete.blockers, null, 2));
  });

  test("evidence conflicts and existing blockers prevent PRD readiness", () => {
    const readiness = inspectDemandPrdReadiness({
      objective: "Change API schema for account roles.",
      target_users: ["account admin"],
      status_quo: ["Roles are manually inferred."],
      success_criteria: ["API returns account roles."],
      scope_in: ["Account role API schema."],
      scope_out: ["No billing changes."],
      constraints: ["Keep existing clients compatible."],
      risks: ["Wrong roles can grant access incorrectly."],
      approve: true,
      blockers: [{ code: "PRODUCT_DECISION_PENDING", message: "Role names are not approved." }],
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Current response omits roles.", "Primary code read.")],
          recommendation: "proceed",
        },
        {
          role: "cross-checker",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Fixture already returns roles.", "Independent check.", { source: "project_test", path: "__tests__/accounts.test.ts" })],
          recommendation: "block",
        },
        {
          role: "verifier",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Evidence is inconsistent.", "Readiness verification.", { source: "project_docs", path: "docs/accounts.md" })],
          recommendation: "block",
        },
      ],
    });

    assert.equal(readiness.prd_ready, false);
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "PRODUCT_DECISION_PENDING"));
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "EVIDENCE_AGENT_CONFLICT"));
  });

  test("evidence agent missing data and clarify recommendations block PRD readiness", () => {
    const readiness = inspectDemandPrdReadiness({
      objective: "Change API schema for account roles.",
      target_users: ["account admin"],
      status_quo: ["Roles are manually inferred."],
      success_criteria: ["API returns account roles."],
      scope_in: ["Account role API schema."],
      scope_out: ["No billing changes."],
      constraints: ["Keep existing clients compatible."],
      risks: ["Wrong roles can grant access incorrectly."],
      approve: true,
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Current response omits roles.", "Primary code read.")],
          recommendation: "proceed",
        },
        {
          role: "cross-checker",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Independent route read agrees.", "Cross-check.", { path: "src/routes/accounts.ts" })],
          missing: ["Need product owner confirmation for role naming."],
          recommendation: "clarify",
        },
        {
          role: "verifier",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Evidence supports code fact but not product naming.", "Readiness verification.", { source: "project_docs", path: "docs/accounts.md" })],
          recommendation: "proceed",
        },
      ],
    });

    assert.equal(readiness.prd_ready, false);
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "EVIDENCE_AGENT_MISSING"));
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "EVIDENCE_AGENT_CLARIFICATION_REQUIRED"));
  });

  test("single-agent evidence policy requires explorer and verifier results", () => {
    const base = {
      objective: "Existing release notes mention demand dispatch behavior.",
      target_users: ["maintainer"],
      status_quo: ["Maintainers inspect release notes manually."],
      success_criteria: ["Maintainer can verify the current documented behavior."],
      scope_in: ["Release note documentation."],
      scope_out: ["No implementation changes."],
      constraints: ["Use current repository docs."],
      risks: ["Wrong documentation can mislead maintainers."],
      approve: true,
    };

    const missingVerifier = inspectDemandPrdReadiness({
      ...base,
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "Release notes mention demand dispatch.",
          evidence: [projectEvidence("Docs mention demand dispatch.", "Primary project fact.", { source: "project_docs", path: "docs/release-notes.md" })],
          recommendation: "proceed",
        },
      ],
    });

    assert.equal(missingVerifier.prd_ready, false);
    assert.ok(missingVerifier.blockers.some((blocker) => blocker.role === "verifier"));

    const complete = inspectDemandPrdReadiness({
      ...base,
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "Release notes mention demand dispatch.",
          evidence: [projectEvidence("Docs mention demand dispatch.", "Primary project fact.", { source: "project_docs", path: "docs/release-notes.md" })],
          recommendation: "proceed",
        },
        {
          role: "verifier",
          status: "completed",
          claim: "Release notes mention demand dispatch.",
          evidence: [projectEvidence("Explorer evidence is usable.", "Readiness verification.", { source: "project_docs", path: "docs/release-notes.md" })],
          recommendation: "proceed",
        },
      ],
    });

    assert.equal(complete.prd_ready, true, JSON.stringify(complete.blockers, null, 2));
  });

  test("external-only evidence cannot satisfy existing project facts", () => {
    const externalEvidence = {
      url: "https://example.com/api-schema-guidance",
      scope: "external",
      source: "web-search",
      summary: "External API schema guidance mentions role fields.",
      why: "Useful background, but not proof of this repository's implementation.",
    };
    const readiness = inspectDemandPrdReadiness({
      objective: "Change existing API schema for account roles.",
      target_users: ["account admin"],
      status_quo: ["Roles are manually inferred."],
      success_criteria: ["API returns account roles."],
      scope_in: ["Account role API schema."],
      scope_out: ["No billing changes."],
      constraints: ["Keep existing clients compatible."],
      risks: ["Wrong roles can grant access incorrectly."],
      approve: true,
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [externalEvidence],
          recommendation: "proceed",
        },
        {
          role: "cross-checker",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [externalEvidence],
          recommendation: "proceed",
        },
        {
          role: "verifier",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [externalEvidence],
          recommendation: "proceed",
        },
      ],
    });

    assert.equal(readiness.prd_ready, false);
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "PROJECT_FACT_REQUIRES_PROJECT_EVIDENCE"));
  });

  test("project evidence requires a concrete project locator", () => {
    const locatorlessProjectEvidence = {
      scope: "project",
      source: "repo-docs",
      summary: "Repository docs mention account roles.",
      why: "Source says repo docs, but no concrete file path was cited.",
    };
    const readiness = inspectDemandPrdReadiness({
      objective: "Change existing API schema for account roles.",
      target_users: ["account admin"],
      status_quo: ["Roles are manually inferred."],
      success_criteria: ["API returns account roles."],
      scope_in: ["Account role API schema."],
      scope_out: ["No billing changes."],
      constraints: ["Keep existing clients compatible."],
      risks: ["Wrong roles can grant access incorrectly."],
      approve: true,
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [locatorlessProjectEvidence],
          recommendation: "proceed",
        },
        {
          role: "cross-checker",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [locatorlessProjectEvidence],
          recommendation: "proceed",
        },
        {
          role: "verifier",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [locatorlessProjectEvidence],
          recommendation: "proceed",
        },
      ],
    });

    assert.equal(readiness.prd_ready, false);
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "PROJECT_EVIDENCE_PATH_REQUIRED"));
  });

  test("external URLs cannot be relabeled as project evidence", () => {
    const mislabeledExternalEvidence = {
      scope: "project",
      source: "project_docs",
      url: "https://example.com/project-docs",
      summary: "External page was mislabeled as project docs.",
      why: "A URL cannot prove this repository's implementation.",
    };
    const readiness = inspectDemandPrdReadiness({
      objective: "Change existing API schema for account roles.",
      target_users: ["account admin"],
      status_quo: ["Roles are manually inferred."],
      success_criteria: ["API returns account roles."],
      scope_in: ["Account role API schema."],
      scope_out: ["No billing changes."],
      constraints: ["Keep existing clients compatible."],
      risks: ["Wrong roles can grant access incorrectly."],
      approve: true,
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [mislabeledExternalEvidence],
          recommendation: "proceed",
        },
        {
          role: "cross-checker",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [mislabeledExternalEvidence],
          recommendation: "proceed",
        },
        {
          role: "verifier",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [mislabeledExternalEvidence],
          recommendation: "proceed",
        },
      ],
    });

    assert.equal(readiness.prd_ready, false);
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "PROJECT_EVIDENCE_PATH_REQUIRED"));
  });

  test("evidence records must declare valid scope explicitly", () => {
    const scopeLessEvidence = {
      path: "src/api/accounts.ts",
      source: "project_code",
      summary: "Current response omits roles.",
      why: "Primary code read, but scope was not declared.",
    };
    const readiness = inspectDemandPrdReadiness({
      objective: "Change existing API schema for account roles.",
      target_users: ["account admin"],
      status_quo: ["Roles are manually inferred."],
      success_criteria: ["API returns account roles."],
      scope_in: ["Account role API schema."],
      scope_out: ["No billing changes."],
      constraints: ["Keep existing clients compatible."],
      risks: ["Wrong roles can grant access incorrectly."],
      approve: true,
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [scopeLessEvidence],
          recommendation: "proceed",
        },
        {
          role: "cross-checker",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [scopeLessEvidence],
          recommendation: "proceed",
        },
        {
          role: "verifier",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [scopeLessEvidence],
          recommendation: "proceed",
        },
      ],
    });

    assert.equal(readiness.prd_ready, false);
    assert.ok(readiness.blockers.some((blocker) => blocker.code === "EVIDENCE_SCOPE_REQUIRED"));
  });

  test("non-missing status notes in missing arrays do not block readiness", () => {
    const readiness = inspectDemandPrdReadiness({
      objective: "Change existing API schema for account roles.",
      target_users: ["account admin"],
      status_quo: ["Roles are manually inferred."],
      success_criteria: ["API returns account roles."],
      scope_in: ["Account role API schema."],
      scope_out: ["No billing changes."],
      constraints: ["Keep existing clients compatible."],
      risks: ["Wrong roles can grant access incorrectly."],
      approve: true,
      evidence_results: [
        {
          role: "explorer",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Current response omits roles.", "Primary code read.")],
          missing: ["No missing data identified."],
          recommendation: "proceed",
        },
        {
          role: "cross-checker",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Independent route read agrees.", "Cross-check.", { path: "src/routes/accounts.ts" })],
          missing: ["Evidence agreement between explorer and cross-checker is 100% (no conflicts)."],
          recommendation: "proceed",
        },
        {
          role: "verifier",
          status: "completed",
          claim: "API schema lacks account roles.",
          evidence: [projectEvidence("Evidence supports the acceptance criteria.", "Readiness verification.", { source: "project_docs", path: "docs/accounts.md" })],
          missing: ["All required evidence tasks completed."],
          recommendation: "proceed",
        },
      ],
    });

    assert.equal(readiness.prd_ready, true, JSON.stringify(readiness.blockers, null, 2));
  });

  test("low-risk copy change stays fast", () => {
    const result = runDemandStatusRuntime({
      objective: "Update the empty-state copy on a new marketing prototype.",
      target_users: ["visitor"],
      status_quo: ["The empty state is confusing."],
      success_criteria: ["Visitor sees clearer copy."],
    });

    assertRoutedState(result);
    assert.equal(result.state.route, "fast");
    assert.equal(result.state.evidence_policy, "none");
  });

  test("status can inspect an existing demand session read-only", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-status-"));
    try {
      const sessionPath = join(root, ".yolo", "demand", "DEMAND-1", "session.json");
      writeJson(sessionPath, {
        schema_version: "1.0",
        schema: "yolo.demand.session.v1",
        id: "DEMAND-1",
        idea: "Existing billing API needs an invoiceStatus schema field.",
        target_files: ["src/api/billing.ts"],
        vision: {
          target_users: ["billing admin"],
          status_quo: ["Admins manually inspect invoices."],
          success_criteria: ["API exposes invoiceStatus."],
        },
        requirements: {
          active: [{ id: "REQ-1", text: "Expose invoiceStatus in billing API." }],
          out_of_scope: ["No payment collection changes."],
          constraints: ["Do not break existing invoice consumers."],
        },
        risks: ["Wrong invoice status can cause billing errors."],
        evidence: ["Existing billing API is implemented in src/api/billing.ts."],
        approval: { approved: true },
      });

      const before = readFileSyncUtf8(sessionPath);
      const result = runDemandStatusRuntime({ projectRoot: root, demandPath: sessionPath });
      const after = readFileSyncUtf8(sessionPath);

      assert.equal(before, after);
      assertRoutedState(result);
      assert.equal(result.state.route, "careful");
      assert.equal(result.state.evidence_policy, "cross_check");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("status reports an explicit missing demand path as blocked", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-missing-"));
    try {
      const missingPath = join(root, ".yolo", "demand", "missing", "session.json");
      const result = runDemandStatusRuntime({ projectRoot: root, demandPath: missingPath });

      assert.equal(result.status, "blocked");
      assert.equal(result.code, "DEMAND_SESSION_MISSING");
      if ("prd_ready" in result.state) {
        assert.equal(result.state.prd_ready, false);
      }
      assert.ok(result.blockers.some((blocker: { message: string }) => blocker.message.includes(missingPath)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("evidence protocol defines explorer cross-checker verifier and conflicts block", () => {
    assert.equal(DEMAND_EVIDENCE_AGENT_PROTOCOLS.explorer.writes_code, false);
    assert.equal(DEMAND_EVIDENCE_AGENT_PROTOCOLS.cross_checker.required_when.includes("cross_check"), true);
    assert.equal(DEMAND_EVIDENCE_AGENT_PROTOCOLS.verifier.result_schema, "yolo.demand.evidence_result.v1");

    const agreement = inspectEvidenceAgreement([
      { claim: "API schema has invoiceStatus", recommendation: "proceed" },
      { claim: "API schema has invoiceStatus", recommendation: "block" },
    ]);
    assert.equal(agreement.status, "blocked");
    assert.equal(agreement.conflicts[0].code, "EVIDENCE_AGENT_CONFLICT");
  });
});

function readFileSyncUtf8(path) {
  return readFileSync(path, "utf8");
}
