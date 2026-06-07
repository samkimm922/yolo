import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReleaseCandidateChangeManifest,
  classifyReleaseChangeDomain,
  readReleaseCandidateChangeManifest,
} from "../src/release/change-provenance.js";

function z(...records) {
  return `${records.join("\0")}\0`;
}

describe("release change provenance manifest", () => {
  test("clean worktree produces a non-blocking release manifest", () => {
    const manifest = buildReleaseCandidateChangeManifest({
      rootDir: "/repo",
      statusOutput: "",
      diffNameStatusOutput: "",
    });

    assert.equal(manifest.status, "pass");
    assert.equal(manifest.blocks_release, false);
    assert.equal(manifest.clean, true);
    assert.deepEqual(manifest.tracked_modified, []);
    assert.deepEqual(manifest.untracked, []);
    assert.deepEqual(manifest.deleted_or_renamed, []);
    assert.deepEqual(manifest.blockers, []);
    assert.equal(manifest.contains_possible_non_round_changes, false);
  });

  test("unknown file fails closed as a release blocker", () => {
    const manifest = buildReleaseCandidateChangeManifest({
      rootDir: "/repo",
      statusOutput: z(" M experimental/trello-special-case.ts"),
      diffNameStatusOutput: z("M", "experimental/trello-special-case.ts"),
    });

    assert.equal(manifest.status, "blocked");
    assert.equal(manifest.blocks_release, true);
    assert.equal(manifest.groups.unknown.files[0], "experimental/trello-special-case.ts");
    assert.equal(manifest.tracked_modified[0].domain, "unknown");
    assert.ok(manifest.blockers.some((blocker) => blocker.code === "UNKNOWN_CHANGE_DOMAIN"));
    assert.equal(manifest.risk_level, "critical");
  });

  test("allowUnknown permits unknown tracked changes without a release blocker", () => {
    const manifest = buildReleaseCandidateChangeManifest({
      rootDir: "/repo",
      statusOutput: z(" M experimental/trello-special-case.ts"),
      diffNameStatusOutput: z("M", "experimental/trello-special-case.ts"),
      allowUnknown: true,
    });

    assert.equal(manifest.status, "pass");
    assert.equal(manifest.blocks_release, false);
    assert.deepEqual(manifest.blockers, []);
    assert.equal(manifest.groups.unknown.risk_level, "medium");
  });

  test("untracked source/test and deleted files fail closed", () => {
    const manifest = buildReleaseCandidateChangeManifest({
      rootDir: "/repo",
      statusOutput: z("?? src/release/new-gate.ts", " D docs/old-runbook.md"),
      allowUnknown: true,
    });

    assert.equal(manifest.status, "blocked");
    assert.equal(manifest.blocks_release, true);
    assert.deepEqual(manifest.untracked.map((entry) => entry.path), ["src/release/new-gate.ts"]);
    assert.deepEqual(manifest.deleted_or_renamed.map((entry) => entry.path), ["docs/old-runbook.md"]);
    assert.ok(manifest.blockers.some((blocker) => blocker.code === "UNTRACKED_SOURCE_OR_TEST_FAIL_CLOSED"));
    assert.ok(manifest.blockers.some((blocker) => blocker.code === "DELETED_CHANGE_FAIL_CLOSED"));
  });

  test("untracked CI metadata fails closed by default", () => {
    const manifest = buildReleaseCandidateChangeManifest({
      rootDir: "/repo",
      statusOutput: z("?? .github/workflows/release.yml"),
    });

    assert.equal(manifest.status, "blocked");
    assert.equal(manifest.blocks_release, true);
    assert.equal(manifest.untracked[0].path, ".github/workflows/release.yml");
    assert.equal(manifest.untracked[0].domain, "ci-meta-package");
    assert.equal(manifest.groups["ci-meta-package"].risk_level, "critical");
    assert.ok(manifest.blockers.some((blocker) => blocker.code === "UNTRACKED_CI_META_PACKAGE_FAIL_CLOSED"));
  });

  test("allowUntracked permits untracked source/test files when ownership is known", () => {
    const manifest = buildReleaseCandidateChangeManifest({
      rootDir: "/repo",
      statusOutput: z("?? src/runtime/review-loop/new-helper.ts"),
      allowUntracked: true,
    });

    assert.equal(manifest.status, "pass");
    assert.equal(manifest.blocks_release, false);
    assert.equal(manifest.untracked[0].domain, "review-loop");
    assert.deepEqual(manifest.blockers, []);
  });

  test("git failure returns structured fail-closed blocker", () => {
    const calls = [];
    const execFileSync = (command, args) => {
      calls.push([command, ...args]);
      const error = new Error("git missing");
      error.stderr = "fatal: not a git repository\n";
      throw error;
    };

    const manifest = readReleaseCandidateChangeManifest({ rootDir: "/repo", execFileSync });

    assert.equal(manifest.status, "blocked");
    assert.equal(manifest.blocks_release, true);
    assert.equal(manifest.error.code, "GIT_CHANGE_PROVENANCE_UNAVAILABLE");
    assert.match(manifest.error.message, /fatal: not a git repository/);
    assert.equal(manifest.risk_level, "critical");
    assert.deepEqual(calls, [["git", "rev-parse", "--is-inside-work-tree"]]);
  });

  test("groups release changes by responsibility domain", () => {
    const filesByDomain = {
      "runner/finalize": "src/runtime/run-lifecycle/finalize.ts",
      "review-loop": "src/runtime/review-loop/orchestrator.ts",
      "acceptance-warning": "src/runtime/acceptance/report.ts",
      "prd-preflight/check": "src/prd/preflight.ts",
      "worktree-commit": "src/runtime/execution/commit-flow.ts",
      "ci-meta-package": "package.json",
      "docs-data": "docs/release.md",
      unknown: "scratch/notes.txt",
    };
    const statusOutput = z(
      ...Object.values(filesByDomain).map((file) => ` M ${file}`),
      "R  src/runtime/execution/new-worktree-session.ts",
      "src/runtime/execution/worktree-session.ts",
    );
    const manifest = buildReleaseCandidateChangeManifest({
      rootDir: "/repo",
      statusOutput,
      allowUnknown: true,
      currentRoundFiles: Object.values(filesByDomain),
    });

    for (const [domain, file] of Object.entries(filesByDomain)) {
      assert.equal(classifyReleaseChangeDomain(file), domain);
      assert.ok(manifest.groups[domain].files.includes(file), `${domain} should include ${file}`);
    }
    assert.deepEqual(
      manifest.deleted_or_renamed.map((entry) => [entry.kind, entry.path, entry.old_path]),
      [["renamed", "src/runtime/execution/new-worktree-session.ts", "src/runtime/execution/worktree-session.ts"]],
    );
    assert.ok(manifest.group_suggestions.some((group) => group.domain === "worktree-commit"));
    assert.equal(manifest.contains_possible_non_round_changes, true);
  });
});
