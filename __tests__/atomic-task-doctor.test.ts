import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { inspectAtomicTask, inspectTaskFromPrd } from "../src/runtime/execution/atomic-task-doctor.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");

describe("atomic task doctor", () => {
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
    const result = inspectAtomicTask({
      id: "FIX-SIMPLE-001",
      title: "修单文件文案",
      type: "bugfix",
      status: "pending",
      scope: { targets: [{ file: "src/services/card.service.ts" }], max_files: 1 },
      pre_conditions: [{ id: "PRE-TEXT", type: "code_contains", severity: "FAIL", params: { file: "src/services/card.service.ts", text: "old" } }],
      post_conditions: [{ id: "POST-TEXT", type: "code_not_contains", severity: "FAIL", params: { file: "src/services/card.service.ts", text: "old" } }],
    }, { root: YOLO_DIR, writeEvidence: false });

    assert.equal(result.status, "pass");
    assert.notEqual(result.mode, "must_split");
    assert.ok(result.score <= 5);
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
});
