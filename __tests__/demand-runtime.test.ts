import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertGeneratedTaskInstructionsSelfConsistent,
  readDemandSession,
  runDemandApprovedRuntime,
  runDemandBrainstormRuntime,
  runDemandDiscussRuntime,
  runDemandPrdRuntime,
} from "../src/demand/runtime.js";
import {
  groundDemandExecutionScope,
  inferGreenfieldTargetFiles,
} from "../src/demand/artifacts.js";
import { deriveEvidenceRequirements, isGreenfieldDemandSession } from "../src/demand/evidence-requirements.js";
import { inspectDemandQuality, inspectDemandReadiness } from "../src/demand/gate.js";
import { inspectStoryAtomicityFromPrd } from "../src/demand/story-atomicity.js";
import { inspectYoloCheck } from "../src/runtime/gates/check-report.js";
import { inspectLifecycleGuard } from "../src/lifecycle/guard.js";
import { demandSessionSchemaError } from "../src/demand/router.js";
import {
  generateFindings,
  parseFindingsJsonOutput,
  validateFindings,
  type FindingsProviderPromptOptions,
  type ProviderRunLike as FindingsProviderRun,
} from "../src/demand/findings-generator.js";
import type {
  DemandAssumptionFact,
  DemandPrdDocument,
  DemandRecord,
  DemandRuntimeInput,
  DemandSession,
  DemandTargetFileFact,
  DemandTask,
  DemandTaskSessionPlan,
} from "../src/demand/graph.js";

interface DemandPrdResultForTest extends DemandRecord {
  status: string;
  code?: string;
  blockers?: DemandRecord[];
  artifacts: string[];
  outputs?: Array<{ path: string; type: string; stage?: string }>;
  grounding?: DemandRecord | null;
  prd_path?: string | null;
  output_path?: string | null;
  prd?: DemandPrdDocument | null;
  quality_report?: DemandRecord & { blockers?: Array<{ code?: string }> };
}

function requirePrd(result: DemandPrdResultForTest): asserts result is DemandPrdResultForTest & { prd: DemandPrdDocument } {
  if (!("prd" in result) || result.prd === null || result.prd === undefined) {
    throw new Error(`expected prd to exist, got status=${result.status}`);
  }
}

function requirePrdTasks(prd: DemandPrdDocument): DemandTask[] {
  if (!Array.isArray(prd.tasks)) {
    throw new Error("expected demand PRD tasks");
  }
  return prd.tasks;
}

function assertTaskSessionPlan(task: DemandTask, demandId: string): DemandTaskSessionPlan {
  if (typeof task.id !== "string") {
    throw new Error("task session plan requires a string task id");
  }
  const taskId = task.id;
  const session = task.handoff?.session;
  assert.ok(session, `missing session plan for ${taskId}`);
  const taskRoot = `.yolo/demand/${demandId}/tasks/${taskId}`;
  assert.equal(session.schema, "yolo.demand.task_session_plan.v1");
  assert.equal(session.session_id, `${taskId}-session`);
  assert.equal(session.task_id, taskId);
  assert.equal(session.demand_id, demandId);
  assert.equal(session.state_path, `${taskRoot}/session.json`);
  assert.equal(session.handoff_path, `${taskRoot}/handoff.md`);
  assert.equal(session.evidence_path, `${taskRoot}/evidence.jsonl`);
  assert.equal(session.memory_update_paths?.includes(".yolo/memory/CURRENT_HANDOFF.md"), true);
  assert.equal(session.memory_update_paths?.includes(".yolo/memory/PROGRESS.md"), true);
  assert.equal(session.memory_update_paths?.includes(".yolo/state/session-memory.jsonl"), true);
  assert.equal(session.progress_update_path, ".yolo/memory/PROGRESS.md");
  assert.equal(session.resume_instructions?.includes(taskId), true);
  return session;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function defaultDemandTargetFileContent(file: string): string {
  if (file.endsWith("inventory-list.tsx")) {
    return [
      "export function InventoryList({ items }) {",
      "  return <ul>{items.map((item) => <li key={item.sku}>{item.sku}{item.quantity <= item.lowStockThreshold ? <span>Low stock</span> : null}</li>)}</ul>;",
      "}",
      "",
    ].join("\n");
  }
  if (file.endsWith("inventory-alerts.ts")) {
    return "export function isLowStock(item) { return item.quantity <= item.lowStockThreshold; }\n";
  }
  if (file.endsWith("inventory-alerts.test.ts")) {
    return "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isLowStock } from './inventory-alerts';\ntest('low stock threshold', () => assert.equal(isLowStock({ quantity: 1, lowStockThreshold: 2 }), true));\n";
  }
  return "export const yoloDemandTarget = true;\n";
}

function writeProjectFile(root: string, file: string, content: string = defaultDemandTargetFileContent(file)): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function seedDemandTargetFiles(root: string, files: string[]): void {
  for (const file of files) writeProjectFile(root, file);
}

function seedDogfoodGitweeklyR2Fixture(root: string): string {
  const sessionPath = join(process.cwd(), "__tests__/fixtures/dogfood-gitweekly-r2/session.json");
  const ledgerPath = join(process.cwd(), "__tests__/fixtures/dogfood-gitweekly-r2/state/evidence/ledger.jsonl");
  const session = JSON.parse(readFileSync(sessionPath, "utf8"));
  const demandDir = join(root, ".yolo", "demand", session.id);
  mkdirSync(demandDir, { recursive: true });
  writeJson(join(demandDir, "session.json"), session);
  mkdirSync(join(root, ".yolo", "state", "evidence"), { recursive: true });
  writeFileSync(join(root, ".yolo", "state", "evidence", "ledger.jsonl"), readFileSync(ledgerPath, "utf8"), "utf8");
  writeJson(join(root, ".yolo", "config.json"), {
    schema_version: "1.0",
    project: { name: "dogfood-gitweekly-r2" },
    paths: { state: ".yolo/state" },
  });
  return demandDir;
}

function scaffoldInstructionText(task: DemandTask): string {
  const value = (task as DemandTask & { instructions?: unknown }).instructions;
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => String(item ?? "")).filter(Boolean).join("\n");
}

function assertNodeScaffoldToolchain(scaffold: DemandTask): void {
  const instructions = scaffoldInstructionText(scaffold);
  const requiredCapabilities = Array.isArray(scaffold.required_capabilities) ? scaffold.required_capabilities : [];
  assert.ok(requiredCapabilities.includes("shell"), "scaffold must declare shell capability for install/toolchain commands");
  assert.doesNotMatch(instructions, /\b(?:vitest|jest)\b/i);
  assert.match(instructions, /\bnode --test\b/);
  assert.match(instructions, /npm install --save-dev typescript/);
  assert.ok(scaffold.post_conditions?.some((condition) =>
    condition.type === "build_command_available" &&
    condition.params?.kind === "test" &&
    condition.params?.command === "node --test"
  ), "scaffold must verify the node:test command is available");
  assert.ok(scaffold.post_conditions?.some((condition) =>
    condition.type === "build_command_available" &&
    condition.params?.kind === "type_check" &&
    condition.params?.command === "tsc --noEmit"
  ), "scaffold must verify the TypeScript command is available when type gates exist");
}

function duplicateTaskKeys(tasks: DemandTask[] = []): string[] {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const task of tasks) {
    const rawTargets = Array.isArray(task.scope?.targets)
      ? task.scope.targets as Array<string | { file?: string }>
      : [];
    const targets = rawTargets
      .map((target) => String(typeof target === "string" ? target : target.file || target))
      .filter(Boolean)
      .sort()
      .join(",");
    const key = JSON.stringify([task.title, targets, task.type]);
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  return duplicates;
}

function isRecord(value: unknown): value is DemandRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTargetFileFact(value: unknown): value is DemandTargetFileFact {
  return isRecord(value) && typeof value.file === "string";
}

function isAssumptionFact(value: unknown): value is DemandAssumptionFact {
  return isRecord(value);
}

function targetFileFacts(value: unknown): DemandTargetFileFact[] {
  return Array.isArray(value) ? value.filter(isTargetFileFact) : [];
}

function traceId(value: DemandRecord | string | undefined): string {
  return typeof value === "string" ? value : String(value?.id ?? "");
}

function textValue(value: unknown): string {
  return String(value ?? "");
}

type GenerateFindingsResult = Awaited<ReturnType<typeof generateFindings>>;

function hasFindingsProviderRun(value: GenerateFindingsResult): value is GenerateFindingsResult & { provider_run: FindingsProviderRun } {
  return isRecord(value) && "provider_run" in value && isRecord(value.provider_run);
}

function assertExecutableTaskGraph(tasks: DemandTask[]) {
  const ids = new Set(tasks.map((task) => task.id));
  const roots = tasks.filter((task) => (task.depends_on || []).length === 0);
  assert.ok(roots.length > 0, "task graph must have at least one zero-dependency root");

  const indegree = new Map<string, number>(tasks.map((task) => [task.id, 0]));
  const outgoing = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dependency of task.depends_on || []) {
      assert.ok(ids.has(dependency), `dependency ${dependency} must reference an existing task`);
      outgoing.get(dependency).push(task.id);
      indegree.set(task.id, indegree.get(task.id) + 1);
    }
  }

  const ready: string[] = [...roots.map((task) => task.id)];
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    ordered.push(id);
    for (const next of outgoing.get(id) || []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  assert.equal(ordered.length, tasks.length, `task graph must be topologically sortable; ordered=${ordered.join(",")}`);
}

function acceptanceAdapterManifest() {
  return {
    schema: "yolo.manifest.v1",
    id: "local-browser",
    kind: "acceptance_adapter",
    description: "Local browser acceptance adapter",
    inputs: ["url", "prd"],
    outputs: ["acceptance_report"],
    commands: [{ command: "npm run accept" }],
    evidence: ["screenshot", "runtime_log"],
    capabilities: ["page_reachable", "screenshot", "runtime_errors"],
    applies_to: ["ui", "browser"],
  };
}

function hasVerifyCommand(condition: DemandRecord = Object()): boolean {
  const params = isRecord(condition.params) ? condition.params : {};
  return Boolean(condition.verify_command || condition.verifyCommand || params.verify_command || params.verifyCommand);
}

function nakedManualAcceptancePostConditions(prd: DemandPrdDocument): DemandRecord[] {
  return requirePrdTasks(prd).flatMap((task) =>
    (task.post_conditions || []).filter((condition) =>
      condition?.type === "acceptance_criteria" && !hasVerifyCommand(condition)
    )
  );
}

function prdTraceEvidenceCount(prd: DemandPrdDocument): number {
  return requirePrdTasks(prd).reduce((total, task) => total + ((task.trace?.evidence as unknown[]) || []).length, 0);
}

function taskcliDemandInput(root: string): DemandRuntimeInput {
  return {
    projectRoot: root,
    stateRoot: join(root, ".yolo"),
    demand_id: "DEMAND-TASKCLI",
    title: "taskcli command line todo",
    idea: "Build taskcli, a Node TypeScript command line todo tool.",
    target_users: ["solo developer who manages a small todo list from the terminal"],
    status_quo: ["The developer keeps todos in a scratch text file and manually counts done items."],
    evidence: ["User interview approved a greenfield Node TypeScript CLI; no existing app files are required."],
    assumptions: ["The project is greenfield and the first implementation file can be created under src."],
    success_criteria: [
      "Taskcli stores todos in a local JSON file and supports add/list/done/stats terminal output.",
    ],
    proof: [
      "During acceptance, run taskcli add one item, list it, mark it done, and see stats count one completed item.",
    ],
    constraints: [
      "Node and TypeScript only; persist data to a JSON file in the project working directory.",
    ],
    non_goals: ["No UI, no network service, no database server."],
    decisions: ["Use one source module for the command line behavior and JSON persistence."],
    roadmap: ["MVP is one command line module with add/list/done/stats."],
    exceptions: ["If the JSON file is missing, taskcli starts with an empty todo list."],
    approve: true,
    playback: { confirmed: true, confirmed_by: "user" },
    writeArtifacts: true,
  };
}

function taskcliInterviewToDemandStyleSession(): DemandSession {
  return {
    id: "DEMAND-20260619-TASKCLI-REAL-STYLE",
    phase: "prd_intake",
    source: "yolo-interview",
    project: {
      title: "做一个命令行待办工具 taskcli(Node + TypeScript, Vitest 测试, 纯本地 JSON 文件持久化, 无 UI、无网络)。",
      target_users: [
        "目标用户是每天在终端工作的个人用户和开发协作者；每人每天多次记录、查看、完成自己的本地待办。",
      ],
      target_files: [],
      candidate_target_files: [
        "specs/tasks.md",
        ".yolo-bridge-manifest.json",
      ],
    },
    project_facts: {
      schema: "yolo.demand.project_facts.v1",
      target_files: [
        {
          file: "specs/tasks.md",
          status: "candidate",
          source: "auto_scout_candidate",
          evidence: ["specs/tasks.md exists, but relevance is only inferred."],
          message: "Auto-scouted file is only a candidate and must not enter execution scope until verified.",
        },
        {
          file: ".yolo-bridge-manifest.json",
          status: "candidate",
          source: "auto_scout_candidate",
          evidence: [".yolo-bridge-manifest.json exists, but relevance is only inferred."],
          message: "Auto-scouted file is only a candidate and must not enter execution scope until verified.",
        },
      ],
      candidate_target_files: [
        "specs/tasks.md",
        ".yolo-bridge-manifest.json",
      ],
      assumptions: [{
        id: "ASM-001",
        text: "Interview answers are user-provided and should be validated before implementation.",
        status: "assumption",
        source: "user_or_dialogue",
      }],
      policy: {
        inferred_files_are_execution_scope: false,
        unverified_project_facts_block_prd: true,
        user_approval_cannot_override_fact_conflicts: true,
      },
    },
    vision: {
      statement: "做一个命令行待办工具 taskcli。功能包括 taskcli add/list/done/rm/stats，存 ~/.taskcli/tasks.json，非法输入友好报错并返回非零 exit code。",
      idea: "做一个命令行待办工具 taskcli(Node + TypeScript, Vitest 测试, 纯本地 JSON 文件持久化, 无 UI、无网络)。",
    },
    prd_intake: {
      schema: "yolo.demand.prd_intake.v1",
      source: "input.interview",
      question_ids: [
        "target_users",
        "status_quo",
        "desired_outcome",
        "success_criteria",
        "success_proof",
        "scope_boundaries",
        "exceptions",
        "execution_approval",
      ],
      plain_language_problem: "终端待办散落在临时笔记里，用户找回任务和确认状态很慢。",
      audience: ["每天在终端工作的个人用户和开发协作者。"],
      desired_outcomes: [
        "用户可以用 taskcli add/list/done/rm/stats 在终端完成本地待办管理。",
      ],
      success_proof: [
        "Vitest 全绿，并用临时 HOME 的 CLI smoke 执行 add→list→done→stats。",
      ],
      boundaries: [
        "本次只做本地 Node + TypeScript CLI、Vitest 测试和 JSON 文件持久化。",
      ],
      exceptions: [
        "必须处理空文本、非法日期、不存在 id、tasks.json 损坏或内容不是数组。",
      ],
    },
    requirements: {
      active: [
        {
          id: "REQ-001",
          text: "用户可以用 taskcli add/list/done/rm/stats 在终端完成本地待办管理；数据持久保存到 ~/.taskcli/tasks.json；异常输入以友好信息和非零 exit code 返回。",
          source: "demand",
          status: "confirmed",
          acceptance_scenarios: [{
            id: "SCN-001",
            when: "the user exercises this requirement",
            then: "taskcli add→list→done→stats works in a clean HOME.",
          }],
          trace: {
            evidence: [],
            decisions: ["DEC-001"],
            question_ids: ["desired_outcome", "success_criteria"],
          },
        },
      ],
      constraints: [
        "仅本地文件、无网络、不引非必要依赖。",
      ],
      out_of_scope: [
        "不做 UI、网络请求、账号、同步、数据库、后台服务。",
      ],
    },
    scenario_matrix: {
      schema: "yolo.demand.scenario_matrix.v1",
      generated_from: "nontechnical_interview",
      nontechnical_user_safe: true,
      scenarios: [{
        id: "SCN-001",
        requirement_id: "REQ-001",
        actor: "terminal user",
        touchpoint: "terminal",
        trigger: "the user runs taskcli",
        current_behavior: "Todos are scattered in temporary notes.",
        desired_behavior: "taskcli manages local todos.",
        proof: "CLI smoke and Vitest pass.",
        out_of_scope: ["No UI or network."],
        constraints: ["Local JSON persistence only."],
        exceptions: ["Invalid input exits non-zero."],
        surfaces: [{
          id: "SCN-001-SFC-001",
          kind: "service",
          label: "业务规则/服务逻辑",
          user_visible: false,
          target_files: [],
          readonly_files: [],
          session_budget: {
            expected: "single_session",
            max_files: 1,
            max_lines_per_file: 120,
          },
          proof: "CLI smoke and Vitest pass.",
          visual_style_source: [],
        }],
        question_trace: ["desired_outcome", "success_criteria"],
        source_question_ids: ["desired_outcome", "success_criteria"],
      }],
    },
    playback: {
      schema: "yolo.demand.understanding_playback.v1",
      confirmed: true,
      confirmed_by: "user",
      answer: "确认理解无误。",
    },
    approval: {
      approved: true,
      approved_by: "user",
      reason: "批准进入 PRD intake。",
    },
  };
}

describe("demand findings generator output parsing", () => {
  function validFindingsJson() {
    return JSON.stringify({
      findings: [{
        id: "DEV-001",
        description: "Update the inventory module.",
        files: ["src/inventory.ts"],
      }],
    });
  }

  test("parses fenced explanatory output with deeply nested findings JSON", () => {
    const output = [
      "Here is the generated JSON:",
      "```json",
      JSON.stringify({
        findings: [{
          id: "DEV-001",
          title: "Add nested task",
          severity: "HIGH",
          description: "Implement nested scope and condition parsing.",
          files: ["src/pages/nested.tsx"],
          scope: {
            targets: [{
              file: "src/pages/nested.tsx",
              metadata: {
                owner: "demand",
                checks: [{ name: "target", params: { required: true } }],
              },
            }],
          },
          post_conditions: [{
            id: "POST-NESTED",
            type: "code_contains",
            severity: "FAIL",
            params: {
              file: "src/pages/nested.tsx",
              matcher: {
                any: [{ text: "nested", options: { case_sensitive: false } }],
              },
            },
          }],
        }],
      }, null, 2),
      "```",
      "This object is ready for audit-to-prd.",
    ].join("\n");

    const parsed = parseFindingsJsonOutput(output);

    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.data.findings[0].scope.targets[0].metadata.checks[0].params.required, true);
    assert.equal(parsed.data.findings[0].post_conditions[0].params.matcher.any[0].options.case_sensitive, false);
    assert.equal(validateFindings(parsed.data).ok, true);
  });

  test("uses provider adapter defaults without dangerous claude permissions", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-findings-generator-"));
    let capturedPrompt = "";
    let capturedOptions: FindingsProviderPromptOptions | null = null;
    try {
      const result = await generateFindings("build findings", 1234, {
        projectRoot: root,
        spawnProviderPrompt: async (prompt, runOptions) => {
          capturedPrompt = prompt;
          capturedOptions = runOptions;
          return {
            success: true,
            provider: "claude",
            stdout: validFindingsJson(),
            stderr: "",
          };
        },
      });

      assert.equal(result.ok, true);
      assert.equal(capturedPrompt, "build findings");
      if (capturedOptions === null) {
        throw new Error("expected findings provider options to be captured");
      }
      assert.equal(capturedOptions.timeout, 1234);
      assert.equal(capturedOptions.rootDir, root);
      assert.equal(capturedOptions.config.ai.claude_permission_mode, "acceptEdits");
      assert.equal(JSON.stringify(capturedOptions.config.ai).includes("dangerously-skip-permissions"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("adapter contract blocks dangerous claude permission mode for findings", async () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-findings-generator-"));
    let spawned = false;
    try {
      const result = await generateFindings("build findings", 1234, {
        projectRoot: root,
        config: {
          ai: {
            provider: "claude",
            executor: "claude",
            model: "claude-sonnet-4",
            settings: "",
            claude_permission_mode: "dangerously-skip-permissions",
          },
        },
        commandExists: () => true,
        spawnImpl: () => {
          spawned = true;
          throw new Error("should not spawn when adapter contract blocks");
        },
      });

      assert.equal(result.ok, false);
      assert.equal(spawned, false);
      assert.ok(hasFindingsProviderRun(result));
      const providerRun = result.provider_run;
      assert.equal(providerRun.blocked, true);
      assert.equal(providerRun.reason, "agent_permission_unsafe");
      assert.ok(providerRun.adapter_contract_inspection?.blockers?.some((blocker) => blocker.code === "AGENT_PERMISSION_UNSAFE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("demand runtime", () => {
  test("infers a traceable planned new file from greenfield CLI demand text", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-grounding-"));
    try {
      const approved = runDemandApprovedRuntime(taskcliDemandInput(root));
      assert.equal(approved.status, "success");
      assert.deepEqual(approved.session.project.target_files, []);

      const inferred = inferGreenfieldTargetFiles(approved.session, { projectRoot: root });
      assert.deepEqual(inferred.map((item) => item.file), ["src/taskcli.ts"]);
      assert.equal(inferred[0].status, "planned_new_file");

      const grounded = groundDemandExecutionScope(approved.session, { projectRoot: root });
      assert.equal(grounded.applied, true);
      assert.deepEqual(grounded.session.project.target_files, ["src/taskcli.ts"]);
      const fact = grounded.session.project_facts.target_files[0];
      assert.equal(fact.file, "src/taskcli.ts");
      assert.equal(fact.status, "planned_new_file");
      assert.equal(fact.allow_new_files, true);
      assert.match(fact.evidence.join("\n"), /approved demand requirement/i);
      assert.equal(grounded.session.project_facts.policy.inferred_files_are_execution_scope, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("grounds greenfield planned new file from interview-to-demand session despite unrelated candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-grounding-real-style-"));
    try {
      writeProjectFile(root, "specs/tasks.md", "# Existing generated task scaffold\n");
      writeProjectFile(root, ".yolo-bridge-manifest.json", "{}\n");
      const session = taskcliInterviewToDemandStyleSession();

      const inferred = inferGreenfieldTargetFiles(session, { projectRoot: root });
      assert.deepEqual(inferred.map((item) => item.file), ["src/taskcli.ts"]);
      assert.equal(inferred[0].status, "planned_new_file");
      assert.equal(inferred[0].source, "demand_greenfield_inference");

      const grounded = groundDemandExecutionScope(session, { projectRoot: root });
      assert.equal(grounded.applied, true, JSON.stringify(grounded, null, 2));
      assert.equal(grounded.status, "applied");
      assert.deepEqual(grounded.session.project.target_files, ["src/taskcli.ts"]);

      const target = targetFileFacts(grounded.target_files).find((item) => item.file === "src/taskcli.ts");
      assert.ok(target);
      assert.equal(target.status, "planned_new_file");
      assert.equal(target.allow_new_files, true);

      const fact = grounded.session.project_facts.target_files.find((item) => item.file === "src/taskcli.ts");
      assert.ok(fact);
      assert.equal(fact.status, "planned_new_file");
      assert.equal(fact.source, "demand_greenfield_inference");
      assert.equal(fact.allow_new_files, true);
      assert.deepEqual(grounded.session.project.candidate_target_files, []);
      assert.deepEqual(grounded.session.project_facts.candidate_target_files, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("spec --demand auto-grounds greenfield demand into executable PRD accepted by check", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-grounding-prd-"));
    try {
      const approved = runDemandApprovedRuntime(taskcliDemandInput(root), { writeLifecycle: false });
      const spec = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: approved.demand_path,
        writeArtifacts: true,
      }) as DemandPrdResultForTest;

      assert.equal(spec.status, "success", JSON.stringify(spec.blockers, null, 2));
      assert.equal(spec.grounding?.applied, true);
      requirePrd(spec);
      const prdPath = spec.artifacts.find((path) => path.endsWith("prd.json"));
      assert.ok(prdPath);
      assert.equal(spec.prd_path, prdPath);
      assert.equal(spec.output_path, prdPath);
      assert.equal(spec.artifacts[0], prdPath);
      const outputs = spec.outputs || [];
      assert.equal(outputs.find((output) => output.type === "prd")?.path, prdPath);
      assert.equal(outputs.find((output) => output.path.endsWith("session.json"))?.type, "demand_session");
      assert.equal(outputs.find((output) => output.path.endsWith("GROUNDING.json"))?.type, "grounding");
      assert.equal(outputs.find((output) => output.path.endsWith("READINESS.json"))?.type, "readiness");
      assert.equal(existsSync(join(approved.demand_dir, "GROUNDING.json")), true);
      assert.equal(existsSync(join(root, ".yolo/lifecycle/discovery.json")), true);
      assert.equal(existsSync(join(root, ".yolo/lifecycle/roadmap.json")), true);

      const savedSession = JSON.parse(readFileSync(approved.demand_path, "utf8")) as DemandSession;
      assert.deepEqual(savedSession.project.target_files, ["src/taskcli.ts"]);
      assert.equal(savedSession.project_facts.target_files[0].status, "planned_new_file");

      const prd = spec.prd;
      const tasks = requirePrdTasks(prd);
      assert.equal(tasks[0].task_kind, "greenfield_scaffold");
      const task = tasks.find((candidate) =>
        candidate.scope?.targets?.some((target) => target.file === "src/taskcli.ts")
      );
      assert.ok(task);
      assert.ok(task.scope?.targets);
      assert.deepEqual(task.scope.targets.map((target) => target.file), ["src/taskcli.ts"]);
      assert.equal(task.scope.allow_new_files, true);
      assert.equal(prd.demand.project_facts.target_files[0].status, "planned_new_file");
      assertExecutableTaskGraph(tasks);

      const check = inspectYoloCheck({
        prdPath,
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeLifecycle: false,
      });
      assert.equal(check.status, "pass", JSON.stringify(check.blockers, null, 2));
      const runGuard = inspectLifecycleGuard({
        command: "yolo-run",
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        prdPath,
      });
      assert.equal(runGuard.status, "blocked");
      assert.deepEqual(runGuard.missing_required_stages, ["check"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("greenfield planned new files treat success criteria and exceptions as acceptance targets", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-greenfield-evidence-"));
    try {
      const session = {
        id: "DEMAND-GREENFIELD-EVIDENCE",
        phase: "prd_intake",
        project: {
          title: "Build a pure TypeScript markdown notes library from scratch.",
          target_users: ["developer using local markdown notes"],
          target_files: ["src/notes.ts"],
          candidate_target_files: [],
        },
        vision: {
          statement: "Build a pure TypeScript markdown notes library from scratch for local note parsing and search.",
          target_users: ["developer using local markdown notes"],
          status_quo: ["The user currently keeps notes in loose markdown files."],
        },
        investigation: {
          evidence: ["User approved a greenfield library; no existing target implementation file is required."],
        },
        reflection: {
          assumptions: ["The first implementation file is planned under src and will be verified by tests after delivery."],
        },
        requirements: {
          active: [
            {
              id: "REQ-001",
              text: "The user-visible completion standard is concrete: a user can run the main markdown notes library workflow on local sample data, see the expected output file/API/library result, see invalid input rejected with a clear message, rerun without corrupting existing data, and confirm the same behavior through a passing test command.",
              acceptance_scenarios: [{ id: "SCN-001", when: "the user runs local samples", then: "the expected output is produced and invalid input is rejected with a clear message" }],
            },
            {
              id: "REQ-002",
              text: "Handle missing input file, empty document, missing required fields, invalid content, duplicate entries, and data containing punctuation or whitespace where the parser supports it.",
              acceptance_scenarios: [{ id: "SCN-002", when: "the user provides malformed local note data", then: "the library reports a clear validation result without corrupting existing data" }],
            },
          ],
          constraints: ["Use local TypeScript only and make network access out of scope."],
          out_of_scope: ["No remote sources, UI, database loading, or deployed service."],
        },
        scenario_matrix: {
          scenarios: [
            {
              id: "SCN-001",
              requirement_id: "REQ-001",
              proof: "A test imports the library, parses local markdown samples, searches the in-memory index, and verifies the expected output.",
              surfaces: [{
                id: "SCN-001-SFC-001",
                kind: "code",
                target_files: ["src/notes.ts"],
                allow_new_files: true,
                proof: "A test imports the library, parses local markdown samples, searches the in-memory index, and verifies the expected output.",
                session_budget: { expected: "single_session", max_files: 1, max_lines_per_file: 120 },
              }],
            },
            {
              id: "SCN-002",
              requirement_id: "REQ-002",
              proof: "A test passes malformed local note data and sees a clear validation result without corrupting existing data.",
              surfaces: [{
                id: "SCN-002-SFC-001",
                kind: "code",
                target_files: ["src/notes.ts"],
                allow_new_files: true,
                proof: "A test passes malformed local note data and sees a clear validation result without corrupting existing data.",
                session_budget: { expected: "single_session", max_files: 1, max_lines_per_file: 120 },
              }],
            },
          ],
        },
        project_facts: {
          schema: "yolo.demand.project_facts.v1",
          target_files: [{
            file: "src/notes.ts",
            status: "planned_new_file",
            source: "demand_greenfield_inference",
            new_file: true,
            allow_new_files: true,
          }],
          candidate_target_files: [],
          assumptions: [],
          policy: {
            greenfield_new_files_are_execution_scope: true,
            unverified_project_facts_block_prd: true,
          },
        },
        roadmap: { mvp: ["Local parser and in-memory search."] },
        approval: { approved: true },
        playback: { confirmed: true, confirmed_by: "user" },
      };

      assert.equal(isGreenfieldDemandSession({}, session), true);
      assert.deepEqual(deriveEvidenceRequirements({}, session, { kinds: ["project"] }), []);

      const readiness = inspectDemandReadiness(session, {
        phase: "prd",
        projectRoot: root,
        stateDir: join(root, ".yolo", "state"),
      });
      assert.equal(readiness.blockers.some((blocker) => blocker.code === "PROJECT_FACTS_GROUNDED"), false);
      assert.equal(readiness.blockers.some((blocker) => blocker.code === "PROJECT_EVIDENCE_REQUIREMENT_REQUIRED"), false);
      assert.equal(readiness.blockers.some((blocker) => blocker.code === "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("brownfield existing payload claims still require project evidence", () => {
    const session = {
      project: { target_files: ["src/inventory.ts"] },
      project_facts: {
        target_files: [{ file: "src/inventory.ts", status: "verified" }],
      },
      requirements: {
        active: [{
          id: "REQ-001",
          text: "Inventory list already receives quantity and threshold fields from the existing request payload.",
          acceptance_scenarios: [{ then: "A low-stock result can use those existing fields." }],
        }],
      },
    };

    assert.equal(isGreenfieldDemandSession({}, session), false);
    const requirements = deriveEvidenceRequirements({}, session, { kinds: ["project"] });
    assert.equal(requirements.length, 1);
    assert.equal(requirements[0].kind, "project");
    assert.equal(requirements[0].status, "pending");
  });

  test("deduplicates same-scenario tasks with identical title target and type", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-task-dedup-"));
    try {
      seedDemandTargetFiles(root, ["src/taskcli.ts", "__tests__/taskcli.test.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demand_id: "DEMAND-TASK-DEDUP",
        idea: "Build a small local command tool.",
        target_users: ["terminal user"],
        status_quo: ["The user tracks one task manually."],
        evidence: ["Agent read src/taskcli.ts and __tests__/taskcli.test.ts and confirmed they are the target files."],
        assumptions: ["The local command behavior can be implemented in one source file and verified in one test file."],
        success_criteria: ["The command records one local task and reports it back to the user."],
        proof: ["A unit test and CLI smoke show the recorded task is listed back."],
        constraints: ["Keep the implementation local and deterministic."],
        non_goals: ["No network service or UI."],
        target_files: ["src/taskcli.ts", "__tests__/taskcli.test.ts"],
        decisions: ["Use one source module plus one test module."],
        roadmap: ["MVP command behavior."],
        exceptions: ["Empty input returns a friendly error."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      const scenario = discuss.session.scenario_matrix.scenarios[0];
      scenario.surfaces = [
        {
          id: `${scenario.id}-SFC-001`,
          kind: "code",
          label: "代码实现",
          target_files: ["src/taskcli.ts"],
          readonly_files: [],
          session_budget: { expected: "single_session", max_files: 1, max_lines_per_file: 120 },
          proof: scenario.proof,
        },
        {
          id: `${scenario.id}-SFC-002`,
          kind: "code",
          label: "代码实现",
          target_files: ["src/taskcli.ts"],
          readonly_files: [],
          session_budget: { expected: "single_session", max_files: 1, max_lines_per_file: 120 },
          proof: scenario.proof,
        },
        {
          id: `${scenario.id}-SFC-003`,
          kind: "test",
          label: "测试/验证",
          target_files: ["__tests__/taskcli.test.ts"],
          readonly_files: ["src/taskcli.ts"],
          session_budget: { expected: "single_session", max_files: 1, max_lines_per_file: 120 },
          proof: scenario.proof,
        },
      ];
      writeJson(join(discuss.demand_dir, "session.json"), discuss.session);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      }) as DemandPrdResultForTest;

      assert.equal(prd.status, "success", JSON.stringify(prd.blockers, null, 2));
      requirePrd(prd);
      assert.deepEqual(duplicateTaskKeys(prd.prd.tasks), []);
      assert.equal(prd.prd.tasks[0].task_kind, "greenfield_scaffold");
      const businessTasks = prd.prd.tasks.filter((task) => task.task_kind !== "greenfield_scaffold");
      assert.equal(businessTasks.filter((task) => task.scope.targets.some((target) => target.file === "src/taskcli.ts")).length, 1);
      assert.equal(businessTasks.filter((task) => task.scope.targets.some((target) => target.file === "__tests__/taskcli.test.ts")).length, 1);
      assert.equal(businessTasks.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("generic multi-action demands compile into atomic executable PRD tasks across unrelated domains", () => {
    const cases = [
      {
        name: "cli-actions",
        file: "src/cli-actions.ts",
        idea: "Build a local command tool for personal records.",
        targetUsers: ["terminal operator"],
        criterion: "The local tool supports add/list/done/rm/stats flows; persisted state survives another run; invalid input returns clear errors.",
        expectedStories: 7,
      },
      {
        name: "url-service",
        file: "src/url-service.ts",
        idea: "Build a small REST service for generated URLs.",
        targetUsers: ["API consumer"],
        criterion: "The REST service supports shorten/redirect/stats flows for generated URLs.",
        expectedStories: 3,
      },
      {
        name: "notes-library",
        file: "src/notes-library.ts",
        idea: "Build a Markdown repository helper.",
        targetUsers: ["knowledge worker"],
        criterion: "The Markdown repository can parse/tag/index/search note files.",
        expectedStories: 4,
      },
      {
        name: "csv-pipeline",
        file: "src/csv-pipeline.ts",
        idea: "Build a CSV processing pipeline.",
        targetUsers: ["data analyst"],
        criterion: "The data pipeline can load/clean/aggregate/export CSV rows.",
        expectedStories: 4,
      },
    ];

    for (const item of cases) {
      const root = mkdtempSync(join(tmpdir(), `yolo-demand-generic-${item.name}-`));
      try {
        seedDemandTargetFiles(root, [item.file]);
        const discuss = runDemandDiscussRuntime({
          projectRoot: root,
          stateRoot: join(root, ".yolo"),
          demand_id: `DEMAND-${item.name.toUpperCase()}`,
          idea: item.idea,
          target_users: item.targetUsers,
          status_quo: ["The user currently completes the workflow manually in separate steps."],
          evidence: [`Agent read ${item.file} and confirmed it is the implementation target.`],
          assumptions: ["The workflow is local and can be verified from deterministic inputs."],
          success_criteria: [item.criterion],
          proof: ["Acceptance observes the requested single action outcome."],
          constraints: ["Keep each generated task to one user-visible action."],
          non_goals: ["No unrelated workflow expansion."],
          target_files: [item.file],
          decisions: ["Split enumerated actions into separate implementation tasks."],
          roadmap: ["Deliver the enumerated MVP actions as atomic tasks."],
          exceptions: ["Invalid input should fail deterministically."],
          approve: true,
          playback: { confirmed: true, confirmed_by: "user" },
          writeArtifacts: true,
        });

        assert.equal(discuss.status, "success", JSON.stringify(discuss.blockers, null, 2));
        assert.equal(discuss.session.requirements.active.length, item.expectedStories);
        assert.equal(discuss.session.scenario_matrix.scenarios.length, item.expectedStories);

        const prd = runDemandPrdRuntime({
          projectRoot: root,
          stateRoot: join(root, ".yolo"),
          demandPath: discuss.demand_dir,
          writeArtifacts: false,
        });

        assert.equal(prd.status, "success", JSON.stringify(prd.blockers, null, 2));
        requirePrd(prd);
        assert.equal(prd.prd.tasks.length >= item.expectedStories, true);
        assert.equal(prd.prd.tasks.length <= Math.max(8, item.expectedStories + 2), true, `${item.name} generated too many tasks: ${prd.prd.tasks.length}`);
        assert.deepEqual(duplicateTaskKeys(prd.prd.tasks), [], `${item.name} generated duplicate tasks`);
        assertExecutableTaskGraph(prd.prd.tasks);
        assert.equal(inspectStoryAtomicityFromPrd(prd.prd).status, "pass");
        assert.equal(prd.prd.demand.quality_report.status, "pass");

        if (item.name === "csv-pipeline" || item.name === "notes-library") {
          const prdPath = join(root, `${item.name}-prd.json`);
          writeJson(prdPath, prd.prd);
          const check = inspectYoloCheck({
            prdPath,
            projectRoot: root,
            stateRoot: join(root, ".yolo"),
            writeLifecycle: false,
          });
          assert.equal(check.status, "pass", JSON.stringify(check.blockers, null, 2));
          assert.equal(check.task_surface_summary.ui_task_count, 0);
          assert.equal(check.blockers.some((blocker) => blocker.code === "ACCEPTANCE_ADAPTER_MISSING"), false);
          assert.equal(check.blockers.some((blocker) => blocker.code === "ADAPTER_UI_ACCEPTANCE_MISSING"), false);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("self-contained URL short-link REST service spec does not require external research evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-url-shortener-"));
    try {
      seedDemandTargetFiles(root, ["src/url-shortener.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demand_id: "DEMAND-URL-SHORTENER",
        idea: "Build a self-contained HTTP REST service for URL short links.",
        target_users: ["API consumer"],
        status_quo: ["Users paste long links into ad hoc notes and cannot track generated short codes."],
        evidence: ["Agent read src/url-shortener.ts and confirmed it is the implementation target."],
        assumptions: ["The URL short-link service is self-contained and can be verified with deterministic local requests."],
        success_criteria: [
          "Use URL inputs for POST /shorten, redirect GET /:code to the stored original URL, and expose GET /stats from local state.",
        ],
        proof: ["Build and unit tests cover shorten, redirect, and stats behavior without network calls."],
        constraints: ["Use local in-memory storage only; do not fetch external websites or integrate third-party APIs."],
        non_goals: ["No external API calls, scraping, authentication, or deployed web hosting."],
        target_files: ["src/url-shortener.ts"],
        decisions: ["Implement the REST handlers as a self-contained local module."],
        roadmap: ["Deliver deterministic URL short-link behavior in one local service module."],
        exceptions: ["Unknown short codes return a deterministic not-found response."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      assert.equal(discuss.status, "success", JSON.stringify(discuss.blockers, null, 2));
      assert.equal(discuss.readiness.blockers.some((blocker) => blocker.code === "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED"), false);
      assert.equal(discuss.readiness.evidence_requirements.some((requirement) => requirement.kind === "external"), false);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      }) as DemandPrdResultForTest;

      assert.equal(prd.status, "success", JSON.stringify(prd.blockers, null, 2));
      assert.equal(prd.blockers.some((blocker) => blocker.code === "EXTERNAL_RESEARCH_EVIDENCE_REQUIRED"), false);
      requirePrd(prd);
      assert.equal((prd.prd.demand.evidence_requirements || []).some((requirement) => requirement.kind === "external"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not promote auto-scouted brownfield candidates without explicit confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-grounding-candidate-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "existing.ts"), "export const existing = true;\n", "utf8");
      const session = {
        id: "DEMAND-CANDIDATE",
        requirements: {
          active: [{
            id: "REQ-001",
            text: "Update `existing` so operators can see the requested behavior in the current implementation.",
          }],
        },
        project: {
          target_files: [],
          candidate_target_files: ["src/existing.ts"],
        },
        project_facts: {
          target_files: [{ file: "src/existing.ts", status: "candidate", source: "auto_scout_candidate" }],
          candidate_target_files: ["src/existing.ts"],
        },
      };

      const grounded = groundDemandExecutionScope(session, { projectRoot: root });
      assert.equal(grounded.applied, false);
      assert.equal(grounded.status, "blocked");
      assert.equal(grounded.reason, "candidate_files_require_explicit_confirmation");
      assert.deepEqual(grounded.candidate_target_files, ["src/existing.ts"]);
      assert.deepEqual(grounded.target_files, []);
      assert.deepEqual(session.project.target_files, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prunes scaffold candidate facts when greenfield scope is grounded", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-grounding-scaffold-"));
    try {
      const approved = runDemandApprovedRuntime(taskcliDemandInput(root));
      approved.session.project.candidate_target_files = ["specs/tasks.md"];
      approved.session.project_facts.target_files = [
        { file: "specs/tasks.md", status: "candidate", source: "auto_scout_candidate" },
      ];
      approved.session.project_facts.candidate_target_files = ["specs/tasks.md"];

      const grounded = groundDemandExecutionScope(approved.session, { projectRoot: root });
      assert.equal(grounded.applied, true);
      assert.deepEqual(
        grounded.session.project_facts.target_files.map((fact) => fact.status),
        ["planned_new_file"],
      );
      assert.deepEqual(grounded.session.project_facts.candidate_target_files, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("brainstorm writes gsd-style demand artifact pack without business code", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-brainstorm-"));
    try {
      const result = runDemandBrainstormRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Build inventory stockout prevention for store managers.",
        target_users: ["store manager"],
        status_quo: ["Managers discover stockouts after customers complain."],
        assumptions: ["Thresholds are configurable per SKU."],
        success_criteria: ["Managers can see a low-stock alert before stockout."],
        non_goals: ["Do not change order import."],
        writeArtifacts: true,
      });

      assert.equal(result.demand_id.startsWith("DEMAND-"), true);
      assert.equal(existsSync(join(result.demand_dir, "VISION.md")), true);
      assert.equal(existsSync(join(result.demand_dir, "REQUIREMENTS.md")), true);
      assert.equal(existsSync(join(result.demand_dir, "CONTEXT.md")), true);
      assert.equal(existsSync(join(result.demand_dir, "ROADMAP.md")), true);
      assert.equal(existsSync(join(result.demand_dir, "SCENARIO_MATRIX.md")), true);
      assert.equal(result.session.nontechnical_intake.technical_terms_required_from_user, false);
      assert.equal(result.session.scenario_matrix.nontechnical_user_safe, true);
      assert.equal(result.guarantees.writes_business_code, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("brainstorm persists content-derived evidence requirements in session state", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-evidence-requirements-"));
    try {
      const result = runDemandBrainstormRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Create onboarding checklist copy modeled on https://example.com/checklist-guide.",
        target_users: ["freelance designer"],
        status_quo: ["Designers copy checklist items from old notes."],
        success_criteria: ["Designer sees checklist copy aligned to the external guide."],
        non_goals: ["No calendar sync."],
        writeArtifacts: true,
      });

      const read = readDemandSession(join(result.demand_dir, "session.json"));
      assert.equal(read.ok, true);
      assert.equal(read.session.evidence_requirements.length > 0, true);
      assert.equal(read.session.evidence_requirements[0].kind, "external");
      assert.equal(read.session.evidence_requirements[0].status, "pending");
      assert.equal(read.session.evidence_requirement_summary.pending > 0, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("discuss requires approval and compiles approved demand to L3 PRD", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-discuss-"));
    try {
      seedDemandTargetFiles(root, ["src/services/label-summary.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Build a label summary helper for support operators.",
        target_users: ["support operator"],
        status_quo: ["Operators manually trim and normalize labels before writing summaries."],
        evidence: ["Support notes show repeated label cleanup before handoff.", "The existing helper file is src/services/label-summary.ts."],
        assumptions: ["Labels arrive as short plain strings from the support form."],
        success_criteria: ["Operators get a trimmed label summary from one helper call."],
        constraints: ["Do not change ticket routing behavior."],
        non_goals: ["Do not build a label editor."],
        target_files: ["src/services/label-summary.ts"],
        decisions: ["Start with trimming whitespace and returning the normalized label text."],
        roadmap: ["MVP label summary helper."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      assert.equal(discuss.status, "success");
      assert.equal(discuss.readiness.readiness_level, "L3");
      const read = readDemandSession(join(discuss.demand_dir, "session.json"));
      assert.equal(read.ok, true);
      assert.equal(read.session.approval.approved, true);
      assert.equal(read.session.approval.effective_for_prd, true);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        base_commit: "abcdef0",
        writeArtifacts: true,
      });

      assert.equal(prd.status, "success");
      requirePrd(prd);
      assert.equal(prd.prd.base_commit, "abcdef0");
      assert.equal(prd.prd.demand.approval.effective_for_prd, true);
      assert.equal(prd.prd.execution_readiness.level, "L3");
      assert.equal(prd.prd.execution_readiness.atomic_tasks, true);
      assert.equal(prd.prd.demand.quality_report.status, "pass");
      assert.equal(prd.prd.demand.project_facts.target_files.every((fact) => fact.status === "verified"), true);
      assert.equal(prd.prd.demand.project_facts.assumptions.every((fact) => fact.status !== "needs_verification" && fact.status !== "contradicted"), true);
      assert.equal(prd.prd.demand.quality_report.dimensions.length, 6);
      assert.equal(prd.prd.execution_readiness.quality_report.total_score, prd.prd.demand.quality_report.total_score);
      assert.equal(prd.prd.tasks[0].handoff.type, "agent_brief");
      assert.equal(prd.prd.tasks[0].handoff.plain_language_goal.length > 0, true);
      const firstSession = assertTaskSessionPlan(prd.prd.tasks[0], prd.prd.demand.id);
      assert.equal(existsSync(join(root, firstSession.state_path)), false);
      assert.equal(existsSync(join(root, firstSession.handoff_path)), false);
      assert.equal(existsSync(join(root, firstSession.evidence_path)), false);
      assert.equal(prd.prd.execution_readiness.session_handoff.planned, true);
      assert.equal(prd.prd.execution_readiness.session_handoff.task_count, prd.prd.tasks.length);
      assert.equal(prd.prd.demand.atomicity_contract.session_handoff.session_count, prd.prd.tasks.length);

      const check = inspectYoloCheck({
        prdPath: prd.artifacts[0],
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeLifecycle: true,
      });
      assert.notEqual(check.checks.find((item) => item.name === "demand_contract").status, "blocked");
      const guard = inspectLifecycleGuard({
        command: "yolo-run",
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        prdPath: prd.artifacts[0],
      });
      assert.equal(guard.status, "pass", JSON.stringify(guard.blockers, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("PRD compilation stamps approval effective_for_prd from verified readiness", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-prd-effective-"));
    try {
      seedDemandTargetFiles(root, ["src/services/label-summary.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Build a label summary helper for support operators.",
        target_users: ["support operator"],
        status_quo: ["Operators manually trim and normalize labels before writing summaries."],
        evidence: ["Support notes show repeated label cleanup before handoff.", "The existing helper file is src/services/label-summary.ts."],
        assumptions: ["Labels arrive as short plain strings from the support form."],
        success_criteria: ["Operators get a trimmed label summary from one helper call."],
        constraints: ["Do not change ticket routing behavior."],
        non_goals: ["Do not build a label editor."],
        target_files: ["src/services/label-summary.ts"],
        decisions: ["Start with trimming whitespace and returning the normalized label text."],
        roadmap: ["MVP label summary helper."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });
      assert.equal(discuss.status, "success");
      assert.equal(discuss.readiness.executable_prd_ready, true);

      const read = readDemandSession(join(discuss.demand_dir, "session.json"));
      assert.equal(read.ok, true);
      delete read.session.approval.effective_for_prd;
      writeJson(join(discuss.demand_dir, "session.json"), read.session);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        base_commit: "abcdef0",
        writeArtifacts: true,
      });

      assert.equal(prd.status, "success", JSON.stringify(prd.blockers, null, 2));
      requirePrd(prd);
      assert.equal(prd.prd.demand.approval.approved, true);
      assert.equal(prd.prd.demand.approval.effective_for_prd, true);

      const check = inspectYoloCheck({
        prdPath: prd.artifacts[0],
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeLifecycle: false,
      });

      assert.equal(check.blockers.some((blocker) => blocker.code === "DEMAND_APPROVAL_NOT_EFFECTIVE_FOR_PRD"), false);
      assert.notEqual(check.checks.find((item) => item.name === "demand_contract").status, "blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand PRD quality gate blocks vague proof despite readiness passing", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-quality-proof-"));
    try {
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["ok"],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
        roadmap: ["MVP badge in inventory list."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });
      assert.equal(discuss.status, "success");
      assert.equal(discuss.readiness.executable_prd_ready, true);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      }) as DemandPrdResultForTest;

      assert.equal(prd.status, "blocked");
      assert.equal(prd.code, "DEMAND_QUALITY_BLOCKED");
      if ("prd" in prd) assert.equal(prd.prd, null);
      if ("quality_report" in prd && prd.quality_report) {
        assert.ok(prd.quality_report.blockers.some((blocker: { code: string }) => blocker.code === "QUALITY_SCENARIO_PROOF_CONCRETE"));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand PRD blocks unverified project field assumptions", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-field-grounding-"));
    try {
      mkdirSync(join(root, "src/pages"), { recursive: true });
      writeFileSync(join(root, "src/pages/inventory-list.tsx"), "export function InventoryList({ items }) { return items.map((item) => item.quantity).join(','); }\n", "utf8");
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory list already receives quantity and threshold fields."],
        success_criteria: ["Inventory list displays a visible low-stock badge on affected SKUs."],
        proof: ["A store manager can point to the low-stock badge on an affected SKU."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with an inline badge labelled 'Low stock' after the SKU."],
        roadmap: ["MVP badge in inventory list."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      assert.equal(discuss.readiness.status, "blocked");
      assert.equal(discuss.session.approval.approved, true);
      assert.equal(discuss.session.approval.effective_for_prd, false);
      assert.ok(discuss.session.approval.blocked_by.some((blocker) => blocker.code === "PROJECT_FACTS_GROUNDED"));
      assert.ok(discuss.readiness.blockers.some((blocker) => blocker.code === "PROJECT_FACTS_GROUNDED"));
      assert.ok(discuss.readiness.blockers.some((blocker) => (
        blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_CONTRADICTED_ASSUMPTION_BLOCKED")
        || blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_FIELD_ASSUMPTION_VERIFIED")
      )));

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.ok(prd.blockers.some((blocker) => (
        blocker.code === "PROJECT_FACTS_GROUNDED"
        || blocker.code === "QUALITY_FIELD_ASSUMPTION_VERIFIED"
        || blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_FIELD_ASSUMPTION_VERIFIED")
        || blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_CONTRADICTED_ASSUMPTION_BLOCKED")
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand PRD blocks unresolved conditional UI style source", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-conditional-style-"));
    try {
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Agent read src/pages/inventory-list.tsx and confirmed inventory rows expose item.quantity and item.lowStockThreshold."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays an inline 'Low stock' badge after the SKU when item.quantity <= item.lowStockThreshold."],
        proof: ["A screenshot or component test shows an inline 'Low stock' badge after the SKU when item.quantity <= item.lowStockThreshold."],
        visual_style: ["Use an existing project badge component if one is present; otherwise use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Show an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
        roadmap: ["MVP badge in inventory list."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      const grounding = discuss.readiness.blockers.find((blocker) => blocker.code === "PROJECT_FACTS_GROUNDED");
      assert.equal(discuss.readiness.status, "blocked");
      assert.equal(discuss.session.approval.effective_for_prd, false);
      assert.ok(grounding?.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_UI_STYLE_SOURCE_RESOLVED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("auto-scouted files stay candidates until user or evidence verifies scope", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-candidate-scope-"));
    try {
      seedDemandTargetFiles(root, ["src/inventory-list.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Update `inventory-list` service so store managers get low-stock alert calculations.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        success_criteria: ["Inventory list service returns a low-stock signal when item.quantity <= item.lowStockThreshold."],
        proof: ["A service-level test can show the low-stock rule returns true for affected SKUs."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        decisions: ["Start with the existing inventory-list service file and add the threshold rule there."],
        roadmap: ["MVP low-stock service rule."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      assert.deepEqual(discuss.session.project.target_files, []);
      assert.ok(discuss.session.project.candidate_target_files.includes("src/inventory-list.ts"));
      assert.equal(discuss.readiness.executable_prd_ready, false);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      const grounding = (prd as DemandPrdResultForTest).grounding;
      assert.equal(grounding?.reason, "candidate_files_require_explicit_confirmation");
      assert.deepEqual(grounding?.candidate_target_files, ["src/inventory-list.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand blocks target files outside the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-target-boundary-"));
    const outsideFile = `${root}-outside.js`;
    try {
      writeFileSync(outsideFile, "export const lowStockThreshold = 3;\n", "utf8");
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers a low-stock signal.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: [`Agent read ${outsideFile} and claims it is the target file.`],
        assumptions: [
          "The implementation file must remain inside the target project root.",
          "The selected implementation file exposes lowStockThreshold.",
        ],
        success_criteria: ["Inventory list displays a visible low-stock signal."],
        proof: ["A test verifies the low-stock signal is visible."],
        visual_style: ["Use current project styling."],
        constraints: ["Do not read or modify files outside this project."],
        non_goals: ["Do not change order import behavior."],
        target_files: [outsideFile],
        decisions: ["Keep execution scope confined to the project root."],
        roadmap: ["MVP low-stock signal."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      const targetFact = discuss.session.project_facts.target_files.find((fact) => fact.file === outsideFile);
      assert.equal(discuss.status, "blocked");
      assert.deepEqual(discuss.session.project.target_files, []);
      assert.equal(targetFact.status, "invalid_scope");
      const outsideAssumption = discuss.session.project_facts.assumptions
        .filter(isAssumptionFact)
        .find((fact) => /lowStockThreshold/.test(textValue(fact.text)));
      assert.notEqual(outsideAssumption.status, "verified");
      assert.equal(outsideAssumption.verified_by?.includes("project_read"), false);
      assert.equal(discuss.readiness.blockers.some((blocker) => (
        blocker.code === "PROJECT_FACTS_GROUNDED"
        && blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_TARGET_FILE_WITHIN_PROJECT")
      )), true);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });
      assert.equal(prd.status, "blocked");
      assert.equal(prd.blockers.some((blocker) => (
        blocker.code === "PROJECT_FACTS_GROUNDED"
        || blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_TARGET_FILE_WITHIN_PROJECT")
      )), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outsideFile, { force: true });
    }
  });

  test("legacy demand readiness blocks raw target files outside the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-legacy-target-boundary-"));
    const outsideFile = `${root}-outside.js`;
    try {
      writeFileSync(outsideFile, "export const outsideProject = true;\n", "utf8");
      const readiness = inspectDemandReadiness({
        phase: "prd",
        vision: {
          statement: "Show store managers a clear low-stock signal.",
          target_users: ["store manager"],
          status_quo: ["Managers only see raw counts."],
        },
        reflection: {
          assumptions: ["Scope must stay inside the project root."],
        },
        investigation: {
          evidence: ["Existing project files were reviewed."],
        },
        requirements: {
          active: [{
            id: "REQ-1",
            text: "Inventory list displays a visible low-stock signal.",
            acceptance_scenarios: [{ then: "The low-stock signal is visible." }],
          }],
          out_of_scope: ["No backend changes."],
        },
        scenario_matrix: {
          scenarios: [{
            id: "SCN-1",
            proof: "A test verifies the low-stock signal.",
            surfaces: [{
              id: "SFC-1",
              target_files: [outsideFile],
              session_budget: { max_files: 1 },
            }],
          }],
        },
        approval: { approved: true },
        project: { target_files: [outsideFile] },
        roadmap: { mvp: ["MVP low-stock signal."] },
      }, { phase: "prd", projectRoot: root });

      assert.equal(readiness.status, "blocked");
      assert.equal(readiness.blockers.some((blocker) => (
        blocker.code === "PROJECT_FACTS_GROUNDED"
        && blocker.fact_grounding_issues?.some((issue) => issue.code === "QUALITY_TARGET_FILE_WITHIN_PROJECT")
      )), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outsideFile, { force: true });
    }
  });

  test("inspectDemandQuality flags missing proof handoff and atomicity gaps", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-quality-pure-"));
    try {
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["A store manager can point to the low-stock badge on an affected SKU."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
        roadmap: ["MVP badge in inventory list."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });
      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });
      assert.equal(prd.status, "success");
      requirePrd(prd);

      const clone = (value) => JSON.parse(JSON.stringify(value));
      const passAtomicity = { status: "pass", blockers: [], warnings: [] };

      const proofless = clone(discuss.session);
      proofless.scenario_matrix.scenarios[0].proof = "";
      proofless.scenario_matrix.scenarios[0].surfaces[0].proof = "";
      const proofQuality = inspectDemandQuality(proofless, {
        phase: "prd",
        tasks: prd.prd.tasks,
        atomicity: passAtomicity,
        requireTasks: true,
      });
      assert.equal(proofQuality.status, "blocked");
      assert.ok(proofQuality.blockers.some((blocker) => blocker.code === "QUALITY_SCENARIO_PROOF_CONCRETE"));

      const missingHandoffTasks = clone(prd.prd.tasks);
      delete missingHandoffTasks[0].handoff;
      const handoffQuality = inspectDemandQuality(discuss.session, {
        phase: "prd",
        tasks: missingHandoffTasks,
        atomicity: passAtomicity,
        requireTasks: true,
      });
      assert.equal(handoffQuality.status, "blocked");
      assert.ok(handoffQuality.blockers.some((blocker) => blocker.code === "QUALITY_TASK_HANDOFF_COMPLETE"));

      const missingSessionPlanTasks = clone(prd.prd.tasks);
      delete missingSessionPlanTasks[0].handoff.session;
      const sessionPlanQuality = inspectDemandQuality(discuss.session, {
        phase: "prd",
        tasks: missingSessionPlanTasks,
        atomicity: passAtomicity,
        requireTasks: true,
      });
      assert.equal(sessionPlanQuality.status, "blocked");
      assert.ok(sessionPlanQuality.blockers.some((blocker) => blocker.code === "QUALITY_TASK_SESSION_PLAN_COMPLETE"));

      const atomicityQuality = inspectDemandQuality(discuss.session, {
        phase: "prd",
        tasks: prd.prd.tasks,
        atomicity: {
          status: "blocked",
          blockers: [{ code: "ATOMIC_TASK_TOO_COARSE", task_id: prd.prd.tasks[0].id }],
          warnings: [],
        },
        requireTasks: true,
      });
      assert.equal(atomicityQuality.status, "blocked");
      assert.ok(atomicityQuality.blockers.some((blocker) => blocker.code === "QUALITY_ATOMIC_DOCTOR_PASSED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("interview trace is preserved into approved-demand PRD tasks", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-interview-"));
    try {
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["A store manager can point to the badge on a low-stock SKU."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        exceptions: ["What if the inventory system is down?"],
        decisions: ["Show an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
        roadmap: ["MVP badge in inventory list."],
        interview: {
          question_trace: [
            {
              id: "Q-STOCKOUT-PROOF",
              question: "How will the manager know the change worked?",
              answer: "They can point to a low-stock badge before the item sells out.",
            },
          ],
          prd_intake: {
            desired_outcomes: ["Managers see the warning in the inventory list."],
            success_proof: ["Visible badge on low-stock SKU."],
          },
          approval_reason: "Business owner confirmed this is enough for MVP.",
        },
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      assert.equal(discuss.status, "success");
      assert.equal(traceId(discuss.session.question_trace[0]), "Q-STOCKOUT-PROOF");
      assert.equal(discuss.session.prd_intake.question_ids.includes("Q-STOCKOUT-PROOF"), true);
      assert.equal(discuss.session.approval_reason, "Business owner confirmed this is enough for MVP.");
      assert.equal(discuss.session.scenario_matrix.scenarios[0].source_question_ids.includes("Q-STOCKOUT-PROOF"), true);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        base_commit: "abcdef0",
        writeArtifacts: false,
      });

      assert.equal(prd.status, "success");
      requirePrd(prd);
      assert.equal(prd.prd.base_commit, "abcdef0");
      assert.equal(traceId(prd.prd.demand.question_trace[0]), "Q-STOCKOUT-PROOF");
      assert.equal(prd.prd.tasks[0].source_question_ids.includes("Q-STOCKOUT-PROOF"), true);
      assert.equal(prd.prd.tasks[0].handoff.source_question_ids.includes("Q-STOCKOUT-PROOF"), true);
      assert.equal(typeof prd.prd.tasks[0].verification_hint, "string");
      assert.equal(prd.prd.tasks[0].verification_hint.length > 0, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand UI PRDs include UI readiness fields and pass yolo check with an adapter", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-ui-check-"));
    try {
      writeJson(join(root, ".yolo", "adapters", "local-browser.manifest.json"), acceptanceAdapterManifest());
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts in the inventory list."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["A store manager can point to the low-stock badge on an affected SKU."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
        roadmap: ["MVP badge in inventory list."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });
      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        base_commit: "abcdef0",
        writeArtifacts: true,
      });

      assert.equal(prd.status, "success");
      requirePrd(prd);
      const uiTask = prd.prd.tasks.find((task) => task.handoff?.surface?.kind === "ui");
      assert.ok(uiTask);
      assert.ok(Array.isArray(uiTask.state_matrix) && uiTask.state_matrix.length > 0);
      assert.ok(Array.isArray(uiTask.evidence_plan) && uiTask.evidence_plan.length > 0);
      assert.equal(Array.isArray(uiTask.handoff.state_matrix), true);
      assert.equal(Array.isArray(uiTask.handoff.evidence_plan), true);

      const check = inspectYoloCheck({
        prdPath: prd.artifacts[0],
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeLifecycle: false,
      });

      assert.notEqual(check.status, "blocked", JSON.stringify(check.blockers, null, 2));
      assert.equal(check.checks.find((item) => item.name === "ui_readiness").status, "pass");
      assert.equal(check.blockers.some((blocker) => blocker.code === "UI_STATE_MATRIX_MISSING"), false);
      assert.equal(check.blockers.some((blocker) => blocker.code === "UI_EVIDENCE_PLAN_MISSING"), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand PRD compilation blocks before requirements confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-blocked-"));
    try {
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Build alerts",
        target_users: ["operator"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });
      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: true,
      });

      assert.equal(prd.status, "blocked");
      assert.ok(prd.blockers.some((blocker) => blocker.code === "REQUIREMENTS_PRESENT"));
      assert.equal(prd.artifacts.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand PRD blocks surfaces with oversized session budget", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-budget-"));
    try {
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx", "src/services/inventory-alerts.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx", "src/services/inventory-alerts.ts"],
        decisions: ["Start with one threshold rule item.quantity <= item.lowStockThreshold and one inline badge labelled 'Low stock'."],
        roadmap: ["MVP service rule and list badge."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });
      assert.equal(discuss.status, "success");

      discuss.session.scenario_matrix.scenarios[0].surfaces[0].session_budget.max_files = 3;
      writeFileSync(join(discuss.demand_dir, "session.json"), `${JSON.stringify(discuss.session, null, 2)}\n`, "utf8");

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.ok(prd.blockers.some((blocker) => blocker.code === "SURFACE_SESSION_BUDGET_EXECUTABLE"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved demand compiles scenario surfaces without self-blocking on investigate-first atomicity", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-atomic-"));
    try {
      seedDemandTargetFiles(root, ["src/services/inventory-alerts.ts", "src/pages/inventory-list.tsx", "src/services/inventory-alerts.test.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts in a spreadsheet-like list."],
        evidence: ["Weekly support tickets mention surprise stockouts."],
        assumptions: ["Existing inventory service already returns item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory service marks low-stock SKUs.", "Inventory list displays a visible low-stock badge."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/services/inventory-alerts.ts", "src/pages/inventory-list.tsx", "src/services/inventory-alerts.test.ts"],
        decisions: ["Start with one threshold rule item.quantity <= item.lowStockThreshold and one inline badge labelled 'Low stock'."],
        deferred: ["Forecasting and supplier ordering remain later demands."],
        deferred_scope_confirmed: true,
        roadmap: ["MVP service rule and list badge."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        config: { build: { test: "cargo test", type_check: "cargo check", build: "cargo build" } },
        writeArtifacts: false,
      });

      assert.equal(prd.status, "success", JSON.stringify(prd.blockers, null, 2));
      assert.equal(prd.code, "DEMAND_PRD_READY");
      requirePrd(prd);
      assert.equal(prd.preflight.status, "pass", JSON.stringify(prd.preflight.blocked_reasons, null, 2));
      assert.equal(prd.blockers.some((blocker) => blocker.code === "ATOMICITY_INVESTIGATE_FIRST"), false);
      const prdPath = join(root, "inventory-demand-prd.json");
      writeJson(join(root, ".yolo/adapters/local-browser.manifest.json"), acceptanceAdapterManifest());
      writeJson(prdPath, prd.prd);
      const check = inspectYoloCheck({
        prdPath,
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        writeLifecycle: false,
      });
      assert.equal(check.status, "pass", JSON.stringify(check.blockers, null, 2));
      assert.equal(check.blockers.some((blocker) => blocker.code === "ATOMICITY_INVESTIGATE_FIRST"), false);
      const compiledPrd = prd.prd;
      assert.equal(compiledPrd.tasks.length >= 3, true);
      assert.equal(compiledPrd.tasks[0].task_kind, "greenfield_scaffold");
      const businessTasks = compiledPrd.tasks.filter((task) => task.task_kind !== "greenfield_scaffold");
      assert.equal(businessTasks.every((task) => task.task_kind === "demand_atomic_task"), true);
      assert.equal(businessTasks.every((task) => task.scope.max_files <= 2), true);
      assert.equal(businessTasks.every((task) => Boolean(task.handoff.proof)), true);
      assert.equal(compiledPrd.demand.approval.approved_at !== null, true);
      assert.ok(compiledPrd.demand.deferred_scope.includes("Forecasting and supplier ordering remain later demands."));
      assert.equal(compiledPrd.demand.deferred_scope_confirmation.confirmed, true);
      assert.equal(compiledPrd.demand.deferred_follow_up.required, true);
      assert.ok(compiledPrd.demand.deferred_follow_up.next_session_prompt.includes("Forecasting and supplier ordering"));
      assert.ok(businessTasks.every((task) => task.handoff.deferred_scope.includes("Forecasting and supplier ordering remain later demands.")));
      assert.ok(businessTasks.every((task) => task.handoff.deferred_scope_confirmation.confirmed === true));
      assert.ok(businessTasks.every((task) => task.handoff.deferred_follow_up.required === true));
      assert.equal(businessTasks.some((task) => task.handoff.surface.kind === "ui"), true);
      assert.equal(businessTasks.some((task) => task.handoff.surface.kind === "service"), true);
      assert.equal(businessTasks.some((task) => task.handoff.surface.kind === "test"), true);
      const serviceTask = businessTasks.find((task) => task.handoff.surface.kind === "service");
      const testTask = businessTasks.find((task) => task.handoff.surface.kind === "test");
      assert.ok(testTask.depends_on.includes(serviceTask.id));
      assert.ok(testTask.handoff.read_first.includes("src/services/inventory-alerts.ts"));
      assert.ok(testTask.post_conditions.some((condition) => condition.type === "tests_pass" && condition.severity === "FAIL"));
      assert.ok(testTask.post_conditions.some((condition) =>
        condition.type === "tests_pass" && condition.params?.command === "cargo test"
      ));
      assert.equal(compiledPrd.tasks.every((task) => task.post_conditions.some((condition) => condition.severity === "FAIL" && condition.type !== "acceptance_criteria")), true);
      for (const task of compiledPrd.tasks) {
        assertTaskSessionPlan(task, compiledPrd.demand.id);
      }
      const handoffStats = compiledPrd.execution_readiness.session_handoff;
      assert.equal(handoffStats.planned, true);
      assert.equal(handoffStats.task_count, compiledPrd.tasks.length);
      assert.equal(handoffStats.session_count, compiledPrd.tasks.length);
      assert.equal(handoffStats.tasks_with_session_plan, compiledPrd.tasks.length);
      assert.equal(handoffStats.state_paths.length, compiledPrd.tasks.length);
      assert.equal(handoffStats.handoff_paths.length, compiledPrd.tasks.length);
      assert.equal(handoffStats.evidence_paths.length, compiledPrd.tasks.length);
      assert.equal(handoffStats.memory_update_paths.includes(".yolo/memory/CURRENT_HANDOFF.md"), true);
      assert.equal(handoffStats.memory_update_paths.includes(".yolo/state/session-memory.jsonl"), true);
      assert.equal(handoffStats.progress_update_paths.includes(".yolo/memory/PROGRESS.md"), true);
      assert.deepEqual(compiledPrd.demand.atomicity_contract.session_handoff, handoffStats);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("R2 dogfood demand generates machine-verifiable gates and a greenfield scaffold first task", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-r2-gitweekly-"));
    try {
      const demandDir = seedDogfoodGitweeklyR2Fixture(root);

      const result = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: demandDir,
        writeArtifacts: false,
      });

      assert.equal(result.status, "success", JSON.stringify(result.blockers, null, 2));
      requirePrd(result);
      assert.equal(result.preflight.status, "pass", JSON.stringify(result.preflight.blocked_reasons, null, 2));

      const compiledPrd = result.prd;
      const tasks = requirePrdTasks(compiledPrd);
      assert.equal(nakedManualAcceptancePostConditions(compiledPrd).length, 0, "auto-verifiable R2 demand must not emit naked prose acceptance_criteria post_conditions");
      assert.equal(prdTraceEvidenceCount(compiledPrd) > 0, true, "R2 PRD should retain demand evidence trace");

      const scaffold = tasks[0];
      const scaffoldExpectedOutput = Array.isArray(scaffold.expected_output) ? scaffold.expected_output : [];
      assert.equal(scaffold.task_kind, "greenfield_scaffold");
      assertNodeScaffoldToolchain(scaffold);
      assert.equal(scaffold.scope?.targets?.some((target) => target.file === "package.json"), true);
      assert.equal(scaffold.scope?.targets?.some((target) => target.file === ".npmrc"), true);
      assert.ok((scaffold.scope?.targets?.length || 0) <= 2);
      assert.ok(scaffoldExpectedOutput.includes(".npmrc"));
      assert.match(scaffoldInstructionText(scaffold), /@types\/node/);
      assert.match(scaffoldInstructionText(scaffold), /package-lock=false/);
      assert.doesNotMatch(scaffoldInstructionText(scaffold), /src\/\*\*\/\*\.ts/);
      assert.match(scaffoldInstructionText(scaffold), /src\/\*\.ts/);
      assert.ok(scaffold.post_conditions.some((condition) =>
        condition.type === "file_exists" && condition.params?.file === "package.json"
      ));
      assert.ok(scaffold.post_conditions.some((condition) =>
        condition.type === "code_contains" && condition.params?.file === ".npmrc" && condition.params?.text === "package-lock=false"
      ));
      assert.ok(scaffold.post_conditions.some((condition) =>
        condition.type === "code_contains" && condition.params?.file === "package.json" && condition.params?.text === "\"@types/node\""
      ));
      assert.ok(scaffold.post_conditions.some((condition) =>
        condition.type === "file_not_exists" && condition.params?.file === "package-lock.json"
      ));
      assert.ok(scaffold.post_conditions.some((condition) =>
        condition.type === "file_not_exists" && condition.params?.file === "tsconfig.json"
      ));
      assert.ok(scaffold.post_conditions.some((condition) =>
        condition.type === "tests_pass" && condition.severity === "FAIL"
      ));

      const downstreamTypeOrTestTasks = tasks.slice(1).filter((task) =>
        task.post_conditions.some((condition) => ["no_new_type_errors", "tests_pass", "test_file_passes"].includes(String(condition.type)))
      );
      const machineTestGates = tasks.slice(1).flatMap((task) =>
        task.post_conditions.filter((condition) => condition.type === "tests_pass")
      );
      const machineTestTasks = tasks.slice(1).filter((task) =>
        task.post_conditions.some((condition) => condition.type === "tests_pass" && condition.params?.require_tests === true)
      );
      assert.equal(machineTestGates.length > 0, true);
      assert.equal(machineTestGates.every((condition) => condition.params?.require_tests === true), true, "automated acceptance test gates must reject empty test suites");
      assert.equal(machineTestTasks.every((task) =>
        task.scope.targets.some((target) => /(^|\/)tests?\//.test(target.file) || /\.test\./.test(target.file))
      ), true, "require_tests gates must give the executor an in-scope test file to create or update");
      assert.equal(machineTestTasks.every((task) => Number(task.scope.max_files || 0) >= task.scope.targets.length), true);
      const testGeneration = (task) => task.test_generation as { mode?: string; allowed_test_files?: string[] } | undefined;
      assert.equal(machineTestTasks.every((task) => testGeneration(task)?.mode === "add_minimal"), true);
      assert.equal(machineTestTasks.every((task) =>
        task.scope.targets.every((target) => testGeneration(task)?.allowed_test_files?.includes(target.file))
      ), true, "synthetic acceptance test tasks must allowlist their target test file");
      const syntheticAcceptance = machineTestTasks.find((task) => task.id === "DEMAND-AUTOMATED-ACCEPTANCE-TEST-001");
      assert.ok(syntheticAcceptance, "R2 dogfood PRD must include a synthetic acceptance task");
      const syntheticAcceptanceText = [
        scaffoldInstructionText(syntheticAcceptance),
        JSON.stringify(syntheticAcceptance.handoff || {}),
      ].join("\n");
      assert.match(syntheticAcceptanceText, /spawnSync/);
      assert.match(syntheticAcceptanceText, /git init/);
      assert.match(syntheticAcceptanceText, /--repo/);
      assert.match(syntheticAcceptanceText, /--output/);
      assert.match(syntheticAcceptanceText, /bad repo/i);
      for (const requiredText of ["spawnSync", "--repo", "--since", "--until", "--output", "bad repo", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]) {
        assert.ok(syntheticAcceptance.post_conditions.some((condition) =>
          condition.type === "code_contains" &&
          condition.params?.file === "test/cli-git-weekly.test.ts" &&
          condition.params?.text === requiredText
        ), `synthetic acceptance task must gate test file on ${requiredText}`);
      }
      const gitInitCondition = syntheticAcceptance.post_conditions.find((condition) =>
        condition.type === "code_matches" &&
        condition.params?.file === "test/cli-git-weekly.test.ts" &&
        String(condition.params?.pattern || condition.params?.text || "").includes("init")
      );
      assert.ok(gitInitCondition, "synthetic acceptance task must gate argv-style git init calls");
      const gitInitPattern = String(gitInitCondition.params?.pattern || gitInitCondition.params?.text || "");
      assert.match('spawnSync("git", ["init"], { cwd: repo });', new RegExp(gitInitPattern));
      const addedStatsCondition = syntheticAcceptance.post_conditions.find((condition) =>
        condition.type === "code_matches" && String(condition.message || "").includes("numeric added lines")
      );
      const deletedStatsCondition = syntheticAcceptance.post_conditions.find((condition) =>
        condition.type === "code_matches" && String(condition.message || "").includes("numeric deleted lines")
      );
      assert.ok(addedStatsCondition, "synthetic acceptance task must gate concrete added-line assertions");
      assert.ok(deletedStatsCondition, "synthetic acceptance task must gate concrete deleted-line assertions");
      const addedStatsPattern = String(addedStatsCondition.params?.pattern || addedStatsCondition.params?.text || "");
      const deletedStatsPattern = String(deletedStatsCondition.params?.pattern || deletedStatsCondition.params?.text || "");
      assert.doesNotMatch("assert.ok(result.stdout.includes('Lines Added:'));", new RegExp(addedStatsPattern));
      assert.doesNotMatch("assert.ok(result.stdout.includes('Lines Deleted:'));", new RegExp(deletedStatsPattern));
      assert.match("assert.match(stdout, /Lines Added:\\s*[1-9]/);", new RegExp(addedStatsPattern));
      assert.match("assert.match(stdout, /Lines Deleted:\\s*[1-9]/);", new RegExp(deletedStatsPattern));
      assert.equal(downstreamTypeOrTestTasks.length > 0, true);
      assert.equal(downstreamTypeOrTestTasks.every((task) => task.depends_on.includes(scaffold.id)), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("R4-shaped git-weekly demand regenerates a self-consistent zero-dependency scaffold", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-r4-gitweekly-"));
    try {
      const discuss = runDemandDiscussRuntime({
        ...taskcliDemandInput(root),
        demand_id: "DEMAND-R4-GIT-WEEKLY",
        title: "git-weekly",
        idea: "Build git-weekly, a local Node.js CLI that summarizes git commits into Markdown.",
        evidence: ["R4 dogfood showed the scaffold task created a vitest script without installing vitest."],
        success_criteria: ["npm test verifies stdout markdown and --output file markdown for a deterministic fixture repository."],
        proof: ["Automated node:test coverage verifies author sections, conventional type counts, commit totals, line stats, and output parity."],
        non_goals: ["No network calls, no GitHub API, no GUI, and no npm publishing."],
        decisions: ["Use node:test as the default zero-dependency test runner."],
      });

      const result = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(result.status, "success", JSON.stringify(result.blockers, null, 2));
      requirePrd(result);
      const scaffold = requirePrdTasks(result.prd)[0];
      assert.equal(scaffold.task_kind, "greenfield_scaffold");
      assertNodeScaffoldToolchain(scaffold);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("git-weekly exact proof is carried into synthetic acceptance gates", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-gitweekly-exact-proof-"));
    try {
      const discuss = runDemandDiscussRuntime({
        ...taskcliDemandInput(root),
        demand_id: "DEMAND-GIT-WEEKLY-EXACT-PROOF",
        title: "git-weekly",
        idea: "Build git-weekly, a local Node.js CLI that summarizes git commits into Markdown.",
        target_users: ["engineering lead preparing a weekly local repository report"],
        success_criteria: [
          "npm test creates a fixture git repository and verifies stdout markdown, --output file writing, author commit list, conventional commit stats, Total commits: 2, Added lines, Deleted lines, and bad --repo nonzero exit.",
        ],
        proof: [
          "The fixture has fixed commit dates in 2026-06-01 to 2026-06-07, Alice makes a feat commit and Bob makes a fix commit; tests assert Alice, Bob, Total commits: 2, feat/fix counts, and numeric added/deleted line stats.",
        ],
        non_goals: ["No network calls, no GitHub API, no GUI, and no npm publishing."],
        decisions: ["Use node:test and spawnSync for CLI acceptance coverage."],
      });

      const result = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(result.status, "success", JSON.stringify(result.blockers, null, 2));
      requirePrd(result);
      const syntheticAcceptance = requirePrdTasks(result.prd).find((task) => task.id === "DEMAND-AUTOMATED-ACCEPTANCE-TEST-001");
      assert.ok(syntheticAcceptance, "exact git-weekly demand must include synthetic acceptance");
      const syntheticAcceptanceText = [
        scaffoldInstructionText(syntheticAcceptance),
        JSON.stringify(syntheticAcceptance.handoff || {}),
      ].join("\n");
      assert.match(syntheticAcceptanceText, /concrete proof values/);
      for (const requiredText of ["Alice", "Bob", "GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]) {
        assert.ok(syntheticAcceptance.post_conditions.some((condition) =>
          condition.type === "code_contains" &&
          condition.params?.text === requiredText
        ), `synthetic acceptance task must gate test file on ${requiredText}`);
      }
      const totalCondition = syntheticAcceptance.post_conditions.find((condition) =>
        condition.type === "code_matches" && String(condition.message || "").includes("Total commits: 2")
      );
      assert.ok(totalCondition, "synthetic acceptance task must gate exact commit total assertions");
      const totalPattern = String(totalCondition.params?.pattern || totalCondition.params?.text || "");
      assert.match("assert.match(stdout, /Total Commits:\\s*2/);", new RegExp(totalPattern));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("generated task instruction assertion rejects uninstalled vitest references", () => {
    assert.throws(
      () => assertGeneratedTaskInstructionsSelfConsistent([{ id: "TASK-BAD-VITEST", instructions: ["Create package.json with a test script that runs vitest run."] }]),
      /vitest/,
    );
  });

  test("approved demand splits compound board-style user stories before task generation", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-story-split-"));
    try {
      seedDemandTargetFiles(root, ["package.json", "index.html", "src/styles.css", "tests/board.e2e.cjs"]);
      writeProjectFile(root, "src/app.js", [
        "const STORAGE_KEY = 'yolo-board-state';",
        "export function loadBoard() { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }",
        "export function saveBoard(board) { localStorage.setItem(STORAGE_KEY, JSON.stringify(board)); }",
        "",
      ].join("\n"));
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Build a local board MVP.",
        target_users: ["small team lead"],
        status_quo: ["Tasks are tracked in notes and chat messages."],
        evidence: [
          "Agent read src/app.js and verified it already uses localStorage through loadBoard and saveBoard.",
          "Agent read src/styles.css and tests/board.e2e.cjs as the board layout and Playwright coverage entry points.",
        ],
        assumptions: ["The local MVP can stay single-user and does not need collaboration, auth, comments, or labels."],
        success_criteria: [
          "当用户输入 Review 并提交时, 新列表 Review 出现在看板末尾, 当用户在 Todo 输入 Prepare demo 并提交时, 卡片显示在 Todo 列表。",
          "当用户把 Prepare demo 编辑为 Prepare customer demo 时, 新标题可见；当用户将 Prepare customer demo 移动到 Doing 时, Todo 列表不再显示该卡片, Doing 列表显示 Prepare customer demo。",
          "当用户归档 Prepare customer demo 时, 普通列表不显示该归档卡片；当用户刷新页面时, 未归档列表和卡片仍从 localStorage 恢复。",
        ],
        proof: [
          "Playwright verifies Review appears as the final board list after submitting the list form.",
          "Playwright verifies Prepare demo appears inside the Todo list after submitting the card form.",
          "Playwright verifies Prepare demo changes to Prepare customer demo after editing the card title.",
          "Playwright verifies Prepare customer demo appears in Doing and no longer appears in Todo after moving it.",
          "Playwright verifies the archived Prepare customer demo card is hidden from normal lists.",
          "Playwright reloads the page and verifies unarchived lists and cards restore from localStorage.",
        ],
        visual_style: ["Use the existing compact board layout from src/styles.css without introducing a new visual system."],
        constraints: ["Local single-page MVP only."],
        non_goals: ["No external API or login."],
        target_files: ["package.json", "index.html", "src/app.js", "src/styles.css", "tests/board.e2e.cjs"],
        decisions: ["Keep every task to one visible board behavior."],
        roadmap: ["MVP board behavior slices."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      assert.equal(discuss.status, "success");
      const scenarios = discuss.session.scenario_matrix.scenarios;
      assert.equal(scenarios.length, 6);
      assert.equal(scenarios.some((scenario) => scenario.requirement_id === "REQ-001-S01"), true);
      assert.equal(scenarios.some((scenario) => scenario.requirement_id === "REQ-002-S02"), true);
      assert.equal(scenarios.every((scenario) => !(/新增列表/.test(textValue(scenario.desired_behavior)) && /新增卡片|卡片显示/.test(textValue(scenario.desired_behavior)))), true);
      assert.equal(scenarios.every((scenario) => !(/编辑/.test(textValue(scenario.desired_behavior)) && /移动/.test(textValue(scenario.desired_behavior)))), true);
      assert.equal(scenarios.every((scenario) => !(/(?<!未)归档/u.test(textValue(scenario.desired_behavior)) && /刷新|重新加载|恢复/.test(textValue(scenario.desired_behavior)))), true);
      assert.match(textValue(discuss.session.scenario_matrix.atomic_task_rule), /one user-visible story/);

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.equal(prd.code, "DEMAND_PRD_PREFLIGHT_BLOCKED");
      if ("prd" in prd) assert.equal(prd.prd, null);
      assert.ok(prd.blockers.some((blocker) => blocker.code === "ATOMICITY_INVESTIGATE_FIRST"));
      if (!("compiled" in prd) || !prd.compiled) throw new Error("expected compiled");
      const compiledPrd = prd.compiled.prd;
      assert.equal(compiledPrd.tasks.some((task) => task.requirement_ids.includes("REQ-003-S02")), true);
      assert.equal(compiledPrd.tasks.every((task) => !(/编辑/.test(textValue(task.description)) && /移动/.test(textValue(task.description)))), true);
      assert.match(textValue(compiledPrd.demand.atomicity_contract.rule), /one user-visible story/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved-demand PRD blocks deferred scope without explicit confirmation", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-deferred-confirm-"));
    try {
      seedDemandTargetFiles(root, ["src/api/orders.ts", "src/api/orders.test.ts"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        idea: "Reject negative order line quantities for operations admins.",
        target_users: ["operations admin"],
        status_quo: ["Order validation checks customer but not invalid line quantities."],
        evidence: ["src/api/orders.ts reads input.lines as the order line payload and declares ORDER_LINE_QUANTITY_FIELD = 'quantity'."],
        assumptions: ["Order line quantities are present as input.lines[].quantity."],
        success_criteria: ["validateOrder returns ok:false with error code NEGATIVE_QUANTITY when any input.lines[].quantity < 0."],
        proof: ["A regression test calls validateOrder with input.lines[].quantity < 0 and observes ok:false plus error code NEGATIVE_QUANTITY."],
        constraints: ["Do not change fulfillment integration."],
        non_goals: ["Do not redesign order creation UI."],
        target_files: ["src/api/orders.ts", "src/api/orders.test.ts"],
        decisions: ["Add negative quantity validation only."],
        deferred: ["Zero quantity validation is deferred.", "Inventory availability checks are deferred."],
        roadmap: ["MVP negative quantity validation."],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      assert.equal(discuss.session.discussion.deferred_scope_confirmation.required, true);
      assert.equal(discuss.session.discussion.deferred_scope_confirmation.confirmed, false);
      assert.equal(discuss.session.approval.approved, true);
      assert.equal(discuss.session.approval.effective_for_prd, false);
      assert.ok(discuss.readiness.blockers.some((blocker) => blocker.code === "DEFERRED_SCOPE_CONFIRMED"));

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "blocked");
      assert.ok(prd.blockers.some((blocker) => blocker.code === "DEFERRED_SCOPE_CONFIRMED"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("task session handoff paths preserve non-ASCII demand ids", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-cjk-"));
    try {
      seedDemandTargetFiles(root, ["src/pages/inventory-list.tsx"]);
      const discuss = runDemandDiscussRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demand_id: "DEMAND-20260529-库存预警",
        idea: "Show store managers low-stock alerts in the inventory list.",
        target_users: ["store manager"],
        status_quo: ["Managers only see raw inventory counts."],
        evidence: ["Support tickets mention surprise stockouts weekly."],
        assumptions: ["Inventory rows expose item.quantity and item.lowStockThreshold."],
        success_criteria: ["Inventory list displays a visible low-stock badge before stockout."],
        proof: ["A store manager can point to the low-stock badge on an affected SKU."],
        visual_style: ["Use an inline text label with the current list typography and no new color system."],
        constraints: ["Do not change order import behavior."],
        non_goals: ["Do not build supplier ordering."],
        target_files: ["src/pages/inventory-list.tsx"],
        decisions: ["Start with an inline badge labelled 'Low stock' after the SKU when item.quantity <= item.lowStockThreshold."],
        roadmap: ["MVP badge in inventory list."],
        exceptions: ["What if the inventory system is down?"],
        approve: true,
        playback: { confirmed: true, confirmed_by: "user" },
        writeArtifacts: true,
      });

      const prd = runDemandPrdRuntime({
        projectRoot: root,
        stateRoot: join(root, ".yolo"),
        demandPath: discuss.demand_dir,
        writeArtifacts: false,
      });

      assert.equal(prd.status, "success");
      requirePrd(prd);
      assert.match(prd.prd.id, /^[A-Z]+-[0-9]+-[A-Z0-9-]+$/);
      const businessTask = prd.prd.tasks.find((task) => task.task_kind !== "greenfield_scaffold");
      assert.ok(businessTask);
      assert.equal(businessTask.handoff.session.state_path, ".yolo/demand/DEMAND-20260529-库存预警/tasks/DEMAND-REQ-001-0010101/session.json");
      assert.ok(prd.prd.execution_readiness.session_handoff.state_paths[0].includes("库存预警"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("P8.L7: readDemandSession rejects sessions with wrong/missing schema_version", () => {
    const root = mkdtempSync(join(tmpdir(), "yolo-demand-schema-"));
    try {
      const validSession = {
        schema_version: "1.0",
        schema: "yolo.demand.session.v1",
        id: "DEMAND-VALID-001",
        objective: "valid session",
      };
      const validPath = join(root, "valid", "session.json");
      mkdirSync(dirname(validPath), { recursive: true });
      writeFileSync(validPath, JSON.stringify(validSession), "utf8");
      assert.equal(readDemandSession(join(root, "valid")).ok, true);

      const futureVersion = { ...validSession, schema_version: "2.0" };
      const futurePath = join(root, "future", "session.json");
      mkdirSync(dirname(futurePath), { recursive: true });
      writeFileSync(futurePath, JSON.stringify(futureVersion), "utf8");
      const futureRead = readDemandSession(join(root, "future"));
      assert.equal(futureRead.ok, false);
      assert.match(futureRead.error, /unsupported schema_version "2\.0"/);

      const wrongSchema = { ...validSession, schema: "yolo.demand.session.v2" };
      const wrongPath = join(root, "wrong-schema", "session.json");
      mkdirSync(dirname(wrongPath), { recursive: true });
      writeFileSync(wrongPath, JSON.stringify(wrongSchema), "utf8");
      const wrongRead = readDemandSession(join(root, "wrong-schema"));
      assert.equal(wrongRead.ok, false);
      assert.match(wrongRead.error, /unsupported schema "yolo\.demand\.session\.v2"/);

      const missingFields = { id: "no-schema-fields" };
      const missingPath = join(root, "missing", "session.json");
      mkdirSync(dirname(missingPath), { recursive: true });
      writeFileSync(missingPath, JSON.stringify(missingFields), "utf8");
      const missingRead = readDemandSession(join(root, "missing"));
      assert.equal(missingRead.ok, false);
      assert.match(missingRead.error, /unsupported schema_version "undefined"/);

      // Helper returns null for the valid shape and a string otherwise.
      assert.equal(demandSessionSchemaError(validSession), null);
      assert.ok(typeof demandSessionSchemaError(futureVersion) === "string");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
