// Shared external-research signal detector — single source of truth for
// "does this content ask for external/web research".
// Consumed by discovery (research decision + PRD readiness) and demand
// (evidence dispatch). No specific site/product names — only generic intent:
// research/search evidence, external data collection, third-party integration,
// or explicit references to outside sources. Building a self-contained service
// that handles URLs/HTTP/web requests is not external research by itself.

const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;

const EXTERNAL_RESEARCH_TARGET = "(?:external|web|internet|online)\\s+(?:research|search|evidence|browsing)";
const EXPLICIT_RESEARCH_REQUEST_RE = new RegExp(
  "\\b(?:use|run|perform|execute|do(?!\\s+not\\b)|conduct|complete|provide|include|require|record|gather)\\b"
  + `.{0,100}\\b${EXTERNAL_RESEARCH_TARGET}\\b`,
  "i",
);
const EXPLICIT_REQUIRED_RE = new RegExp(
  `\\b${EXTERNAL_RESEARCH_TARGET}\\b`
  + ".{0,100}\\b(?:required|must|needed|requested|recorded|provided|included|as\\s+external\\s+evidence)\\b",
  "i",
);

const EXTERNAL_SOURCE =
  "(?:external|outside|third[_ -]?party|remote|public|online|web(?:site)?|site|url|https?:\\/\\/|source)";
const EXTERNAL_API_SOURCE =
  "(?:(?:external|outside|third[_ -]?party|unknown|remote|public|upstream)(?:\\s+[\\w-]+){0,4}\\s+(?:api|service|provider|endpoint))";
const SAME_SENTENCE_GAP = "[^\\n.。；;]{0,120}";

const EXTERNAL_DATA_REQUEST_RE = new RegExp(
  "\\b(?:scrap(?:e|es|ing)|crawl(?:s|ing)?|fetch(?:es|ing)?|pull(?:s|ing)?|ingest(?:s|ing)?|collect(?:s|ing)?|extract(?:s|ing)?|read(?:s|ing)?|inspect(?:s|ing)?|brows(?:e|es|ing)|search(?:es|ing)?|look\\s+up|lookup|quer(?:y|ies|ying))\\b"
  + `${SAME_SENTENCE_GAP}\\b(?:${EXTERNAL_SOURCE}(?:\\s+(?:data|content|records|feed|docs?|documentation|api|service|endpoint|source))?|${EXTERNAL_API_SOURCE})\\b`,
  "i",
);
const THIRD_PARTY_INTEGRATION_RE = new RegExp(
  "\\b(?:integrat(?:e|es|ing)|connect(?:s|ing)?|call(?:s|ing)?|consume(?:s|ing)?|quer(?:y|ies|ying)|sync(?:s|ing)?\\s+with|authenticat(?:e|es|ing)\\s+with)\\b"
  + `${SAME_SENTENCE_GAP}\\b${EXTERNAL_API_SOURCE}\\b`
  + "|"
  + `\\b${EXTERNAL_API_SOURCE}\\b${SAME_SENTENCE_GAP}\\b(?:integration|connect|call|consume|query|sync|auth)\\b`,
  "i",
);

const URL_CONTEXT_BEFORE_RE =
  /\b(?:check|see|read|inspect|browse|search|look\s+up|lookup|fetch|scrape|crawl|pull|ingest|collect|extract|use|reference|model(?:ed)?\s+on|based\s+on|according\s+to|from|against|compare\s+with|match|replicate|clone|align(?:\s+with)?|follow)\b/i;
const URL_CONTEXT_AFTER_RE =
  /\b(?:for\s+(?:reference|schema|data|content|guidance|docs?|documentation)|as\s+(?:reference|external\s+evidence)|to\s+(?:replicate|match|align|follow|model)|source|reference)\b/i;

// External-reference intent: "match the external source", "port from an
// external library", "align with an external API". Broad word-stems, never
// product/site literals.
const EXTERNAL_REFERENCE =
  "(?:(?:external|outside|third[_ -]?party|upstream|public|remote)\\s+"
  + "(?:[\\w-]+\\s+){0,4}(?:source|site|api|library|service|product|implementation|spec|contract|docs?|documentation|guide|pattern))";
const EXTERNAL_INTENT_RE = new RegExp(
  "\\b(?:replicate|clone|match|align(?:\\s+with)?|port(?:\\s+from)?|mirror|reproduce|copy\\s+from|reference|follow|model(?:ed)?\\s+on|based\\s+on)\\b"
  + `.{0,120}\\b${EXTERNAL_REFERENCE}\\b`
  + "|"
  + `\\b${EXTERNAL_REFERENCE}\\b.{0,120}\\b(?:replicate|clone|match|align|follow|reference|port|copy)\\b`,
  "i",
);

export interface ExternalResearchSignal {
  requires_external: boolean;
  reason: "url" | "explicit" | "intent" | null;
  matches: string[];
}

function uniqueMatches(values: string[]) {
  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function trimUrl(value: string) {
  return value.replace(/[),.;，。；]+$/u, "");
}

function regexWithGlobal(regex: RegExp) {
  return new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
}

function isNegatedMatch(text: string, index: number, match: string) {
  const before = text.slice(Math.max(0, index - 48), index).toLowerCase();
  const matched = match.toLowerCase();
  const window = text.slice(Math.max(0, index - 96), Math.min(text.length, index + match.length + 96)).toLowerCase();
  return /(?:\b(?:do\s+not|don't|dont|no|without|never|avoid)\b|不要|禁止|不需要|无需)[\s\w,;:/.()[\]-]{0,48}$/.test(before)
    || /\bnot\s+(?:required|needed|requested|included|provided|recorded)\b/.test(matched)
    || /\b(?:without|no|not|never|avoid)\s+(?:any\s+)?(?:external|outside|third[_ -]?party|remote|public|online|web(?:site)?|internet|network)\b/.test(matched)
    || /\b(?:out\s+of\s+scope|non[- ]?goals?|not\s+in\s+scope|excluded?|disabled)\b[^.\n。；;]{0,100}\b(?:external|outside|third[_ -]?party|remote|public|online|web(?:site)?|internet|network)\b/.test(window)
    || /\b(?:external|outside|third[_ -]?party|remote|public|online|web(?:site)?|internet|network)\b[^.\n。；;]{0,100}\b(?:out\s+of\s+scope|non[- ]?goals?|not\s+in\s+scope|excluded?|disabled)\b/.test(window);
}

function firstNonNegatedMatch(text: string, regex: RegExp) {
  const pattern = regexWithGlobal(regex);
  for (const match of text.matchAll(pattern)) {
    const value = match[0] || "";
    if (!value) continue;
    if (!isNegatedMatch(text, match.index ?? 0, value)) return value;
  }
  return "";
}

function urlResearchMatches(text: string) {
  const matches: string[] = [];
  const urlPattern = new RegExp(URL_RE.source, URL_RE.flags);
  for (const match of text.matchAll(urlPattern)) {
    const raw = match[0] || "";
    const url = trimUrl(raw);
    const index = match.index ?? -1;
    if (!url || index < 0) continue;
    const before = text.slice(Math.max(0, index - 120), index);
    const after = text.slice(index + raw.length, Math.min(text.length, index + raw.length + 120));
    if (!isNegatedMatch(text, index, url) && (URL_CONTEXT_BEFORE_RE.test(before) || URL_CONTEXT_AFTER_RE.test(after))) {
      matches.push(url);
    }
  }
  return matches;
}

export function detectExternalResearchSignal(...texts: string[]): ExternalResearchSignal {
  const text = texts.map((value) => String(value ?? "")).join("\n");
  if (!text.trim()) return { requires_external: false, reason: null, matches: [] };

  const matches: string[] = [];
  let reason: ExternalResearchSignal["reason"] | null = null;

  const urlMatches = urlResearchMatches(text);
  if (urlMatches.length > 0) {
    reason = "url";
    matches.push(...urlMatches);
  }

  const explicitRequestMatch = firstNonNegatedMatch(text, EXPLICIT_RESEARCH_REQUEST_RE)
    || firstNonNegatedMatch(text, EXPLICIT_REQUIRED_RE)
    || firstNonNegatedMatch(text, EXTERNAL_DATA_REQUEST_RE)
    || firstNonNegatedMatch(text, THIRD_PARTY_INTEGRATION_RE);
  if (explicitRequestMatch) {
    if (reason === null) reason = "explicit";
    matches.push(explicitRequestMatch);
  }

  const intentMatch = firstNonNegatedMatch(text, EXTERNAL_INTENT_RE);
  if (intentMatch) {
    if (reason === null) reason = "intent";
    matches.push(intentMatch);
  }

  const unique = uniqueMatches(matches);
  return { requires_external: unique.length > 0, reason, matches: unique };
}
