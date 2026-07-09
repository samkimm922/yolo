import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync as realExecFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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

const srcBusinessConfig = {
  project: {
    business_file_patterns: ["src/**/*.ts"],
  },
};

const layoutBusinessConfig = {
  project: {
    business_file_patterns: [
      "packages/**/*.ts",
      "app/**/*.tsx",
      "components/**/*.tsx",
      "lib/**/*.ts",
      "migrations/**/*.sql",
    ],
  },
};

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
    let darwinCopied = false;
    let linuxCopied = false;
    const fakeLstat = () => ({ isDirectory: () => true, isSymbolicLink: () => false });
    const fakeRealpath = (path) => path;

    assert.equal(provisionWorktreeNodeModules({
      wtPath: "/repo/.yolo-worktrees/FIX-1",
      rootDir: "/repo",
      platform: "darwin",
      existsSync: (path) => path === "/repo/node_modules" || (darwinCopied && path === "/repo/.yolo-worktrees/FIX-1/node_modules"),
      lstatSync: fakeLstat,
      realpathSync: fakeRealpath,
      execFileSync: (command, args, options) => {
        darwinCalls.push({ command, args, options });
        darwinCopied = true;
      },
    }), true);
    assert.deepEqual(darwinCalls.map((call) => [call.command, call.args]), [["cp", ["-cR", "/repo/node_modules", "/repo/.yolo-worktrees/FIX-1/node_modules"]]]);
    assertNodeModulesExecOptions(darwinCalls[0].options, 300000);

    assert.equal(provisionWorktreeNodeModules({
      wtPath: "/repo/.yolo-worktrees/FIX-2",
      rootDir: "/repo",
      platform: "linux",
      existsSync: (path) => path === "/repo/node_modules" || (linuxCopied && path === "/repo/.yolo-worktrees/FIX-2/node_modules"),
      lstatSync: fakeLstat,
      realpathSync: fakeRealpath,
      execFileSync: (command, args, options) => {
        linuxCalls.push({ command, args, options });
        linuxCopied = true;
      },
    }), true);
    assert.deepEqual(linuxCalls.map((call) => [call.command, call.args]), [["cp", ["-a", "--reflink=auto", "/repo/node_modules", "/repo/.yolo-worktrees/FIX-2/node_modules"]]]);
    assertNodeModulesExecOptions(linuxCalls[0].options, 300000);
  });

  test("provisionWorktreeNodeModules falls back from clone to ordinary copy", () => {
    const calls = [];
    let copied = false;
    assert.equal(provisionWorktreeNodeModules({
      wtPath: "/repo/.yolo-worktrees/FIX-CP",
      rootDir: "/repo",
      platform: "darwin",
      existsSync: (path) => path === "/repo/node_modules" || (copied && path === "/repo/.yolo-worktrees/FIX-CP/node_modules"),
      lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
      realpathSync: (path) => path,
      execFileSync: (command, args, options) => {
        calls.push({ command, args, options });
        if (args[0] === "-cR") throw new Error("clone unsupported");
        copied = true;
        return "";
      },
    }), true);

    assert.deepEqual(calls.map((call) => [call.command, call.args]), [
      ["cp", ["-cR", "/repo/node_modules", "/repo/.yolo-worktrees/FIX-CP/node_modules"]],
      ["cp", ["-pR", "/repo/node_modules", "/repo/.yolo-worktrees/FIX-CP/node_modules"]],
    ]);
    assertNodeModulesExecOptions(calls[0].options, 300000);
    assertNodeModulesExecOptions(calls[1].options, 300000);
  });

  test("provisionWorktreeNodeModules fails closed instead of linking node_modules outside the worktree", () => {
    const calls = [];
    assert.throws(
      () => provisionWorktreeNodeModules({
        wtPath: "/repo/.yolo-worktrees/FIX-LINK",
        rootDir: "/repo",
        platform: "linux",
        existsSync: (path) => path === "/repo/node_modules",
        execFileSync: (command, args, options) => {
          calls.push({ command, args, options });
          throw new Error("copy failed");
        },
      }),
      /copy failed/,
    );

    assert.deepEqual(calls.map((call) => [call.command, call.args]), [
      ["cp", ["-a", "--reflink=auto", "/repo/node_modules", "/repo/.yolo-worktrees/FIX-LINK/node_modules"]],
      ["cp", ["-a", "/repo/node_modules", "/repo/.yolo-worktrees/FIX-LINK/node_modules"]],
    ]);
    assertNodeModulesExecOptions(calls[0].options, 300000);
    assertNodeModulesExecOptions(calls[1].options, 300000);
  });

  test("provisionWorktreeNodeModules removes timed-out copy partials before failing closed", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-node-modules-timeout-"));
    const rootDir = join(root, "project");
    const wtPath = join(root, ".yolo-worktrees", "FIX-TIMEOUT");
    const wtNodeModules = join(wtPath, "node_modules");
    try {
      mkdirSync(join(rootDir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(wtPath, { recursive: true });
      writeFileSync(join(rootDir, "node_modules", "pkg", "index.js"), "module.exports = 1;\n", "utf8");

      const calls = [];
      const execFileSync = (command, args, options) => {
        calls.push({ command, args, options });
        if (args[0] === "-a" && args[1] === "--reflink=auto") throw new Error("clone unsupported");
        if (args[0] === "-a") {
          mkdirSync(wtNodeModules, { recursive: true });
          writeFileSync(join(wtNodeModules, "partial.txt"), "partial\n", "utf8");
          throw Object.assign(new Error("copy timed out"), { code: "ETIMEDOUT" });
        }
        throw new Error(`unexpected command: ${command}`);
      };

      assert.throws(
        () => provisionWorktreeNodeModules({
          wtPath,
          rootDir,
          platform: "linux",
          execFileSync,
        }),
        /copy timed out/,
      );

      assert.deepEqual(calls.map((call) => [call.command, call.args]), [
        ["cp", ["-a", "--reflink=auto", join(rootDir, "node_modules"), wtNodeModules]],
        ["cp", ["-a", join(rootDir, "node_modules"), wtNodeModules]],
      ]);
      assertNodeModulesExecOptions(calls[0].options, 300000);
      assertNodeModulesExecOptions(calls[1].options, 300000);
      assert.equal(existsSync(wtNodeModules), false);
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

  test("provisionWorktreeNodeModules preserves package bin symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-node-modules-symlink-"));
    const rootDir = join(root, "project");
    const wtPath = join(root, ".yolo-worktrees", "FIX-SYMLINKS");
    try {
      mkdirSync(join(rootDir, "node_modules", "pkg", "bin"), { recursive: true });
      mkdirSync(join(rootDir, "node_modules", ".bin"), { recursive: true });
      mkdirSync(wtPath, { recursive: true });
      writeFileSync(join(rootDir, "node_modules", "pkg", "bin", "cli.js"), "console.log('ok');\n", "utf8");
      symlinkSync("../pkg/bin/cli.js", join(rootDir, "node_modules", ".bin", "pkg-cli"));

      assert.equal(provisionWorktreeNodeModules({ wtPath, rootDir, platform: "linux" }), true);

      const wtBin = join(wtPath, "node_modules", ".bin", "pkg-cli");
      assert.equal(lstatSync(wtBin).isSymbolicLink(), true);
      assert.equal(readlinkSync(wtBin), "../pkg/bin/cli.js");
      assert.equal(existsSync(join(wtPath, "node_modules", "pkg", "bin", "cli.js")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("provisionWorktreeNodeModules materializes package symlinks that point outside node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-node-modules-file-dep-"));
    const rootDir = join(root, "project");
    const wtPath = join(root, ".yolo-worktrees", "FIX-FILE-DEP");
    const rootNodeModules = join(rootDir, "node_modules");
    const storePackage = join(root, "store", "typescript");
    try {
      mkdirSync(join(storePackage, "bin"), { recursive: true });
      mkdirSync(join(rootNodeModules, ".bin"), { recursive: true });
      mkdirSync(wtPath, { recursive: true });
      writeFileSync(join(storePackage, "package.json"), "{\"name\":\"typescript\"}\n", "utf8");
      writeFileSync(join(storePackage, "bin", "tsc"), "#!/usr/bin/env node\n", "utf8");
      symlinkSync(relative(rootNodeModules, storePackage), join(rootNodeModules, "typescript"));
      symlinkSync("../typescript/bin/tsc", join(rootNodeModules, ".bin", "tsc"));
      assert.equal(existsSync(join(rootNodeModules, ".bin", "tsc")), true);

      assert.equal(provisionWorktreeNodeModules({ wtPath, rootDir, platform: "linux" }), true);

      const wtPackage = join(wtPath, "node_modules", "typescript");
      const wtBin = join(wtPath, "node_modules", ".bin", "tsc");
      assert.equal(lstatSync(wtPackage).isDirectory(), true);
      assert.equal(lstatSync(wtPackage).isSymbolicLink(), false);
      assert.equal(lstatSync(wtBin).isSymbolicLink(), true);
      assert.equal(readlinkSync(wtBin), "../typescript/bin/tsc");
      assert.equal(existsSync(join(wtPackage, "package.json")), true);
      assert.equal(existsSync(wtBin), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cleanupTaskWorktree persists scaffold-installed node_modules for later worktrees", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-node-modules-persist-"));
    const rootDir = join(root, "project");
    const wtPath = join(root, ".yolo-worktrees", "SCAFFOLD");
    try {
      mkdirSync(rootDir, { recursive: true });
      mkdirSync(join(wtPath, "node_modules", "typescript", "bin"), { recursive: true });
      mkdirSync(join(wtPath, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(wtPath, "package.json"), "{\"scripts\":{\"typecheck\":\"tsc --noEmit\"}}\n", "utf8");
      writeFileSync(join(wtPath, "node_modules", "typescript", "package.json"), "{\"name\":\"typescript\"}\n", "utf8");
      writeFileSync(join(wtPath, "node_modules", "typescript", "bin", "tsc"), "#!/usr/bin/env node\n", "utf8");
      symlinkSync("../typescript/bin/tsc", join(wtPath, "node_modules", ".bin", "tsc"));

      const execSync = (command) => {
        if (command === "git rev-parse --is-inside-work-tree") return "true\n";
        return "";
      };
      const execFileSync = (command, args, options) => {
        if (command === "cp" || command === "rm") return realExecFileSync(command, args, options);
        if (command !== "git") throw new Error(`unexpected command: ${command}`);
        const joined = args.join("\0");
        if (joined === ["-C", wtPath, "status", "--porcelain"].join("\0")) return " M package.json\n";
        if (joined === ["-C", wtPath, "diff", "--name-status", "HEAD~1", "HEAD"].join("\0")) return "";
        if (joined === ["-C", wtPath, "ls-files", "--others", "--exclude-standard"].join("\0")) return "";
        if (joined === ["diff", "--name-only", "--", "package.json"].join("\0")) return "package.json\n";
        if (joined === ["ls-files", "--others", "--exclude-standard", "--", "package.json"].join("\0")) return "";
        if (joined === ["worktree", "remove", wtPath, "--force"].join("\0")) return "";
        if (joined === ["branch", "-D", "yolo-SCAFFOLD-1"].join("\0")) return "";
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      };

      const copied = cleanupTaskWorktree({
        wtPath,
        wtBranch: "yolo-SCAFFOLD-1",
        rootDir,
        mergeToMain: true,
        allowedScope: [{ file: "package.json" }],
        baseRef: "HEAD~1",
        execSync,
        execFileSync,
      });

      assert.deepEqual([...copied], ["package.json"]);
      assert.equal(existsSync(join(rootDir, "node_modules", ".bin", "tsc")), true);
      assert.equal(existsSync(join(rootDir, "node_modules", "typescript", "package.json")), true);
      assert.equal(existsSync(wtPath), false);
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
      assert.equal(isBusinessLikeFile(filePath, { config: layoutBusinessConfig }), true);
    }
    assert.equal(isBusinessLikeFile("docs/notes.md", { config: layoutBusinessConfig }), false);
    assert.equal(isBusinessLikeFile("public/robots.txt", { config: layoutBusinessConfig }), false);
    assert.equal(isBusinessLikeFile("public/robots.txt", { config: { build: { business_globs: ["public/**"] } } }), true);
  });

  test("createTaskWorktree creates a deterministic worktree and writes gate baselines", () => {
    const commands = [];
    const fileCommands = [];
    const writes = new Map();
    const mkdirs = [];
    const execSync = (command) => {
      commands.push(command);
      if (command === "git rev-parse --is-inside-work-tree") return "true\n";
      if (command === "git rev-parse --verify HEAD") return "abc123\n";
      return "";
    };
    const execFileSync = (bin, args) => {
      fileCommands.push({ bin, args });
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
    assert.ok(fileCommands.some((call) => call.bin === "git" && call.args.join("\0") === ["worktree", "add", "--detach", "/repo/.yolo-worktrees/FIX-1", "HEAD"].join("\0")));
    assert.ok(fileCommands.some((call) => call.bin === "git" && call.args.join("\0") === ["-C", "/repo/.yolo-worktrees/FIX-1", "checkout", "-b", "yolo-FIX-1-123"].join("\0")));
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

  test("createTaskWorktree syncs lifecycle authorization files into git worktrees", () => {
    const writes = new Map();
    const mkdirs = [];
    const statusPath = "/repo/.yolo/lifecycle/status.json";
    const reportPath = "/repo/.yolo/lifecycle/check-report.json";
    const statusJson = JSON.stringify({ current_stage: "run", stages: [{ id: "check", status: "completed" }] });
    const reportJson = JSON.stringify({ stage: { id: "check" }, status: "completed" });
    const execSync = (command) => {
      if (String(command).includes("rev-parse --is-inside-work-tree")) return "true\n";
      if (String(command).includes("rev-parse HEAD")) return "abc123\n";
      return "";
    };
    const execFileSync = () => "";

    createTaskWorktree({
      taskId: "FIX-LIFECYCLE",
      rootDir: "/repo",
      worktreeRoot: "/repo/.yolo-worktrees",
      config: { build: { type_check: "", lint: "" } },
      now: () => 123,
      execSync,
      execFileSync,
      existsSync: (path) => path === statusPath || path === reportPath,
      readFileSync: (path) => {
        if (path === statusPath) return statusJson;
        if (path === reportPath) return reportJson;
        return "";
      },
      mkdirSync: (path) => mkdirs.push(path),
      writeFileSync: (path, content) => writes.set(path, content),
    });

    assert.ok(mkdirs.includes("/repo/.yolo-worktrees/FIX-LIFECYCLE/.yolo/lifecycle"));
    assert.equal(writes.get("/repo/.yolo-worktrees/FIX-LIFECYCLE/.yolo/lifecycle/status.json"), statusJson);
    assert.equal(writes.get("/repo/.yolo-worktrees/FIX-LIFECYCLE/.yolo/lifecycle/check-report.json"), reportJson);
  });

  test("createTaskWorktree rejects unsafe task IDs before git or filesystem execution", () => {
    const calls = [];

    for (const taskId of ["FIX-1;touch-pwned", "../FIX-1", "FIX-1/child", "FIX-1 $(touch pwned)"]) {
      assert.throws(
        () => createTaskWorktree({
          taskId,
          rootDir: "/repo",
          worktreeRoot: "/repo/.yolo-worktrees",
          config: { build: { type_check: "", lint: "" } },
          now: () => 123,
          execSync: (...args) => {
            calls.push(["execSync", ...args]);
            return "";
          },
          execFileSync: (...args) => {
            calls.push(["execFileSync", ...args]);
            return "";
          },
          existsSync: () => false,
          mkdirSync: (...args) => calls.push(["mkdirSync", ...args]),
          cpSync: (...args) => calls.push(["cpSync", ...args]),
          writeFileSync: (...args) => calls.push(["writeFileSync", ...args]),
        }),
        /unsafe taskId/,
      );
    }

    assert.deepEqual(calls, []);
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
      base: "filesystem",
      mode: "filesystem",
      reason: "not_git_worktree",
      detail: "",
    });
    assert.deepEqual(copies, [{ src: "/repo/yolo", dst: "/repo/.yolo-worktrees/FIX-FS" }]);
    assert.equal(removed.length, 0);
    assert.ok(writes.has("/repo/.yolo-worktrees/FIX-FS/scripts/yolo/state/runtime/tsc-baseline.json"));
  });

  test("createTaskWorktree refuses filesystem fallback for unborn git HEAD", () => {
    const commands = [];
    const copies = [];

    assert.throws(
      () => createTaskWorktree({
        taskId: "FIX-UNBORN",
        rootDir: "/repo/new-project",
        worktreeRoot: "/repo/.yolo-worktrees",
        config: { build: { type_check: "tsc", lint: "eslint" } },
        now: () => 789,
        execSync: (command) => {
          commands.push(command);
          if (command === "git rev-parse --is-inside-work-tree") return "true\n";
          if (command === "git rev-parse --verify HEAD") {
            const error: Error & { stderr: string } = Object.assign(new Error("invalid reference"), { stderr: "fatal: Needed a single revision" });
            throw error;
          }
          return "";
        },
        execFileSync: () => "",
        existsSync: () => false,
        mkdirSync: () => {},
        cpSync: (src, dst) => copies.push({ src, dst }),
        writeFileSync: () => {},
      }),
      /git HEAD unavailable in git repository \(unborn_head: fatal: Needed a single revision\).*initial commit baseline/,
    );
    assert.equal(commands.some((command) => command.includes("git worktree add --detach")), false);
    assert.deepEqual(copies, []);
  });

  test("filesystem fallback excludes in-project worktree roots for non-git projects", () => {
    const copies = [];
    const wt = createTaskWorktree({
      taskId: "FIX-INTERNAL",
      rootDir: "/repo/new-project",
      worktreeRoot: "/repo/new-project/.yolo/runtime/worktrees",
      config: { build: { type_check: "", lint: "" } },
      now: () => 987,
      execSync: (command) => {
        if (command === "git rev-parse --is-inside-work-tree") throw new Error("not a worktree");
        return "";
      },
      execFileSync: () => "",
      existsSync: () => false,
      mkdirSync: () => {},
      readdirSync: (path) => path === "/repo/new-project" ? [".git", ".yolo", "src", "package.json"] : [],
      rmSync: () => {},
      cpSync: (src, dst) => copies.push({ src, dst }),
      writeFileSync: () => {},
    });

    const filesystemWt = wt as any;
    assert.equal(filesystemWt.mode, "filesystem");
    assert.equal(filesystemWt.reason, "not_git_worktree");
    assert.deepEqual(copies, [
      { src: "/repo/new-project/src", dst: "/repo/new-project/.yolo/runtime/worktrees/FIX-INTERNAL/src" },
      { src: "/repo/new-project/package.json", dst: "/repo/new-project/.yolo/runtime/worktrees/FIX-INTERNAL/package.json" },
    ]);
  });

  test("cleanupTaskWorktree copies scoped files, skips out-of-scope business files, and cleans worktree", () => {
    const copied = [];
    const commands = [];
    const fileCommands = [];
    const logs = [];
    const execFileSync = (command, args) => {
      fileCommands.push({ command, args });
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
      config: srcBusinessConfig,
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
    assert.ok(fileCommands.some((call) => call.command === "git" && call.args.join("\0") === ["worktree", "remove", "/wt/FIX-1", "--force"].join("\0")));
    assert.ok(fileCommands.some((call) => call.command === "git" && call.args.join("\0") === ["branch", "-D", "yolo-FIX-1"].join("\0")));
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

  test("cleanupTaskWorktree skips unscoped package-manager lockfiles without copying or blocking", () => {
    const copied = [];
    const execFileSync = (_command, args) => {
      if (args[0] === "-C" && args[2] === "status") {
        return [
          " M src/a.ts",
          " M pnpm-lock.yaml",
        ].join("\n");
      }
      if (args[0] === "-C" && args[2] === "ls-files") return "";
      if (args[0] === "diff") return "src/a.ts\n";
      if (args[0] === "ls-files") return "";
      return "";
    };

    const result = cleanupTaskWorktree({
      wtPath: "/wt/FIX-LOCK",
      wtBranch: "yolo-FIX-LOCK",
      rootDir: "/repo",
      mergeToMain: true,
      allowedScope: { targets: [{ file: "src/a.ts" }] },
      config: layoutBusinessConfig,
      execFileSync,
      execSync: () => "true\n",
      existsSync: (path) => path === "/wt/FIX-LOCK/src/a.ts",
      statSync: () => ({ isDirectory: () => false }),
      mkdirSync: () => {},
      copyFileSync: (src, dst) => copied.push({ src, dst }),
    });

    const mergedResult = result as string[] & { outOfScopeSkipped: string[] };
    assert.deepEqual(result, ["src/a.ts"]);
    assert.deepEqual(mergedResult.outOfScopeSkipped, []);
    assert.deepEqual(copied, [{ src: "/wt/FIX-LOCK/src/a.ts", dst: "/repo/src/a.ts" }]);
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
      config: layoutBusinessConfig,
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

  test("cleanupTaskWorktree rejects scoped paths that escape the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-worktree-escape-"));
    try {
      const repo = join(root, "repo");
      const wt = join(root, "worktrees", "task");
      mkdirSync(repo, { recursive: true });
      mkdirSync(wt, { recursive: true });
      const escapeTarget = `../../${root.split("/").pop()}-outside.txt`;
      const srcOutsideWt = resolve(wt, escapeTarget);
      const dstOutsideRepo = resolve(repo, escapeTarget);
      rmSync(dstOutsideRepo, { force: true });
      mkdirSync(resolve(srcOutsideWt, ".."), { recursive: true });
      writeFileSync(srcOutsideWt, "ESCAPE_FROM_WORKTREE", "utf8");

      assert.throws(
        () => cleanupTaskWorktree({
          wtPath: wt,
          wtBranch: "yolo-G1",
          rootDir: repo,
          mergeToMain: true,
          allowedScope: { targets: [{ file: escapeTarget }] },
          execSync: () => { throw new Error("not a worktree"); },
          execFileSync: () => "",
          log: () => {},
        }),
        /worktree merge unsafe file path/,
      );
      assert.equal(existsSync(dstOutsideRepo), false);
      rmSync(dstOutsideRepo, { force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
