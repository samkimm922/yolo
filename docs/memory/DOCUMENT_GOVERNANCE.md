# YOLO Document Governance

> Generated: 2026-05-29T11:20:55.607Z

## Decision

- Human-readable YOLO memory and operational documents have one canonical home: `docs/memory/`.
- Machine-readable ledgers have one canonical home: `state/*.jsonl`.
- Root-level `PROJECT_TREE.md`, `SYSTEM_STATE.md`, and `ROADMAP.md` are compatibility mirrors only; do not edit them as source documents.
- `docs/PROJECT_TREE.md`, `docs/SYSTEM_STATE.md`, and `docs/ROADMAP.md` are also mirrors/pointers only.
- New durable project-memory documents must be added to this memory center and to the refresh/bootstrap rules, not hand-written in random folders.

## Canonical Document Homes

| Document Type | Canonical Location | Naming Rule | Notes |
|---|---|---|---|
| Current status / handoff / tree / audit / learning / governance | `docs/memory/` | `UPPER_SNAKE_CASE.md` | Generated or refreshed by `yolo memory refresh`. |
| Machine ledgers | `state/` | `lower-kebab-or-domain.jsonl` | Append-only; retention archives old records before trimming. |
| Public user docs | `docs/` | `lower-kebab-case.md` | README-linked docs for users and integrators. |
| Roadmap/progress truth | `docs/yolo-public-sdk-progress.md` | fixed name | Ordered execution table and current SDK progress. |
| Gap/architecture truth | `docs/sdk-gap-matrix.md` and `docs/sdk-agent-architecture.md` | fixed names | Strategic comparison and agent architecture. |
| API/release reference | `docs/api-reference.md`, `docs/public-sdk-contract.md`, `docs/public-sdk-api-boundary.json` | fixed names | Public SDK contract and machine-readable API tiers. |
| Spec artifacts in user projects | `specs/` | `requirements.md`, `design.md`, `tasks.md` | Project-owned requirements/design/tasks, not YOLO memory docs. |
| Temporary analysis | `tmp/` | `lower-kebab-case.md` | Scratch only; must become deletion candidate unless promoted. |
| Legacy learning sources | `closed-loop/*.jsonl` | existing names | Read-only migration sources; do not add new v1 docs here. |

## Naming Rules

- Generated memory docs use `UPPER_SNAKE_CASE.md` so agents can recognize canonical operational memory quickly.
- Public docs under `docs/` use lowercase kebab-case, for example `agent-native-integration.md`.
- JSON ledgers use `.jsonl`; JSON manifests use `.json`.
- Do not create duplicate documents with date suffixes in active folders. If a snapshot is needed, store it under an archive path with a retention policy.
- Do not encode local usernames, absolute machine paths, or one-off project names in public docs.

## Add / Move / Delete Policy

- Before adding a new doc, check `MEMORY_AUDIT.md` in the memory center for existing homes.
- If the doc affects active execution state, update the canonical memory doc or roadmap first, then refresh mirrors.
- If the doc is public-facing reference, put it in `docs/` and link it from README or an existing index.
- If the doc is temporary, put it in `tmp/` and promote or delete it after review.
- Do not delete legacy or scratch docs unless the audit marks them as deletion candidates and a human explicitly approves cleanup.

## Enforcement

- `yolo memory refresh` regenerates canonical memory docs and compatibility mirrors.
- `MEMORY_AUDIT.md` classifies `.md` and `.jsonl` files as keep, archive, reference, legacy-readonly, or deletion-candidate.
- Package smoke requires canonical memory docs to be present in the public tarball and blocks local `state/`, `data/`, `tmp/`, and `closed-loop/` content.
- Project bootstrap creates the same memory governance document for initialized external projects.

## Practical Answer

Yes: from this point forward, YOLO should treat `docs/memory/` in the YOLO package, and `.yolo/memory/` in installed projects, as the unique home for operational memory documents. Other locations may exist as public reference docs, project specs, ledgers, compatibility mirrors, archives, or scratch space, but they must not become competing sources of truth.
