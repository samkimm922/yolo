# Dogfood Loop Log

## Round 1

- Project path: `/Users/sippingroom/Developer/dogfood-gitweekly-loop1`
- Dogfood window: 2026-07-06T09:33:48Z to 2026-07-06T09:55:16Z for lifecycle run attempt; about 44m through fix PR creation.
- Stop point: `yolo run --executor claude` failed before review/acceptance/ship.
- Blocker: greenfield tasks that targeted new `src/git-weekly-cli.ts` repeatedly timed out at about 120s.
- Root cause: `computeTaskTimeout` only counted existing target file lines. Missing in-root greenfield targets contributed 0 lines, so tasks with `scope.max_lines_per_file: 120` still received only the 120s floor.
- Evidence:
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop1/.dogfood-loop1/command-output/run.log`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop1/.yolo/state/runtime/task-results.jsonl`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop1/.yolo/state/reports/run-20260706093623/run-report.json`
  - `src/runtime/runner-core-helpers.ts`
  - `src/runtime/execution/session-attempt.ts`
- Repro first went red with `node --import tsx --test __tests__/runner-core-helpers.test.ts`: greenfield timeout returned 120000 instead of expected 300000.
- Fix commit: `9ea17ec fix(runtime): scale greenfield task timeouts from scope budget`
- Draft PR: `https://github.com/samkimm922/yolo/pull/254`
- Validation:
  - `npm run typecheck --silent`: pass
  - `npm test --silent`: pass, 2018/2018
  - `npm run verify --silent`: pass
  - `npm run quality-gate --silent`: pass, Q=1.0000
- Frozen files touched: none.

## Round 2

- Project path: `/Users/sippingroom/Developer/dogfood-gitweekly-loop2`
- Dogfood window: 2026-07-06T10:23:15Z to 2026-07-06T10:46:43Z for lifecycle run attempt; about 38m through fix validation.
- Stop point: `yolo run --executor claude` was stopped after the same gate blocker exceeded the allowed official-path repetitions; review/acceptance/ship were not reached.
- Blocker: downstream task worktrees repeatedly failed `npm test` and typecheck because `package.json` was missing from `/Users/sippingroom/Developer/.yolo-worktrees/.../package.json`.
- Root cause: greenfield scaffold tasks are allowed to complete as metadata-only work, but `buildCommitSkipDecision` skipped committing those metadata files. The scaffold wrote `package.json`, was marked PASS, and then later git worktrees were created from `HEAD` without that package baseline.
- Evidence:
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop2/.dogfood-loop2/command-output/run.log`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop2/.yolo/state/runtime/task-results.jsonl`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop2/.yolo/state/runtime/retry-count.json`
  - `src/runtime/execution/commit-flow.ts`
  - `src/runtime/execution/post-commit-outcome.ts`
- Repro first went red with `node --import tsx --test __tests__/commit-flow.test.ts`: greenfield scaffold metadata returned `metadata_only` instead of committing `package.json` for downstream worktrees.
- Fix commit: `4f2cd5c fix(runtime): commit allowed scaffold metadata`
- Draft PR: `https://github.com/samkimm922/yolo/pull/254` carries this cumulative-branch commit. Attempting a separate Round 2 draft PR failed because GitHub already has a PR for `fix/dogfood-loop-to-ship` into `main`.
- Validation:
  - `node --import tsx --test __tests__/commit-flow.test.ts`: pass
  - `node --import tsx --test __tests__/post-commit-outcome.test.ts __tests__/runner-review-flow.test.ts`: pass
  - `npm run typecheck --silent`: pass
  - `npm test --silent`: pass, 2019/2019
  - `npm run verify --silent`: pass, 2019/2019 plus source-grep, ci guard, and prd-preflight pass
  - `npm run quality-gate --silent`: pass, Q=1.0000
- Trace note: `run` output is present in `command-output/run.log`; `commands.jsonl` lacks the interrupted `run` record because Ctrl-C terminated the wrapper while stopping at the repetition fuse.
- Frozen files touched: none.
