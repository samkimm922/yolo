# YOLO Memory Index

> Generated: 2026-05-29T04:40:50.425Z

This folder is the canonical human-readable memory center. Machine-readable ledgers remain in `state/*.jsonl` for this package, or `.yolo/state/*.jsonl` for initialized projects.

## Canonical Files

- `CURRENT_STATUS.md`: current release/runtime/project state.
- `CURRENT_HANDOFF.md`: handoff notes for the next agent/session.
- `PROJECT_BRIEF.md`: plain-language project purpose, users, and surfaces.
- `PROGRESS.md`: human-readable progress summary and next work.
- `OPEN_QUESTIONS.md`: product and execution questions that block PRD or implementation.
- `DECISION_LOG.md`: durable decisions and ADR promotion candidates.
- `DOCUMENT_GOVERNANCE.md`: canonical document homes, naming rules, and anti-sprawl policy.
- `PROJECT_TREE.md`: generated project structure tree and active ledger summary.
- `MEMORY_AUDIT.md`: audit of `.md` and `.jsonl` files with keep/archive/delete-candidate classification.
- `LEARNING_INDEX.md`: summary of the model-agnostic learning ledger.
- `LESSONS_PLAYBOOK.md`: human-readable pitfalls and prevention playbook.

## Machine Ledgers

- State dir: `state`
- `changes.jsonl`: task starts/completions and auto file-change records.
- `events.jsonl`: runtime/manual events.
- `runs.jsonl`: run lifecycle events.
- `learning.jsonl`: unified lessons, pitfalls, rules, and recovery records.
- `session-memory.jsonl`: runner checkpoints and handoff memory.
- `questions.jsonl`: demand interview questions and answers.
- `decisions.jsonl`: structured product/technical decisions.
- `artifacts.jsonl`: generated artifacts and trace links.
- `runtime/task-*.jsonl`: task audit/results/log records.
- `archive/jsonl/YYYY-MM/*.jsonl`: old ledger records archived by retention before active files are trimmed.

## Compatibility Mirrors

- Root `PROJECT_TREE.md`, `SYSTEM_STATE.md`, and `ROADMAP.md` are compatibility mirrors.
- `docs/PROJECT_TREE.md`, `docs/SYSTEM_STATE.md`, and `docs/ROADMAP.md` point back to this canonical memory center.
