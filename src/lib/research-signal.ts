// Shared external-research signal detector — single source of truth for
// "does this content ask for external/web research".
// Consumed by discovery (research decision + PRD readiness) and demand
// (evidence dispatch). No specific site/product names — only generic
// signals: URLs, explicit external-research requests, and external-reference
// intent words (replicate/clone/match/align/port/...).

const URL_RE = /https?:\/\//i;

// "use/perform/fetch ... external research|web|url" — explicit request to
// run external research. Preserved verbatim from the former demand-side
// detection so behavior does not drift.
const EXPLICIT_TARGET_RE = /(?:external research|web\s+(?:research|search|browser)|fetch|search|browser|url)/i;
const EXPLICIT_REQUEST_RE = new RegExp(
  "\\b(?:"
  + [
    `use\\s+${EXPLICIT_TARGET_RE.source}`,
    "(?:run|perform|execute|do(?!\\s+not\\b)|fetch|search|browse|inspect|read|look up|lookup)\\b.{0,80}"
      + EXPLICIT_TARGET_RE.source,
  ].join("|")
  + ")\\b",
  "i",
);
const EXPLICIT_REQUIRED_RE = /\b(?:external research|web|fetch|search|browser|url)\b.{0,80}\b(?:required|must|explicitly requested|as external evidence)\b/i;

// External-reference intent: "replicate the existing X", "clone behavior of",
// "match the external source", "port from an external library",
// "align with an external API". Broad word-stems, never product/site literals.
const EXTERNAL_INTENT_RE = new RegExp(
  "\\b(?:"
  + [
    "replicate", "clone", "match", "align(?:\\s+with)?", "port(?:\\s+from)?",
    "mirror", "reproduce", "copy\\s+from\\s+(?:external|outside|third[_ -]?party|upstream)",
    "reference(?:\\s+(?:an?|the)\\s+(?:external|outside|third[_ -]?party)\\s+(?:source|site|api|library|service|product|implementation))?",
    "follow(?:\\s+the)?\\s+(?:external|outside|upstream)\\s+(?:source|spec|api|contract)",
  ].join("|")
  + ")\\b",
  "i",
);

export interface ExternalResearchSignal {
  requires_external: boolean;
  reason: "url" | "explicit" | "intent" | null;
  matches: string[];
}

export function detectExternalResearchSignal(...texts: string[]): ExternalResearchSignal {
  const text = texts.map((value) => String(value ?? "")).join("\n");
  if (!text.trim()) return { requires_external: false, reason: null, matches: [] };

  const matches: string[] = [];
  let reason: ExternalResearchSignal["reason"] | null = null;

  const urlMatch = text.match(URL_RE);
  if (urlMatch) {
    reason = "url";
    matches.push(urlMatch[0]);
  }

  const explicitRequestMatch = text.match(EXPLICIT_REQUEST_RE) || text.match(EXPLICIT_REQUIRED_RE);
  if (explicitRequestMatch) {
    if (reason === null) reason = "explicit";
    matches.push(explicitRequestMatch[0]);
  }

  const intentMatch = text.match(EXTERNAL_INTENT_RE);
  if (intentMatch) {
    if (reason === null) reason = "intent";
    matches.push(intentMatch[0]);
  }

  return { requires_external: matches.length > 0, reason, matches };
}
