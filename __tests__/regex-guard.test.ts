// P10.S4 adversarial tests — user-supplied regex safety guard
// Asserts that validateRegexPattern rejects patterns with nested quantifiers
// and other common ReDoS shapes, while accepting the simple regexes used by
// yolo gates.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { safeRegExp, validateRegexPattern } from "../src/lib/security/regex-guard.js";

describe("P10.S4 validateRegexPattern rejects ReDoS patterns", () => {
  const dangerousPatterns = [
    "(a+)+",
    "(a+)+$",
    "(a*)*",
    "(a+)*",
    "(a*)+",
    "(a+)?",
    "(a?)+",
    "([a-z]+)+",
    "(\\d+)*",
    "(a+){1,3}",
  ];

  for (const pattern of dangerousPatterns) {
    test(`rejects nested quantifier ${pattern}`, () => {
      const result = validateRegexPattern(pattern);
      assert.equal(result.ok, false);
      assert.match(result.reason || "", /nested quantifiers/);
    });
  }

  test("rejects empty pattern", () => {
    const result = validateRegexPattern("");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /empty/);
  });

  test("rejects invalid regex syntax", () => {
    const result = validateRegexPattern("(");
    assert.equal(result.ok, false);
    assert.match(result.reason || "", /invalid regex/);
  });

  test("rejects null/undefined pattern", () => {
    assert.equal(validateRegexPattern(null).ok, false);
    assert.equal(validateRegexPattern(undefined).ok, false);
  });
});

describe("P10.S4 validateRegexPattern accepts safe patterns", () => {
  const safePatterns = [
    "foo",
    "^foo$",
    "foo|bar",
    "[a-zA-Z_][a-zA-Z0-9_]*",
    "TS\\d{4}",
    "\\bimport\\b",
    "(a|b)",
    "(ab|cd)+",
    "a+",
    "a*",
    "a?",
  ];

  for (const pattern of safePatterns) {
    test(`accepts safe pattern ${pattern}`, () => {
      const result = validateRegexPattern(pattern);
      assert.equal(result.ok, true, `expected ${pattern} to be safe`);
    });
  }

  test("safeRegExp returns null for unsafe pattern", () => {
    assert.equal(safeRegExp("(a+)+"), null);
  });

  test("safeRegExp returns RegExp for safe pattern", () => {
    const re = safeRegExp("^foo$", "i");
    assert.ok(re instanceof RegExp);
    assert.ok(re?.test("FOO"));
  });
});
