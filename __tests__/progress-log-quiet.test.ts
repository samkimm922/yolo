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
