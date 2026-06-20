import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PROPERTY_CASES = 100;

export class SeededRng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  next() {
    this.state += 0x6D2B79F5;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number) {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  bool(probability = 0.5) {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    assert.ok(items.length > 0, "pick requires at least one item");
    return items[this.int(0, items.length - 1)];
  }

  subset<T>(items: readonly T[], max = items.length): T[] {
    const selected: T[] = [];
    for (const item of items) {
      if (selected.length < max && this.bool()) selected.push(item);
    }
    return selected;
  }
}

export interface PropertyCase<T> {
  seed: number;
  input: T;
}

export function stableJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function runProperty<T>(
  name: string,
  baseSeed: number,
  build: (rng: SeededRng, seed: number, index: number) => T,
  check: (testCase: PropertyCase<T>, rng: SeededRng, index: number) => void,
  cases = PROPERTY_CASES,
) {
  for (let index = 0; index < cases; index += 1) {
    const seed = (baseSeed + index) >>> 0;
    const buildRng = new SeededRng(seed);
    const input = build(buildRng, seed, index);
    try {
      check({ seed, input }, new SeededRng(seed ^ 0xA5A5A5A5), index);
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new Error([
        `${name} property failed`,
        `minimal counterexample seed=${seed} index=${index}`,
        `input=${stableJson(input)}`,
        `cause=${detail}`,
      ].join("\n"));
    }
  }
}

export function expectInvariantFailure(name: string, fn: () => void, pattern?: RegExp) {
  try {
    fn();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (pattern) assert.match(detail, pattern, `${name} failure should mention ${pattern}`);
    return;
  }
  assert.fail(`${name} negative control did not fail`);
}

export function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writeText(file: string, value: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value, "utf8");
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value ? [String(value)] : [];
}

export function taskDependencyIds(task: any) {
  return [...new Set([...asArray(task?.depends_on), ...asArray(task?.dependencies)])];
}

export function assertExecutableTaskGraph(tasks: any[]) {
  const ids = new Set(tasks.map((task) => task.id));
  const roots = tasks.filter((task) => taskDependencyIds(task).length === 0);
  assert.ok(roots.length >= 1, "task graph must have at least one zero-dependency root");

  const indegree = new Map<string, number>(tasks.map((task) => [task.id, 0]));
  const outgoing = new Map<string, string[]>(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dependency of taskDependencyIds(task)) {
      assert.ok(ids.has(dependency), `dependency ${dependency} must reference an existing task`);
      outgoing.get(dependency)?.push(task.id);
      indegree.set(task.id, (indegree.get(task.id) || 0) + 1);
    }
  }

  const ready = roots.map((task) => task.id);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    ordered.push(id);
    for (const next of outgoing.get(id) || []) {
      indegree.set(next, (indegree.get(next) || 0) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }

  assert.equal(
    ordered.length,
    tasks.length,
    `task graph must be topologically sortable; ordered=${ordered.join(",")}`,
  );
}

export function duplicateTaskKeys(tasks: any[]) {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const task of tasks) {
    const targets = (task.scope?.targets || [])
      .map((target: any) => target.file || target)
      .filter(Boolean)
      .sort()
      .join(",");
    const key = JSON.stringify([task.title, targets, task.type]);
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  return duplicates;
}

export function makeStrictPrd({
  id = "PRD-20260620-PROPERTY",
  title = "Property PRD",
  tasks,
  targetFiles,
  qualityStatus = "pass",
}: {
  id?: string;
  title?: string;
  tasks: any[];
  targetFiles?: string[];
  qualityStatus?: "pass" | "warning" | "blocked";
}) {
  const files = [...new Set((targetFiles || tasks.flatMap((task) =>
    (task.scope?.targets || []).map((target: any) => target.file).filter(Boolean)
  )).filter(Boolean))];
  const quality = {
    schema_version: "1.0",
    schema: "yolo.demand.quality.v1",
    status: qualityStatus,
    total_score: qualityStatus === "pass" ? 100 : qualityStatus === "warning" ? 80 : 40,
    dimensions: [],
  };
  return {
    version: "2.0",
    id,
    title,
    project: { name: "property-test", language: "typescript", framework: "generic" },
    generated_by: "yolo-demand",
    generated_at: "2026-06-20T00:00:00.000Z",
    base_commit: "abcdef0",
    source: "approved_demand",
    demand_contract_required: true,
    demand: {
      id: `DEMAND-${id}`,
      approval: { approved: true, effective_for_prd: true },
      project_facts: {
        target_files: files.map((file) => ({ file, status: "verified" })),
        assumptions: [],
      },
      quality_report: quality,
    },
    execution_readiness: {
      level: "L3",
      afk_ready: true,
      quality_status: qualityStatus,
      quality_report: quality,
    },
    requirements: [{
      id: "REQ-PROP-001",
      text: "Keep the property-test target behavior bounded and verifiable.",
      demand_trace: { evidence: ["EVID-PROP-001"] },
    }],
    designs: [{ id: "DES-REQ-PROP-001", text: "Use target-file evidence and executable checks." }],
    tasks,
  };
}

export function makeStrictTask({
  id,
  title,
  type = "feature",
  file,
  dependsOn = [],
  priority = "P2",
}: {
  id: string;
  title: string;
  type?: string;
  file: string;
  dependsOn?: string[];
  priority?: string;
}) {
  return {
    id,
    title,
    priority,
    type,
    task_kind: "atomic_fix",
    status: "pending",
    requirement_ids: ["REQ-PROP-001"],
    design_ids: ["DES-REQ-PROP-001"],
    depends_on: dependsOn,
    scope: { targets: [{ file }] },
    acceptance_criteria: [`${title} changes ${file}.`],
    post_conditions: [
      {
        id: `POST-TARGET-${id}`,
        type: "target_file_modified",
        severity: "FAIL",
        params: { file },
      },
      {
        id: `POST-TYPECHECK-${id}`,
        type: "no_new_type_errors",
        severity: "FAIL",
        params: { command: "npm run typecheck" },
      },
    ],
  };
}
