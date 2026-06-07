# YOLO Public SDK Contract

日期：2026-05-26

本文定义当前公开 SDK 边界。未列入 stable 的入口都不能被外部项目当成长期兼容 API。

机器可读边界见 `docs/public-sdk-api-boundary.json`。`package.json` exports、`sdk.ts` named exports 和 `createYoloSdk()` namespaces 新增或改名时，必须先在该 manifest 里分级，并通过 public SDK boundary 测试。

## Version Policy

- `stable`：外部项目可以长期依赖；破坏性变更需要 major version、兼容 shim 或迁移说明。
- `stable_alias`：stable API 的兼容别名；行为必须跟目标 API 保持一致，移除前必须给出 canonical path。
- `experimental`：可以试用，但 shape、返回字段和执行语义仍可能在 beta 前变化；变更必须写入 release/docs。
- `experimental_alias`：experimental API 的兼容别名；跟随目标 API 演进。
- `compatibility`：历史公开入口，只保留兼容，不新增能力；迁移目标必须明确。
- `internal`：不承诺兼容；只能在不破坏 package exports、bin 和文档化 SDK API 的前提下自由改动。

## Stable

Stable 表示可以被外部项目集成，并且变更时需要保留兼容或提供迁移说明。

Package exports:

| Export | Target | Status | Purpose |
|---|---|---|---|
| `yolo` / `.` | `dist/sdk.js` | stable | 聚合 SDK 入口。 |
| `yolo/agents` | `dist/src/agents/presets.js` | stable | agent preset 查询和计划生成。 |
| `yolo/core/config` | `dist/src/core/config.js` | stable | 配置加载。 |
| `yolo/core/paths` | `dist/src/core/paths.js` | stable | YOLO 路径解析和目录初始化。 |
| `yolo/config` | `dist/src/core/config.js` | stable alias | 兼容短路径。 |
| `yolo/contract` | `dist/src/prd/contract.js` | stable | contract condition evaluation。 |
| `yolo/scanner` | `dist/src/review/scanner.js` | stable | deterministic review scanner。 |
| `yolo/validate-prd` | `dist/src/prd/validate.js` | stable | PRD schema validation。 |
| `yolo/prd/preflight` | `dist/src/prd/preflight.js` | stable | PRD execution readiness gate。 |
| `yolo/prd-preflight` | `dist/src/prd/preflight.js` | stable alias | 兼容旧 export 名。 |

Stable SDK namespaces from `createYoloSdk()`:

- `sdk.config`
- `sdk.paths`
- `sdk.paths.stateRoot`
- `sdk.contract`
- `sdk.prd.validatePrdPath`
- `sdk.prd.preflightPrd`
- `sdk.prd.preflightAllPrds`
- `sdk.task.inspectAtomicTask`
- `sdk.task.inspectTaskFromPrd`
- `sdk.provider.detectModelProvider`
- `sdk.agents.listPresets`
- `sdk.agents.getPreset`
- `sdk.agents.createPlan`
- `sdk.review.scanProject`
- `sdk.review.scanFile`

## Experimental

Experimental 表示当前可用，但 API shape、返回字段或执行语义仍可能变化。

| Export / API | Reason |
|---|---|
| `yolo/pi` | PI 是最高阶 preset，仍依赖 runner 单体和 runtime adapter 演进。 |
| `yolo/pi-runtimes` | runtime action map 还在扩展。 |
| `yolo/runtime` | runner runtime 已能把外部 `projectRoot/stateRoot` 注入真实 runner，runtime implementation 已 freeze-ready；该 export 仍保持 experimental，等待显式 stable-boundary approval 和公开 release evidence。 |
| `yolo/runtime/adapters` | agent adapter capability、budget、sandbox contract 可用；provider/runtime matrix 和 provider CLI dry-run matrix 通过 `sdk.provider.*` 暴露，仍为 experimental。 |
| `yolo/runtime/adapter-evidence` | adapter evidence collector 可规划或在显式授权下执行 acceptance adapter manifest command；默认 dry-run，不自动执行外部工具。 |
| `yolo/runtime/progress-ui-evidence` | progress dashboard UI/UX evidence harness 可生成本地 HTML snapshot、结构化 `ui_evidence` 和 adapter 可消费证据；当前 schema/browser execution 仍为 beta-only。 |
| `yolo/core/bootstrap` | `yolo init` 的项目初始化 SDK；结构已可用，但 spec lifecycle 目录可能继续扩展。 |
| `yolo/core/init-smoke` | init-to-first-PRD smoke 可证明 bootstrap、spec lifecycle、PRD preflight 和 runner dry-run readiness；smoke shape 仍可能扩展。 |
| `yolo/prd/migration` | gate migration 可用，但自动修复策略会随 contract 严格度变化。 |
| `yolo/prd-migrate-gates` | 兼容 alias；同上。 |
| `yolo/spec/lifecycle` | requirements/design/tasks/changes artifact helpers 可用，但 schema 尚未冻结。 |
| `yolo/spec/traceability` | spec governance 已接入 preflight/runner fail-closed，但 traceability lifecycle schema 尚未冻结。 |
| `yolo/evidence/ledger` | evidence ledger façade 和 v1 event/artifact schema 可用，但 report 生成策略尚未冻结。 |
| `yolo/evidence/report` | run-report JSON/Markdown 和 final-answer artifact 生成可用，已聚合 gate/review/fixture/spec 摘要，并读取 review finding v1。 |
| `yolo/review/findings` | review finding v1 normalize/validate/output helpers 可用；当前为 experimental，字段扩展仍需兼容。 |
| `yolo/workflows` | workflow/skill descriptor registry 可用；descriptor shape 仍是 experimental。 |
| `yolo/workflows/install` | workflow skill install plan、descriptor validation、artifact writer、target `RULES.md` / `triggers.json` convention 和 target smoke 可用；真实 agent execution 约定仍会扩展。 |
| `yolo/fixtures` | fixture registry 和最小隔离执行 harness 可用，但跨项目执行矩阵尚未完成。 |
| `yolo/release/readiness` | public beta readiness 检查可用；package metadata 和 files allowlist 已纳入 gate，但发布流程仍 fail-closed。 |
| `yolo/release/pack-smoke` | npm pack/install smoke 可在临时外部项目安装 tarball、import public exports、调用 `.bin/yolo --help`；release workflow 仍是 experimental。 |
| `yolo/release/hardening-drill` | public beta hardening drill 可串起 readiness、pack/install、fixture registry、API/docs、provider CLI dry-run 和 workflow target smoke；该 drill 不发布、不改 `private=true`、不读凭证、不执行 provider。 |
| `yolo/release/decision-gate` | controlled beta release decision gate 可在 P5 drill 通过后校验人工决策记录；移除 `private=true`、真实 publish、凭证或 billable provider action 都必须显式批准，函数本身仍不执行这些动作。 |
| `yolo/release/change-provenance` | release candidate change provenance 会把 release 相关变更、evidence 链接和 dirty workspace blocker 写成 manifest；它只读状态，不批准发布。 |
| `yolo/release/clean-environment-verify` | clean-environment verification 会规划并可在显式授权下执行外部干净环境 install/build/test smoke；当前仍是 release candidate 证据，不代表 release-ready。 |
| `yolo/release/dogfood-matrix` | dogfood matrix 会生成 dogfood scenario plan、evidence 和 fail-closed report；缺证据或安全保证时阻断 release candidate。 |
| `yolo/release/operator-state` | operator-approved release-state mutation helper 可在 decision gate ready 后 dry-run 或显式 apply package `private` removal；即使 apply，也不 publish、不读凭证、不执行 provider。 |
| `yolo/release/operator-runbook` | operator release runbook gate 会校验 applied release state、publish 授权、credential/billable 授权和 public dogfood report 证据，只产出人工命令，不执行 publish、凭证读取、provider 或报告发布。 |
| `yolo/release/post-release-audit` | post-release audit gate 会校验人工外部发布记录、发布后 hardening、package install smoke 和 dogfood audit 证据；它只审计证据，不执行 publish/token/provider/report 操作。 |
| `yolo/release/stable-graduation` | stable graduation gate 会在 post-release audit 通过后校验 public readiness、root entrypoint budget、稳定性 review、runtime API freeze 和公开 dogfood 证据；当前 root budget 与 runtime implementation 已达标，但通过前仍不能把 SDK 声明为 stable。 |
| `yolo/release/manual-external-release` | manual external release evidence gate 会校验人工外部 publish、credential、billable provider、public dogfood、post-release audit 和 stable graduation 证据；它只验收 P11 证据包，不执行这些敏感动作。 |
| `yolo/release/agent-integration-doctor` | native agent integration doctor 会校验 Codex/Claude YOLO skill、slash/source command 和 workflow artifacts 是否存在；它只读文件状态，不安装、不改 host。 |
| `yolo/release/real-project-dogfood` | real-project dogfood gate 会校验外部真实项目里的稳定 YOLO 入口证据（`/yolo-demand`、`/yolo-tasks`、`/yolo-spec`、`/yolo-check`、`/yolo-review`、`/yolo-release`、`/yolo-run`）；它不编辑代码、不执行 provider。 |
| `yolo/release/pi-execution-drill` | PI execution drill gate 会校验 PI mock/dry-run 或人工授权的 controlled billable evidence；SDK gate 本身不执行 provider 或 billable action。 |
| `yolo/release/runtime-boundary-decision` | runtime boundary decision gate 会校验 `./runtime` 从 experimental 晋级 stable 的人工批准记录和 rollback plan；它不修改 API boundary。 |
| `yolo/release/public-beta-evidence` | public beta evidence gate 会聚合 native agent、真实项目 dogfood、PI drill、runtime decision 和可选 manual external release 证据；它只产出 public beta/operator evidence 状态。 |
| `yolo/release/real-project-dogfood-pack` | isolated real-project dogfood pack 会创建隔离外部项目，跑 `yolo init`、agent bridge dry-run、skill/command dry-run doctor，并生成 idea、discovery、plan、PRD、check、review、accept、controlled-run no-code evidence；不安装、不执行 provider。 |
| `yolo/release/experience-pack-audit` | experience pack effectiveness audit 会制造相关/无关学习记录并验证下一次 prompt 只注入相关 bounded experience；不阻塞 prompt，不执行 provider。 |
| `yolo/release/nontechnical-ux-doctor` | non-technical UX doctor 会校验 README、agent docs、native skill、Claude/Codex command artifacts 都收束到一句话入口和 chat-first 规则；只读检查。 |
| `yolo/eval/benchmark` | benchmark fixtures 和 rubric scoring 可评估 discovery、PRD、UI acceptance、agent command、evidence 与 dogfood 质量；缺结果、低分或回归超阈值会 fail-closed。 |
| `yolo/pm` | requirement -> findings 仍是早期 PM 模块。 |
| `yolo/audit-to-prd` | audit 输入格式还未冻结。 |
| `sdk.prd.convertAuditToPrd` | 输入 contract 未完全公开。 |
| `sdk.prd.generateFindingsFromRequirement` | PM findings schema 未完全冻结。 |
| `sdk.prd.migratePrdGates` / `migratePrdFile` | 迁移策略仍可能随 gates 演进。 |
| `sdk.task.classifyTaskExecution` | task routing rules 仍会调整。 |
| `sdk.task.validateDiffQuality` | diff quality policy 仍会调整。 |
| `sdk.task.validateTestGeneration` | test generation policy 仍会调整。 |
| `sdk.spec.*` | requirement/design/task/evidence traceability policy 已接入执行前 gate，但 spec artifact lifecycle 尚未冻结。 |
| `sdk.evidence.*` | ledger write API、v1 event/artifact builder、validator、run-report generator 和 final-answer generator 可用。 |
| `sdk.review.*` finding helpers | scanner API stable；review finding v1 normalize/validate/output helpers 当前 experimental。 |
| `sdk.workflows.*` | workflow registry、skill descriptor validation、install plan、artifact writer、target `RULES.md` / `triggers.json` 和 target smoke 可用；真实 agent execution 仍是 experimental。 |
| `sdk.eval.*` | 固定 benchmark plan、fixture list、rubric scoring、regression report 和 `/yolo-eval` 同源；只写 evidence，不执行 provider 或发布动作。 |
| `sdk.parallel.*` | controlled parallel planning、task dependency graph、wave planning、worktree isolation plan、merge gate 和 evidence merge 可用；当前只通过 SDK façade 暴露，不提供 deep package export，shape 仍为 experimental。 |
| `sdk.commands.*` | 统一 `/yolo-*` command registry、usage、workflow routing 和 no-code/code-writing 分类；command shape 当前仍为 experimental。 |
| `sdk.doctor.*` | 只读 doctor report 和 plain-language formatter；用于 Codex/Claude chat 内判断当前项目能不能用、下一句说什么。 |
| `sdk.progress.*` | progress dashboard UI/UX evidence façade，可 build/inspect/run 本地 snapshot evidence，并能被 adapter bridge / acceptance evidence 消费。 |
| `sdk.pi.*` | PI lifecycle façade，等价组合 `createPiAgent()`、`createPiRunPlan()` 和 `runPiAgent()`；保持 experimental，避免把 PI 误声明为唯一 stable 入口。 |
| `sdk.fixtures.*` | fixture registry 和 `runFixtureHarness()` 可用，但还没有完整跨项目执行矩阵。 |
| `sdk.release.*` | release readiness 可以 fail-closed，并提供 change provenance、clean-environment verify、dogfood matrix、release candidate gate、package install smoke、public beta hardening drill、controlled beta release decision gate、operator release-state mutation helper、operator runbook gate、post-release audit gate、stable graduation gate、manual external release evidence gate、agent integration doctor、real-project dogfood gate、PI execution drill gate、runtime boundary decision gate、public beta evidence gate、real-project dogfood pack、experience-pack audit 与 non-technical UX doctor；发布前仍需要人工 release 决策，不能自动移除 `private=true` 或执行 publish/token/provider/report 操作。 |
| `sdk.runtime.*` | runner execution stateRoot 已有 smoke；runtime implementation 已 freeze-ready，但 SDK runtime namespace 仍未获得 stable-boundary approval。 |
| `sdk.provider.*` adapter helpers | `detectModelProvider()` stable；capability/budget/sandbox contract helpers、provider/runtime matrix 和 provider CLI dry-run matrix 当前 experimental。 |
| `sdk.project.*` | project bootstrap 可生成 `.yolo/` 和 `specs/` 基础结构，并能运行 init-to-first-PRD smoke；初始化模板仍会随 spec lifecycle 演进。 |
| `sdk.agents.createPiAgent` / `createPiPlan` / `runPi` | PI orchestration 仍处于高阶 preset 演进期。 |

## Internal

Internal 不承诺兼容，不建议外部项目 import。

- 根目录 compatibility/migration debt `.ts` shim 文件，构建后输出对应 `dist/*.js`。
- `lib/*`，当前是历史实现层；PI agent、PI runtimes 和 runner runtime 已迁入 `src/*`，剩余 lib 模块不承诺兼容。
- `closed-loop/*`，v1 legacy；边界和允许的只读兼容引用见 `docs/legacy-boundary.json`。
- `data/*`，本地 PRD/review/retry 样本和运行数据。
- `state/*`，运行时状态和证据。
- `hooks/*`，当前仅作为本项目 hook 实现。
- `src/runtime/execution/context-pack-validator.ts` 和 `src/review/findings-to-tasks.ts`，当前是 runner support modules；后续要么公开为 documented SDK API，要么继续 internal。
- `src/runtime/runner-core.ts`、`src/runtime/runner-core-helpers.ts`、`src/runtime/gates/*`、`src/runtime/evidence/*`、`src/runtime/task-state/*`、`src/runtime/task-loop/*`、`src/runtime/run-lifecycle/*`、`src/runtime/recovery/*`、`src/runtime/review-loop/*`、`src/runtime/progress/*`（除已登记的 `yolo/runtime/progress-ui-evidence` façade）、`src/runtime/parallel/*` 和 `src/runtime/execution/*`，当前是 runner/PI/team 拆分中的 internal runtime support，不在 package exports 中承诺兼容；其中 PRD contract doctor gate、spec governance gate、pre-execution gate orchestration、task-state transition helpers、task-loop status helpers、task outcome handler、task-loop side effects、task runner/main-loop/split application helpers、runner core helpers、embedded progress server、controlled parallel planner、run lifecycle state/orchestrator helpers、retry round/orchestrator recovery helpers、gate stuck recovery helpers、review-loop round/execution/task application/orchestrator helpers、provider execution adapter 和 runtime evidence ledger 已可被 runner/SDK 以纯函数方式调用，但仍未升为 stable public API；公开调用请走 experimental façade。
- `src/release/local-dogfood-evidence.ts` 和 `src/release/runtime-boundary-candidate.ts`，当前是内部 release 证据/决策 helper；它们不会发布、不会读凭证、不会执行 provider，也不会自动修改 public API boundary。

## CLI Contract

Public bin:

- `yolo`
- `yolo-gate`
- `yolo-pi`
- `yolo-prompt`
- `yolo-prd-preflight`
- `yolo-prd-migrate-gates`

Phase 1A 起，package bin 都指向 `bin/`。当前状态：

- `yolo` 直接调用 `src/cli/yolo.ts`；默认 `yolo run` 进入 `src/agents/pi.ts`，runner-only 调试入口才进入 `src/runtime/runner-runtime.ts`。
- `yolo-pi` 直接调用 `src/cli/pi.ts`。
- `yolo-gate` 直接调用 `src/cli/gate.ts`。
- `yolo-prompt` 直接调用 `src/cli/prompt.ts`，后者调用 import-safe 的 `prompt.ts` generator。
- `yolo-prd-preflight` 直接调用 `src/cli/prd-preflight.ts`。
- `yolo-prd-migrate-gates` 直接调用 `src/cli/prd-migrate-gates.ts`。

重要 `yolo` subcommands：

- `yolo run <prd.json>` 和 `yolo --prd <prd.json>` 默认进入 PI 主线：preflight -> runner -> review -> final schema gate -> acceptance -> ship -> learn；`yolo runner <prd.json>` 或 `yolo run --engine-only` 才是底层 runner 调试入口。
- `yolo progress-ui-evidence [path]` 会生成 progress dashboard UI/UX 本地 evidence；默认写入目标项目 `.yolo/state/evidence/progress-dashboard-ui/`，可被 `yolo run` / `yolo accept` 的 adapter bridge 消费。

## Compatibility Rules

- Public exports 必须 import-safe：import 不能启动 runner、server、模型调用、写状态或修改目标项目。
- Public SDK evaluator 必须以 SDK 实例的 `projectRoot` 为准，不能因为另一个 SDK 实例改变全局 root。
- Public SDK 的状态目录默认归属目标项目的 `.yolo/`，不能在 package install root / `node_modules/yolo` 下创建运行状态。
- CLI shim 改写时必须保留退出码、JSON 输出形状和常用参数。
- Experimental API 升级为 stable 前必须有单元测试、文档示例和至少一个 fixture。
- Internal API 被移动时只需要保证 public exports/bin 不破。
