// LLM semantic story-atomicity — augments the heuristic (verb/signature counting) with a
// semantic judgment from a provider. The heuristic can only count enumerated deliverable
// verbs; an LLM understands that "sign up and log in" is two independent stories without
// needing the verbs enumerated.
//
// Two hard design rules keep this safe:
//   1. STRICTER-WINS combiner: a story is "multi" if EITHER the heuristic OR the LLM says
//      so. The LLM can only ADD splits (catch heuristic misses), never remove them — so it
//      can never introduce an under-split regression (the worst failure mode).
//   2. FAIL-OPEN to heuristic: if the LLM is disabled, unreachable, or returns garbage, we
//      fall back to the pure heuristic result. The deterministic gates/battery test the
//      heuristic; the LLM layer is opt-in and tested separately with a stub provider.

export type LlmStoryVerdict = {
  text: string;
  story_count: number;      // LLM's count of independent user stories (>=1)
  slices: string[];         // if multi, the atomic slices it would split into
};

const MAX_STORIES_PER_CALL = 40;

export function buildStoryAtomicityPrompt(stories: string[]): string {
  const numbered = stories.slice(0, MAX_STORIES_PER_CALL).map((s, i) => `${i + 1}. ${s}`).join("\n");
  return [
    "You judge whether each requirement/story below is a SINGLE atomic user story or",
    "SEVERAL independent user stories bundled together. A story is NOT atomic if it mixes",
    "multiple independently-deliverable actions (e.g. \"sign up and log in\" = 2 stories;",
    "\"validate, save, and redirect\" = 3 stories). Supporting steps (read/show/return/render)",
    "do NOT count as separate stories.",
    "",
    "For each numbered item, output one JSON object. Output ONLY a JSON array, nothing else:",
    '[{"index":1,"story_count":2,"slices":["...","..."]}, ...]',
    "story_count is the number of independent stories (1 = atomic). If story_count is 1,",
    "slices may be an empty array. Be precise; do not over-split a single coherent story.",
    "",
    "Items:",
    numbered,
  ].join("\n");
}

export function parseStoryAtomicityResponse(stdout: string, stories: string[]): LlmStoryVerdict[] | null {
  if (!stdout) return null;
  const start = stdout.indexOf("[");
  const end = stdout.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const verdicts: LlmStoryVerdict[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { index?: unknown; story_count?: unknown; slices?: unknown };
    const index = Number(e.index);
    if (!Number.isInteger(index) || index < 1 || index > stories.length) continue;
    const count = Number(e.story_count);
    if (!Number.isFinite(count) || count < 1) continue;
    verdicts[index - 1] = {
      text: stories[index - 1],
      story_count: Math.floor(count),
      slices: Array.isArray(e.slices) ? e.slices.filter((s): s is string => typeof s === "string") : [],
    };
  }
  return verdicts.length > 0 ? verdicts : null;
}

// Stricter-wins: the combined story_count is the MAX of heuristic and LLM. The LLM can only
// raise the count (catch a miss), never lower it.
export function combineStoryCounts(heuristicCount: number, llmCount: number | undefined): number {
  const h = Number.isFinite(heuristicCount) ? heuristicCount : 1;
  const l = Number.isFinite(llmCount) ? Number(llmCount) : 1;
  return Math.max(h, l);
}

type SpawnProviderPrompt = (prompt: string, options: Record<string, unknown>) => Promise<{ success?: boolean; stdout?: string }>;

// Opt-in async semantic pass. Returns per-story LLM verdicts, or null on any failure
// (caller then keeps the pure heuristic result). Never throws.
export async function llmInspectStories(
  stories: string[],
  options: { spawnProviderPrompt?: SpawnProviderPrompt; config?: Record<string, unknown>; cwd?: string; timeout?: number } = {},
): Promise<LlmStoryVerdict[] | null> {
  const spawn = options.spawnProviderPrompt;
  if (typeof spawn !== "function" || !Array.isArray(stories) || stories.length === 0) return null;
  try {
    const run = await spawn(buildStoryAtomicityPrompt(stories), {
      timeout: options.timeout ?? 60000,
      cwd: options.cwd,
      config: options.config || Object(),
    });
    if (!run || run.success === false) return null;
    return parseStoryAtomicityResponse(run.stdout || "", stories);
  } catch {
    return null;
  }
}

// ---- v2 wiring: augment a heuristic story-atomicity report with the LLM pass ----
//
// The heuristic report (from inspectStoryAtomicityItems) is the deterministic, gated
// truth. This opt-in async layer runs the LLM over the same item texts and, where the
// LLM raises a story_count the heuristic missed (stricter-wins), upgrades that item to a
// blocker. It NEVER downgrades a heuristic blocker and NEVER mutates the input report —
// on any failure (disabled, no provider, garbage) it returns the original report as-is.

type StoryItem = { kind?: string; id?: string | null; text?: string };
type StoryReport = {
  status?: string;
  inspected?: Array<{ kind?: string; id?: string | null; status?: string; story_count?: number }>;
  findings?: unknown[];
  blockers?: unknown[];
  [k: string]: unknown;
};

const txt = (s: unknown): string => (typeof s === "string" ? s.trim() : "");

export async function augmentStoryAtomicityWithLlm(
  report: StoryReport,
  items: StoryItem[],
  options: {
    enabled?: boolean;
    spawnProviderPrompt?: SpawnProviderPrompt;
    config?: Record<string, unknown>;
    cwd?: string;
    timeout?: number;
  } = {},
): Promise<StoryReport> {
  if (!report || options.enabled !== true) return report;
  const texted = (Array.isArray(items) ? items : []).filter((i) => txt(i?.text));
  if (texted.length === 0) return report;

  const verdicts = await llmInspectStories(texted.map((i) => txt(i.text)), {
    spawnProviderPrompt: options.spawnProviderPrompt,
    config: options.config,
    cwd: options.cwd,
    timeout: options.timeout,
  });
  if (!verdicts) return report; // fail-open: keep pure heuristic

  const inspected = Array.isArray(report.inspected) ? report.inspected.slice() : [];
  const findings = Array.isArray(report.findings) ? report.findings.slice() : [];
  const blockers = Array.isArray(report.blockers) ? report.blockers.slice() : [];
  let upgraded = 0;

  for (let i = 0; i < texted.length; i++) {
    const verdict = verdicts[i];
    if (!verdict) continue;
    const item = texted[i];
    const entry = inspected.find((e) => e && e.id === (item.id ?? null) && (e.kind || "story") === (item.kind || "story"));
    if (!entry) continue;
    const combined = combineStoryCounts(Number(entry.story_count) || 1, verdict.story_count);
    if (combined < 2 || entry.status === "blocked") continue; // heuristic already strict enough

    entry.status = "blocked";
    entry.story_count = combined;
    const finding = {
      code: "STORY_ATOMICITY_MULTI_STORY_LLM",
      severity: "error",
      kind: item.kind || "story",
      item_id: item.id ?? null,
      task_id: item.kind === "task" ? item.id ?? null : null,
      requirement_id: item.kind === "requirement" ? item.id ?? null : null,
      scenario_id: item.kind === "scenario" ? item.id ?? null : null,
      message: `${item.kind || "Story"} ${item.id || ""} bundles ${combined} independent user stories (LLM semantic split the heuristic missed): ${verdict.slices.join("; ")}.`,
      story_count: combined,
      split_suggestions: verdict.slices,
    };
    findings.push(finding);
    blockers.push({
      code: finding.code,
      message: finding.message,
      kind: finding.kind,
      item_id: finding.item_id,
      task_id: finding.task_id,
      requirement_id: finding.requirement_id,
      scenario_id: finding.scenario_id,
      story_count: combined,
      split_suggestions: verdict.slices,
    });
    upgraded++;
  }

  if (upgraded === 0) return report;
  return {
    ...report,
    status: "blocked",
    inspected,
    findings,
    finding_count: findings.length,
    blockers,
    llm_upgraded_count: upgraded,
  };
}
