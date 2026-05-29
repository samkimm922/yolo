# YOLO Memory Handoff

> Generated: 2026-05-29T11:20:55.607Z

## What Changed In This Memory System

- Canonical memory documents live under `docs/memory/` for the YOLO package, and under `.yolo/memory/` for initialized user projects.
- Append-only ledgers stay machine-readable under `state/*.jsonl` or `.yolo/state/*.jsonl`.
- Overflow from active ledgers is archived under `state/archive/jsonl/YYYY-MM/` or `.yolo/state/archive/jsonl/YYYY-MM/` before the active files are trimmed.
- Learning records are unified under `state/learning.jsonl` or `.yolo/state/learning.jsonl`; legacy closed-loop knowledge files are read-only migration sources.
- Compatibility docs such as `PROJECT_TREE.md`, `SYSTEM_STATE.md`, and `ROADMAP.md` are mirrors or pointers, not the source of truth.
- Hook-triggered refresh now targets `src/runtime/devtools/memory-center.js` instead of removed root scripts.

## Next Operator Actions

- Review `docs/memory/MEMORY_AUDIT.md` before deleting any legacy/scratch document.
- Keep `docs/yolo-public-sdk-progress.md` as the roadmap/progress source; mirror only summaries into memory docs.
- Run `npm test` after memory center changes, because hooks, package smoke, bootstrap, and legacy-boundary tests all guard this area.

## Key Paths

- Project root: `.`
- State root: `.`
- State dir: `state`
- Memory dir: `docs/memory`
