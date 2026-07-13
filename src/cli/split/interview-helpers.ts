// Demand-interview state helpers for the CLI interview flow.
// Extracted from src/cli/yolo.ts as a pure structural refactor (no behavior change).

import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  answerDemandInterviewQuestion,
  createDemandInterviewSession,
  inspectDemandInterviewCoverage,
  selectDemandInterviewNextQuestion,
} from "../../demand/interview.js";
import {
  appendJsonlFile,
  cleanCliText,
  cloneJson,
  readJsonFile,
  writeJsonFile,
} from "./shared.js";

export function slugForPath(value: unknown, fallback = "interview") {
  const slug = cleanCliText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return slug || fallback;
}

export function demandIdFromInterview(id: unknown) {
  const cleanId = cleanCliText(id);
  if (/^DEMAND-/i.test(cleanId)) return cleanId;
  return `DEMAND-${slugForPath(cleanId, "interview").toUpperCase()}`;
}

export function defaultInterviewPath(stateRoot: string, id: string) {
  return join(stateRoot, "demand-interviews", id, "interview.json");
}

export function resolveInterviewPath(pathOrDir: unknown, cwd = process.cwd()) {
  const resolved = resolve(cwd, cleanCliText(pathOrDir));
  if (existsSync(resolved)) {
    try {
      if (statSync(resolved).isDirectory()) return join(resolved, "interview.json");
    } catch {
      return join(resolved, "interview.json");
    }
  }
  return resolved.endsWith(".json") ? resolved : join(resolved, "interview.json");
}

type InterviewQuestion = {
  id?: string;
  question_id?: string;
  slot?: string;
  text?: string;
  plain_language_prompt?: string;
  category?: string;
  why_it_matters?: string;
  stage?: string;
  layer?: number;
  confirmation_gate?: boolean;
  recommended_answer?: string;
  recommendation_reason?: string;
  follow_up?: boolean;
  follow_up_id?: string;
  follow_up_code?: string;
  follow_up_reason?: string;
  original_prompt?: string;
};

type InterviewCoverage = {
  ready_for_prd_intake?: boolean;
  readiness?: { blockers?: Array<{ slot?: string; code?: string }>; readiness_level?: string; [key: string]: unknown };
  answered?: unknown;
  missing?: Array<{ question_id?: string; id?: string; slot?: string; text?: string; plain_language_prompt?: string; category?: string }>;
  [key: string]: unknown;
};

type InterviewState = {
  questions?: InterviewQuestion[];
  stateRoot?: string;
  state_root?: string;
  id?: string;
  demand_id?: string;
  interview_path?: string;
  next_question?: InterviewQuestion | null;
  playback?: { confirmed?: boolean; [key: string]: unknown };
  initial_playback?: { confirmed?: boolean; confirmed_content_hash?: string; [key: string]: unknown };
  coverage?: { approval?: { approved?: boolean } } & InterviewCoverage;
  answers?: unknown;
  [key: string]: unknown;
};

export function decorateInterviewState(state: InterviewState = {}): InterviewState {
  const questions = Array.isArray(state.questions) ? state.questions : [];
  const coverage = inspectDemandInterviewCoverage({ ...state, questions });
  const next = selectDemandInterviewNextQuestion({ ...state, questions }, coverage);
  return {
    ...state,
    questions,
    status: coverage.ready_for_prd_intake ? "complete" : "in_progress",
    readiness: coverage.readiness,
    next_question: next ? {
      id: next.id,
      question_id: next.question_id || next.id,
      slot: next.slot,
      text: next.plain_language_prompt || next.text || next.id,
      category: next.category,
      why_it_matters: next.why_it_matters,
      stage: next.stage,
      layer: next.layer,
      confirmation_gate: next.confirmation_gate === true,
      recommended_answer: next.recommended_answer,
      recommendation_reason: next.recommendation_reason,
      follow_up: next.follow_up === true,
      follow_up_id: next.follow_up_id,
      follow_up_code: next.follow_up_code,
      follow_up_reason: next.follow_up_reason,
      original_prompt: next.original_prompt,
    } : null,
    coverage,
  };
}

export function createInterviewState(input: { id?: string; title?: string; idea?: string } = {}, projectRoot: string, stateRoot: string) {
  const session = createDemandInterviewSession({
    projectRoot,
    stateRoot,
    id: input.id,
    demand_id: input.id ? demandIdFromInterview(input.id) : undefined,
    title: input.title,
    idea: input.idea || input.title,
    source: "yolo-interview",
  });
  return decorateInterviewState({
    ...session,
    interview_path: defaultInterviewPath(stateRoot, session.id),
  });
}

type ReadInterviewResult = {
  ok: boolean;
  path: string;
  error?: string;
  dir?: string;
  state?: InterviewState;
};

export function readInterviewState(pathOrDir: unknown, cwd = process.cwd()): ReadInterviewResult {
  const path = resolveInterviewPath(pathOrDir, cwd);
  if (!existsSync(path)) {
    return { ok: false, path, error: `Interview session not found: ${path}` };
  }
  try {
    const state = decorateInterviewState({ ...(readJsonFile<Record<string, unknown>>(path)), interview_path: path });
    return { ok: true, path, dir: dirname(path), state };
  } catch (error) {
    return { ok: false, path, error: `Interview session JSON parse failed: ${(error as Error).message}` };
  }
}

export function resolveInterviewQuestionId(state: InterviewState = {}, value: unknown) {
  const questions: InterviewQuestion[] = state.questions || [];
  const clean = cleanCliText(value);
  if (/^\d+$/.test(clean)) return questions[Number(clean) - 1]?.id || clean;
  const qMatch = clean.toUpperCase().match(/^Q0*(\d+)$/);
  if (qMatch) return questions[Number(qMatch[1]) - 1]?.id || clean;
  return questions.find((question) => question.id === clean)?.id
    || questions.find((question) => question.id?.toLowerCase() === clean.toLowerCase())?.id
    || clean;
}

export function coverageCounts(coverage: InterviewCoverage = {}, state: InterviewState = {}) {
  const answered = Array.isArray(coverage.answered) ? coverage.answered.length : Number(coverage.answered || 0);
  const missing = Array.isArray(coverage.missing) ? coverage.missing.length : 0;
  const total = Array.isArray(state.questions) && state.questions.length
    ? state.questions.length
    : answered + missing;
  return {
    answered,
    total,
    percent: total > 0 ? Math.round((answered / total) * 100) : 100,
  };
}

export function coverageForCli(coverage: InterviewCoverage = {}, state: InterviewState = {}) {
  const counts = coverageCounts(coverage, state);
  return {
    ...coverage,
    answered_questions: coverage.answered || [],
    missing: (coverage.missing || []).map((item) => ({
      id: item.question_id || item.id,
      slot: item.slot,
      text: item.plain_language_prompt || item.text || item.slot,
      category: item.category,
    })),
    answered: counts.answered,
    total: counts.total,
    percent: counts.percent,
    complete: coverage.ready_for_prd_intake === true,
  };
}

export function writeInterviewAnswerLedger(state: InterviewState = {}, question: InterviewQuestion = {}, answer = "") {
  const stateRoot = state.stateRoot || state.state_root;
  if (!stateRoot) return null;
  return appendJsonlFile(join(stateRoot, "state", "questions.jsonl"), {
    ts: new Date().toISOString(),
    type: "demand_interview_answer",
    source: "yolo-interview",
    interview_id: state.id,
    demand_id: state.demand_id,
    question_id: question.id,
    slot: question.slot,
    category: question.category,
    question: question.plain_language_prompt || question.text || question.id,
    answer,
  });
}

export function writeInterviewDecisionLedger(state: InterviewState = {}, demandResult: { demand_id?: string; demand_dir?: string; readiness?: { readiness_level?: string } } = {}) {
  const stateRoot = state.stateRoot || state.state_root;
  if (!stateRoot) return null;
  return appendJsonlFile(join(stateRoot, "state", "decisions.jsonl"), {
    ts: new Date().toISOString(),
    type: "demand_interview_to_demand",
    source: "yolo-interview",
    interview_id: state.id,
    demand_id: demandResult.demand_id || state.demand_id,
    approved: state.coverage?.approval?.approved === true,
    demand_dir: demandResult.demand_dir,
    readiness_level: demandResult.readiness?.readiness_level,
  });
}

export function interviewNextActions(state: ReturnType<typeof decorateInterviewState> = decorateInterviewState({}), extra: { demand_dir?: string; demand_path?: string; runtime_next_actions?: string[] } = {}) {
  const path = state.interview_path;
  const actions: string[] = [];
  if (state.next_question) {
    actions.push(`Answer ${state.next_question.id}: yolo interview answer --session ${path} --question ${state.next_question.id} --answer "<answer>"`);
    actions.push(`Check progress: yolo interview status --session ${path}`);
    return actions;
  }
  if (state.playback?.confirmed !== true) {
    actions.push(`Confirm understanding: yolo interview playback --session ${path}`);
    if (!extra.demand_dir) actions.push(`Then create demand artifacts: yolo interview to-demand --session ${path}`);
    return actions;
  }
  if (!extra.demand_dir) actions.push(`Create demand artifacts: yolo interview to-demand --session ${path}`);
  if (extra.demand_dir) {
    actions.push(`yolo spec --demand ${extra.demand_path || extra.demand_dir}`);
  }
  for (const action of extra.runtime_next_actions || []) {
    if (actions.length >= 3) break;
    if (!actions.includes(action)) actions.push(action);
  }
  return actions;
}

export function interviewResult(command: string, state: InterviewState = {}, extra: Record<string, unknown> = {}) {
  const decorated = decorateInterviewState(state);
  const result = Object.assign(Object(), {
    status: extra.status || "success",
    code: extra.code || "INTERVIEW_OK",
    command,
    summary: extra.summary || "Interview state updated.",
    session_path: decorated.interview_path,
    interview: decorated,
    next_question: decorated.next_question,
    coverage: coverageForCli(decorated.coverage, decorated),
    coverage_detail: decorated.coverage,
    artifacts: extra.artifacts || [],
    outputs: extra.outputs || [],
    demand_dir: extra.demand_dir,
    demand_path: extra.demand_path,
    demand_result: extra.demand_result,
  });
  result.next_actions = extra.next_actions || interviewNextActions(decorated, extra as { demand_dir?: string; demand_path?: string; runtime_next_actions?: string[] });
  result.next_action = extra.next_action || (result.next_actions as string[])?.[0] || null;
  if (extra.blockers) result.blockers = extra.blockers;
  return result;
}

// Re-exported so interview-helpers callers (e.g. the interview command) can use
// the same answer application entry point the original yolo.ts used. Note
// decorateInterviewState is already exported as a function above.
export {
  cloneJson,
  writeJsonFile,
  answerDemandInterviewQuestion,
};
