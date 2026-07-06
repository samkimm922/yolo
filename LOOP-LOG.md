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

## Round 3

- Project path: `/Users/sippingroom/Developer/dogfood-gitweekly-loop3`
- Dogfood window: 2026-07-06T10:53:00Z to 2026-07-06T11:08:00Z for lifecycle run attempt; about 33m through fix validation and push.
- Stop point: `yolo run --executor claude` failed before review/acceptance/ship.
- Blocker: after the scaffold commit succeeded, downstream business tasks repeatedly touched `package.json`, `package-lock.json`, and `tsconfig.json` outside their task scopes, tripping the global same-failure fuse.
- Root cause: the generated greenfield scaffold established only a partial Node/TypeScript baseline. It committed `package.json` with `typescript`, but did not include Node types, lockfile suppression, or a compiler configuration that later tasks could reuse. Downstream worktrees then installed/fixed toolchain metadata while implementing business slices, creating out-of-scope metadata churn.
- Evidence:
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop3/.dogfood-loop3/command-output/run.log`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop3/.yolo/state/runtime/task-results.jsonl`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop3/.yolo/state/reports/run-20260706110800/run-report.json`
  - `src/demand/runtime.ts`
  - `__tests__/demand-runtime.test.ts`
- Repro first went red with `node --import tsx --test __tests__/demand-runtime.test.ts --test-name-pattern "R2 dogfood demand generates machine-verifiable gates"`: the scaffold task lacked `.npmrc`, `@types/node`, lockfile suppression, and postconditions preventing `package-lock.json` / `tsconfig.json` churn.
- Fix commit: `3051604 fix(demand): scaffold complete typecheck toolchain`
- Draft PR: `https://github.com/samkimm922/yolo/pull/254` carries this cumulative-branch commit. Attempting a separate Round 3 draft PR failed because GitHub already has a PR for `fix/dogfood-loop-to-ship` into `main`.
- Validation:
  - `node --import tsx --test __tests__/demand-runtime.test.ts --test-name-pattern "R2 dogfood demand generates machine-verifiable gates"`: red before fix, pass after fix
  - `node --import tsx --test __tests__/check-report.test.ts __tests__/provider-capability-gate.test.ts __tests__/demand-runtime-p2-16-task-schema.test.ts`: pass, 59/59
  - `npm run typecheck --silent`: pass
  - `npm test --silent`: pass, 2019/2019
  - `npm run verify --silent`: pass, 2019/2019 plus source-grep, ci guard, and prd-preflight pass
  - `npm run quality-gate --silent`: pass, Q=1.0000
- Trace note: `commands.jsonl` includes the lifecycle commands; the first `interview-start` attempt records a harmless `CLI_UNKNOWN_FLAG` because `--idea` was rejected, then the correct positional command succeeded.
- Frozen files touched: none.

## Round 4

- Project path: `/Users/sippingroom/Developer/dogfood-gitweekly-loop4`
- Dogfood window: 2026-07-06T11:46:00Z to 2026-07-06T12:18:00Z for lifecycle run attempt; about 1h 06m through fix validation and push.
- Stop point: `yolo run --executor claude` was stopped after the same blocker exceeded the official-path repetition limit; review/acceptance/ship were not reached.
- Blocker: `DEMAND-REQ-001-0010101` repeatedly failed `no_new_type_errors` with TypeScript exit code 2, then follow-on tasks touched `package.json` and created `tsconfig.json` out of scope.
- Root cause: the Round 3 scaffold typecheck instruction used `src/**/*.ts`. In the generated npm/shell context that glob was passed literally to `tsc`, which produced `TS6053: File 'src/**/*.ts' not found` when the scaffold contained `src/git-weekly-cli.ts`.
- Evidence:
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop4/.dogfood-loop4/command-output/run.log`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop4/.yolo/state/runtime/task-results.jsonl`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop4/.yolo/state/runtime/task-audit.jsonl`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop4/.yolo/state/runtime/task-logs/`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop4/.yolo/state/runtime/gate-*`
  - `src/demand/runtime.ts`
  - `__tests__/demand-runtime.test.ts`
- Minimal repro:
  - `tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --types node 'src/**/*.ts'`: failed with `TS6053` and exit 2.
  - `tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --types node src/*.ts`: passed with exit 0.
- Repro first went red with `node --import tsx --test __tests__/demand-runtime.test.ts --test-name-pattern "R2 dogfood demand generates machine-verifiable gates"`: the test asserted the scaffold must reject `src/**/*.ts` and require `src/*.ts`.
- Fix commit: `48214f5 fix(demand): use executable scaffold typecheck glob`
- Draft PR: `https://github.com/samkimm922/yolo/pull/254` carries this cumulative-branch commit. Attempting a separate Round 4 draft PR failed because GitHub already has a PR for `fix/dogfood-loop-to-ship` into `main`.
- Validation:
  - `node --import tsx --test __tests__/demand-runtime.test.ts --test-name-pattern "R2 dogfood demand generates machine-verifiable gates"`: red before fix, pass after fix, 36/36
  - `node --import tsx --test __tests__/check-report.test.ts __tests__/provider-capability-gate.test.ts __tests__/demand-runtime-p2-16-task-schema.test.ts`: pass, 59/59
  - `npm run typecheck --silent`: pass
  - `npm test --silent`: pass, 2019/2019
  - `npm run verify --silent`: pass, 2019/2019 plus source-grep, ci guard, and prd-preflight pass
  - `npm run quality-gate --silent`: pass, Q=1.0000
- Trace note: the `run` command wrapper exited 130 because it was manually stopped after the repeated official-path blocker; full run output and task evidence are preserved under `.dogfood-loop4/` and `.yolo/`.
- Frozen files touched: none.

## Round 5

- Project path: `/Users/sippingroom/Developer/dogfood-gitweekly-loop5`
- Dogfood window: 2026-07-06T12:13:00Z to 2026-07-06T12:51:00Z for lifecycle run attempt; about 54m through fix validation and push.
- Stop point: `yolo run --executor claude` exited 1 after producing the final run report; review/acceptance/ship were not reached.
- Blocker: final run output showed `run_success_rate: 100.0% (10/7)` but reported `status:error` and exit 1 because six retried task IDs still remained in the failed bucket.
- Root cause: `handleTaskOutcome` appended later completed task IDs, but did not remove the same task or merged source IDs from stale `failed`, `blocked`, `contractReview`, or tracker failed buckets. `buildRunReport` then failed closed because `failed.length > 0` even though later retry evidence for those tasks passed.
- Evidence:
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop5/.dogfood-loop5/command-output/run.log`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop5/.dogfood-loop5/commands.jsonl`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop5/.yolo/state/reports/run-20260706121333/run-report.json`
  - `/Users/sippingroom/Developer/dogfood-gitweekly-loop5/.yolo/state/runtime/task-results.jsonl`
  - `src/runtime/task-loop/outcome-handler.ts`
  - `src/runtime/evidence/report.ts`
  - `src/runtime/run-lifecycle/finalize.ts`
- Repro first went red with `node --import tsx --test __tests__/task-loop-outcome-handler.test.ts --test-name-pattern "completion resolves stale"`: the completed retry left `FIX-P36-003` and `FIX-P36-001` in `results.failed` instead of pruning them.
- Fix commit: `4025fc0 fix(runtime): resolve stale failed task buckets on completion`
- Draft PR: `https://github.com/samkimm922/yolo/pull/254` carries this cumulative-branch commit. Attempting a separate Round 5 draft PR failed because GitHub already has a PR for `fix/dogfood-loop-to-ship` into `main`.
- Validation:
  - `node --import tsx --test __tests__/task-loop-outcome-handler.test.ts --test-name-pattern "completion resolves stale"`: red before fix, pass after fix
  - `node --import tsx --test __tests__/task-loop-outcome-handler.test.ts __tests__/recovery-retry-round.test.ts __tests__/evidence-report.test.ts __tests__/run-lifecycle-finalize.test.ts`: pass, 60/60
  - `npm run typecheck --silent`: pass
  - `npm test --silent`: pass, 2020/2020
  - `npm run verify --silent`: pass, 2020/2020 plus source-grep, ci guard, and prd-preflight pass
  - `npm run quality-gate --silent`: pass, Q=1.0000
- Trace note: Round 5 lifecycle commands and full stdout/stderr are preserved under `.dogfood-loop5/`; run failed after reporting the stale-bucket final verdict, so no review/acceptance/ship artifacts exist for this round.
- Frozen files touched: none.
