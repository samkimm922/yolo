# YOLO SDK Agent Architecture

YOLO should not expose a PI-only SDK. PI is the highest-level preset, but the public SDK boundary is:

1. Core SDK: deterministic capabilities such as contract checks, task inspection, review scanning, provider detection, and quality validation.
2. Agent presets: thin orchestration plans over the core SDK.
3. CLI/runtime: concrete execution loops that can call the SDK and selected agent preset.

For the current public-SDK gap analysis and decoupling roadmap, see [sdk-gap-matrix.md](sdk-gap-matrix.md). For stable/experimental/internal API boundaries, see [public-sdk-contract.md](public-sdk-contract.md).

## Presets

- `pi`: full product-to-implementation loop from requirement intake to final gate.
- `reviewer`: review-only agent for code/spec/test risk analysis.
- `gatekeeper`: fail-closed verifier for contracts, evidence, and quality gates.
- `implementer`: scoped task executor for existing PRD tasks.

## PI Execution Chain

The PI agent is available through `sdk.agents.createPiPlan(...)`, `sdk.agents.runPi(...)`, or `yolo-pi`.

By default it only returns an auditable plan. Execution starts only when `execute=true` or `--execute` is provided.

Full requirement flow:

1. `pm.findings` generates atomic findings.
2. `prd.generate` converts findings into PRD v2.
3. `prd.preflight` validates schema, contract, migration advice, and runner readiness.
4. `runner` performs implementation, retries, gates, review, and fix loops.
5. `review.scan` performs deterministic post-run scan.
6. `prd.schema_gate` validates final PRD state.

PI actions use SDK runtime calls, not shell commands. The CLI still exists, but PI can call each phase in-process through `runPiRuntime(...)`.

## Workflow Registry

`sdk.workflows` is the experimental bridge between agent presets and installable skills. It defines PI, review, fix, and ship workflows with:

- triggers
- inputs and outputs
- SDK namespaces
- SDK / CLI / skill entrypoints
- verification hooks

This keeps stable agent presets unchanged while YOLO grows a Superpowers/GSD-style workflow layer.

Contract gate requirements for pending tasks:

- At least one executable `FAIL` post condition.
- Every `scope.targets[].file` must be covered by a target-specific executable `FAIL` post condition.
- Manual `acceptance_criteria`, `WARN` conditions, and project-level gates such as typecheck/test/build do not count as target coverage.

Legacy PRDs can be inspected with `yolo-prd-migrate-gates` or `sdk.prd.migratePrdGates(...)`. The migration is dry-run by default and only writes when `--apply` is passed for a single PRD. `yolo-prd-preflight`, PI preflight, and runner runtime all return migration advice before execution when target coverage can be safely inferred.

## Rule

Agent presets must not own low-level behavior directly. They should compose SDK namespaces:

- `contract`
- `task`
- `review`
- `provider`
- `spec`
- `evidence`
- `workflows`

This keeps YOLO usable for different project types, different models, and different execution hosts.

## Runtime Contracts

Real provider execution goes through `spawnProviderPrompt(...)`. Before a provider process is spawned, YOLO runs:

1. `inspectAgentAdapterContract(...)` for AgentAdapterContract v1.1.
2. `buildProviderInvocation(...)`.
3. `inspectProviderInvocationPreflight(...)`.
4. `commandExists(...)` checks for the adapter command and invocation command.

AgentAdapterContract v1.1 includes timeout, retry policy, budget enforcement, output/evidence schema, failure codes, allowed roots, and permission/sandbox/root policy. Unsafe Claude bypass permission modes, Codex `danger-full-access`, unavailable commands, and configured but unenforceable budgets block before spawn.

Demand evidence dispatch no longer defaults Claude to `bypassPermissions`. Normal evidence agents use `default` permission mode with write tools disallowed. Only an explicit boundary mutation probe opens a narrow write-capable tool set, and the boundary diff must still block the run.

Review clean passes require scanner coverage when findings are empty. Empty findings without `scanner_version`, `scanned_files`, `rules`, `expected_scope`, and complete `coverage_status` are blocked. Review finding conversion failures preserve the original findings as blocking review evidence instead of dropping them.

Parallel planning separates structural plan validity from executable state. A later wave has a `start_gate` and cannot start until prior wave merge evidence is terminal pass; task dependencies must have completed/pass evidence and are not satisfied by merely being planned.

Team dispatch plans are evidence-only by default. Executable dispatch requires every selected role to have a runtime binding or be explicitly marked `evidence_only`; unresolved roles block the executable plan.
