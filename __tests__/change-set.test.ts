import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCommitChangeContext,
  classifyChangedFiles,
  filterCommittableFiles,
  isBusinessFile,
  readTaskChangedFiles,
  scopedOutOfScopeFiles,
} from "../src/runtime/execution/change-set.js";

describe("execution change-set helpers", () => {
  test("readTaskChangedFiles uses explicit worktree file lists without fallback filtering", () => {
    const result = readTaskChangedFiles({
      rootDir: "/repo",
      worktreeFiles: ["src/a.ts", ".gstack/generated.txt"],
      execFileSync: () => {
        throw new Error("should not read git status");
      },
    });

    assert.deepEqual(result, ["src/a.ts", ".gstack/generated.txt"]);
  });

  test("readTaskChangedFiles combines tracked and untracked fallback lists", () => {
    const calls = [];
    const execFileSync = (bin, args) => {
      calls.push([bin, ...args]);
      if (args[0] === "diff") return "src/a.ts\n.gstack/tmp\n";
      if (args[0] === "ls-files") return "tests/a.test.ts\n.yolo-backup/old\n";
      return "";
    };

    assert.deepEqual(readTaskChangedFiles({ rootDir: "/repo", execFileSync }), [
      "src/a.ts",
      "tests/a.test.ts",
    ]);
    assert.deepEqual(calls, [
      ["git", "diff", "--name-only"],
      ["git", "ls-files", "--others", "--exclude-standard"],
    ]);
  });

  test("filterCommittableFiles excludes runner docs and common binary artifacts", () => {
    assert.deepEqual(filterCommittableFiles([
      "docs/memory/SESSION.md",
      "src/a.ts",
      "docs/memory/SNAPSHOT.md",
      "assets/icon.png",
      "package.json",
    ]), [
      "src/a.ts",
      "package.json",
    ]);
  });

  test("isBusinessFile default policy detects source files across layouts", () => {
    assert.equal(isBusinessFile("components/board/top-bar.tsx"), true);
    assert.equal(isBusinessFile("app/page.tsx"), true);
    assert.equal(isBusinessFile("lib/store.ts"), true);
    assert.equal(isBusinessFile("src/a.ts"), true);
    assert.equal(isBusinessFile("cloudfunctions/f/index.js"), true);
    assert.equal(isBusinessFile("__tests__/a.test.js"), true);
    assert.equal(isBusinessFile(".yolo/state/x.json"), false);
    assert.equal(isBusinessFile("docs/spec.md"), false);
    assert.equal(isBusinessFile("node_modules/pkg/index.js"), false);
    assert.equal(isBusinessFile("dist/server.js"), false);
    assert.equal(isBusinessFile("scripts/yolo/runner.js"), false);
    assert.equal(isBusinessFile("README.md"), false);
    assert.equal(isBusinessFile("package-lock.json"), false);
  });

  test("isBusinessFile honors configured business_globs as an inclusion policy", () => {
    const config = { build: { business_globs: ["app/**", "lib/**"] } };
    assert.equal(isBusinessFile("app/x.ts", { config }), true);
    assert.equal(isBusinessFile("lib/store.ts", { config }), true);
    assert.equal(isBusinessFile("components/x.tsx", { config }), false);
    assert.equal(isBusinessFile(".yolo/state/x.ts", { config }), false);
  });

  test("classifyChangedFiles keeps layout-neutral business files in the business list", () => {
    assert.deepEqual(classifyChangedFiles([
      "components/board/top-bar.tsx",
      "app/page.tsx",
      "docs/spec.md",
      "package.json",
    ]), {
      business: ["components/board/top-bar.tsx", "app/page.tsx"],
      metadata: ["docs/spec.md", "package.json"],
    });
  });

  test("classifyChangedFiles uses configured business_globs to narrow business files", () => {
    const config = { build: { business_globs: ["app/**", "lib/**"] } };
    assert.deepEqual(classifyChangedFiles([
      "app/x.ts",
      "components/x.tsx",
      "lib/store.ts",
    ], { config }), {
      business: ["app/x.ts", "lib/store.ts"],
      metadata: ["components/x.tsx"],
    });
  });

  test("scopedOutOfScopeFiles returns target files and violations", () => {
    const task = {
      scope: {
        targets: [{ file: "src/a.ts" }],
        allow_new_files: false,
      },
    };
    const result = scopedOutOfScopeFiles(["src/a.ts", "src/b.ts"], task, {
      isFileAllowedByScope: (file, scope) => scope.targets.some((target) => target.file === file),
    });

    assert.deepEqual(result, {
      targetFiles: ["src/a.ts"],
      outOfScope: ["src/b.ts"],
    });
  });

  test("buildCommitChangeContext composes changed files, classifications, zero-biz override, and audit scope", () => {
    const calls = [];
    const execFileSync = (bin, args) => {
      calls.push([bin, ...args]);
      if (args[0] === "diff") return "src/a.ts\nREADME.md\ndocs/memory/SNAPSHOT.md\nassets/logo.png\n";
      if (args[0] === "ls-files") return "docs/spec.md\nsrc/out.ts\n";
      return "";
    };
    const task = {
      scope: {
        expected_zero_business_code: true,
        targets: [{ file: "src/a.ts" }],
      },
    };

    const context = buildCommitChangeContext({
      rootDir: "/repo",
      task,
      execFileSync,
      isFileAllowedByScope: (file, scope) => scope.targets.some((target) => target.file === file),
    });

    assert.deepEqual(calls, [
      ["git", "diff", "--name-only"],
      ["git", "ls-files", "--others", "--exclude-standard"],
    ]);
    assert.deepEqual(context.allChanged, [
      "src/a.ts",
      "README.md",
      "docs/memory/SNAPSHOT.md",
      "assets/logo.png",
      "docs/spec.md",
      "src/out.ts",
    ]);
    assert.deepEqual(context.code, [
      "src/a.ts",
      "README.md",
      "docs/spec.md",
      "src/out.ts",
    ]);
    assert.deepEqual(context.businessFiles, ["src/a.ts", "src/out.ts"]);
    assert.deepEqual(context.metadataFiles, ["README.md", "docs/spec.md"]);
    assert.equal(context.hasRealCode, true);
    assert.deepEqual(context.auditTargets, ["src/a.ts"]);
    assert.deepEqual(context.outOfScope, ["README.md", "docs/spec.md", "src/out.ts"]);
  });

  test("buildCommitChangeContext classifies component layout targets as business code", () => {
    const context = buildCommitChangeContext({
      rootDir: "/repo",
      task: { scope: { targets: [{ file: "components/board/top-bar.tsx" }] } },
      worktreeFiles: ["components/board/top-bar.tsx", "README.md"],
      isFileAllowedByScope: (file, scope) => scope.targets.some((target) => target.file === file),
    });

    assert.deepEqual(context.businessFiles, ["components/board/top-bar.tsx"]);
    assert.deepEqual(context.metadataFiles, ["README.md"]);
    assert.equal(context.hasRealCode, true);
    assert.deepEqual(context.auditTargets, ["components/board/top-bar.tsx"]);
    assert.deepEqual(context.outOfScope, ["README.md"]);
  });

  test("buildCommitChangeContext preserves out-of-scope files skipped during worktree cleanup", () => {
    const worktreeFiles = ["src/a.ts"];
    Object.defineProperty(worktreeFiles, "outOfScopeSkipped", {
      value: ["src/out.ts"],
      enumerable: false,
    });

    const context = buildCommitChangeContext({
      rootDir: "/repo",
      task: {
        scope: {
          targets: [{ file: "src/a.ts" }],
        },
      },
      worktreeFiles,
      isFileAllowedByScope: (file, scope) => scope.targets.some((target) => target.file === file),
    });

    assert.deepEqual(context.code, ["src/a.ts"]);
    assert.deepEqual(context.outOfScope, ["src/out.ts"]);
  });

  test("buildCommitChangeContext treats metadata-only changes as no real code without zero-biz override", () => {
    const context = buildCommitChangeContext({
      rootDir: "/repo",
      task: { scope: { targets: [{ file: "package.json" }] } },
      worktreeFiles: ["package.json"],
      isFileAllowedByScope: () => true,
    });

    assert.deepEqual(context.allChanged, ["package.json"]);
    assert.deepEqual(context.code, ["package.json"]);
    assert.deepEqual(context.businessFiles, []);
    assert.deepEqual(context.metadataFiles, ["package.json"]);
    assert.equal(context.hasRealCode, false);
    assert.deepEqual(context.outOfScope, []);
  });
});
