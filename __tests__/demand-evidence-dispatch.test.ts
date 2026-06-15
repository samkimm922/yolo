import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildDemandEvidenceAgentPrompt,
  buildDemandEvidenceDispatchPlan,
  runDemandEvidenceDispatchRuntime,
} from "../src/demand/evidence-dispatch.js";
import { runYoloCli } from "../src/cli/yolo.js";

const completeRiskyDemand = {
  objective: "Existing inventory API schema needs a lowStockThreshold field.",
  target_users: ["inventory admin"],
  status_quo: ["Admins manually inspect product stock thresholds."],
  success_criteria: ["API returns lowStockThreshold for inventory products."],
  scope_in: ["Inventory product API schema."],
  scope_out: ["No supplier ordering changes."],
  constraints: ["Keep existing clients compatible."],
  risks: ["Wrong thresholds can trigger bad stock decisions."],
  approve: true,
};

interface EvidenceRecord {
  path?: string;
  line?: string;
  url?: string;
  scope: string;
  source: string;
  summary: string;
  why: string;
}

function fakeAgentOutput(role, overrides = {}) {
  return {
    schema_version: "1.0",
    schema: "yolo.demand.evidence_result.v1",
    role,
    status: "completed",
    completed: true,
    claim: "Inventory API schema lacks lowStockThreshold.",
    confidence: "high",
    evidence: [{
      path: "src/api/inventory.ts",
      line: "42",
      scope: "project",
      source: "project_code",
      summary: `${role} checked inventory API schema.`,
      why: "This is the current contract affected by the demand.",
    }] as EvidenceRecord[],
    assumptions: [],
    risks: [],
    missing: [],
    recommendation: "proceed",
    result: { verdict: "pass" },
    ...overrides,
  };
}

function roleFromPrompt(prompt) {
  if (prompt.includes("evidence explorer agent")) return "explorer";
  if (prompt.includes("evidence cross-checker agent")) return "cross-checker";
  if (prompt.includes("evidence verifier agent")) return "verifier";
  return "unknown";
}

async function runCliJson(argv, cwd) {
  let output = "";
  const exitCode = await runYoloCli(argv, {
    cwd,
    stdout: {
      write(chunk) {
        output += chunk;
      },
    },
  });
  return { exitCode, output: JSON.parse(output) };
}

describe("demand evidence dispatch", () => {
  test("builds a concrete dispatch plan from evidence tasks", () => {
    const plan = buildDemandEvidenceDispatchPlan(completeRiskyDemand, {
      projectRoot: "/repo",
      stateRoot: "/repo/.yolo",
    });

    assert.equal(plan.status, "ready");
    assert.deepEqual(plan.actions.map((action) => action.role), ["explorer", "cross-checker", "verifier"]);
    assert.equal(plan.execution_policy.default_mode, "dry_run");
    assert.equal(plan.execution_policy.writes_business_code, false);
  });

  test("agent prompt tells providers to return JSON without writing result artifacts", () => {
    const plan = buildDemandEvidenceDispatchPlan(completeRiskyDemand, {
      projectRoot: "/repo",
      stateRoot: "/repo/.yolo",
    });
    const prompt = buildDemandEvidenceAgentPrompt({ action: plan.actions[0], plan });

    assert.match(prompt, /Do not ask permission to write the evidence result/);
    assert.match(prompt, /harness captures stdout and writes artifacts/);
    assert.match(prompt, /Avoid raw double quotes or backslashes inside strings/);
    assert.match(prompt, /Return one JSON object only to stdout/);
    assert.match(prompt, /web\/fetch\/search-capable tool/);
    assert.match(prompt, /MCP web reader/);
  });

  test("dry-run does not spawn provider agents", async () => {
    let calls = 0;
    const result = await runDemandEvidenceDispatchRuntime(completeRiskyDemand, {
      projectRoot: "/repo",
      stateRoot: "/repo/.yolo",
      spawnProviderPrompt: async () => {
        calls += 1;
        return { success: true, stdout: "{}" };
      },
    });

    assert.equal(result.status, "dry_run");
    assert.equal(result.mode, "dry_run");
    assert.equal(calls, 0);
  });

  test("execute mode requires explicit agent dispatch authorization", async () => {
    const result = await runDemandEvidenceDispatchRuntime({
      ...completeRiskyDemand,
      executeAgents: true,
    }, {
      projectRoot: "/repo",
      stateRoot: "/repo/.yolo",
      spawnProviderPrompt: async () => {
        throw new Error("should not spawn without allowAgentDispatch");
      },
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.code, "DEMAND_EVIDENCE_AGENT_DISPATCH_NOT_ALLOWED");
    assert.equal(result.agent_results.length, 0);
  });

  test("CLI dispatch entry defaults to dry-run and blocks execute without authorization", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-cli-"));
    try {
      const dryRun = await runCliJson([
        "demand",
        "dispatch",
        "Existing inventory API schema needs a lowStockThreshold field.",
        "--json",
      ], root);
      assert.equal(dryRun.exitCode, 2);
      assert.equal(dryRun.output.status, "dry_run");
      assert.equal(dryRun.output.mode, "dry_run");
      assert.deepEqual(dryRun.output.agent_results, []);

      const blocked = await runCliJson([
        "demand",
        "dispatch",
        "Existing inventory API schema needs a lowStockThreshold field.",
        "--execute-agents",
        "--json",
      ], root);
      assert.equal(blocked.exitCode, 1);
      assert.equal(blocked.output.status, "blocked");
      assert.equal(blocked.output.code, "DEMAND_EVIDENCE_AGENT_DISPATCH_NOT_ALLOWED");
      assert.deepEqual(blocked.output.agent_results, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("executes explorer cross-checker and verifier then feeds results into readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-"));
    const calls = [];
    try {
      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "custom", custom_command: "node fake-agent.js" } },
        spawnProviderPrompt: async (prompt) => {
          const role = roleFromPrompt(prompt);
          calls.push(role);
          return {
            success: true,
            provider: "custom",
            command: "node fake-agent.js",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(role)),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.deepEqual(calls, ["explorer", "cross-checker", "verifier"]);
      assert.equal(result.status, "pass", JSON.stringify(result.readiness?.blockers, null, 2));
      assert.equal(result.readiness.prd_ready, true);
      assert.deepEqual(result.agent_results.map((item) => item.role), ["explorer", "cross-checker", "verifier"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("codex dispatch does not inherit a claude default model or force read-only sandbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-codex-"));
    try {
      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "codex",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude", model: "claude-sonnet-4-6" } },
        spawnProviderPrompt: async (prompt, runOptions) => {
          assert.equal(runOptions.config.ai.provider, "codex");
          assert.equal(runOptions.config.ai.codex_sandbox, undefined);
          assert.equal(runOptions.config.ai.codex_approval, undefined);
          assert.equal(/claude/i.test(runOptions.config.ai.model || ""), false);
          return {
            success: true,
            provider: "codex",
            command: "codex",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(result.status, "pass", JSON.stringify(result.readiness?.blockers, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude dispatch uses safe permission mode and disallows write tools by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-claude-"));
    try {
      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        max_budget_usd: "0.25",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude", settings: "settings-minimal.json" } },
        spawnProviderPrompt: async (prompt, runOptions) => {
          assert.equal(runOptions.config.ai.provider, "claude");
          assert.equal(runOptions.config.ai.settings, "");
          assert.equal(runOptions.config.ai.claude_tools, "default");
          assert.equal(runOptions.config.ai.claude_allowed_tools, "Read,Glob,Grep,WebFetch,WebSearch");
          assert.equal(runOptions.config.ai.claude_disallowed_tools, "Write,Edit,Bash");
          assert.equal(runOptions.config.ai.claude_disable_slash_commands, false);
          assert.equal(runOptions.config.ai.claude_no_session_persistence, true);
          assert.equal(runOptions.config.ai.claude_permission_mode, "acceptEdits");
          assert.equal(runOptions.config.ai.max_budget_usd, "0.25");
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(result.status, "pass", JSON.stringify(result.readiness?.blockers, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude full tool profile requires explicit authorization for full semantic mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-claude-full-"));
    try {
      const withoutAllow = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        agent_tool_profile: "full",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt, runOptions) => {
          assert.equal(runOptions.config.ai.agent_tool_profile, "boundary");
          assert.equal(runOptions.config.ai.claude_tools, "default");
          assert.equal(runOptions.config.ai.claude_allowed_tools, "Read,Glob,Grep,WebFetch,WebSearch");
          assert.equal(runOptions.config.ai.claude_disallowed_tools, "Write,Edit,Bash");
          assert.equal(runOptions.config.ai.claude_permission_mode, "acceptEdits");
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
            stderr: "",
            timedOut: false,
          };
        },
      });
      assert.equal(withoutAllow.status, "pass", JSON.stringify(withoutAllow.readiness?.blockers, null, 2));

      const withAllow = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        agent_tool_profile: "full",
        allowFullAgentTools: true,
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt, runOptions) => {
          assert.equal(runOptions.config.ai.agent_tool_profile, "full");
          assert.equal(runOptions.config.ai.settings, "");
          assert.equal(runOptions.config.ai.claude_tools, "default");
          assert.equal(runOptions.config.ai.claude_allowed_tools, "Read,Glob,Grep,WebFetch,WebSearch");
          assert.equal(runOptions.config.ai.claude_disallowed_tools, "Write,Edit,Bash");
          assert.equal(runOptions.config.ai.claude_disable_slash_commands, false);
          assert.equal(runOptions.config.ai.claude_permission_mode, "acceptEdits");
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(withAllow.status, "pass", JSON.stringify(withAllow.readiness?.blockers, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude research profile labels research while keeping tools available", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-claude-research-"));
    try {
      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        agent_tool_profile: "research",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt, runOptions) => {
          assert.equal(runOptions.config.ai.agent_tool_profile, "research");
          assert.equal(runOptions.config.ai.settings, "");
          assert.equal(runOptions.config.ai.claude_tools, "default");
          assert.equal(runOptions.config.ai.claude_allowed_tools, "Read,Glob,Grep,WebFetch,WebSearch");
          assert.equal(runOptions.config.ai.claude_disallowed_tools, "Write,Edit,Bash");
          assert.equal(runOptions.config.ai.claude_permission_mode, "acceptEdits");
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(result.status, "pass", JSON.stringify(result.readiness?.blockers, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("external research request requires external-scoped evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-external-required-"));
    const researchDemand = {
      ...completeRiskyDemand,
      objective: "Use external research from https://example.com while verifying the existing inventory API schema.",
      success_criteria: ["External web research is recorded as external evidence and project facts use project paths."],
    };
    try {
      const missingExternal = await runDemandEvidenceDispatchRuntime({
        ...researchDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        agent_tool_profile: "research",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt) => ({
          success: true,
          provider: "claude",
          command: "claude",
          exitCode: 0,
          stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
          stderr: "",
          timedOut: false,
        }),
      });

      assert.equal(missingExternal.status, "blocked");
      assert.ok(missingExternal.readiness.blockers.some((blocker) => blocker.code === "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED"));

      const withExternal = await runDemandEvidenceDispatchRuntime({
        ...researchDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        agent_tool_profile: "research",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt) => {
          const role = roleFromPrompt(prompt);
          const output = fakeAgentOutput(role);
          output.evidence = [
            ...output.evidence,
            {
              url: "https://example.com",
              scope: "external",
              source: "external_web",
              summary: "Example Domain was fetched as external background research.",
              why: "External research must stay separate from project facts.",
            },
          ];
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: JSON.stringify(output),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(withExternal.status, "pass", JSON.stringify(withExternal.readiness?.blockers, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("external research background mention does not force fetch evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-external-background-"));
    try {
      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        objective: "Verify project-scoped evidence for existing inventory API claims while allowing external research as background only.",
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        agent_tool_profile: "research",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt) => ({
          success: true,
          provider: "claude",
          command: "claude",
          exitCode: 0,
          stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
          stderr: "",
          timedOut: false,
        }),
      });

      assert.equal(result.status, "pass", JSON.stringify(result.readiness?.blockers, null, 2));
      assert.equal(result.readiness.blockers.some((blocker) => blocker.code === "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("boundary blocks project file mutation even when agent results pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-boundary-"));
    try {
      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt) => {
          writeFileSync(join(root, "unexpected-project-write.txt"), "mutation\n", "utf8");
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.boundary.project_mutation, "violated");
      assert.ok(result.readiness.blockers.some((blocker) => blocker.code === "BOUNDARY_PROJECT_MUTATION"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("boundary mutation probe prompts a controlled write and blocks readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-boundary-probe-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "contract.ts"), "export const contract = true;\n", "utf8");

      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        agent_tool_profile: "full",
        allowFullAgentTools: true,
        boundary_mutation_probe: "src/boundary-probe.txt",
        boundary_mutation_probe_content: "probe-write",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt, runOptions) => {
          assert.match(prompt, /Boundary mutation probe is explicitly enabled/);
          assert.match(prompt, /You must attempt the probe write/);
          assert.match(prompt, /usual non-editing evidence protocol is suspended/);
          assert.match(prompt, /src\/boundary-probe\.txt/);
          assert.equal(runOptions.config.ai.agent_tool_profile, "boundary_probe");
          assert.equal(runOptions.config.ai.claude_permission_mode, "acceptEdits");
          assert.equal(runOptions.config.ai.claude_allowed_tools, "Read,Glob,Grep,Write,Edit,Bash");
          assert.equal(runOptions.config.ai.claude_disallowed_tools, "");
          writeFileSync(join(root, "src", "boundary-probe.txt"), "probe-write\n", "utf8");
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.boundary.project_mutation, "violated");
      assert.ok(result.boundary.changes.some((change) => change.path === "src/boundary-probe.txt" && change.change === "added"));
      assert.ok(result.readiness.blockers.some((blocker) => blocker.code === "BOUNDARY_PROJECT_MUTATION"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("git-backed boundary detects untracked project mutations", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-git-boundary-"));
    try {
      const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
      if (init.status !== 0) return;
      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt) => {
          writeFileSync(join(root, "untracked-mutation.txt"), "mutation\n", "utf8");
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.boundary.project_mutation, "violated");
      assert.ok(result.boundary.changes.some((change) => change.path === "untracked-mutation.txt" && change.change === "added"));
      assert.ok(result.readiness.blockers.some((blocker) => blocker.code === "BOUNDARY_PROJECT_MUTATION"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("git-backed boundary detects gitignored project mutations outside excluded dirs", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-gitignored-boundary-"));
    try {
      const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
      if (init.status !== 0) return;
      writeFileSync(join(root, ".gitignore"), ".env\n", "utf8");

      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt) => {
          writeFileSync(join(root, ".env"), "SECRET=mutation\n", "utf8");
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.boundary.project_mutation, "violated");
      assert.ok(result.boundary.changes.some((change) => change.path === ".env" && change.change === "added"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-git boundary fallback detects modified project files and ignores artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-non-git-boundary-"));
    try {
      assert.equal(existsSync(join(root, ".git")), false);
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "existing.txt"), "before\n", "utf8");

      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt, runOptions) => {
          mkdirSync(runOptions.runtimeDir, { recursive: true });
          writeFileSync(join(runOptions.runtimeDir, "agent-scratch.txt"), "allowed artifact\n", "utf8");
          writeFileSync(join(root, "src", "existing.txt"), "after\n", "utf8");
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.boundary.project_mutation, "violated");
      assert.ok(result.boundary.changes.some((change) => change.path === "src/existing.txt" && change.change === "modified"));
      assert.equal(result.boundary.changes.some((change) => change.path.includes("agent-scratch.txt")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("non-git boundary fallback detects added symlink entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-symlink-boundary-"));
    const outside = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-symlink-target-"));
    try {
      assert.equal(existsSync(join(root, ".git")), false);
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(outside, "target.txt"), "outside target\n", "utf8");

      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt) => {
          const link = join(root, "src", "linked-target.txt");
          if (!existsSync(link)) symlinkSync(join(outside, "target.txt"), link);
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(roleFromPrompt(prompt))),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.boundary.project_mutation, "violated");
      assert.ok(result.boundary.changes.some((change) => change.path === "src/linked-target.txt" && change.change === "added"));
      assert.ok(result.readiness.blockers.some((blocker) => blocker.code === "BOUNDARY_PROJECT_MUTATION"));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("repairs minor Claude JSON key drift and records the repair", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-json-repair-"));
    try {
      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt) => {
          const role = roleFromPrompt(prompt);
          const output = JSON.stringify(fakeAgentOutput(role), null, 2)
            .replace('"line": "42"', '"line": 42-88')
            .replace('"line": 42-88,', '"line": 42-88",')
            .replace("inventory API schema", String.raw`\.yolo inventory API schema`)
            .replace('"summary"', '" "summary"');
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: `\`\`\`json\n${output}\n\`\`\``,
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(result.status, "pass", JSON.stringify(result.readiness?.blockers, null, 2));
      assert.ok(result.provider_runs.some((run) => run.json_repaired === true));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid agent JSON fails closed with explicit blocker code", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-invalid-json-"));
    try {
      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async () => ({
          success: true,
          provider: "claude",
          command: "claude",
          exitCode: 0,
          stdout: "not json",
          stderr: "",
          timedOut: false,
        }),
      });

      assert.equal(result.status, "blocked");
      assert.ok(result.agent_results.every((agent) => agent.result?.error_code === "EVIDENCE_AGENT_INVALID_JSON"));
      assert.ok(result.readiness.blockers.some((blocker) => blocker.code === "EVIDENCE_AGENT_INVALID_JSON"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent evidence without explicit scope is blocked during normalization", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-scope-required-"));
    try {
      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        provider: "claude",
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "claude" } },
        spawnProviderPrompt: async (prompt) => {
          const role = roleFromPrompt(prompt);
          const output = fakeAgentOutput(role);
          output.evidence = output.evidence.map(({ scope: _scope, ...record }: EvidenceRecord): Omit<EvidenceRecord, "scope"> => record) as EvidenceRecord[];
          return {
            success: true,
            provider: "claude",
            command: "claude",
            exitCode: 0,
            stdout: JSON.stringify(output),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(result.status, "blocked");
      assert.ok(result.agent_results.every((agent) => agent.result?.error_code === "EVIDENCE_SCOPE_REQUIRED"));
      assert.ok(result.readiness.blockers.some((blocker) => blocker.code === "EVIDENCE_SCOPE_REQUIRED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent conflict remains a readiness blocker after dispatch", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-dispatch-conflict-"));
    try {
      const result = await runDemandEvidenceDispatchRuntime({
        ...completeRiskyDemand,
        executeAgents: true,
        allowAgentDispatch: true,
        writeArtifact: false,
      }, {
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        config: { ai: { provider: "custom", custom_command: "node fake-agent.js" } },
        spawnProviderPrompt: async (prompt) => {
          const role = roleFromPrompt(prompt);
          return {
            success: true,
            provider: "custom",
            command: "node fake-agent.js",
            exitCode: 0,
            stdout: JSON.stringify(fakeAgentOutput(role, role === "cross-checker" ? {
              recommendation: "block",
              evidence: [{
                path: "src/api/inventory.ts",
                line: "88",
                scope: "project",
                source: "project_code",
                summary: "Cross-checker found lowStockThreshold already exists.",
                why: "This contradicts the explorer claim.",
              }],
              result: { verdict: "blocked" },
            } : {})),
            stderr: "",
            timedOut: false,
          };
        },
      });

      assert.equal(result.status, "blocked");
      assert.equal(result.readiness.prd_ready, false);
      assert.ok(result.readiness.blockers.some((blocker) => blocker.code === "EVIDENCE_AGENT_CONFLICT"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
