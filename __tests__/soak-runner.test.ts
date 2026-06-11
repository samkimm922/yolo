import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { main, runSoak, summarizeFakeSuccess } from "../scripts/soak/run.js";

function capture() {
  let value = "";
  return {
    stream: {
      write(chunk) {
        value += String(chunk);
        return true;
      },
    },
    text() {
      return value;
    },
  };
}

describe("soak runner", () => {
  test("aggregates fake-success reports and returns non-zero when rate is positive", async () => {
    const fakeStats = summarizeFakeSuccess([
      {
        run_id: "soak-fake-pass",
        status: "PASS",
        summary: {
          run_success_rate: 100,
          task_success_rate: 100,
          files_changed_total: 0,
        },
        changed_files: [],
      },
      {
        run_id: "soak-real-pass",
        status: "success",
        summary: {
          run_success_rate: 100,
          task_success_rate: 100,
          files_changed_total: 1,
        },
        changed_files: ["src/index.ts"],
      },
    ]);
    assert.equal(fakeStats.fake_success, 1);
    assert.equal(fakeStats.fake_success_rate, 50);

    const out = capture();
    const exitCode = await main(["--rounds", "1", "--fixtures", "node-basic"], {
      stdout: out.stream,
      runSoak: async (options) => ({
        summary: {
          rounds: options.rounds,
          fixtures: options.fixtures,
          fake_success: fakeStats.fake_success,
          fake_success_rate: fakeStats.fake_success_rate,
          failures: [],
        },
        exitCode: 1,
        reports: [],
      }),
    });

    assert.equal(exitCode, 1);
    assert.match(out.text(), /"fake_success": 1/);
    assert.match(out.text(), /fake_success_rate=50/);
  });

  test("runs a real node-basic dry-run fixture through the canonical path", async () => {
    const result = await runSoak({
      rounds: 1,
      fixtures: ["node-basic"],
      dryRun: true,
    });

    assert.equal(result.exitCode, 0, JSON.stringify(result.summary.failures, null, 2));
    assert.equal(result.summary.rounds, 1);
    assert.deepEqual(result.summary.fixtures, ["node-basic"]);
    assert.equal(result.summary.fake_success, 0);
    assert.equal(result.summary.fake_success_rate, 0);
    assert.deepEqual(result.summary.failures, []);
  });
});
