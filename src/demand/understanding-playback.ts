import { createHash } from "node:crypto";
import { DEMAND_INTERVIEW_QUESTION_BANK } from "./interview.js";

export const UNDERSTANDING_PLAYBACK_SCHEMA = "yolo.demand.understanding_playback.v1";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

interface DemandAnswerRecord extends Record<string, unknown> {
  slot?: unknown;
  answer?: unknown;
  normalized?: unknown;
}

interface UnderstandingSession {
  answers?: unknown;
  objective?: unknown;
  title?: unknown;
}

function normalizedText(record: DemandAnswerRecord): unknown {
  return isRecord(record.normalized) ? record.normalized.text : undefined;
}

function textFromAnswer(record: DemandAnswerRecord | undefined): string {
  if (!record) return "";
  const answer = record.answer;
  if (typeof answer === "string") return clean(answer);
  if (isRecord(answer)) {
    return clean(answer.text || answer.value || answer.answer || normalizedText(record));
  }
  return clean(normalizedText(record));
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
  content_hash: string;
  scene?: {
    actor: string;
    objective: string;
    current_behavior: string;
    pain: string;
    day_in_life: string;
    desired_outcome: string;
    exceptions: string;
    boundaries: string;
    acceptance_evidence: string;
  };
  confirmation_contract: {
    schema: string;
    subject: string;
    algorithm: string;
    expected_content_hash: string;
    evidence_required: string;
  };
}

function playbackContentHash(items: PlaybackItem[]): string {
  const snapshot = JSON.stringify({ schema: UNDERSTANDING_PLAYBACK_SCHEMA, items });
  return `sha256:${createHash("sha256").update(snapshot).digest("hex")}`;
}

// 在进入 PRD 前，把已收集的每个槽位复述成"我的理解"清单，要求用户逐项确认或纠正。
// 这是防"鸡同鸭讲"的结构化对齐步骤：审批门只问"批不批准"，复述步骤先确认"我理解对了吗"。
export function buildUnderstandingPlayback(session: UnderstandingSession = {}): UnderstandingPlayback {
  const answers = isRecord(session.answers) ? session.answers : {};
  const bySlot = new Map<string, string>();
  for (const value of Object.values(answers)) {
    if (!isRecord(value)) continue;
    const record: DemandAnswerRecord = value;
    const slot = clean(record?.slot);
    if (!slot || slot === "execution_approval" || bySlot.has(slot)) continue;
    const text = textFromAnswer(record);
    if (text) bySlot.set(slot, text);
  }

  const actor = bySlot.get("target_users") || "目标用户";
  const objective = clean(session.objective || session.title) || bySlot.get("desired_outcome") || "这项工作";
  const currentBehavior = bySlot.get("status_quo") || "沿用现在的临时办法";
  const pain = bySlot.get("pain_points") || bySlot.get("premise_consequence") || "现有流程仍有明确代价";
  const dayInLife = bySlot.get("day_in_life") || "进入日常工作入口并处理当天事项";
  const desiredOutcome = bySlot.get("desired_outcome") || bySlot.get("mvp_priority") || objective;
  const exceptions = bySlot.get("exceptions") || "尚未确认例外情况";
  const boundaries = bySlot.get("scope_boundaries") || "尚未确认本次边界";
  const acceptanceEvidence = bySlot.get("success_criteria") || "尚未确认验收证据";
  const cadence = /每天|每日|早上|上午|下午|下班|daily|morning|afternoon/i.test(`${actor}\n${dayInLife}\n${currentBehavior}`)
    ? "每天"
    : "在需要处理这件事时";
  const sceneText = [
    `${cadence}，${actor}打开与“${objective}”相关的工作入口。`,
    `她/他们先按当前方式处理：${currentBehavior}；这会带来：${pain}。`,
    `新流程里，先围绕一天的实际步骤完成“${dayInLife}”，然后看到或完成“${desiredOutcome}”。`,
  ].join("");
  const items: PlaybackItem[] = bySlot.size > 0 ? [
    { slot: "scenario", label: "一天的使用场景", understanding: sceneText },
    { slot: "exceptions", label: slotLabel("exceptions"), understanding: `流程走不下去时，按以下例外处理：${exceptions}。` },
    { slot: "scope_boundaries", label: slotLabel("scope_boundaries"), understanding: `这次明确保持以下边界：${boundaries}。` },
    { slot: "success_proof", label: slotLabel("success_proof"), understanding: `用户将通过以下可见证据判断做对了：${acceptanceEvidence}。` },
  ] : [];

  const summary = items.length > 0
    ? items.map((item) => `- ${item.label}：${item.understanding}`).join("\n")
    : "（尚未收集到任何需求信息）";

  const confirmationRequired = items.length > 0;
  const contentHash = playbackContentHash(items);
  const prompt = confirmationRequired
    ? `以下是我目前对需求的理解，请逐项确认是否正确；如有偏差请直接纠正后我再更新，确认无误才进入 PRD：\n${summary}`
    : "目前还没有可复述的需求信息，请先回答前面的问题。";

  return {
    schema: UNDERSTANDING_PLAYBACK_SCHEMA,
    items,
    summary,
    confirmation_required: confirmationRequired,
    prompt,
    content_hash: contentHash,
    scene: items.length > 0 ? {
      actor,
      objective,
      current_behavior: currentBehavior,
      pain,
      day_in_life: dayInLife,
      desired_outcome: desiredOutcome,
      exceptions,
      boundaries,
      acceptance_evidence: acceptanceEvidence,
    } : undefined,
    confirmation_contract: {
      schema: "yolo.demand.playback_confirmation_contract.v1",
      subject: "playback.items",
      algorithm: "sha256",
      expected_content_hash: contentHash,
      evidence_required: "user_provided_content_hash",
    },
  };
}
