import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertBuildCommandAvailable,
  resolveBuildCommand,
} from "../src/lib/toolchain.js";

function withTempProject(prefix: string, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("toolchain build command resolution", () => {
  test("detects pnpm defaults from pnpm-lock.yaml", () => withTempProject("yolo-toolchain-pnpm-", (root) => {
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    assert.equal(resolveBuildCommand("test", {}, root), "pnpm test");
    assert.equal(resolveBuildCommand("type_check", {}, root), "pnpm run typecheck");
    assert.equal(resolveBuildCommand("build", {}, root), "pnpm run build");
  }));

  test("detects yarn defaults from yarn.lock", () => withTempProject("yolo-toolchain-yarn-", (root) => {
    writeFileSync(join(root, "yarn.lock"), "# yarn lockfile\n", "utf8");

    assert.equal(resolveBuildCommand("test", {}, root), "yarn test");
    assert.equal(resolveBuildCommand("type_check", {}, root), "yarn run typecheck");
    assert.equal(resolveBuildCommand("build", {}, root), "yarn run build");
  }));

  test("falls back to npm defaults when no known lockfile exists", () => withTempProject("yolo-toolchain-npm-", (root) => {
    assert.equal(resolveBuildCommand("test", {}, root), "npm test");
    assert.equal(resolveBuildCommand("type_check", {}, root), "npm run typecheck");
    assert.equal(resolveBuildCommand("build", {}, root), "npm run build");
  }));

  test("config build command overrides lockfile detection", () => withTempProject("yolo-toolchain-config-", (root) => {
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    assert.equal(resolveBuildCommand("test", { build: { test: "cargo test" } }, root), "cargo test");
  }));

  test("missing command failure names the missing executable and config key", () => withTempProject("yolo-toolchain-missing-", (root) => {
    mkdirSync(join(root, "src"), { recursive: true });

    const result = assertBuildCommandAvailable("type_check", { build: { type_check: "missing-tsc --noEmit" } }, root, {
      commandExists: () => false,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /missing-tsc/);
    assert.match(result.message, /config\.build\.type_check/);
  }));

  test("unconfigured lint failure names eslint and config key", () => withTempProject("yolo-toolchain-lint-", (root) => {
    const result = assertBuildCommandAvailable("lint", { build: { lint: "" } }, root, {
      commandExists: () => false,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /eslint/);
    assert.match(result.message, /config\.build\.lint/);
  }));
});
