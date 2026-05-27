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
