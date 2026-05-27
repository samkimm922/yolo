import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const promptSource = readFileSync(resolve(YOLO_DIR, "src/cli/prompt.ts"), "utf8");

describe("R9 prompt contract", () => {
  test("test file splits get a dedicated bounded split contract", () => {
    assert.match(promptSource, /function isR9TestSplitTask/);
    assert.match(promptSource, /function renderR9TestSplitContract/);
    assert.match(promptSource, /function renderR9StaticSplitPlan/);
    assert.match(promptSource, /R9 测试文件拆分快路径/);
    assert.match(promptSource, /静态拆分计划/);
    assert.match(promptSource, /候选测试块/);
    assert.match(promptSource, /建议优先移动/);
    assert.match(promptSource, /优先按 top-level describe 分组拆/);
    assert.match(promptSource, /原文件不能删除/);
    assert.match(promptSource, /不新增 TSC 错误/);
  });
});
