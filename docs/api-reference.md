# YOLO Public API Reference

日期：2026-05-26

本文是 public beta 前的 API reference。机器可读稳定性边界见 `docs/public-sdk-api-boundary.json`，兼容规则见 `docs/public-sdk-contract.md`。

## Stable Package Exports

| Export | Purpose |
|---|---|
| `yolo` / `.` | Main SDK facade with `createYoloSdk()`. |
| `yolo/agents` | Model-agnostic agent presets and plan creation. |
| `yolo/core/config` | Config loading. |
| `yolo/core/paths` | YOLO path helpers. |
| `yolo/prd/preflight` | PRD readiness gate before execution. |
| `yolo/contract` | Contract condition evaluation. |
| `yolo/scanner` | Deterministic review scanner. |
| `yolo/validate-prd` | PRD schema validation. |

## Experimental Package Exports

| Export | Purpose |
|---|---|
| `yolo/core/bootstrap` | Project bootstrap used by `yolo init`. |
| `yolo/core/init-smoke` | Init-to-first-PRD smoke for bootstrap, spec, preflight, and runner dry-run readiness. |
| `yolo/runtime/adapters` | Agent adapter capability, budget, sandbox, and approval policy contract. |
| `yolo/runtime/adapter-evidence` | Adapter evidence collector; dry-run by default, executes manifest commands only with explicit authorization. |
| `yolo/runtime/progress-ui-evidence` | Progress dashboard UI/UX evidence harness; writes local HTML snapshot evidence and adapter-consumable `ui_evidence` only when explicitly run. |
| `yolo/spec/lifecycle` | Requirement, design, task, and change artifact helpers. |
| `yolo/spec/traceability` | Requirement/design/evidence traceability inspection. |
| `yolo/evidence/ledger` | Evidence ledger and artifact builders. |
| `yolo/evidence/report` | Run report JSON/Markdown and final-answer artifact generation. |
| `yolo/fixtures` | Fixture registry. |
| `yolo/fixtures/harness` | Isolated fixture execution harness. |
| `yolo/workflows` | Workflow and skill descriptor registry. |
| `yolo/workflows/install` | Workflow skill install plan, descriptor validation, artifact writer, target `RULES.md` / `triggers.json`, and target smoke. |
| `yolo/release/readiness` | Public beta readiness checks. |
| `yolo/release/pack-smoke` | npm pack/install smoke for external package import and bin checks. |
| `yolo/release/hardening-drill` | Public beta hardening drill that composes readiness, pack/install, fixtures, API docs, provider CLI dry-run, and workflow target smoke without publishing. |
| `yolo/release/decision-gate` | Controlled beta release decision gate that requires a human decision record before private removal, publish, credential, or billable provider actions are authorized. |
| `yolo/release/change-provenance` | Release candidate change provenance manifest for release-relevant files, evidence links, and dirty workspace blockers. |
| `yolo/release/clean-environment-verify` | Clean-environment package verification plan and gated runner for external install/build/test smoke checks. |
| `yolo/release/dogfood-matrix` | Dogfood scenario matrix, evidence builders, and fail-closed dogfood report helpers for release candidates. |
| `yolo/release/operator-state` | Operator-approved release-state mutation helper that can dry-run or explicitly apply `private` removal after the decision gate while still refusing publish, credentials, and provider execution. |
| `yolo/release/operator-runbook` | Operator release runbook gate that verifies applied release state, publish authorization, credential/billable authorization, and public dogfood evidence, then emits manual-only commands without executing them. |
| `yolo/release/post-release-audit` | Post-release audit gate that verifies manual external publish evidence, post-release hardening, package install smoke, and dogfood audit evidence without executing release side effects. |
| `yolo/release/stable-graduation` | Stable graduation gate that requires post-release audit pass, public readiness pass, root entrypoint budget, stability review, runtime API freeze, and public dogfood evidence. |
| `yolo/release/manual-external-release` | Manual external release evidence gate that verifies human-run publish, credential, billable provider, public dogfood, post-release audit, and stable graduation evidence without executing those actions. |
| `yolo/release/agent-integration-doctor` | Native Codex/Claude integration doctor that validates YOLO skills, slash/source commands, and workflow artifacts without installing or mutating host state. |
| `yolo/release/real-project-dogfood` | Real-project dogfood evidence gate for chat-driven stable YOLO entries (`/yolo-demand`, `/yolo-tasks`, `/yolo-spec`, `/yolo-check`, `/yolo-review`, `/yolo-release`, `/yolo-run`) on an external project with no code edits or provider execution. |
| `yolo/release/pi-execution-drill` | PI execution drill gate for mock/dry-run and externally authorized controlled billable evidence; the gate itself never executes providers. |
| `yolo/release/runtime-boundary-decision` | Runtime stable-boundary decision gate that requires explicit human approval before `./runtime` can move from experimental to stable. |
| `yolo/release/public-beta-evidence` | Public beta evidence bundle gate that aggregates agent integration, real-project dogfood, PI drill, optional runtime decision, and optional manual external release evidence. |
| `yolo/release/real-project-dogfood-pack` | Isolated external-project dogfood pack that runs `yolo init`, agent bridge dry-run, skill/command dry-run doctor, and idea/discovery/plan/PRD/check/review/accept/controlled-run evidence gates without provider execution. |
| `yolo/release/experience-pack-audit` | Experience pack effectiveness audit that verifies prompt injection is relevant, bounded, and non-blocking. |
| `yolo/release/nontechnical-ux-doctor` | Non-technical UX doctor that checks the one-sentence Codex/Claude entrypoint and chat-first command artifacts. |
| `yolo/eval/benchmark` | Benchmark fixtures and rubric scoring for discovery, PRD, UI acceptance, evidence, agent command quality, and dogfood readiness. |
| `yolo/pi`, `yolo/pi-runtimes`, `yolo/runtime` | High-level PI and runner runtime integration. |

## SDK Namespaces

```js
import { createYoloSdk } from "yolo";

const sdk = createYoloSdk({ projectRoot: "/path/to/project" });
```

Stable namespaces:

- `sdk.config`
- `sdk.paths`
- `sdk.paths.stateRoot`
- `sdk.contract`
- `sdk.prd.preflightPrd()`
- `sdk.prd.preflightAllPrds()`
- `sdk.prd.validatePrdPath()`
- `sdk.task.inspectAtomicTask()`
- `sdk.task.inspectTaskFromPrd()`
- `sdk.provider.detectModelProvider()`
- `sdk.agents.listPresets()`
- `sdk.agents.getPreset()`
- `sdk.agents.createPlan()`
- `sdk.review.scanProject()`
- `sdk.review.scanFile()`

Experimental namespaces:

- `sdk.project.buildInitPlan()` / `sdk.project.initProject()` / `sdk.project.runInitToFirstPrdSmoke()`
- `sdk.spec.buildSpecLifecyclePackage()` / `sdk.spec.inspectSpecLifecyclePackage()` / `sdk.spec.specLifecycleToPrd()`
- `sdk.acceptance.buildAdapterEvidencePlan()` / `sdk.acceptance.collectAdapterEvidence()`
- `sdk.progress.buildUiEvidence()` / `sdk.progress.inspectUiEvidence()` / `sdk.progress.runUiEvidence()`
- `sdk.evidence.*`, including `buildRunFinalAnswer()` and `formatRunFinalAnswerMarkdown()`
- `sdk.fixtures.*`
- `sdk.workflows.*`, including `buildSkillInstallPlan()`, `installSkills()`, and `runSkillTargetSmoke()`
- `sdk.eval.*`, including `buildBenchmarkPlan()`, `runBenchmark()`, and `scoreScenario()`
- `sdk.parallel.*`, including `planWaves()`, `inspectMergeGate()`, and `mergeEvidence()`
- `sdk.commands.*`, including `listNames()`, `get()`, and `renderUsage()`
- `sdk.doctor.*`, including `buildReport()` and `formatReportText()`
- `sdk.release.*`, including `buildReleaseCandidateChangeManifest()`, `readReleaseCandidateChangeManifest()`, `buildCleanEnvironmentVerifyPlan()`, `runCleanEnvironmentVerify()`, `buildDogfoodMatrixPlan()`, `buildDogfoodMatrixReport()`, `buildDogfoodMatrixEvidence()`, `runReleaseCandidateGate()`, `runPackageInstallSmoke()`, `runPublicBetaHardeningDrill()`, `runControlledBetaReleaseDecisionGate()`, `runOperatorReleaseStateMutation()`, `runOperatorReleaseRunbookGate()`, `runPostReleaseAuditGate()`, `runStableGraduationGate()`, `runManualExternalReleaseGate()`, `runAgentIntegrationDoctor()`, `runRealProjectDogfoodGate()`, `runRealProjectDogfoodPack()`, `runPiExecutionDrillGate()`, `runRuntimeBoundaryDecisionGate()`, and `runPublicBetaEvidenceGate()`
- `sdk.runtime.*`
- `sdk.provider.buildAgentAdapterContract()` / `sdk.provider.inspectAgentAdapterContract()`
- `sdk.provider.buildProviderRuntimeMatrix()` / `sdk.provider.inspectProviderRuntimeMatrix()`
- `sdk.provider.buildProviderCliDryRunMatrix()` / `sdk.provider.inspectProviderCliDryRunMatrix()`
- `sdk.agents.createPiAgent()` / `createPiPlan()` / `runPi()`
- `sdk.pi.createAgent()` / `createPlan()` / `run()`

## CLI

Public bins:

- `yolo`
- `yolo-pi`
- `yolo-gate`
- `yolo-prompt`
- `yolo-prd-preflight`
- `yolo-prd-migrate-gates`

Bootstrap:

```bash
yolo init /path/to/project --name demo --json
```

Execution:

```bash
yolo run /path/to/prd.json --json
yolo run /path/to/prd.json --executor claude --model third-party-model-name --json
yolo run /path/to/prd.json --dry-run --collect-evidence --execute-adapter --allow-adapter-commands --json
yolo runner /path/to/prd.json --dry-run --json
yolo progress-ui-evidence /path/to/project --json
yolo-prd-preflight /path/to/prd.json --json
```

## Release Blockers

Current public beta blockers are intentional:

- `package.json` still has `private: true`.
- Some compatibility root scripts still exist as shims.
- Runtime implementation is freeze-ready, but `yolo/runtime` remains experimental until explicit stable-boundary approval and public release evidence exist.
- Runner execution, provider/runtime matrix, provider CLI dry-run matrix, workflow target smoke, progress dashboard UI evidence, and controlled parallel planning now accept SDK `projectRoot/stateRoot`; workflow skill install also emits target `RULES.md` / `triggers.json`; release candidate helpers now cover change provenance, clean-environment verification, dogfood matrix evidence, and `runReleaseCandidateGate()` without publishing or executing providers; `runPublicBetaHardeningDrill()` can verify the no-publish public beta drill, `runControlledBetaReleaseDecisionGate()` requires a human decision record before `private=true` removal, publish, credential, or billable provider actions are authorized, `runOperatorReleaseStateMutation()` can dry-run or explicitly apply package `private` removal only after that decision gate is ready, `runOperatorReleaseRunbookGate()` checks the final manual publish / credential / billable provider / dogfood report runbook without executing it, `runPostReleaseAuditGate()` checks externally executed release evidence after manual publish, `runStableGraduationGate()` blocks stable claims until post-release audit, public readiness, root-entrypoint budget, stability review, runtime API freeze, and public dogfood evidence all pass, `runManualExternalReleaseGate()` verifies the final P11 evidence bundle for externally executed publish, credential, billable provider, dogfood, post-release audit, and stable graduation steps, P28-P32 add `runAgentIntegrationDoctor()`, `runRealProjectDogfoodGate()`, `runPiExecutionDrillGate()`, `runRuntimeBoundaryDecisionGate()`, and `runPublicBetaEvidenceGate()`, and P37-P39 add `runRealProjectDogfoodPack()`, `runExperiencePackEffectivenessAudit()`, and `runNonTechnicalUxDoctor()` for isolated dogfood, learning effectiveness, and non-technical UX evidence. Internal local dogfood and runtime boundary candidate helpers only produce evidence; they do not declare public dogfood or change API stability.

The release readiness gate must continue to fail closed until these blockers are removed intentionally. The controlled decision gate, operator release-state helper, operator runbook gate, post-release audit gate, stable graduation gate, manual external release evidence gate, agent integration doctor, real-project dogfood gate, PI execution drill gate, runtime boundary decision gate, public beta evidence gate, real-project dogfood pack, experience-pack audit, non-technical UX doctor, and controlled parallel planner still do not publish, read credentials, execute providers, or publish dogfood reports.
