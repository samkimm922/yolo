import { planControlledParallelWaves } from "../../src/runtime/parallel/wave-planner.js";

export type ParallelExpectation = "pass" | "blocked";

export type ParallelBatteryCase = {
  id: string;
  category: "parallel_planner_safety";
  description: string;
  expect: ParallelExpectation;
  tasks: unknown[];
};

type ParallelBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

export const PARALLEL_BATTERY: ParallelBatteryCase[] = [
  {
    id: "parallel_unsafe_task_id_blocks",
    category: "parallel_planner_safety",
    description: "Parallel planner must block unsafe task ids before deriving worktree paths or branch names.",
    expect: "blocked",
    tasks: [
      { id: "../escape", files: ["src/a.ts"] },
      { id: "a/b", files: ["src/b.ts"] },
      { id: "", files: ["src/c.ts"] },
    ],
  },
];

function runParallelCase(testCase: ParallelBatteryCase): ParallelBatteryResult {
  const plan = planControlledParallelWaves({
    projectRoot: "/tmp/project",
    worktreeRoot: "/tmp/worktrees",
    tasks: testCase.tasks,
  }) as { status?: string; blockers?: Array<Record<string, unknown>> };
  const unsafeBlockers = (plan.blockers || []).filter((blocker) => blocker.code === "PARALLEL_UNSAFE_TASK_ID");
  const status = plan.status === "blocked" && unsafeBlockers.length >= 3 ? "blocked" : String(plan.status || "unknown");
  const correct = testCase.expect === "blocked" ? status === "blocked" : status === "pass";
  return {
    id: testCase.id,
    category: testCase.category,
    expect: testCase.expect,
    actualExit: correct ? 0 : 1,
    actualStatus: status,
    correct,
  };
}

export function runParallelBattery(): ParallelBatteryResult[] {
  return PARALLEL_BATTERY.map(runParallelCase);
}
