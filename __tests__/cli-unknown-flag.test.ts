import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runYoloCli, parseYoloArgs } from "../src/cli/yolo.js";

function tempProject(prefix = "yolo-unknown-flag-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function captureIo(cwd, extra = {}) {
  const stdout = { text: "", write(chunk) { this.text += chunk; } };
  const stderr = { text: "", write(chunk) { this.text += chunk; } };
  return { io: { cwd, stdout, stderr, ...extra }, stdout, stderr };
}

describe("CLI unknown flag rejection", () => {
  // Regression: an unknown `--*` flag must surface a structured error instead
  // of being silently dropped and falling through to the misleading
  // "missing PRD path" / "missing requirement" branch (which sends a
  // non-technical user down the wrong path).
  test("yolo run --bad-flag --json returns a structured CLI_UNKNOWN_FLAG error", async () => {
    const root = tempProject("yolo-run-unknown-flag-");
    try {
      const { io, stdout, stderr } = captureIo(root);
      const exitCode = await runYoloCli(["run", "--bad-flag", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(exitCode, 2);
      assert.equal(stderr.text, "");
      assert.equal(payload.schema, "yolo.cli.parse_error.v1");
      assert.equal(payload.status, "error");
      assert.equal(payload.code, "CLI_UNKNOWN_FLAG");
      assert.equal(payload.exit_code, 2);
      assert.equal(payload.flag, "--bad-flag");
      assert.deepEqual(payload.unknown_flags, ["--bad-flag"]);
      assert.match(payload.summary, /--bad-flag/);
      assert.ok(
        payload.next_actions.some((a) => /--bad-flag/.test(a)),
        "next_actions must name the offending flag"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unknown flag without --json writes the flag name to stderr and exits 2", async () => {
    const root = tempProject("yolo-run-unknown-flag-text-");
    try {
      const { io, stderr, stdout } = captureIo(root);
      const exitCode = await runYoloCli(["run", "--bad-flag"], io);

      assert.equal(exitCode, 2);
      assert.equal(stdout.text, "");
      assert.match(stderr.text, /--bad-flag/);
      // Must NOT be the misleading "missing PRD path" path.
      assert.doesNotMatch(stderr.text, /missing PRD path/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("multiple unknown flags are all listed in unknown_flags", async () => {
    const root = tempProject("yolo-run-multi-unknown-");
    try {
      const { io, stdout } = captureIo(root);
      const exitCode = await runYoloCli(["run", "--foo", "--bar", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(exitCode, 2);
      assert.equal(payload.code, "CLI_UNKNOWN_FLAG");
      assert.deepEqual(payload.unknown_flags, ["--foo", "--bar"]);
      assert.match(payload.summary, /--foo/);
      assert.match(payload.summary, /--bar/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unknown flag passed with =value is normalized to the bare flag name", async () => {
    const root = tempProject("yolo-run-unknown-value-");
    try {
      const { io, stdout } = captureIo(root);
      const exitCode = await runYoloCli(["run", "--bad-flag=value", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(exitCode, 2);
      assert.equal(payload.code, "CLI_UNKNOWN_FLAG");
      assert.equal(payload.flag, "--bad-flag");
      assert.deepEqual(payload.unknown_flags, ["--bad-flag"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo auto --bad-flag --json reports the unknown flag, not a missing requirement", async () => {
    const root = tempProject("yolo-auto-unknown-flag-");
    try {
      const { io, stdout, stderr } = captureIo(root);
      const exitCode = await runYoloCli(["auto", "--bad-flag", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(exitCode, 2);
      assert.equal(stderr.text, "");
      assert.equal(payload.code, "CLI_UNKNOWN_FLAG");
      assert.equal(payload.flag, "--bad-flag");
      assert.notEqual(payload.code, "AUTO_MISSING_REQUIREMENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("yolo check --bad-flag --json reports the unknown flag", async () => {
    const root = tempProject("yolo-check-unknown-flag-");
    try {
      const { io, stdout, stderr } = captureIo(root);
      const exitCode = await runYoloCli(["check", "--bad-flag", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(exitCode, 2);
      assert.equal(payload.code, "CLI_UNKNOWN_FLAG");
      assert.equal(payload.flag, "--bad-flag");
      // Must not be the silent-ignore fallthrough.
      assert.doesNotMatch(JSON.stringify(payload), /LIFECYCLE_NOT_INITIALIZED/);
      assert.equal(stderr.text, "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Normal path must be unaffected: a valid flag combination without a PRD
  // still reaches the real MISSING_PRD_PATH branch (proving known flags still
  // parse correctly and only unknown ones are rejected).
  test("known flag combination still parses and reaches MISSING_PRD_PATH", async () => {
    const root = tempProject("yolo-known-flags-");
    try {
      const { io, stdout } = captureIo(root);
      const exitCode = await runYoloCli(["run", "--dry-run", "--mode", "fix", "--engine-only", "--no-review-loop", "--json"], io);
      const payload = JSON.parse(stdout.text);

      assert.equal(exitCode, 2);
      assert.equal(payload.code, "MISSING_PRD_PATH");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--help still works alongside otherwise-valid arguments", async () => {
    const root = tempProject("yolo-help-");
    try {
      const { io, stdout } = captureIo(root);
      const exitCode = await runYoloCli(["run", "--help"], io);

      assert.equal(exitCode, 0);
      assert.match(stdout.text, /用法:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parseYoloArgs throws CLI_UNKNOWN_FLAG for an unrecognized flag", () => {
    assert.throws(
      () => parseYoloArgs(["--bad-flag", "--json"]),
      (error) => {
        const e = error as { code?: string; flag?: string; name?: string };
        return e.code === "CLI_UNKNOWN_FLAG" && e.flag === "--bad-flag" && e.name === "YoloCliParseError";
      },
      "parseYoloArgs must throw a structured CLI_UNKNOWN_FLAG error for unknown flags"
    );
  });

  test("parseYoloArgs returns normally for known flags only", () => {
    const { input, options } = parseYoloArgs(["--dry-run", "--mode", "fix", "--json"]);
    assert.equal(options.dryRun, true);
    assert.equal(options.json, true);
    assert.equal(input.mode, "fix");
  });

  test("a positional PRD path combined with known flags parses correctly", () => {
    const { input, options } = parseYoloArgs(["some/prd.json", "--dry-run"]);
    assert.equal(input.prdPath, "some/prd.json");
    assert.equal(options.dryRun, true);
  });
});
