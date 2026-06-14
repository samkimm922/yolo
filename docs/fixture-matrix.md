# YOLO Fixture Matrix

日期：2026-05-27

Fixture registry and harness prove YOLO is not tied to one application shape. Every fixture has a requirement, spec trace, PRD task, smoke command, and evidence contract.

| Fixture | Project Signal | Smoke Command | Coverage Purpose |
|---|---|---|---|
| `node-basic` | JavaScript package with `node:test` | `npm test` | Basic Node package execution. |
| `no-tests` | JavaScript package without test script | `node src/index.js` | Degraded validation when tests are absent. |
| `python-basic` | Python project with `unittest` | `python3 -m unittest discover -s tests -p 'test_*.py'` | Cross-language non-Node project support. |
| `python-service` | Multi-module Python service with CLI | `python3 -m unittest discover -s tests -p 'test_*.py'` | Larger non-Node service structure with domain, repository, and machine-readable CLI boundaries. |
| `frontend-vite` | Vite-style frontend project | `npm test` | Frontend source/test layout without external install. |
| `backend-api` | Dependency-free Node HTTP API service | `npm test` | Backend endpoint smoke coverage for health, JSON resources, and fail-closed 404s. |
| `monorepo` | Multi-package workspace | `node --test packages/app/test.mjs` | Scoped work across package boundaries. |
| `dirty-tree` | Existing local user work marker | `node scripts/check-dirty-marker.mjs` | Preserve dirty tree / readonly local files. |
| `failing-baseline` | Known pre-existing failure record | `node scripts/check-baseline.mjs` | Separate old baseline failures from current task verification. |

## Harness Contract

`sdk.fixtures.runFixtureHarness(id)` copies the fixture to an isolated temporary workspace, runs its local smoke command, writes a `fixture.run` evidence artifact, verifies every declared expected evidence artifact exists, validates the primary evidence schema, and returns command output tails.

The harness must not need network access. Fixtures should use built-in runtimes or local scripts unless a future fixture explicitly opts into network or dependency-install behavior. Unsafe commands such as publish/token access, shell-downloaded installers, remote copy, or unapproved dependency installation are blocked by fixture inspection before they become accepted harness contracts.

## Remaining Matrix Gaps

- Init-to-first-PRD smoke fixture.
- npm pack/install fixture for public beta.
