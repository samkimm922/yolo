import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRunnerProgressLogger } from "../src/runtime/run-lifecycle/progress-log.js";

function makeLogger({ quiet }: { quiet?: boolean } = {}) {
  const consoleLogs = [];
  const fileLogs = [];
  const progress = { done: 1, failed: 0, total: 5 };
  const logger = createRunnerProgressLogger({
    progress,
    startTimeMs: 0,
    getOutputLog: () => "/tmp/test.log",
    appendFileSync: (_path, line) => fileLogs.push(line),
    nowMs: () => 1000,
    localeTime: () => "12:00:00",
    log: (line) => consoleLogs.push(line),
    quiet,
  });
  return { logger, consoleLogs, fileLogs };
}

describe("createRunnerProgressLogger — quiet mode", () => {
  test("normal mode logs all lines to console", () => {
    const { logger, consoleLogs } = makeLogger({ quiet: false });
    logger("task-1", "├ step 1", "running");
    logger("task-1", ">> MILESTONE", "done");
    assert.equal(consoleLogs.length, 2);
  });

  test("quiet=true suppresses non-milestone lines from console", () => {
    const { logger, consoleLogs } = makeLogger({ quiet: true });
    logger("task-1", "├ step 1", "running");
    assert.equal(consoleLogs.length, 0);
  });

  test("quiet=true passes through lines containing >> prefix", () => {
    const { logger, consoleLogs } = makeLogger({ quiet: true });
    logger("task-1", ">> phase start", "");
    assert.equal(consoleLogs.length, 1);
  });

  test("quiet=true passes through lines containing DONE", () => {
    const { logger, consoleLogs } = makeLogger({ quiet: true });
    logger("task-1", "DONE", "success");
    assert.equal(consoleLogs.length, 1);
  });

  test("quiet=true passes through lines containing !!", () => {
    const { logger, consoleLogs } = makeLogger({ quiet: true });
    logger("task-1", "!! error", "critical");
    assert.equal(consoleLogs.length, 1);
  });

  test("file log always receives all lines regardless of quiet", () => {
    const { logger, fileLogs } = makeLogger({ quiet: true });
    logger("task-1", "├ step 1", "running");
    logger("task-1", ">> milestone", "done");
    logger("task-1", "└ step 2", "complete");
    assert.equal(fileLogs.length, 3);
  });

  test("default (no quiet option) logs all lines", () => {
    const { logger, consoleLogs } = makeLogger();
    logger("task-1", "├ step 1", "running");
    logger("task-1", "└ step 2", "complete");
    assert.equal(consoleLogs.length, 2);
  });
});

// ── P10.S3: redaction tests ─────────────────────────────────────
describe("createRunnerProgressLogger — secret redaction (P10.S3)", () => {
  test("redacts OpenAI-style API keys from file output", () => {
    const { logger, fileLogs } = makeLogger();
    logger("task-1", "claude", "Bearer sk-test123456789abcdefghijk");
    assert.equal(fileLogs.length, 1);
    assert.equal(fileLogs[0].includes("sk-test123456789abcdefghijk"), false);
    assert.equal(fileLogs[0].includes("[REDACTED:sk-key]"), true);
  });

  test("redacts GitHub tokens from file output", () => {
    const { logger, fileLogs } = makeLogger();
    logger("task-1", "!! error", "ghp_test123456789abcdefghijklmnopqrstuvwxyz");
    assert.equal(fileLogs.length, 1);
    assert.equal(fileLogs[0].includes("[REDACTED:gh-token]"), true);
  });

  test("redacts secrets from console output too", () => {
    const { logger, consoleLogs } = makeLogger({ quiet: false });
    logger("task-1", "detail", "api_key=sk-test123456789abcdefghijk");
    assert.equal(consoleLogs.length, 1);
    assert.equal(consoleLogs[0].includes("[REDACTED:sk-key]"), true);
  });

  test("normal text is not affected by redaction", () => {
    const { logger, fileLogs, consoleLogs } = makeLogger({ quiet: false });
    logger("task-1", "├ step 1", "normal status message");
    assert.equal(fileLogs[0].includes("normal status message"), true);
    assert.equal(consoleLogs[0].includes("normal status message"), true);
  });
});
