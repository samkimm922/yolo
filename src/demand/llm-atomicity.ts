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
