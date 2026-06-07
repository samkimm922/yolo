import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildCleanEnvironmentVerifyPlan,
  executeCleanEnvironmentVerifyPlan,
  runCleanEnvironmentVerify,
} from "../src/release/clean-environment-verify.js";

const YOLO_DIR = resolve(import.meta.dirname, "..");
const packageJson = {
  name: "yolo",
  version: "0.1.0",
  exports: {
    ".": "./dist/sdk.js",
    "./release/readiness": "./dist/src/release/readiness.js",
  },
  bin: {
    yolo: "./dist/bin/yolo.js",
  },
};

function ok(command = "ok") {
  return {
    command,
    args: command.split(" "),
    cwd: YOLO_DIR,
    exit_code: 0,
    signal: null,
    status: "pass",
    started_at: "2026-06-07T00:00:00.000Z",
    finished_at: "2026-06-07T00:00:00.000Z",
    stdout: "",
    stderr: "",
    stdout_tail: "",
    stderr_tail: "",
  };
}

function fail(command = "fail") {
  return {
    ...ok(command),
    exit_code: 1,
    status: "fail",
    stderr: "boom",
    stderr_tail: "boom",
  };
}

function withFakeTemp(callback) {
  const tempRoot = mkdtempSync(join(tmpdir(), "yolo-clean-verify-test-"));
  try {
    return callback(tempRoot);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function plan() {
  return buildCleanEnvironmentVerifyPlan({
    yoloRoot: YOLO_DIR,
    packageJson,
    hasNpmCiLock: false,
  });
}

describe("clean environment verify", () => {
  test("plan includes isolated npm pack with --ignore-scripts and full clean verification chain", () => {
    const result = plan();

    assert.deepEqual(result.steps.map((step) => step.id), [
      "prepare_clean_source",
      "install_dependencies",
      "verify",
      "pack",
      "install_tarball",
      "public_entrypoint_bin_smoke",
    ]);
    assert.ok(result.steps.find((step) => step.id === "pack").command.includes("--ignore-scripts"));
    assert.ok(result.steps.find((step) => step.id === "pack").command.includes("--pack-destination"));
    assert.deepEqual(result.steps.find((step) => step.id === "install_dependencies").candidate_commands, ["npm ci", "npm install"]);
    assert.deepEqual(result.package.import_specifiers, ["yolo", "yolo/release/readiness"]);
    assert.deepEqual(result.package.bin_names, ["yolo"]);
    assert.equal(result.execution_policy.dry_run_has_no_side_effects, true);
  });

  test("step failure blocks release instead of warning", () => withFakeTemp((tempRoot) => {
    const calls = [];
    const result = executeCleanEnvironmentVerifyPlan(plan(), {
      tempRoot,
      cleanup: false,
      prepareWorkspace: () => ok("copy"),
      existsSync: () => false,
      commandRunner: (command, args) => {
        calls.push([command, ...args].join(" "));
        if (calls.length === 1) {
          return fail([command, ...args].join(" "));
        }
        return ok([command, ...args].join(" "));
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blocks_release, true);
    assert.deepEqual(result.blockers.map((blocker) => blocker.code), ["CLEAN_VERIFY_COMMAND_NONZERO_EXIT"]);
    assert.equal(result.blockers[0].step_id, "install_dependencies");
    assert.deepEqual(calls, ["npm install"]);
  }));

  test("missing package tarball blocks release", () => withFakeTemp((tempRoot) => {
    const result = executeCleanEnvironmentVerifyPlan(plan(), {
      tempRoot,
      cleanup: false,
      prepareWorkspace: () => ok("copy"),
      existsSync: () => false,
      commandRunner: (command, args) => {
        const rendered = [command, ...args].join(" ");
        if (rendered.startsWith("npm pack")) {
          return {
            ...ok(rendered),
            stdout: JSON.stringify([{ filename: "yolo-0.1.0.tgz" }]),
            stdout_tail: JSON.stringify([{ filename: "yolo-0.1.0.tgz" }]),
          };
        }
        return ok(rendered);
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blockers[0].code, "CLEAN_VERIFY_PACK_TARBALL_MISSING");
    assert.equal(result.blockers[0].filename, "yolo-0.1.0.tgz");
  }));

  test("unparseable npm pack stdout blocks release", () => withFakeTemp((tempRoot) => {
    const result = executeCleanEnvironmentVerifyPlan(plan(), {
      tempRoot,
      cleanup: false,
      prepareWorkspace: () => ok("copy"),
      existsSync: () => true,
      commandRunner: (command, args) => {
        const rendered = [command, ...args].join(" ");
        if (rendered.startsWith("npm pack")) {
          return { ...ok(rendered), stdout: "not-json", stdout_tail: "not-json" };
        }
        return ok(rendered);
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.blockers[0].code, "CLEAN_VERIFY_PACK_STDOUT_UNPARSEABLE");
  }));

  test("all clean verification steps pass with fake executor", () => withFakeTemp((tempRoot) => {
    const calls = [];
    const result = executeCleanEnvironmentVerifyPlan(plan(), {
      tempRoot,
      cleanup: false,
      prepareWorkspace: () => ok("copy"),
      existsSync: (path) => path.endsWith("yolo-0.1.0.tgz"),
      commandRunner: (command, args) => {
        const rendered = [command, ...args].join(" ");
        calls.push(rendered);
        if (rendered.startsWith("npm pack")) {
          return {
            ...ok(rendered),
            stdout: JSON.stringify([{ filename: "yolo-0.1.0.tgz" }]),
            stdout_tail: JSON.stringify([{ filename: "yolo-0.1.0.tgz" }]),
          };
        }
        if (rendered.includes("public-entrypoint-bin-smoke.mjs")) {
          return {
            ...ok(rendered),
            stdout: JSON.stringify({ status: "pass", imported_count: 2, bin_count: 1 }),
            stdout_tail: JSON.stringify({ status: "pass", imported_count: 2, bin_count: 1 }),
          };
        }
        return ok(rendered);
      },
    });

    assert.equal(result.status, "pass", JSON.stringify(result, null, 2));
    assert.equal(result.blocks_release, false);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(calls, [
      "npm install",
      "npm run verify",
      `npm pack --json --ignore-scripts --pack-destination ${join(tempRoot, "pack")}`,
      `npm install --ignore-scripts --no-audit --fund=false --package-lock=false ${join(tempRoot, "pack", "yolo-0.1.0.tgz")}`,
      `${process.execPath} ${join(tempRoot, "consumer", "public-entrypoint-bin-smoke.mjs")}`,
    ]);
  }));

  test("explicit tempRoot is not removed by default cleanup", () => withFakeTemp((tempRoot) => {
    const result = executeCleanEnvironmentVerifyPlan(plan(), {
      tempRoot,
      prepareWorkspace: () => ok("copy"),
      existsSync: (path) => path === join(tempRoot, "pack", "yolo-0.1.0.tgz"),
      commandRunner: (command, args) => {
        const rendered = [command, ...args].join(" ");
        if (rendered.startsWith("npm pack")) {
          return {
            ...ok(rendered),
            stdout: JSON.stringify([{ filename: "yolo-0.1.0.tgz" }]),
            stdout_tail: JSON.stringify([{ filename: "yolo-0.1.0.tgz" }]),
          };
        }
        if (rendered.includes("public-entrypoint-bin-smoke.mjs")) {
          return {
            ...ok(rendered),
            stdout: JSON.stringify({ status: "pass", imported_count: 2, bin_count: 1 }),
            stdout_tail: JSON.stringify({ status: "pass", imported_count: 2, bin_count: 1 }),
          };
        }
        return ok(rendered);
      },
    });

    assert.equal(result.status, "pass", JSON.stringify(result, null, 2));
    assert.equal(existsSync(tempRoot), true);
  }));

  test("default managed mkdtemp workspace is removed after cleanup", () => withFakeTemp((tmpRoot) => {
    let createdTempRoot = null;
    const result = executeCleanEnvironmentVerifyPlan(plan(), {
      tmpRoot,
      prepareWorkspace: (activePlan) => {
        createdTempRoot = activePlan.workspace.temp_root;
        return ok("copy");
      },
      existsSync: (path) => path === join(createdTempRoot, "pack", "yolo-0.1.0.tgz"),
      commandRunner: (command, args) => {
        const rendered = [command, ...args].join(" ");
        if (rendered.startsWith("npm pack")) {
          return {
            ...ok(rendered),
            stdout: JSON.stringify([{ filename: "yolo-0.1.0.tgz" }]),
            stdout_tail: JSON.stringify([{ filename: "yolo-0.1.0.tgz" }]),
          };
        }
        if (rendered.includes("public-entrypoint-bin-smoke.mjs")) {
          return {
            ...ok(rendered),
            stdout: JSON.stringify({ status: "pass", imported_count: 2, bin_count: 1 }),
            stdout_tail: JSON.stringify({ status: "pass", imported_count: 2, bin_count: 1 }),
          };
        }
        return ok(rendered);
      },
    });

    assert.equal(result.status, "pass", JSON.stringify(result, null, 2));
    assert.ok(createdTempRoot);
    assert.ok(createdTempRoot.startsWith(join(tmpRoot, "yolo-clean-env-")));
    assert.equal(existsSync(createdTempRoot), false);
  }));

  test("dryRun returns the full plan without executing", () => {
    let executed = false;
    const result = runCleanEnvironmentVerify({
      yoloRoot: YOLO_DIR,
      packageJson,
      dryRun: true,
      executor: () => {
        executed = true;
        throw new Error("executor should not run during dryRun");
      },
    });

    assert.equal(result.status, "success");
    assert.equal(result.dry_run, true);
    assert.equal(executed, false);
    assert.deepEqual(result.steps.map((step) => step.status), [
      "planned",
      "planned",
      "planned",
      "planned",
      "planned",
      "planned",
    ]);
    assert.ok(result.plan.steps.find((step) => step.id === "pack").command.includes("--ignore-scripts"));
  });
});
