import { DEMAND_INTERVIEW_QUESTION_BANK } from "./interview.js";

export const UNDERSTANDING_PLAYBACK_SCHEMA = "yolo.demand.understanding_playback.v1";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function textFromAnswer(record: any): string {
  if (!record) return "";
  const answer = record.answer;
  if (typeof answer === "string") return clean(answer);
  if (answer && typeof answer === "object") {
    return clean(answer.text || answer.value || answer.answer || record.normalized?.text);
  }
  return clean(record.normalized?.text);
}

function slotLabel(slot: string): string {
  const question = DEMAND_INTERVIEW_QUESTION_BANK.find((item) => item.slot === slot);
  return question?.category || slot;
}

export interface PlaybackItem {
  slot: string;
  label: string;
  understanding: string;
}

export interface UnderstandingPlayback {
  schema: string;
  items: PlaybackItem[];
  summary: string;
  confirmation_required: boolean;
  prompt: string;
}

// 在进入 PRD 前，把已收集的每个槽位复述成"我的理解"清单，要求用户逐项确认或纠正。
// 这是防"鸡同鸭讲"的结构化对齐步骤：审批门只问"批不批准"，复述步骤先确认"我理解对了吗"。
export function buildUnderstandingPlayback(session: any = {}): UnderstandingPlayback {
  const answers = (session && session.answers) || {};
  const items: PlaybackItem[] = [];
  const seen = new Set<string>();
  for (const record of Object.values(answers) as any[]) {
    const slot = clean(record?.slot);
    if (!slot || slot === "execution_approval" || seen.has(slot)) continue;
    const understanding = textFromAnswer(record);
    if (!understanding) continue;
    seen.add(slot);
    items.push({ slot, label: slotLabel(slot), understanding });
  }

  const summary = items.length > 0
    ? items.map((item) => `- ${item.label}：${item.understanding}`).join("\n")
    : "（尚未收集到任何需求信息）";

  const confirmationRequired = items.length > 0;
  const prompt = confirmationRequired
    ? `以下是我目前对需求的理解，请逐项确认是否正确；如有偏差请直接纠正后我再更新，确认无误才进入 PRD：\n${summary}`
    : "目前还没有可复述的需求信息，请先回答前面的问题。";

  return {
    schema: UNDERSTANDING_PLAYBACK_SCHEMA,
    items,
    summary,
    confirmation_required: confirmationRequired,
    prompt,
  };
}
