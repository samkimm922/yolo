import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { evalFileLinesMax, evalFilesModifiedMax } from "../src/lib/evaluators/file-check.js";
import { evalCodeContains } from "../src/lib/evaluators/code-check.js";
import { evalNoNewDeadCode } from "../src/lib/evaluators/quality-check.js";
import { evaluatePreConditions, evaluatePostConditions } from "../src/prd/contract.js";
import { evalBusinessCodeMin } from "../src/lib/evaluators/runtime-check.js";

function fakeExec(outputs) {
  return (cmd) => ({ ok: true, out: outputs[cmd] || "" });
}

function fakeFailExec() {
  return () => ({ ok: false, out: "", err: "git unavailable" });
}

describe("files_modified_max scope filtering", () => {
  test("counts all business diffs and reports target scope violations", () => {
    const result = evalFilesModifiedMax(
      { max: 1 },
      { targets: [{ file: "scripts/yolo/state/dry-run/p3/00-runbook.md" }] },
      "/repo",
      fakeExec({
        "git diff --name-only": [
          "src/a.ts",
          "src/b.ts",
          "scripts/yolo/state/dry-run/p3/00-runbook.md",
        ].join("\n"),
        "git ls-files --others --exclude-standard": "docs/out-of-band.md",
      }),
    );
    assert.equal(result.passed, false);
    assert.equal(result.found, 2);
    assert.deepEqual(result.files, ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(result.target_files, ["scripts/yolo/state/dry-run/p3/00-runbook.md"]);
    assert.deepEqual(result.out_of_scope_files, ["src/a.ts", "src/b.ts"]);
  });

  test("counts in-scope and out-of-scope files together when task scope declares targets", () => {
    const result = evalFilesModifiedMax(
      { max: 2 },
      { targets: [{ file: "src/a.ts" }] },
      "/repo",
      fakeExec({
        "git diff --name-only": "src/a.ts\nsrc/b.ts\n",
        "git ls-files --others --exclude-standard": "",
      }),
    );
    assert.equal(result.passed, true);
    assert.equal(result.found, 2);
    assert.deepEqual(result.target_files, ["src/a.ts"]);
    assert.deepEqual(result.out_of_scope_files, ["src/b.ts"]);
  });

  test("counts layout-independent source files as business diffs", () => {
    const result = evalFilesModifiedMax(
      { max: 2 },
      { targets: [{ file: "app/page.tsx" }] },
      "/repo",
      fakeExec({
        "git diff --name-only": "app/page.tsx\nlib/db.ts\ncomponents/nav.tsx\ndocs/notes.md\n",
        "git ls-files --others --exclude-standard": "",
      }),
    );

    assert.equal(result.passed, false);
    assert.equal(result.found, 3);
    assert.deepEqual(result.files, ["app/page.tsx", "lib/db.ts", "components/nav.tsx"]);
    assert.deepEqual(result.out_of_scope_files, ["lib/db.ts", "components/nav.tsx"]);
  });

  test("honors configured business_globs for files_modified_max", () => {
    const result = evalFilesModifiedMax(
      { max: 1 },
      { targets: [{ file: "app/page.tsx" }] },
      "/repo",
      fakeExec({
        "git diff --name-only": "app/page.tsx\nlib/db.ts\ncomponents/nav.tsx\n",
        "git ls-files --others --exclude-standard": "",
      }),
      { config: { build: { business_globs: ["app/**", "lib/**"] } } },
    );

    assert.equal(result.passed, false);
    assert.equal(result.found, 2);
    assert.deepEqual(result.files, ["app/page.tsx", "lib/db.ts"]);
    assert.deepEqual(result.out_of_scope_files, ["lib/db.ts"]);
  });

  test("uses runner-provided changed files after task commit", () => {
    const result = evalFilesModifiedMax(
      { max: 1 },
      { targets: [{ file: "components/ExternalSmokeBadge.tsx" }] },
      "/repo",
      fakeFailExec(),
      {
        changedFiles: ["components/ExternalSmokeBadge.tsx"],
        config: { build: { business_globs: ["components/**/*.tsx"] } },
      },
    );

    assert.equal(result.passed, true);
    assert.equal(result.found, 1);
    assert.deepEqual(result.files, ["components/ExternalSmokeBadge.tsx"]);
  });

  test("fails closed when git diff is unavailable", () => {
    const result = evalFilesModifiedMax(
      { max: 2 },
      { targets: [{ file: "src/a.ts" }] },
      "/repo",
      fakeFailExec(),
    );

    assert.equal(result.passed, false);
    assert.equal(result.status, "indeterminate");
    assert.match(result.detail, /无法获取 diff/);
  });
});

describe("file_lines_max target existence", () => {
  test("fails when an explicit target file is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-file-lines-"));
    try {
      const result = evalFileLinesMax({ file: "src/missing.ts", max: 150 }, {}, root);
      assert.equal(result.passed, false);
      assert.match(result.detail, /文件不存在/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("allows a small bounded delta on legacy files already over the line limit", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-file-lines-"));
    try {
      mkdirSync(join(root, "src/runtime/progress"), { recursive: true });
      writeFileSync(join(root, "src/runtime/progress/server.js"), Array.from({ length: 156 }, (_, i) => `line${i}`).join("\n"), "utf8");
      writeFileSync(join(root, ".yolo-worktree-baseline.json"), JSON.stringify({
        line_counts: { "src/runtime/progress/server.js": 151 },
      }), "utf8");
      const result = evalFileLinesMax({ file: "src/runtime/progress/server.js", max: 150, legacy_delta_max: 10 }, {}, root);
      assert.equal(result.passed, true);
      assert.match(result.detail, /遗留超长文件未显著恶化/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails legacy files when the delta exceeds the bounded grace", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-file-lines-"));
    try {
      mkdirSync(join(root, "src/runtime/progress"), { recursive: true });
      writeFileSync(join(root, "src/runtime/progress/server.js"), Array.from({ length: 170 }, (_, i) => `line${i}`).join("\n"), "utf8");
      writeFileSync(join(root, ".yolo-worktree-baseline.json"), JSON.stringify({
        line_counts: { "src/runtime/progress/server.js": 151 },
      }), "utf8");
      const result = evalFileLinesMax({ file: "src/runtime/progress/server.js", max: 150, legacy_delta_max: 10 }, {}, root);
      assert.equal(result.passed, false);
      assert.match(result.detail, /限制 150 行/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("evaluator cannot-verify states", () => {
  test("code_contains with an empty target set is not_run instead of pass", () => {
    const result = evalCodeContains({ text: "needle" }, {}, "/repo");

    assert.equal(result.passed, false);
    assert.equal(result.status, "not_run");
  });

  test("target_file_modified without a target is not_run and blocks allPass", () => {
    const result = evaluatePreConditions({
      id: "T",
      pre_conditions: [{
        id: "PRE-TARGET",
        type: "target_file_modified",
        severity: "FAIL",
        params: {},
      }],
    }, {}, { root: "/repo" });

    assert.equal(result.allPass, false);
    assert.equal(result.results[0].status, "not_run");
    assert.equal(result.results[0].passed, false);
  });

  test("target_file_modified with unavailable git diff is indeterminate", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-target-diff-"));
    try {
      const result = evaluatePreConditions({
        id: "T",
        scope: { targets: [{ file: "src/a.ts" }] },
        pre_conditions: [{
          id: "PRE-TARGET",
          type: "target_file_modified",
          severity: "FAIL",
          params: { file: "src/a.ts" },
        }],
      }, {}, { root });

      assert.equal(result.allPass, false);
      assert.equal(result.results[0].status, "indeterminate");
      assert.match(result.results[0].detail, /无法获取 git diff/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("required_imports_present fails closed when target files are missing", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-imports-"));
    try {
      const result = evaluatePreConditions({
        id: "T",
        pre_conditions: [{
          id: "PRE-IMPORT",
          type: "required_imports_present",
          severity: "FAIL",
          params: { files: ["src/missing.ts"], import_path: "./dep" },
        }],
      }, {}, { root });

      assert.equal(result.allPass, false);
      assert.equal(result.results[0].status, "indeterminate");
      assert.deepEqual(result.results[0].missing_files, ["src/missing.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no_new_dead_code without a runnable tool or baseline is indeterminate", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-knip-"));
    try {
      const result = evalNoNewDeadCode({
        command: `"${process.execPath}" -e "process.exit(7)"`,
        timeout_ms: 1000,
      }, {}, root);

      assert.equal(result.passed, false);
      assert.equal(result.status, "indeterminate");
      assert.match(result.detail, /无法验证死代码/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warning-only conditions are non-pass for contract allPass", () => {
    const result = evaluatePreConditions({
      id: "T",
      pre_conditions: [{
        id: "PRE-WARN",
        type: "code_contains",
        severity: "WARN",
        params: { text: "missing" },
      }],
    }, {}, { root: "/repo" });

    assert.equal(result.allPass, false);
    assert.equal(result.warnConditions.length, 1);
    assert.equal(result.results[0].status, "not_run");
  });
});

describe("target_file_modified changed file source", () => {
  const calendarTarget = "components/board/views/calendar-view.tsx";

  function evaluateTargetFileModified({
    target = calendarTarget,
    changedFiles,
    changed_files,
    root = "/repo",
  } = Object()) {
    const options = {
      root,
      ...(changedFiles !== undefined ? { changedFiles } : Object()),
      ...(changed_files !== undefined ? { changed_files } : Object()),
    };
    return evaluatePostConditions({
      id: "T",
      scope: {
        expected_zero_business_code: true,
        targets: [{ file: target }],
      },
      post_conditions: [{
        id: "POST-TARGET",
        type: "target_file_modified",
        severity: "FAIL",
        params: { file: target },
      }],
    }, {}, options);
  }

  function targetResult(result) {
    return result.results.find((item) => item.id === "POST-TARGET");
  }

  test("uses runner-provided changedFiles after task commit", () => {
    const result = evaluateTargetFileModified({
      changedFiles: [calendarTarget],
    });

    assert.equal(result.allPass, true);
    assert.equal(targetResult(result).passed, true);
    assert.equal(targetResult(result).found, 1);
  });

  test("uses runner-provided changed_files alias after task commit", () => {
    const result = evaluateTargetFileModified({
      changed_files: [calendarTarget],
    });

    assert.equal(result.allPass, true);
    assert.equal(targetResult(result).passed, true);
    assert.equal(targetResult(result).found, 1);
  });

  test("matches runner-provided changedFiles by target suffix", () => {
    const result = evaluateTargetFileModified({
      changedFiles: [`packages/web/${calendarTarget}`],
    });

    assert.equal(result.allPass, true);
    assert.equal(targetResult(result).passed, true);
    assert.equal(targetResult(result).found, 1);
  });

  test("fails when runner-provided changedFiles does not include the target", () => {
    const result = evaluateTargetFileModified({
      changedFiles: ["components/board/views/list-view.tsx"],
    });

    assert.equal(result.allPass, false);
    assert.equal(targetResult(result).passed, false);
    assert.equal(targetResult(result).found, 0);
    assert.match(targetResult(result).detail, /未在修改列表中/);
  });

  test("falls back to git diff when changedFiles is not provided", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-target-file-git-"));
    try {
      mkdirSync(join(root, "components/board/views"), { recursive: true });
      writeFileSync(join(root, calendarTarget), "export const initial = true;\n", "utf8");
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["add", calendarTarget], { cwd: root });
      execFileSync("git", [
        "-c", "user.name=YOLO Test",
        "-c", "user.email=yolo@example.invalid",
        "commit", "--quiet", "-m", "init",
      ], { cwd: root });
      writeFileSync(join(root, calendarTarget), "export const changed = true;\n", "utf8");

      const result = evaluateTargetFileModified({ root });

      assert.equal(result.allPass, true);
      assert.equal(targetResult(result).passed, true);
      assert.equal(targetResult(result).found, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to git untracked files for newly created targets", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-target-file-untracked-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["commit", "--allow-empty", "--quiet", "-m", "init"], {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "YOLO Test",
          GIT_AUTHOR_EMAIL: "yolo@example.invalid",
          GIT_COMMITTER_NAME: "YOLO Test",
          GIT_COMMITTER_EMAIL: "yolo@example.invalid",
        },
      });
      mkdirSync(join(root, "components/board/views"), { recursive: true });
      writeFileSync(join(root, calendarTarget), "export const created = true;\n", "utf8");

      const result = evaluateTargetFileModified({ root });

      assert.equal(result.allPass, true);
      assert.equal(targetResult(result).passed, true);
      assert.equal(targetResult(result).found, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("normalizes leading dot path differences before matching changedFiles", () => {
    const result = evaluateTargetFileModified({
      target: `./${calendarTarget}`,
      changedFiles: [calendarTarget],
    });

    assert.equal(result.allPass, true);
    assert.equal(targetResult(result).passed, true);
  });
});

describe("business_code_min scope classification", () => {
  test("counts src/runtime files as project code instead of PM/UI hardcoded noise", () => {
    const result = evalBusinessCodeMin(
      { min: 1 },
      {},
      "/repo",
      fakeExec({
        "git diff --name-only HEAD": "src/runtime/progress/server.js\n",
        "git ls-files --others --exclude-standard": "",
      }),
    );
    assert.equal(result.passed, true);
    assert.equal(result.found, 1);
  });

  test("counts component layout source files as business code", () => {
    const result = evalBusinessCodeMin(
      { min: 1 },
      {},
      "/repo",
      fakeExec({
        "git diff --name-only HEAD": "components/board/top-bar.tsx\n",
        "git ls-files --others --exclude-standard": "",
      }),
    );
    assert.equal(result.passed, true);
    assert.equal(result.found, 1);
  });

  test("honors configured business_globs for business_code_min", () => {
    const result = evalBusinessCodeMin(
      { min: 1 },
      {},
      "/repo",
      fakeExec({
        "git diff --name-only HEAD": "components/x.tsx\n",
        "git ls-files --others --exclude-standard": "",
      }),
      { config: { build: { business_globs: ["app/**", "lib/**"] } } },
    );
    assert.equal(result.passed, false);
    assert.equal(result.found, 0);
    assert.match(result.detail, /business_globs: app\/\*\*, lib\/\*\*/);
  });

  test("uses runner-provided changed files after task commit", () => {
    const result = evalBusinessCodeMin(
      { min: 1 },
      {},
      "/repo",
      fakeFailExec(),
      {
        changedFiles: ["components/ExternalSmokeBadge.tsx"],
        config: { build: { business_globs: ["components/**/*.tsx"] } },
      },
    );

    assert.equal(result.passed, true);
    assert.equal(result.found, 1);
  });

  test("uses filesystem worktree baseline hashes when git diff is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-business-code-"));
    try {
      mkdirSync(join(root, "src/runtime/progress"), { recursive: true });
      writeFileSync(join(root, "src/runtime/progress/server.js"), "export const changed = true;\n", "utf8");
      writeFileSync(join(root, ".yolo-worktree-baseline.json"), JSON.stringify({
        hashes: {
          "src/runtime/progress/server.js": "different-baseline-hash",
        },
      }), "utf8");
      const result = evalBusinessCodeMin(
        { min: 1 },
        { targets: [{ file: "src/runtime/progress/server.js" }] },
        root,
        fakeExec({
          "git diff --name-only HEAD": "",
          "git ls-files --others --exclude-standard": "",
        }),
      );
      assert.equal(result.passed, true);
      assert.equal(result.found, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
