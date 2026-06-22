// P10.S4 regression: ReDoS via evalCodeContains / evalFunctionContainsText
// User-supplied regex from PRD post-conditions must be validated before
// RegExp construction to prevent catastrophic backtracking.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalCodeContains, evalCodeNotContains, evalFunctionContainsText } from "../src/lib/evaluators/code-check.js";

function createVulnerableRoot() {
  const root = mkdtempSync(join(tmpdir(), "yolo-redos-"));
  // Content long enough to trigger catastrophic backtracking if regex is unsafely constructed
  writeFileSync(join(root, "vuln.ts"), "function foo() { return '" + "a".repeat(80) + "b" + "'; }\n", "utf8");
  writeFileSync(join(root, "foo.ts"), "function foo() { return 1; }\n", "utf8");
  writeFileSync(join(root, "bar.ts"), "import { foo } from './foo';\n", "utf8");
  return root;
}

describe("P10.S4 evalCodeContains rejects ReDoS patterns", () => {
  const dangerousPatterns = ["(a+)+", "(a+)+$", "(a*)*", "([a-z]+)+"];

  for (const pattern of dangerousPatterns) {
    test(`evalCodeContains with pattern "${pattern}" returns error, not hang`, () => {
      const root = createVulnerableRoot();
      try {
        const result = evalCodeContains(
          { text: pattern, files: ["vuln.ts"], is_regex: true },
          null,
          root,
        );
        assert.equal(result.passed, false);
        assert.match(result.detail, /不安全的正则表达式|nested quantifiers/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("evalCodeContains with safe regex still works", () => {
    const root = createVulnerableRoot();
    try {
      const result = evalCodeContains(
        { text: "import", files: ["bar.ts"], is_regex: true },
        null,
        root,
      );
      assert.equal(result.passed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("evalCodeContains with literal text (non-regex) still works", () => {
    const root = createVulnerableRoot();
    try {
      const result = evalCodeContains(
        { text: "import", files: ["bar.ts"], is_regex: false },
        null,
        root,
      );
      assert.equal(result.passed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P10.S4 evalCodeNotContains rejects ReDoS patterns", () => {
  test("evalCodeNotContains with ReDoS pattern returns error, not hang", () => {
    const root = createVulnerableRoot();
    try {
      const result = evalCodeNotContains(
        { text: "(a+)+$", files: ["vuln.ts"], is_regex: true },
        null,
        root,
      );
      assert.equal(result.passed, false);
      assert.notEqual(result.detail, "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P10.S4 evalFunctionContainsText rejects ReDoS patterns", () => {
  test("evalFunctionContainsText with ReDoS pattern returns false, not hang", () => {
    const root = createVulnerableRoot();
    try {
      const result = evalFunctionContainsText(
        { file: "vuln.ts", function: "foo", text: "(a+)+", is_regex: true },
        null,
        root,
      );
      // The function body is short, but the fix ensures regex validation runs before construction
      assert.equal(result.passed, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("evalFunctionContainsText with safe regex still works", () => {
    const root = createVulnerableRoot();
    try {
      const result = evalFunctionContainsText(
        { file: "foo.ts", function: "foo", text: "return", is_regex: true },
        null,
        root,
      );
      assert.equal(result.passed, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
