import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execSync as realExecSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  gitLines,
  isBusinessLikeFile,
  isFileAllowedByScope,
  parseGitNameStatusEntries,
  parseGitStatusEntries,
  provisionWorktreeNodeModules,
} from "../src/runtime/execution/worktree-session.js";
import { baselineArtifactHash } from "../src/runtime/execution/baselines.js";

function assertNodeModulesExecOptions(options, timeout) {
  assert.equal(options.encoding, "utf8");
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(options.timeout, timeout);
  assert.equal(options.maxBuffer, 1024 * 1024);
}

describe("worktree execution session helpers", () => {
  test("scope helpers allow explicit targets and sibling new files only when requested", () => {
    const scope = { targets: [{ file: "src/a.ts" }], allow_new_files: true };

    assert.equal(isFileAllowedByScope("src/a.ts", scope as unknown as Parameters<typeof isFileAllowedByScope>[1]), true);
    assert.equal(isFileAllowedByScope("src/a.helper.ts", scope as unknown as Parameters<typeof isFileAllowedByScope>[1]), true);
    assert.equal(isFileAllowedByScope("other/b.ts", scope as unknown as Parameters<typeof isFileAllowedByScope>[1]), false);
    assert.equal(isFileAllowedByScope("src/a.helper.ts", { ...scope, allow_new_files: false } as unknown as Parameters<typeof isFileAllowedByScope>[1]), false);
  });

  test("git entry parsers preserve rename destinations and delete flags", () => {
    assert.deepEqual(parseGitStatusEntries([
      " M src/a.ts",
      "D  src/deleted.ts",
      "R  src/old.ts -> src/new.ts",
    ].join("\n")), [
      { path: "src/a.ts", isDeleted: false },
      { path: "src/deleted.ts", isDeleted: true },
      { path: "src/new.ts", isDeleted: false },
    ]);

    assert.deepEqual(parseGitNameStatusEntries([
      "M\tsrc/a.ts",
      "D\tsrc/deleted.ts",
      "R100\tsrc/old.ts\tsrc/new.ts",
    ].join("\n")), [
      { path: "src/a.ts", isDeleted: false },
      { path: "src/deleted.ts", isDeleted: true },
      { path: "src/new.ts", isDeleted: false },
    ]);
  });

  test("gitLines strict failure throws instead of returning empty success", () => {
    const execFileSync = () => {
      const error: Error & { stderr: string } = Object.assign(new Error("git failed"), { stderr: "fatal: not a git repository" });
      throw error;
    };

    assert.throws(
      () => gitLines("/repo", ["status", "--porcelain"], { execFileSync }),
      /git status --porcelain failed: fatal: not a git repository/,
    );
    assert.deepEqual(gitLines("/repo", ["status", "--porcelain"], { execFileSync, strict: false }), []);
  });

  test("provisionWorktreeNodeModules uses platform clone commands first", () => {
    const darwinCalls = [];
    const linuxCalls = [];
    const exists = (path) => path === "/repo/node_modules";

    assert.equal(provisionWorktreeNodeModules({
      wtPath: "/repo/.yolo-worktrees/FIX-1",
      rootDir: "/repo",
      platform: "darwin",
      existsSync: exists,
      execSync: (command, options) => darwinCalls.push({ command, options }),
    }), true);
    assert.deepEqual(darwinCalls.map((call) => call.command), ['cp -cR "/repo/node_modules" "/repo/.yolo-worktrees/FIX-1/node_modules"']);
    assertNodeModulesExecOptions(darwinCalls[0].options, 15000);

    assert.equal(provisionWorktreeNodeModules({
      wtPath: "/repo/.yolo-worktrees/FIX-2",
      rootDir: "/repo",
      platform: "linux",
      existsSync: exists,
      execSync: (command, options) => linuxCalls.push({ command, options }),
    }), true);
    assert.deepEqual(linuxCalls.map((call) => call.command), ['cp --reflink=auto -r "/repo/node_modules" "/repo/.yolo-worktrees/FIX-2/node_modules"']);
    assertNodeModulesExecOptions(linuxCalls[0].options, 15000);
  });

  test("provisionWorktreeNodeModules falls back from clone to ordinary copy", () => {
    const calls = [];
    assert.equal(provisionWorktreeNodeModules({
      wtPath: "/repo/.yolo-worktrees/FIX-CP",
      rootDir: "/repo",
      platform: "darwin",
      existsSync: (path) => path === "/repo/node_modules",
      execSync: (command, options) => {
        calls.push({ command, options });
        if (command.startsWith("cp -cR ")) throw new Error("clone unsupported");
        return "";
      },
    }), true);

    assert.deepEqual(calls.map((call) => call.command), [
      'cp -cR "/repo/node_modules" "/repo/.yolo-worktrees/FIX-CP/node_modules"',
      'cp -r "/repo/node_modules" "/repo/.yolo-worktrees/FIX-CP/node_modules"',
    ]);
    assertNodeModulesExecOptions(calls[0].options, 15000);
    assertNodeModulesExecOptions(calls[1].options, 120000);
  });

  test("provisionWorktreeNodeModules keeps symlink as the last fallback", () => {
    const calls = [];
    assert.equal(provisionWorktreeNodeModules({
      wtPath: "/repo/.yolo-worktrees/FIX-LINK",
      rootDir: "/repo",
      platform: "linux",
      existsSync: (path) => path === "/repo/node_modules",
      execSync: (command, options) => {
        calls.push({ command, options });
        if (!command.startsWith("ln -s ")) throw new Error("copy failed");
        return "";
      },
    }), true);

    assert.deepEqual(calls.map((call) => call.command), [
      'cp --reflink=auto -r "/repo/node_modules" "/repo/.yolo-worktrees/FIX-LINK/node_modules"',
      'cp -r "/repo/node_modules" "/repo/.yolo-worktrees/FIX-LINK/node_modules"',
      'ln -s "/repo/node_modules" "/repo/.yolo-worktrees/FIX-LINK/node_modules"',
    ]);
    assertNodeModulesExecOptions(calls[0].options, 15000);
    assertNodeModulesExecOptions(calls[1].options, 120000);
    assertNodeModulesExecOptions(calls[2].options, 5000);
  });

  test("provisionWorktreeNodeModules removes timed-out copy partials before symlink fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-node-modules-timeout-"));
    const rootDir = join(root, "project");
    const wtPath = join(root, ".yolo-worktrees", "FIX-TIMEOUT");
    const wtNodeModules = join(wtPath, "node_modules");
    try {
      mkdirSync(join(rootDir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(wtPath, { recursive: true });
      writeFileSync(join(rootDir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");

      const calls = [];
      const execSync = (command, options) => {
        calls.push({ command, options });
        if (command.startsWith("cp --reflink=auto -r ")) throw new Error("clone unsupported");
        if (command.startsWith("cp -r ")) {
          mkdirSync(wtNodeModules, { recursive: true });
          writeFileSync(join(wtNodeModules, "partial.txt"), "partial\n", "utf8");
          throw Object.assign(new Error("copy timed out"), { code: "ETIMEDOUT" });
        }
        if (command.startsWith("ln -s ")) return realExecSync(command, options);
        throw new Error(`unexpected command: ${command}`);
      };

      assert.equal(provisionWorktreeNodeModules({
        wtPath,
        rootDir,
        platform: "linux",
        execSync,
      }), true);

      assert.deepEqual(calls.map((call) => call.command), [
        `cp --reflink=auto -r "${join(rootDir, "node_modules")}" "${wtNodeModules}"`,
        `cp -r "${join(rootDir, "node_modules")}" "${wtNodeModules}"`,
        `ln -s "${join(rootDir, "node_modules")}" "${wtNodeModules}"`,
      ]);
      assertNodeModulesExecOptions(calls[0].options, 15000);
      assertNodeModulesExecOptions(calls[1].options, 120000);
      assertNodeModulesExecOptions(calls[2].options, 5000);
      assert.equal(lstatSync(wtNodeModules).isSymbolicLink(), true);
      assert.equal(realpathSync(wtNodeModules), realpathSync(join(rootDir, "node_modules")));
      assert.equal(existsSync(join(wtNodeModules, "partial.txt")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("provisionWorktreeNodeModules creates an in-worktree real directory", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-node-modules-"));
    const rootDir = join(root, "project");
    const wtPath = join(root, ".yolo-worktrees", "FIX-REAL");
    try {
      mkdirSync(join(rootDir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(wtPath, { recursive: true });
      writeFileSync(join(rootDir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");

      assert.equal(provisionWorktreeNodeModules({ wtPath, rootDir }), true);

      const wtNodeModules = join(wtPath, "node_modules");
      const stat = lstatSync(wtNodeModules);
      const real = realpathSync(wtNodeModules);
      const rel = relative(realpathSync(wtPath), real);
      assert.equal(stat.isDirectory(), true);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(Boolean(rel && !rel.startsWith("..") && !isAbsolute(rel)), true);
      assert.equal(existsSync(join(wtNodeModules, "pkg", "index.js")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("business-like scope uses the shared source-file policy", () => {
    for (const filePath of [
      "packages/app/lib/page.ts",
      "app/page.tsx",
      "components/nav.tsx",
      "lib/db.ts",
      "migrations/001.sql",
    ]) {
      assert.equal(isBusinessLikeFile(filePath), true);
    }
    assert.equal(isBusinessLikeFile("docs/notes.md"), false);
    assert.equal(isBusinessLikeFile("public/robots.txt"), false);
    assert.equal(isBusinessLikeFile("public/robots.txt", { config: { build: { business_globs: ["public/**"] } } }), true);
  });

  test("createTaskWorktree creates a deterministic worktree and writes gate baselines", () => {
    const commands = [];
    const writes = new Map();
    const mkdirs = [];
    const execSync = (command) => {
      commands.push(command);
      if (command === "git rev-parse --is-inside-work-tree") return "true\n";
      if (command === "git rev-parse HEAD") return "abc123\n";
      return "";
    };
    const execFileSync = (bin, _args) => {
      if (bin === "tsc") return "src/a.ts(1,1): error TS1000: bad\n";
      if (bin === "eslint") {
        return JSON.stringify([{ filePath: "/repo/.yolo-worktrees/FIX-1/src/a.ts", messages: [{ line: 2, ruleId: "semi" }] }]);
      }
      return "";
    };

    const wt = createTaskWorktree({
      taskId: "FIX-1",
      rootDir: "/repo",
      worktreeRoot: "/repo/.yolo-worktrees",
      config: { build: { type_check: "tsc", lint: "eslint" } },
      now: () => 123,
      execSync,
      execFileSync,
      existsSync: () => false,
      mkdirSync: (path) => mkdirs.push(path),
      writeFileSync: (path, content) => writes.set(path, content),
    });

    assert.deepEqual(wt, {
      branch: "yolo-FIX-1-123",
      path: "/repo/.yolo-worktrees/FIX-1",
      base: "abc123",
      mode: "git",
    });
    assert.ok(commands.some((command) => command.includes("git worktree add --detach")));
    assert.ok(commands.some((command) => command.includes("checkout -b")));
    assert.ok(mkdirs.includes("/repo/.yolo-worktrees"));
    const tscBaseline = JSON.parse(writes.get("/repo/.yolo-worktrees/FIX-1/scripts/yolo/state/runtime/tsc-baseline.json"));
    const eslintBaseline = JSON.parse(writes.get("/repo/.yolo-worktrees/FIX-1/scripts/yolo/state/runtime/eslint-baseline.json"));
    assert.deepEqual(tscBaseline.keys, ["src/a.ts:1:TS1000"]);
    assert.equal(tscBaseline.meta.command, "tsc");
    assert.equal(tscBaseline.meta.exit_code, 0);
    assert.equal(tscBaseline.meta.artifact_hash, baselineArtifactHash(tscBaseline));
    assert.deepEqual(eslintBaseline.keys, ["src/a.ts:2:semi"]);
    assert.equal(eslintBaseline.meta.command, "eslint");
    assert.equal(eslintBaseline.meta.artifact_hash, baselineArtifactHash(eslintBaseline));
  });

  test("createTaskWorktree falls back to a filesystem copy outside a git worktree", () => {
    const copies = [];
    const removed = [];
    const writes = new Map();
    const wt = createTaskWorktree({
      taskId: "FIX-FS",
      rootDir: "/repo/yolo",
      worktreeRoot: "/repo/.yolo-worktrees",
      config: { build: { type_check: "tsc", lint: "eslint" } },
      now: () => 456,
      execSync: (command) => {
        if (command === "git rev-parse --is-inside-work-tree") throw new Error("not a worktree");
        if (command === "git rev-parse HEAD") return "abc456\n";
        return "";
      },
      execFileSync: () => "",
      existsSync: () => false,
      mkdirSync: () => {},
      rmSync: (path) => removed.push(path),
      cpSync: (src, dst) => copies.push({ src, dst }),
      writeFileSync: (path, content) => writes.set(path, content),
    });

    assert.deepEqual(wt, {
      branch: "yolo-FIX-FS-456",
      path: "/repo/.yolo-worktrees/FIX-FS",
      base: "abc456",
      mode: "filesystem",
    });
    assert.deepEqual(copies, [{ src: "/repo/yolo", dst: "/repo/.yolo-worktrees/FIX-FS" }]);
    assert.equal(removed.length, 0);
    assert.ok(writes.has("/repo/.yolo-worktrees/FIX-FS/scripts/yolo/state/runtime/tsc-baseline.json"));
  });

  test("cleanupTaskWorktree copies scoped files, skips out-of-scope business files, and cleans worktree", () => {
    const copied = [];
    const commands = [];
    const logs = [];
    const execFileSync = (_command, args) => {
      if (args[0] === "-C" && args[2] === "status") {
        return [
          " M src/a.ts",
          " M src/b.ts",
          " M scripts/yolo/state/runtime/tmp.json",
          " D src/deleted.ts",
        ].join("\n");
      }
      if (args[0] === "-C" && args[2] === "diff") return "";
      if (args[0] === "-C" && args[2] === "ls-files") return "";
      if (args[0] === "diff") return "src/a.ts\n";
      if (args[0] === "ls-files") return "";
      return "";
    };

    const result = cleanupTaskWorktree({
      wtPath: "/wt/FIX-1",
      wtBranch: "yolo-FIX-1",
      rootDir: "/repo",
      mergeToMain: true,
      allowedScope: { targets: [{ file: "src/a.ts" }] },
      execFileSync,
      execSync: (command) => {
        commands.push(command);
        if (command === "git rev-parse --is-inside-work-tree") return "true\n";
        return "";
      },
      existsSync: (path) => path === "/wt/FIX-1/src/a.ts",
      statSync: () => ({ isDirectory: () => false }),
      mkdirSync: () => {},
      copyFileSync: (src, dst) => copied.push({ src, dst }),
      log: (phase, detail) => logs.push({ phase, detail }),
    });

    const mergedResult = result as string[] & { outOfScopeSkipped: string[] };
    assert.deepEqual(result, ["src/a.ts"]);
    assert.deepEqual(mergedResult.outOfScopeSkipped, ["src/b.ts"]);
    assert.deepEqual(copied, [{ src: "/wt/FIX-1/src/a.ts", dst: "/repo/src/a.ts" }]);
    assert.ok(logs.some((entry) => entry.phase === "BLOCK" && entry.detail.includes("src/b.ts")));
    assert.ok(logs.some((entry) => entry.phase === "MERGED" && entry.detail.includes("跳过 1 个运行时文件")));
    assert.ok(commands.some((command) => command.includes("git worktree remove")));
    assert.ok(commands.some((command) => command.includes("git branch -D")));
  });

  test("cleanupTaskWorktree blocks when merge diff verification throws", () => {
    const execFileSync = (_command, args) => {
      if (args[0] === "-C" && args[2] === "status") return " M src/a.ts\n";
      if (args[0] === "-C" && args[2] === "ls-files") return "";
      if (args[0] === "diff") {
        const error: Error & { stderr: string } = Object.assign(new Error("diff exploded"), { stderr: "fatal: diff exploded" });
        throw error;
      }
      if (args[0] === "ls-files") return "";
      return "";
    };

    assert.throws(
      () => cleanupTaskWorktree({
        wtPath: "/wt/FIX-VERIFY",
        wtBranch: "yolo-FIX-VERIFY",
        rootDir: "/repo",
        mergeToMain: true,
        allowedScope: { targets: [{ file: "src/a.ts" }] },
        execFileSync,
        execSync: () => "true\n",
        existsSync: (path) => path === "/wt/FIX-VERIFY/src/a.ts",
        statSync: () => ({ isDirectory: () => false }),
        mkdirSync: () => {},
        copyFileSync: () => {},
      }),
      /worktree merge verification failed: fatal: diff exploded/,
    );
  });

  test("cleanupTaskWorktree skips layout-independent business source files for commit blocking", () => {
    const copied = [];
    const logs = [];
    const execFileSync = (_command, args) => {
      if (args[0] === "-C" && args[2] === "status") {
        return [
          " M src/a.ts",
          " M packages/app/lib/page.ts",
          " M app/page.tsx",
          " M components/nav.tsx",
          " M lib/db.ts",
          " M migrations/001.sql",
        ].join("\n");
      }
      if (args[0] === "-C" && args[2] === "ls-files") return "";
      if (args[0] === "diff") return "src/a.ts\n";
      if (args[0] === "ls-files") return "";
      return "";
    };

    const result = cleanupTaskWorktree({
      wtPath: "/wt/FIX-PKG",
      wtBranch: "yolo-FIX-PKG",
      rootDir: "/repo",
      mergeToMain: true,
      allowedScope: { targets: [{ file: "src/a.ts" }] },
      execFileSync,
      execSync: () => "true\n",
      existsSync: (path) => path === "/wt/FIX-PKG/src/a.ts",
      statSync: () => ({ isDirectory: () => false }),
      mkdirSync: () => {},
      copyFileSync: (src, dst) => copied.push({ src, dst }),
      log: (phase, detail) => logs.push({ phase, detail }),
    });

    const pkgResult = result as string[] & { outOfScopeSkipped: string[] };
    assert.deepEqual(result, ["src/a.ts"]);
    assert.deepEqual(pkgResult.outOfScopeSkipped, [
      "packages/app/lib/page.ts",
      "app/page.tsx",
      "components/nav.tsx",
      "lib/db.ts",
      "migrations/001.sql",
    ]);
    assert.deepEqual(copied, [{ src: "/wt/FIX-PKG/src/a.ts", dst: "/repo/src/a.ts" }]);
    assert.ok(logs.some((entry) => entry.phase === "BLOCK" && entry.detail.includes("packages/app/lib/page.ts")));
  });

  test("cleanupTaskWorktree honors configured business_globs when blocking out-of-scope files", () => {
    const copied = [];
    const logs = [];
    const execFileSync = (_command, args) => {
      if (args[0] === "-C" && args[2] === "status") {
        return [
          " M src/a.ts",
          " M public/robots.txt",
          " M components/nav.tsx",
        ].join("\n");
      }
      if (args[0] === "-C" && args[2] === "ls-files") return "";
      if (args[0] === "diff") return "src/a.ts\n";
      if (args[0] === "ls-files") return "";
      return "";
    };

    const result = cleanupTaskWorktree({
      wtPath: "/wt/FIX-GLOBS",
      wtBranch: "yolo-FIX-GLOBS",
      rootDir: "/repo",
      mergeToMain: true,
      allowedScope: { targets: [{ file: "src/a.ts" }] },
      config: { build: { business_globs: ["src/**", "public/**"] } },
      execFileSync,
      execSync: () => "true\n",
      existsSync: (path) => path === "/wt/FIX-GLOBS/src/a.ts" || path === "/wt/FIX-GLOBS/components/nav.tsx",
      statSync: () => ({ isDirectory: () => false }),
      mkdirSync: () => {},
      copyFileSync: (src, dst) => copied.push({ src, dst }),
      log: (phase, detail) => logs.push({ phase, detail }),
    });

    const globResult = result as string[] & { outOfScopeSkipped: string[] };
    assert.deepEqual(result, ["src/a.ts", "components/nav.tsx"]);
    assert.deepEqual(globResult.outOfScopeSkipped, ["public/robots.txt"]);
    assert.deepEqual(copied, [
      { src: "/wt/FIX-GLOBS/src/a.ts", dst: "/repo/src/a.ts" },
      { src: "/wt/FIX-GLOBS/components/nav.tsx", dst: "/repo/components/nav.tsx" },
    ]);
    assert.ok(logs.some((entry) => entry.phase === "BLOCK" && entry.detail.includes("public/robots.txt")));
  });

  test("cleanupTaskWorktree merges scoped files from filesystem worktrees", () => {
    const copied = [];
    const removed = [];
    const result = cleanupTaskWorktree({
      wtPath: "/wt/FIX-FS",
      wtBranch: "yolo-FIX-FS",
      rootDir: "/repo/yolo",
      mergeToMain: true,
      allowedScope: {
        targets: [
          { file: "src/runtime/progress/server.js" },
          { file: "__tests__/progress-dashboard.test.js" },
        ],
      },
      execSync: (command) => {
        if (command === "git rev-parse --is-inside-work-tree") throw new Error("not a worktree");
        return "";
      },
      execFileSync: () => "",
      existsSync: (path) => [
        "/wt/FIX-FS",
        "/wt/FIX-FS/src/runtime/progress/server.js",
        "/wt/FIX-FS/__tests__/progress-dashboard.test.js",
        "/repo/yolo/src/runtime/progress/server.js",
        "/repo/yolo/__tests__/progress-dashboard.test.js",
        "/repo/yolo/src/runtime/progress",
        "/repo/yolo/__tests__",
      ].includes(path),
      statSync: () => ({ isDirectory: () => false }),
      mkdirSync: () => {},
      rmSync: (path) => removed.push(path),
      copyFileSync: (src, dst) => copied.push({ src, dst }),
    });

    assert.deepEqual(result, [
      "src/runtime/progress/server.js",
      "__tests__/progress-dashboard.test.js",
    ]);
    assert.deepEqual(copied.filter((entry) => entry.src.startsWith("/wt/FIX-FS/")), [
      {
        src: "/wt/FIX-FS/src/runtime/progress/server.js",
        dst: "/repo/yolo/src/runtime/progress/server.js",
      },
      {
        src: "/wt/FIX-FS/__tests__/progress-dashboard.test.js",
        dst: "/repo/yolo/__tests__/progress-dashboard.test.js",
      },
    ]);
    assert.deepEqual(removed, ["/wt/FIX-FS"]);
  });
});
