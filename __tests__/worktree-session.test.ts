import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupTaskWorktree,
  createTaskWorktree,
  isFileAllowedByScope,
  parseGitNameStatusEntries,
  parseGitStatusEntries,
} from "../src/runtime/execution/worktree-session.js";

describe("worktree execution session helpers", () => {
  test("scope helpers allow explicit targets and sibling new files only when requested", () => {
    const scope = { targets: [{ file: "src/a.ts" }], allow_new_files: true };

    assert.equal(isFileAllowedByScope("src/a.ts", scope), true);
    assert.equal(isFileAllowedByScope("src/a.helper.ts", scope), true);
    assert.equal(isFileAllowedByScope("other/b.ts", scope), false);
    assert.equal(isFileAllowedByScope("src/a.helper.ts", { ...scope, allow_new_files: false }), false);
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
    const execFileSync = (_command, args) => {
      const shell = args.at(-1);
      if (shell.includes("tsc")) return "src/a.ts(1,1): error TS1000: bad\n";
      if (shell.includes("eslint")) {
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
    assert.deepEqual(JSON.parse(writes.get("/repo/.yolo-worktrees/FIX-1/scripts/yolo/state/runtime/tsc-baseline.json")), {
      keys: ["src/a.ts:1:TS1000"],
    });
    assert.deepEqual(JSON.parse(writes.get("/repo/.yolo-worktrees/FIX-1/scripts/yolo/state/runtime/eslint-baseline.json")), {
      keys: ["src/a.ts:2:semi"],
    });
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

    assert.deepEqual(result, ["src/a.ts"]);
    assert.deepEqual(copied, [{ src: "/wt/FIX-1/src/a.ts", dst: "/repo/src/a.ts" }]);
    assert.ok(logs.some((entry) => entry.phase === "BLOCK" && entry.detail.includes("src/b.ts")));
    assert.ok(logs.some((entry) => entry.phase === "MERGED" && entry.detail.includes("跳过 1 个运行时文件")));
    assert.ok(commands.some((command) => command.includes("git worktree remove")));
    assert.ok(commands.some((command) => command.includes("git branch -D")));
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
