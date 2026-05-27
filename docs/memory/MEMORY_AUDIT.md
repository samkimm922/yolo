# YOLO Memory Audit

> Generated: 2026-05-26T11:19:47.678Z

## Summary

- Total memory-related `.md` / `.jsonl` files: 56.
- Delete candidates: 1.
- Stale compatibility mirrors: 0.
- No file is deleted by this audit. Delete candidates require an explicit human cleanup step.

## Action Counts

- deletion_candidate: 1
- keep_active: 13
- keep_as_pointer: 6
- keep_legacy_readonly: 3
- keep_local_only: 13
- keep_reference: 12
- keep_refresh: 8

## Documents

| Path | Category | Action | Stale | Reason |
|---|---|---|---|---|
| `.agents/skills/yolo/workflows/RULES.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.agents/skills/yolo/workflows/yolo.accept/SKILL.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.agents/skills/yolo/workflows/yolo.check/SKILL.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.agents/skills/yolo/workflows/yolo.discover/SKILL.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.agents/skills/yolo/workflows/yolo.doctor/SKILL.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.agents/skills/yolo/workflows/yolo.eval/SKILL.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.agents/skills/yolo/workflows/yolo.fix/SKILL.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.agents/skills/yolo/workflows/yolo.learn/SKILL.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.agents/skills/yolo/workflows/yolo.pi/SKILL.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.agents/skills/yolo/workflows/yolo.plan/SKILL.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.agents/skills/yolo/workflows/yolo.prd/SKILL.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.agents/skills/yolo/workflows/yolo.review/SKILL.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.agents/skills/yolo/workflows/yolo.ship/SKILL.md` | local_agent_artifact | keep_local_only | no | Local generated agent integration artifact; not canonical repo memory. |
| `.yolo/state/events.jsonl` | active_append_only_ledger | keep_active | no | Active append-only runtime memory ledger. |
| `.yolo/state/learning.jsonl` | active_learning_ledger | keep_active | no | Unified learning compound-interest ledger for lessons, rules, pitfalls, and recoveries. |
| `.yolo/state/session-memory.jsonl` | active_session_memory | keep_active | no | Runner checkpoint/session memory ledger. |
| `CHANGELOG.md` | active_changelog | keep_active | no | Human release/change summary; append memory-system milestones here. |
| `closed-loop/knowledge-base.jsonl` | legacy_learning_source | keep_legacy_readonly | no | v1 learning source; memory refresh migrates it into state/learning.jsonl, preserve read-only until deletion policy is approved. |
| `closed-loop/lessons.jsonl` | legacy_learning_source | keep_legacy_readonly | no | v1 learning source; memory refresh migrates it into state/learning.jsonl, preserve read-only until deletion policy is approved. |
| `closed-loop/red-team-report.jsonl` | legacy_learning_source | keep_legacy_readonly | no | v1 learning source; memory refresh migrates it into state/learning.jsonl, preserve read-only until deletion policy is approved. |
| `docs/agent-chat-usage.md` | reference_doc | keep_reference | no | Project reference document; not an append-only memory ledger. |
| `docs/agent-native-integration.md` | reference_doc | keep_reference | no | Project reference document; not an append-only memory ledger. |
| `docs/api-reference.md` | reference_doc | keep_reference | no | Project reference document; not an append-only memory ledger. |
| `docs/CHANGELOG.md` | active_changelog | keep_active | no | Human release/change summary; append memory-system milestones here. |
| `docs/fixture-matrix.md` | reference_doc | keep_reference | no | Project reference document; not an append-only memory ledger. |
| `docs/HOWTO.md` | reference_doc | keep_reference | no | Project reference document; not an append-only memory ledger. |
| `docs/memory/CURRENT_HANDOFF.md` | canonical_memory_doc | keep_refresh | no | Canonical human-readable memory center document. |
| `docs/memory/CURRENT_STATUS.md` | canonical_memory_doc | keep_refresh | no | Canonical human-readable memory center document. |
| `docs/memory/DOCUMENT_GOVERNANCE.md` | canonical_memory_doc | keep_refresh | no | Canonical human-readable memory center document. |
| `docs/memory/LEARNING_INDEX.md` | canonical_memory_doc | keep_refresh | no | Canonical human-readable memory center document. |
| `docs/memory/LESSONS_PLAYBOOK.md` | canonical_memory_doc | keep_refresh | no | Canonical human-readable memory center document. |
| `docs/memory/MEMORY_AUDIT.md` | canonical_memory_doc | keep_refresh | no | Canonical human-readable memory center document. |
| `docs/memory/MEMORY_INDEX.md` | canonical_memory_doc | keep_refresh | no | Canonical human-readable memory center document. |
| `docs/memory/PROJECT_TREE.md` | canonical_memory_doc | keep_refresh | no | Canonical human-readable memory center document. |
| `docs/non-technical-user-guide.md` | reference_doc | keep_reference | no | Project reference document; not an append-only memory ledger. |
| `docs/PROJECT_TREE.md` | compatibility_memory_mirror | keep_as_pointer | no | Compatibility location; canonical truth lives in docs/memory. |
| `docs/public-sdk-contract.md` | reference_doc | keep_reference | no | Project reference document; not an append-only memory ledger. |
| `docs/ROADMAP.md` | compatibility_memory_mirror | keep_as_pointer | no | Compatibility location; canonical truth lives in docs/memory. |
| `docs/root-entrypoint-inventory.md` | reference_doc | keep_reference | no | Project reference document; not an append-only memory ledger. |
| `docs/sdk-agent-architecture.md` | reference_doc | keep_reference | no | Project reference document; not an append-only memory ledger. |
| `docs/sdk-gap-matrix.md` | active_roadmap | keep_active | no | Current public SDK roadmap/progress truth. |
| `docs/SYSTEM_STATE.md` | compatibility_memory_mirror | keep_as_pointer | no | Compatibility location; canonical truth lives in docs/memory. |
| `docs/yolo-deliverable-implementation-plan.md` | reference_doc | keep_reference | no | Project reference document; not an append-only memory ledger. |
| `docs/yolo-discovery-ui-acceptance-plan.md` | reference_doc | keep_reference | no | Project reference document; not an append-only memory ledger. |
| `docs/yolo-public-sdk-progress.md` | active_roadmap | keep_active | no | Current public SDK roadmap/progress truth. |
| `PROJECT_TREE.md` | compatibility_memory_mirror | keep_as_pointer | no | Compatibility location; canonical truth lives in docs/memory. |
| `README.md` | reference_doc | keep_reference | no | Project reference document; not an append-only memory ledger. |
| `ROADMAP.md` | compatibility_memory_mirror | keep_as_pointer | no | Compatibility location; canonical truth lives in docs/memory. |
| `state/changes.jsonl` | active_append_only_ledger | keep_active | no | Active append-only runtime memory ledger. |
| `state/events.jsonl` | active_append_only_ledger | keep_active | no | Active append-only runtime memory ledger. |
| `state/learning.jsonl` | active_learning_ledger | keep_active | no | Unified learning compound-interest ledger for lessons, rules, pitfalls, and recoveries. |
| `state/review-log.jsonl` | active_append_only_ledger | keep_active | no | Active append-only runtime memory ledger. |
| `state/runs.jsonl` | active_append_only_ledger | keep_active | no | Active append-only runtime memory ledger. |
| `state/session-memory.jsonl` | active_session_memory | keep_active | no | Runner checkpoint/session memory ledger. |
| `SYSTEM_STATE.md` | compatibility_memory_mirror | keep_as_pointer | no | Compatibility location; canonical truth lives in docs/memory. |
| `tmp/review-root-cause-analysis.md` | scratch_doc | deletion_candidate | no | Scratch analysis output; keep only if a human still needs this local note. |
