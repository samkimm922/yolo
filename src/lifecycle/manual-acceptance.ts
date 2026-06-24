function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function isStructuredManualAcceptanceEvidence(entry: unknown): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (record.type !== "manual_acceptance") return false;
  const status = clean(record.status).toLowerCase().replace(/[\s-]+/g, "_");
  return Boolean(
    clean(record.task_id)
    && clean(record.condition_id)
    && clean(record.accepted_by)
    && clean(record.accepted_at)
    && ["accepted", "approved", "pass", "passed"].includes(status)
    && clean(record.signature)
    && clean(record.digest),
  );
}
