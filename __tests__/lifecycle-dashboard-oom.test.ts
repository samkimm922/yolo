// Regression test for CWE-400: unbounded file reads in lifecycle-dashboard readEvents.
//
// readEvents() reads all JSONL files in state/*.jsonl with no per-file size limit.
// An attacker (or a runaway process) writing one large JSONL file causes OOM or
// run-to-completion stall in the progress dashboard.
//
// Fix: filter files by statSync(path).size before readFileSync, with a default
// limit of 50 MB and a test override via setEventsMaxSizeOverride().

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  readLifecycleDashboard,
  resetEventsMaxSizeOverride,
  setEventsMaxSizeOverride,
} from "../src/runtime/progress/lifecycle-dashboard.js";

function tmpProject(t) {
  const root = resolve(tmpdir(), `yolo-oom-test-${t}-${Date.now()}`);
  mkdirSync(join(root, "lifecycle"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(
    join(root, "lifecycle", "status.json"),
    JSON.stringify({ current_stage: "test", stages: [{ id: "test", status: "active" }] }),
  );
  return root;
}

function writeEvent(root, file, content) {
  writeFileSync(join(root, "state", file), content);
}

function cleanup(root) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

describe("lifecycle-dashboard OOM guard (CWE-400)", () => {
  before(() => setEventsMaxSizeOverride(512));
  after(() => resetEventsMaxSizeOverride());

  it("passes small files through", () => {
    const root = tmpProject("pass-small");
    try {
      writeEvent(root, "events.jsonl", JSON.stringify({ stage_id: "s1", status: "ok" }) + "\n");
      const d = readLifecycleDashboard({ projectRoot: root, stateRootCandidates: [root] });
      assert.equal(d.recent_events.length, 1);
    } finally {
      cleanup(root);
    }
  });

  it("filters oversized JSONL files", () => {
    const root = tmpProject("skip-big");
    try {
      const bigPayload = "x".repeat(600);
      writeEvent(
        root,
        "events.jsonl",
        JSON.stringify({ stage_id: "s1", status: "ok", data: bigPayload }) + "\n",
      );
      const d = readLifecycleDashboard({ projectRoot: root, stateRootCandidates: [root] });
      assert.equal(d.recent_events.length, 0);
    } finally {
      cleanup(root);
    }
  });

  it("returns empty events when all files exceed limit", () => {
    const root = tmpProject("all-big");
    try {
      const bigPayload = "x".repeat(600);
      writeEvent(
        root,
        "a.jsonl",
        JSON.stringify({ stage_id: "s1", status: "ok", data: bigPayload }) + "\n",
      );
      writeEvent(
        root,
        "b.jsonl",
        JSON.stringify({ stage_id: "s2", status: "ok", data: bigPayload }) + "\n",
      );
      const d = readLifecycleDashboard({ projectRoot: root, stateRootCandidates: [root] });
      assert.equal(d.recent_events.length, 0);
    } finally {
      cleanup(root);
    }
  });

  it("uses production default (50 MB) when no override set", () => {
    resetEventsMaxSizeOverride();
    const root = tmpProject("prod-default");
    try {
      const medPayload = "y".repeat(1024 * 1024);
      writeEvent(
        root,
        "events.jsonl",
        JSON.stringify({ stage_id: "s1", status: "ok", data: medPayload }) + "\n",
      );
      const d = readLifecycleDashboard({ projectRoot: root, stateRootCandidates: [root] });
      assert.equal(d.recent_events.length, 1);
    } finally {
      cleanup(root);
      resetEventsMaxSizeOverride();
    }
  });
});
