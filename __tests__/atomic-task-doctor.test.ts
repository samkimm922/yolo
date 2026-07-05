import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { inspectAtomicTask, inspectTaskFromPrd } from "../src/runtime/execution/atomic-task-doctor.js";
import { runAtomicTaskDoctorGate } from "../src/runtime/execution/session-validation.js";
import { isAtomicityExempt } from "../src/runtime/gates/readiness-policy.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");

describe("atomic task doctor", () => {
  test("R5 greenfield scaffold fixture is exempt in shared predicate, doctor, and run gate", () => {
    const fixture = JSON.parse(readFileSync(resolve(YOLO_DIR, "__tests__/fixtures/dogfood-gitweekly-r5-scaffold-prd.json"), "utf8"));
    const task = { ...fixture.tasks[0], status: "pending" };

    assert.equal(isAtomicityExempt(task), true);

    const doctor = inspectAtomicTask(task, { root: YOLO_DIR, projectRoot: YOLO_DIR, writeEvidence: false });
    assert.equal(doctor.status, "pass");
    assert.notEqual(doctor.mode, "must_split");
    assert.equal(doctor.atomicity_exempt?.reason, "greenfield_scaffold");
    assert.ok(doctor.reasons.some((reason) => reason.id === "ATOMICITY_EXEMPT"));

    const gate = runAtomicTaskDoctorGate({ task, yoloRoot: YOLO_DIR });
    assert.equal(gate.ok, true);
    assert.notEqual(gate.result?.mode, "must_split");
    assert.equal(gate.result?.atomicity_exempt?.reason, "greenfield_scaffold");
  });

  test("true multi-domain business task still must_split with executable suggestions", () => {
    const postConditions = Array.from({ length: 10 }, (_, index) => ({
      id: `POST-BEHAVIOR-${index + 1}`,
      type: "acceptance_criteria",
      severity: "FAIL",
      message: `Behavior ${index + 1} is verified for checkout UI and inventory service consistency.`,
    }));
    const result = inspectAtomicTask({
      id: "FE-GIANT-001",
      title: "Fix checkout UI and inventory transaction behavior",
      type: "feature",
      status: "pending",
      description: "Update the checkout page selected item state, service transaction writes, inventory quantity, API contract, and tsc compile behavior.",
      scope: {
        targets: [
          { file: "src/pages/checkout.tsx" },
          { file: "src/components/CartSummary.tsx" },
          { file: "src/services/inventory.ts" },
          { file: "src/services/orders.ts" },
        ],
        max_files: 4,
      },
      post_conditions: postConditions,
    }, { root: YOLO_DIR, writeEvidence: false });

    assert.equal(result.status, "fail");
    assert.equal(result.mode, "must_split");
    assert.ok(result.split_suggestions.length > 0);
    assert.ok(result.remediation?.split_suggestions?.length > 0);
  });

  test("environment and artifact postconditions do not count as behavioral", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-atomic-env-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "app.ts"), "export const value = 'ok';\n");
      const result = inspectAtomicTask({
        id: "FIX-ENV-001",
        title: "Verify generated artifact",
        type: "bugfix",
        status: "pending",
        scope: { targets: [{ file: "src/app.ts" }], max_files: 1 },
        post_conditions: [
          { id: "POST-FILE", type: "file_exists", severity: "FAIL", params: { file: "src/app.ts" } },
          { id: "POST-CODE", type: "code_contains", severity: "FAIL", params: { file: "src/app.ts", text: "value" } },
          { id: "POST-CMD", type: "build_command_available", severity: "FAIL", params: { kind: "test", command: "node --test" } },
        ],
      }, { root, projectRoot: root, writeEvidence: true });

      assert.equal(result.reasons.some((reason) => reason.id === "BEHAVIORAL_FAIL_POSTCONDITIONS"), false);
      const evidence = JSON.parse(readFileSync(resolve(root, result.evidence_file), "utf8"));
      assert.equal(evidence.behavioral_fail_postconditions, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("toolchain config files do not create ui_state behavior domains", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-atomic-toolchain-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
      const result = inspectAtomicTask({
        id: "FIX-TOOLCHAIN-001",
        title: "Update package test script",
        type: "bugfix",
        status: "pending",
        scope: { targets: [{ file: "package.json" }], max_files: 1 },
        post_conditions: [
          { id: "POST-PKG", type: "code_contains", severity: "FAIL", params: { file: "package.json", text: "\"test\"" } },
        ],
      }, { root, projectRoot: root, writeEvidence: true });

      assert.equal(result.status, "pass");
      const evidence = JSON.parse(readFileSync(resolve(root, result.evidence_file), "utf8"));
      assert.deepEqual(evidence.behavior_domains, []);
      assert.equal(evidence.behavior_domains.includes("ui_state"), false);
      assert.deepEqual(evidence.layers, ["toolchain"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("must_split without executable split suggestions is downgraded instead of hard-failing", () => {
    const postConditions = Array.from({ length: 10 }, (_, index) => ({
      id: `POST-BEHAVIOR-${index + 1}`,
      type: "acceptance_criteria",
      severity: "FAIL",
      message: `Behavior ${index + 1} is verified.`,
    }));
    const result = inspectAtomicTask({
      id: "FIX-NO-SPLIT-001",
      title: "Single utility with too many behavior assertions",
      type: "bugfix",
      status: "pending",
      description: "Update one utility function with many independently verified outcomes.",
      scope: { targets: [{ file: "src/utils/format.ts" }], max_files: 1 },
      post_conditions: postConditions,
    }, { root: YOLO_DIR, writeEvidence: false });

    assert.equal(result.status, "pass");
    assert.equal(result.mode, "investigate_then_patch");
    assert.equal(result.no_executable_remediation, true);
    assert.match(result.remediation?.reason, /doctor 无法给出拆分建议/);
    assert.equal(result.split_suggestions.length, 0);
  });

  test("classifies P36-003 as must_split with evidence and split suggestions", () => {
    const result = inspectTaskFromPrd("__tests__/fixtures/legacy-cleanup-20260526221343/data/prd/current/prd-yolo-p36-real-task-soak.json", "FIX-P36-003", {
      root: YOLO_DIR,
      writeEvidence: true,
    });

    assert.equal(result.status, "fail");
    assert.equal(result.mode, "must_split");
    assert.ok(result.score >= 10);
    assert.match(result.evidence_file, /state\/evidence\/FIX-P36-003\/investigation\.json/);
    assert.ok(result.split_suggestions.length >= 2);
    assert.ok(result.split_suggestions.some((item) => item.files.includes("src/services/saleMutations.ts")));

    const evidence = JSON.parse(readFileSync(resolve(YOLO_DIR, result.evidence_file), "utf8"));
    assert.equal(evidence.mode, "must_split");
    assert.ok(evidence.reasons.some((reason) => reason.id === "CROSSES_PAGES_SERVICES"));
  });

  test("allows simple single-file direct patch", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-atomic-simple-"));
    try {
      mkdirSync(join(root, "src", "services"), { recursive: true });
      writeFileSync(join(root, "src", "services", "card.service.ts"), "export const old = 1;\n");

      const result = inspectAtomicTask({
        id: "FIX-SIMPLE-001",
        title: "修单文件文案",
        type: "bugfix",
        status: "pending",
        scope: { targets: [{ file: "src/services/card.service.ts" }], max_files: 1 },
        pre_conditions: [{ id: "PRE-TEXT", type: "code_contains", severity: "FAIL", params: { file: "src/services/card.service.ts", text: "old" } }],
        post_conditions: [{ id: "POST-TEXT", type: "code_not_contains", severity: "FAIL", params: { file: "src/services/card.service.ts", text: "old" } }],
      }, { root, projectRoot: root, writeEvidence: false });

      assert.equal(result.status, "pass");
      assert.notEqual(result.mode, "must_split");
      assert.ok(result.score <= 5);
      assert.ok(!result.reasons.some((r) => r.id === "CREATES_NEW_FILE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("feature crossing page and service is blocked before implementation", () => {
    const result = inspectAtomicTask({
      id: "FE-SALES-001",
      title: "新增销售折扣功能",
      type: "feature",
      status: "pending",
      description: "新增销售页面折扣输入，并在 service 写入数据库、更新库存数量。",
      scope: {
        targets: [
          { file: "src/pages/sales/sales.tsx" },
          { file: "src/services/saleMutations.ts" },
        ],
        max_files: 2,
      },
      post_conditions: [
        { id: "POST-UI", type: "acceptance_criteria", severity: "FAIL", message: "页面可输入折扣" },
        { id: "POST-DATA", type: "acceptance_criteria", severity: "FAIL", message: "数据库写入折扣" },
      ],
    }, { root: YOLO_DIR, writeEvidence: false });

    assert.equal(result.status, "fail");
    assert.equal(result.mode, "must_split");
    assert.ok(result.reasons.some((reason) => reason.id === "CROSSES_PAGES_SERVICES"));
  });

  test("single-file split child is investigated instead of split forever", () => {
    const result = inspectAtomicTask({
      id: "FIX-P36REC-002B",
      parent_task_id: "FIX-P36REC-002",
      split_from: "FIX-P36REC-002",
      title: "拆分 createSale service/数据一致性修复",
      type: "bugfix",
      status: "pending",
      description: "只修 service 层持久化和库存一致性；不得修改页面 UI。必须使用 transaction 写入 quantity 并扣减 inventory。",
      scope: {
        targets: [{ file: "src/services/saleMutations.ts" }],
        max_files: 1,
        allow_new_files: false,
      },
      post_conditions: [
        { id: "POST-QTY", type: "function_contains_text", severity: "FAIL", params: { file: "src/services/saleMutations.ts", function: "createSale", text: "quantity" } },
        { id: "POST-TX", type: "function_contains_call", severity: "FAIL", params: { file: "src/services/saleMutations.ts", function: "createSale", callee: "runTransaction" } },
        { id: "POST-INV", type: "function_contains_text", severity: "FAIL", params: { file: "src/services/saleMutations.ts", function: "createSale", text: "inventory" } },
        { id: "POST-TSC", type: "no_new_type_errors", severity: "FAIL", params: {} },
        { id: "POST-FILES", type: "files_modified_max", severity: "FAIL", params: { max: 1 } },
      ],
    }, { root: YOLO_DIR, writeEvidence: false });

    assert.equal(result.status, "pass");
    assert.equal(result.mode, "investigate_then_patch");
    assert.ok(result.reasons.some((reason) => reason.id === "SINGLE_FILE_SPLIT_CHILD_CAP"));
  });

  test("P36 round2 craft db singleton task is not split just because it mentions database/use", () => {
    const result = inspectTaskFromPrd("__tests__/fixtures/legacy-cleanup-20260526221343/data/prd/current/prd-yolo-p36-round2-real-bugfix.json", "FIX-P36R2-001", {
      root: YOLO_DIR,
      writeEvidence: false,
    });

    assert.equal(result.status, "pass");
    assert.notEqual(result.mode, "must_split");
    assert.ok(result.score <= 5);
    assert.equal(result.reasons.some((reason) => reason.id === "HOOK_OR_API_TERMS" && reason.evidence?.terms?.includes("use")), false);
    assert.equal(result.reasons.some((reason) => reason.id === "DATA_CONSISTENCY_TERMS" && reason.evidence?.terms?.includes("database")), false);
  });

  test("single-file R9 structural test split is investigated instead of hard-split by boilerplate terms", () => {
    const result = inspectAtomicTask({
      id: "FIX-ALLSRC-008",
      title: "[R9-file-length] src/services/__tests__/inventory-mutation-wrapper.test.ts: 1 findings",
      type: "refactor",
      task_kind: "review_fix",
      description: "文件 244 行，超过 150 行限制（R9 规则），必须拆分。保持 UI className/行为不变。",
      source_findings: [
        { scanner_id: "R9-file-length", file: "src/services/__tests__/inventory-mutation-wrapper.test.ts" },
      ],
      scope: {
        targets: [{ file: "src/services/__tests__/inventory-mutation-wrapper.test.ts" }],
        max_files: 5,
        allow_new_files: true,
      },
      post_conditions: [
        { id: "POST-LINES", type: "file_lines_max", severity: "FAIL", params: { file: "src/services/__tests__/inventory-mutation-wrapper.test.ts", max: 150 } },
        { id: "POST-TSC", type: "no_new_type_errors", severity: "FAIL", params: {} },
      ],
    }, { root: YOLO_DIR, writeEvidence: false });

    assert.equal(result.status, "pass");
    assert.equal(result.mode, "investigate_then_patch");
    assert.ok(result.reasons.some((reason) => reason.id === "DATA_CONSISTENCY_TERMS"));
    assert.ok(result.reasons.some((reason) => reason.id === "MULTIPLE_BEHAVIOR_DOMAINS"));
  });

  // P2.17: dynamic layer-map correctly classifies files in non-standard directory layouts
  test("dynamic layer map classifies non-standard app/features layout", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p2-17-layermap-"));
    try {
      // Create a non-standard layout: app/features/ + app/services/ + app/ui/
      mkdirSync(join(root, "app", "features", "checkout"), { recursive: true });
      mkdirSync(join(root, "app", "services", "payment"), { recursive: true });
      mkdirSync(join(root, "app", "ui", "widgets"), { recursive: true });
      mkdirSync(join(root, "app", "hooks"), { recursive: true });
      mkdirSync(join(root, "app", "types"), { recursive: true });
      writeFileSync(join(root, "app", "features", "checkout", "CheckoutPage.tsx"), "// page");
      writeFileSync(join(root, "app", "services", "payment", "PaymentService.ts"), "// service");
      writeFileSync(join(root, "app", "ui", "widgets", "Button.tsx"), "// component");
      writeFileSync(join(root, "app", "hooks", "usePayment.ts"), "// hook");

      const result = inspectAtomicTask({
        id: "FIX-NONSTD-001",
        title: "修复支付页面和服务的折扣计算",
        type: "bugfix",
        status: "pending",
        description: "修复支付页面折扣输入，并在 service 写入数据库、更新库存数量。",
        scope: {
          targets: [
            { file: "app/features/checkout/CheckoutPage.tsx" },
            { file: "app/services/payment/PaymentService.ts" },
          ],
        },
        post_conditions: [
          { id: "POST-UI", type: "acceptance_criteria", severity: "FAIL", message: "页面可输入折扣" },
          { id: "POST-DATA", type: "acceptance_criteria", severity: "FAIL", message: "数据库写入折扣" },
        ],
      }, { root, projectRoot: root, writeEvidence: true });

      // Should detect cross-layer (pages + services) even with non-standard layout
      assert.equal(result.status, "fail");
      assert.equal(result.mode, "must_split");
      assert.ok(result.reasons.some((reason) => reason.id === "CROSSES_PAGES_SERVICES"));

      // Verify evidence includes layer_map with non-standard entries
      const evidenceFile = resolve(root, result.evidence_file);
      const evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
      const layerEntries = evidence.layer_map?.entries || [];
      assert.ok(layerEntries.length > 0, "layer_map entries must be non-empty");
      // Verify non-standard directories are classified
      const prefixes = layerEntries.map((entry) => entry.prefix);
      assert.ok(prefixes.some((p) => p.startsWith("app/features")), "app/features must be classified");
      assert.ok(prefixes.some((p) => p.startsWith("app/services")), "app/services must be classified");
      // Verify classification categories
      const featureEntry = layerEntries.find((entry) => entry.prefix.startsWith("app/features"));
      assert.equal(featureEntry.category, "pages");
      const serviceEntry = layerEntries.find((entry) => entry.prefix.startsWith("app/services"));
      assert.equal(serviceEntry.category, "services");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dynamic layer map fallback uses hardcoded rules when project has no recognizable structure", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-p2-17-flat-"));
    try {
      // Create a flat directory with no recognizable layers
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts", "deploy.ts"), "// deploy script");
      writeFileSync(join(root, "README.md"), "# Project");

      const result = inspectAtomicTask({
        id: "FIX-FLAT-001",
        title: "修复部署脚本",
        type: "bugfix",
        status: "pending",
        description: "修复部署脚本的路径问题",
        scope: {
          targets: [{ file: "scripts/deploy.ts" }],
        },
      }, { root, projectRoot: root, writeEvidence: false });

      // Single file in flat structure should still pass
      assert.equal(result.status, "pass");
      assert.ok(result.score <= 5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects new business files outside src with the shared business-file policy", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-atomic-new-app-"));
    try {
      const result = inspectAtomicTask({
        id: "FIX-APP-NEW-001",
        title: "新增 app router helper",
        type: "feature",
        status: "pending",
        scope: {
          targets: [{ file: "app/features/cart/new-helper.ts" }],
          allow_new_files: true,
        },
        post_conditions: [
          { id: "POST-TSC", type: "no_new_type_errors", severity: "FAIL", params: {} },
        ],
      }, { root, projectRoot: root, writeEvidence: false });

      assert.ok(result.reasons.some((reason) => reason.id === "CREATES_NEW_FILE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// BUG-1: atomic_bundle — declarative narrow gate for cohesive multi-file tasks
describe("atomic_bundle exemption", () => {
  const fiveServiceFiles = [
    "src/services/migration/schema.sql",
    "src/services/migration/rls.sql",
    "src/services/migration/triggers.sql",
    "src/services/migration/indexes.sql",
    "src/services/migration/types.ts",
  ];

  const baseScope = {
    targets: fiveServiceFiles.map((file) => ({ file })),
  };

  const basePostConditions = [
    { id: "POST-FILES", type: "files_modified_max", severity: "FAIL", params: { max: 5 } },
    { id: "POST-TYPEERR", type: "no_new_type_errors", severity: "FAIL", params: {} },
  ];

  function bundleTask(overrides = Object()) {
    return {
      id: "FIX-BUNDLE-001",
      title: "数据库 schema 迁移:新增 inventory_transactions 表",
      type: "feature",
      status: "pending",
      description: "新增库存事务表 schema、RLS 策略、触发器、索引和类型定义。",
      ...overrides,
      scope: { ...baseScope, ...overrides.scope },
      post_conditions: overrides.post_conditions || basePostConditions,
    };
  }

  test("valid atomic_bundle with 5 cohesive files is NOT must_split", () => {
    const result = inspectAtomicTask(bundleTask({
      scope: {
        ...baseScope,
        atomic_bundle: {
          reason: "schema + RLS + triggers + indexes + types 构成不可分割的数据库迁移交付单元",
          files: fiveServiceFiles,
        },
      },
    }), { root: YOLO_DIR, writeEvidence: false });

    assert.notEqual(result.mode, "must_split");
    assert.ok(result.reasons.some((r) => r.id === "ATOMIC_BUNDLE_EXEMPT"));
  });

  test("5 files without atomic_bundle is still must_split", () => {
    const result = inspectAtomicTask(bundleTask(), { root: YOLO_DIR, writeEvidence: false });

    assert.equal(result.mode, "must_split");
    assert.equal(result.reasons.some((r) => r.id === "ATOMIC_BUNDLE_EXEMPT"), false);
  });

  test("atomic_bundle with multiple behavior domains is still must_split", () => {
    // Uses data_consistency + compile domains (not ui_state+data_consistency)
    // to independently test the behaviorDomains<=1 exemption condition,
    // since trigger B only fires for ui_state+data_consistency dual domain.
    const result = inspectAtomicTask(bundleTask({
      title: "service 层数据库 schema 迁移 + 编译配置修改",
      description: "在同一层修改数据库 schema 和编译配置，涉及库存事务和 tsc 编译选项。",
      scope: {
        ...baseScope,
        atomic_bundle: {
          reason: "双域修改是一个整体交付",
          files: fiveServiceFiles,
        },
      },
    }), { root: YOLO_DIR, writeEvidence: false });

    assert.equal(result.mode, "must_split");
  });

  test("atomic_bundle with empty reason is still must_split", () => {
    const result = inspectAtomicTask(bundleTask({
      scope: {
        ...baseScope,
        atomic_bundle: {
          reason: "",
          files: fiveServiceFiles,
        },
      },
    }), { root: YOLO_DIR, writeEvidence: false });

    assert.equal(result.mode, "must_split");
    assert.equal(result.reasons.some((r) => r.id === "ATOMIC_BUNDLE_EXEMPT"), false);
  });

  test("atomic_bundle not covering all target files is still must_split", () => {
    const result = inspectAtomicTask(bundleTask({
      scope: {
        ...baseScope,
        atomic_bundle: {
          reason: "只声明了 3 个文件，但任务有 5 个 target",
          files: fiveServiceFiles.slice(0, 3),
        },
      },
    }), { root: YOLO_DIR, writeEvidence: false });

    assert.equal(result.mode, "must_split");
    assert.equal(result.reasons.some((r) => r.id === "ATOMIC_BUNDLE_EXEMPT"), false);
  });
});
