import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ACCEPTANCE_RUN_PASS_STATUSES, RELEASE_RUN_PASS_OUTCOMES, normalizeStatusToken } from "../../lib/status-vocab.js";
import { readRegisteredArtifactDigests, verifyArtifactIntegrity } from "../evidence/artifact-integrity.js";
import { readLedgerJsonl, validateLedgerChain } from "../evidence/ledger.js";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function readJsonRecord(filePath: string): JsonRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function nestedReport(record: JsonRecord): JsonRecord {
  return isRecord(record.report) ? record.report : record;
}

function eventMatchesArtifact(record: JsonRecord, stage: string, artifactPath: string): boolean {
  return clean(record.event) === `lifecycle.${stage}.report`
    && clean(record.stage) === stage
    && resolve(clean(record.artifact)) === artifactPath;
}

function artifactIsRegisteredAndIntact(artifactPath: string, projectRoot: string, stateRoot: string): boolean {
  const registered = readRegisteredArtifactDigests([artifactPath], { rootDir: projectRoot, stateRoot });
  if (registered.status !== "pass") return false;
  const integrity = verifyArtifactIntegrity([artifactPath], {
    rootDir: projectRoot,
    expectedSha256ByPath: registered.expected_sha256_by_path,
  });
  return integrity.status === "pass";
}

export function filterVerifiedSuccessLearningRecords<TRecord extends JsonRecord>(records: TRecord[], options: JsonRecord = Object()): TRecord[] {
  const projectRoot = resolve(clean(options.projectRoot || options.project_root || process.cwd()));
  const stateRootText = clean(options.stateRoot || options.state_root);
  if (!stateRootText) return [];
  const stateRoot = resolve(stateRootText);
  const eventsPath = join(stateRoot, "state", "events.jsonl");
  if (!existsSync(eventsPath)) return [];

  const events = readLedgerJsonl(eventsPath);
  const validation = validateLedgerChain(events, { stateRoot });
  if (!validation.ok || validation.production_ready !== true) return [];

  return records.filter((learningRecord) => {
    if (clean(learningRecord.source_outcome) !== "success") return false;
    const evidenceRefs = Array.isArray(learningRecord.evidence_refs)
      ? learningRecord.evidence_refs.map(clean).filter(Boolean).map((value) => resolve(projectRoot, value))
      : [];
    for (const deliveryPath of evidenceRefs) {
      const deliveryEvent = events.find((event) => isRecord(event)
        && eventMatchesArtifact(event, "delivery", deliveryPath)
        && RELEASE_RUN_PASS_OUTCOMES.has(normalizeStatusToken(event.status)));
      if (!deliveryEvent || !artifactIsRegisteredAndIntact(deliveryPath, projectRoot, stateRoot)) continue;

      const deliveryArtifact = readJsonRecord(deliveryPath);
      if (!deliveryArtifact) continue;
      const deliveryReport = nestedReport(deliveryArtifact);
      if (!RELEASE_RUN_PASS_OUTCOMES.has(normalizeStatusToken(deliveryReport.status))) continue;

      const acceptancePathText = clean(deliveryReport.acceptance_report_path || deliveryReport.acceptanceReportPath);
      if (!acceptancePathText) continue;
      const acceptancePath = resolve(projectRoot, acceptancePathText);
      const acceptanceEvent = events.find((event) => isRecord(event)
        && eventMatchesArtifact(event, "acceptance", acceptancePath)
        && ACCEPTANCE_RUN_PASS_STATUSES.has(normalizeStatusToken(event.status)));
      if (!acceptanceEvent || !artifactIsRegisteredAndIntact(acceptancePath, projectRoot, stateRoot)) continue;

      const acceptanceArtifact = readJsonRecord(acceptancePath);
      if (!acceptanceArtifact) continue;
      const acceptanceReport = nestedReport(acceptanceArtifact);
      if (ACCEPTANCE_RUN_PASS_STATUSES.has(normalizeStatusToken(acceptanceReport.status))) return true;
    }
    return false;
  });
}
