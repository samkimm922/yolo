# YOLO SDK Gap Matrix

日期：2026-05-27

目的：把 YOLO 当前 SDK、PI agent、runner、gate 和 7 个参考项目做交叉对比，确定公开通用 SDK 的差距和解耦顺序。

执行进度表：`docs/yolo-public-sdk-progress.md`。后续按该表的 Ordered Todo 自动推进，遇到 public API/schema/架构方向变化或无法解释的测试失败再停止沟通。

## 结论

YOLO 现在不是一团完全不能用的脚本堆；它已经有 SDK 入口、PI preset、PRD preflight、contract gate、migration、runner runtime 和测试。但它也还不是一个可以放心公开的通用 SDK。

当前最关键的差距不是“要不要直接做 PI”。PI 已经是最高阶 preset，但公开 SDK 不能只围绕 PI。真正需要补齐的是：

- 稳定 SDK kernel：无 import 副作用、无全局 mutable root、API 版本边界已开始机器校验。
- 文件归位：CLI、core、prd、spec、runtime、agents、review、evidence、adapters 分层；root `.ts` public/compat entry 已收敛到 7 个，非 public root 脚本已批量下沉到 `src/`/`bin/`。
- runner 解耦：`runner.ts` 已从旧单体降到 16 行兼容入口；review/retry/run lifecycle pipeline、task execution loop、main loop、split PRD 写回、runner helper、embedded progress server、shutdown/timeout/fatal cleanup、context、progress log、recovery checkpoint、task runtime bindings、process handlers 和 runtime API freeze inspector 都已进入 `src/runtime/*` 可测模块；internal `src/runtime/runner-core.ts` 已压到 599 行。
- spec governance：requirement/design/evidence trace 已接入 preflight 和 runner fail-closed，`yolo init` 已能生成 `.yolo/` 和 `specs/` 基础结构，`yolo/spec/lifecycle` 已提供 requirements/design/tasks/changes artifact helpers；完整 refinement/export loop 仍未冻结。
- evidence ledger：已有 `state/` 事件流、`sdk.evidence` experimental façade、v1 ledger/artifact schema、review finding v1 schema、run-report JSON/Markdown 和 final-answer JSON/Markdown 生成；report 已汇总 gate failure、review issue、fixture run、spec governance 事件。
- 插件/技能/运行时适配：runtime/agent adapter contract 已覆盖 Claude/Codex/custom 的 capability、budget、sandbox policy；provider/runtime matrix 已能检查 Claude/Codex/custom detection、invocation path、gate log-dir 和 runner runtime stateRoot；provider CLI dry-run matrix 已能描述真实 CLI command/stdin/output capture/budget/sandbox/stop conditions，并确保 dry-run 不 spawn provider；workflow registry 和 `src/workflows/install.mjs` 已能生成可安装 skill artifacts、校验 descriptor、写入 target 级 `RULES.md` / `triggers.json`，并 smoke `.yolo/skills` / `.agents/skills` / `.claude/skills` / `.codex/skills` 等目标目录；`tools/install-agent-bridge.mjs` 现在会安装项目级 `AGENTS.md`/`CLAUDE.md`、`.codex/.claude` YOLO skills、Claude Code `.claude/commands/yolo*.md` slash commands，以及 Codex `~/.agents/skills/yolo` 用户级 native skill 和单个 `source-command-yolo` fallback，不再生成顶层 `~/.agents/skills/yolo-*` 阶段入口；Codex 内部 workflow 使用 `WORKFLOW.md`，避免 `yolo.pi` 这类内部名污染 slash 菜单；billable agent execution 仍需人工确认。
- legacy 边界：`docs/legacy-boundary.json` 和 `__tests__/legacy-boundary.test.ts` 已锁住 `closed-loop/` 作为 archived_readonly evidence，不允许 package export/bin、SDK facade 或 `src/**/*.ts` import/execute archived closed-loop 模块；只保留 PRD discovery、validation、migration、dev inventory 等只读兼容引用。
- init-to-first-PRD smoke：`src/core/init-smoke.mjs`、`yolo/core/init-smoke` 和 `sdk.project.*` smoke helpers 已证明陌生项目可从 bootstrap 生成 spec package、first PRD、preflight pass，并通过 runner runtime dry-run readiness，不触发真实 provider/runner 执行。
- root script migration：`atomic-task-doctor.mjs`、`prd-contract-doctor.mjs`、`provider-doctor.mjs`、`pm`、`audit-to-prd`、`contract`、`scanner`、`validate-prd`、progress/devtool/gate helper、`learn`、`state-snapshot`、`session-memory` 类实现已迁入 `src/*` 或 `bin/*`；根目录当前只保留 7 个 compatibility/public entry，且 `migrate_to_src` 清零。
- package install smoke：`package.json` 已有 `files` allowlist，`src/release/pack-smoke.mjs`、`yolo/release/pack-smoke` 和 `sdk.release.runPackageInstallSmoke()` 已证明 tarball 不包含 `__tests__`/`state`/`data`/`closed-loop` 等工作区文件，并能在临时外部项目安装、import 全部 public exports、调用 `.bin/yolo --help`、通过安装后的 SDK 真执行 pending dry-run task、provider/runtime matrix、provider CLI dry-run matrix、workflow target smoke 和 workflow rules/trigger index；package allowlist 已包含 agent bridge 安装器、P37-P39 release audit helpers 和 Codex/Claude 非技术用户集成文档。
- public beta hardening drill：`src/release/hardening-drill.mjs`、`yolo/release/hardening-drill` 和 `sdk.release.runPublicBetaHardeningDrill()` 已串起 release readiness、pack/install、fixture registry、API/docs consistency、provider CLI dry-run 和 workflow target smoke；实跑结果是 drill pass，但 release 仍被 `PACKAGE_PRIVATE_RELEASE_BLOCK` 正确阻断，且未发布、未改 `private:true`、未触碰凭证、未执行 billable provider。
- controlled beta decision gate：`src/release/decision-gate.mjs`、`yolo/release/decision-gate` 和 `sdk.release.runControlledBetaReleaseDecisionGate()` 已把移除 `private:true`、publish、credential access、billable provider execution 全部放到人工决策记录后；无决策默认 blocked，有决策只返回 authorization，不执行发布、不改包、不读凭证、不执行 provider。
- operator release-state helper：`src/release/operator-state.mjs`、`yolo/release/operator-state` 和 `sdk.release.runOperatorReleaseStateMutation()` 已支持默认 dry-run 与显式 `apply + allowWorkspaceMutation` 的 package `private` removal；必须先通过 P6 decision gate，且仍不执行 publish、不读凭证、不执行 provider。
- operator runbook gate：`src/release/operator-runbook.mjs`、`yolo/release/operator-runbook` 和 `sdk.release.runOperatorReleaseRunbookGate()` 已把真实 publish、credential、billable provider 和 public dogfood report 收束成 manual-only runbook；它只校验授权与证据，不执行 `npm publish`、不读取 token、不执行 provider、不发布报告。
- post-release audit gate：`src/release/post-release-audit.mjs`、`yolo/release/post-release-audit` 和 `sdk.release.runPostReleaseAuditGate()` 已能校验人工外部发布记录、operator runbook ready、post-release hardening、package install smoke 和 public dogfood audit evidence；它只审计证据，不执行发布、token、provider 或报告操作。
- stable graduation gate：`src/release/stable-graduation.mjs`、`yolo/release/stable-graduation` 和 `sdk.release.runStableGraduationGate()` 已能在 post-release audit 之后校验 public readiness、semver >=1.0.0、root entrypoint budget、stability review、runner runtime API freeze report 和 public dogfood evidence；runtime implementation freeze-ready，当前真实包仍会被 `private:true`、0.x、`./runtime` experimental boundary 和真实外部 evidence 阻断。
- local dogfood evidence：`src/release/local-dogfood-evidence.mjs` 已能组合 public beta hardening drill、fixture registry coverage 和 runtime implementation-ready report，产出 local-only dogfood evidence；它明确不发布、不读凭证、不执行 provider、不冒充 public dogfood。
- runtime stable-boundary candidate：`src/release/runtime-boundary-candidate.mjs` 已能检查 `./runtime` 当前 package export target、API boundary tier 和 runtime API freeze report，并在 implementation-ready 且仍为 experimental 时产出 `ready_for_decision` 决策包；它只列出批准后应修改的文档/manifest，不自动修改 public API boundary、不声明 stable。
- manual external release evidence gate：`src/release/manual-external-release.mjs`、`yolo/release/manual-external-release` 和 `sdk.release.runManualExternalReleaseGate()` 已能校验 P11 人工外部执行证据包：publish、credential、billable provider、public dogfood、post-release audit 和 stable graduation 证据必须完整；函数仍不执行发布、token、provider 或报告操作。
- P28-P39 public beta evidence gates：`src/release/agent-integration-doctor.mjs`、`real-project-dogfood.mjs`、`pi-execution-drill.mjs`、`runtime-boundary-decision.mjs`、`public-beta-evidence.mjs`、`real-project-dogfood-pack.mjs`、`experience-pack-audit.mjs` 和 `nontechnical-ux-doctor.mjs` 已通过 package export 和 `sdk.release.*` 暴露；它们校验 native Codex/Claude skill/command 安装、外部项目 plan/check/review dogfood、PI dry-run 或人工授权 billable evidence、`./runtime` stable-boundary approval、public beta/stable evidence bundle、隔离外部项目 dogfood pack、experience pack 有效性和非技术入口，仍不发布、不读凭证、不执行 provider；当前 dogfood pack v2 已扩展到 idea/discovery/plan/PRD/check/review/accept/controlled-run 证据。
- Memory center：新增 `src/runtime/memory/center.mjs`、`src/runtime/memory/retention.mjs`、`src/runtime/learning/center.mjs`、`src/runtime/devtools/memory-center.mjs` 和 `yolo memory refresh`；YOLO 自身 canonical memory 位于 `docs/memory/`，外部项目 bootstrap 会生成 `.yolo/memory/` 与 `.yolo/state/*.jsonl`，并把 `.md/.jsonl` 文件分成 keep/refresh/archive/delete-candidate；`DOCUMENT_GOVERNANCE.md` 已成为文档唯一归位和命名规则报告；活跃 ledger 超限时会先归档到 `state/archive/jsonl/YYYY-MM/` 或 `.yolo/state/archive/jsonl/YYYY-MM/`，再保留最近记录；旧 learning/lessons/knowledge 来源会去重迁移到 `learning.jsonl`，公开包 docs 不打印本地 legacy 项目经验细节；prompt 生成会从当前项目 `learning.jsonl` 检索少量相关 experience pack，检索失败静默跳过，不再依赖 legacy `closed-loop/knowledge-load` 注入。
- 外部安装 state/root 隔离：`sdk.paths.stateRoot` 默认指向目标项目 `.yolo`；`createYoloSdk()` 不再初始化 package root；SDK 下 `yoloPath()` 和 PI 默认 artifacts 归属项目 `.yolo`；pack smoke 已验证 SDK/init/PI plan 不会生成 `node_modules/yolo/state|data|logs`。
- runner execution stateRoot：`sdk.runtime.runRunner()` 会把 `projectRoot/stateRoot` 传入真实 runner；runner startup/finalize/snapshot/task-results/task-logs/contract evidence/retry data/gate log-dir 均可落到目标项目 `.yolo`，并有 pending `dry_run_artifact` task smoke 覆盖。
- 跨项目 fixtures：已有 experimental fixture registry、隔离执行 harness，并覆盖 `node-basic`、`no-tests`、`python-basic`、`python-service`、`frontend-vite`、`backend-api`、`monorepo`、`dirty-tree`、`failing-baseline`；harness 现在会校验安全命令、相对 evidence path、全部 expected artifacts 和 primary evidence schema；真实大型项目仍待补。
- Fresh task session：每个 task attempt 现在会生成 session id、prompt Fresh Session Contract 和 `task_session_start` event，把可用上下文、禁止沿用的上下文和 task/attempt 边界写成证据，避免跨 task session 污染。

粗略完成度：

| 层级 | 当前完成度 | 判断 |
|---|---:|---|
| 可调用 SDK facade | 99% | `sdk.ts` 已暴露核心能力、`sdk.pi.*`、`sdk.commands.*`、`sdk.doctor.*`、provider adapter helpers、provider/runtime matrix、provider CLI dry-run matrix、workflow skill target smoke、workflow rules/trigger convention、9 fixture registry/harness、public export src implementations、root compatibility shims、final-answer helpers、init smoke helpers、package install smoke helpers、public beta hardening drill、controlled decision gate、operator state helper、operator runbook gate、post-release audit gate、stable graduation gate、manual external release evidence gate、agent integration doctor、real-project dogfood gate、PI execution drill、runtime boundary decision gate、public beta evidence bundle、real-project dogfood pack、experience-pack audit、non-technical UX doctor、`stateRoot` 和 runner execution stateRoot 注入，且 legacy public 边界已锁住；runner 根入口已经是兼容 shim。 |
| 公开稳定 SDK | 95% | 已有机器可读 API boundary、version policy、import-safe 检查、runtime adapter contract、provider/runtime matrix、provider CLI dry-run matrix、workflow install/target smoke/rules/trigger contract、legacy boundary、first-PRD smoke、npm pack/install smoke、hardening drill、controlled decision gate、operator state helper、operator runbook gate、post-release audit gate、stable graduation gate、manual external release evidence gate、agent integration doctor、real-project dogfood gate、PI execution drill、runtime boundary decision gate、public beta evidence bundle、runtime API freeze inspector、local dogfood evidence drill、runtime stable-boundary candidate inspector、backend API fixture、python service fixture、public export src migration、root entrypoint budget、SDK stateRoot 隔离、runner stateRoot smoke、task-loop、shutdown lifecycle、context/process/checkpoint/task runtime bindings 和 orchestrator 单测；runtime implementation blockers 已清零，当前真实包仍被 `private:true`、0.x、`./runtime` experimental boundary 和真实外部 evidence 阻断 stable。 |
| 通用开发自动化平台 | 96% | spec gate、evidence ledger、workflow registry、eval benchmark、controlled parallel planner、runtime adapter contract、provider/runtime matrix、provider CLI dry-run matrix、skill target smoke、workflow rules/trigger convention、agent integration doctor、real-project dogfood gate、PI execution drill、runtime boundary decision gate、public beta evidence bundle、backend API fixture、python service fixture、public export src migration、root entrypoint budget、PI src implementation、final-answer artifact、legacy boundary、init-to-first-PRD smoke、package install smoke、hardening drill、controlled decision gate、operator state helper、operator runbook gate、post-release audit gate、stable graduation gate、manual external release evidence gate、runtime API freeze inspector、runtime boundary candidate inspector、SDK stateRoot 隔离、runner stateRoot smoke、task-loop、shutdown lifecycle、context/process/checkpoint/task runtime bindings 和 review/retry/run lifecycle orchestrator 都已有雏形；真实 publish、billable execution 实战和真实 dogfood 报告仍未完成。 |
| PI 高阶 agent | 90% | 有 `src/agents/pi.mjs` / `src/runtime/pi-runtimes.mjs` 实现态、plan/dry-run/execute/preflight、agent adapter contract、provider/runtime matrix、provider CLI dry-run matrix、PI/review/fix/ship skill target smoke、workflow rules/trigger index、backend API fixture、python service fixture、public export src migration、runner dry-run readiness、外部 package import smoke、PI plan artifact stateRoot、runner execution stateRoot、hardening drill、controlled decision gate、operator state helper、operator runbook gate、post-release audit gate、stable graduation gate、manual external release evidence gate 和 PI execution drill gate；billable execution 需要人工确认。 |

## 当前 YOLO 证据

本轮检查的本地证据：

- `sdk.ts` 暴露 `config`、`paths`、`contract`、`prd`、`task`、`provider`、`runtime`、`agents`、`review`、`progress` namespace；`sdk.paths.stateRoot` 默认是目标项目 `.yolo`。
- `package.json` 已有 52 个 package exports、6 个 bin 和显式 `files` allowlist：`yolo`、`yolo-pi`、`yolo-gate`、`yolo-prompt`、`yolo-prd-preflight`、`yolo-prd-migrate-gates`；`./pm`、`./audit-to-prd`、`./contract`、`./scanner`、`./validate-prd`、`./core/setup`、`./runtime/adapter-evidence`、`./runtime/progress-ui-evidence`、`./eval/benchmark`、`./release/hardening-drill`、`./release/decision-gate`、`./release/change-provenance`、`./release/clean-environment-verify`、`./release/dogfood-matrix`、`./release/operator-state`、`./release/operator-runbook`、`./release/post-release-audit`、`./release/stable-graduation`、`./release/manual-external-release`、`./release/agent-integration-doctor`、`./release/real-project-dogfood`、`./release/pi-execution-drill`、`./release/runtime-boundary-decision`、`./release/public-beta-evidence`、`./release/real-project-dogfood-pack`、`./release/experience-pack-audit` 和 `./release/nontechnical-ux-doctor` 已指向 `src/`。
- `docs/sdk-agent-architecture.md` 已明确 PI 是最高阶 preset，SDK 不应 PI-only。
- 根目录当前有 7 个 `.ts` 文件：7 个 public/compat entry（`sdk.ts`、`runner.ts`、`gate.ts`、`prompt.ts`、`learn.ts`、`state-snapshot.ts`、`session-memory.ts`），死测试配置已移除；其中只有 `sdk.ts` 是允许保留的 root SDK facade，其余 public/compat entry 都指向 `src`/`bin` 或 `dist` runtime。
- 8 个根目录 `.mjs` 文件已全部登记在 `docs/root-entrypoint-inventory.json`，并由 `__tests__/root-entrypoint-inventory.test.mjs` 阻止新增未归类根脚本；shim target 也会被检查必须存在，当前 `migrate_to_src` / `legacy_pending` 均为 0。
- `docs/public-sdk-api-boundary.json` 已登记 package exports、`sdk.mjs` named exports 和 `createYoloSdk()` namespace 的 stable/experimental 分级，并由 `__tests__/public-sdk-boundary.test.mjs` 与 release readiness 检查。
- `src/core/bootstrap.mjs`、`yolo/core/bootstrap`、`sdk.project.initProject()` 和 `yolo init` 已能生成 `.yolo/`、`.yolo/templates/`、`.yolo/constitution.md`、`specs/requirements.md`、`specs/design.md`、`specs/tasks.md`，默认不覆盖已有文件。
- fixture matrix 已扩到 9 个并全部可由 harness 隔离执行：`node-basic`、`no-tests`、`python-basic`、`python-service`、`frontend-vite`、`backend-api`、`monorepo`、`dirty-tree`、`failing-baseline`。
- `src/spec/lifecycle.mjs`、`yolo/spec/lifecycle` 和 `sdk.spec.*` 已提供 requirement/design/task/change artifact builders、cross-reference inspector、lifecycle -> PRD 转换。
- `src/runtime/adapters/agent-contract.mjs`、`src/runtime/adapters/provider-doctor.mjs`、`src/runtime/adapters/provider-runtime-matrix.mjs`、`yolo/runtime/adapters` 和 `sdk.provider.*` adapter helpers 已提供 Claude/Codex/custom capability、budget、sandbox、approval policy contract，并能 fail-closed 阻断缺失命令、unsafe permission、unsafe sandbox、provider selection mismatch、gate log-dir mismatch 和 dry-run matrix 试图执行 provider。
- `src/runtime/progress/ui-evidence.mjs`、`yolo/runtime/progress-ui-evidence`、`sdk.progress.*` 和 `yolo progress-ui-evidence` 已把 progress dashboard UI/UX 验证做成本地 evidence harness；`yolo run --collect-evidence --execute-adapter --allow-adapter-commands` 可在 UI PRD 下显式采集 HTML snapshot / `ui_evidence`，acceptance adapter 可消费。
- `src/runtime/execution/atomic-task-doctor.mjs` 和 `src/runtime/gates/prd-contract-doctor.mjs` 已承接原根目录 doctor 实现，根目录 shim 只保留兼容入口。
- `src/workflows/install.mjs`、`yolo/workflows/install` 和 `sdk.workflows.*` install helpers 已提供 workflow skill descriptor validation、install plan、`SKILL.md`/`skill.json` artifact writer、target `RULES.md` / `triggers.json`、target index 和 target smoke；可验证外部项目 `.yolo/skills`、`.agents/skills`、`.claude/skills`、`.codex/skills`，并阻断 package root 污染。
- `tools/install-agent-bridge.mjs` 已提供 project/user scope 安装计划和写入器：project scope 写 `AGENTS.md`、`CLAUDE.md`、`.codex/skills/yolo`、单个 `.codex/skills/source-command-yolo` fallback、`.claude/skills/yolo`、`.claude/commands/yolo*.md`；user scope 写 `~/.agents/skills/yolo`、单个 `~/.agents/skills/source-command-yolo` fallback、`~/.claude/skills/yolo`、`~/.claude/commands/yolo*.md`；Codex workflow descriptor 写为 `WORKFLOW.md`，并清理旧顶层 `yolo-*` / `source-command-yolo-*` 菜单噪音；dry-run 不写盘，真实写入会保留已有文件并用 `--force` 才覆盖非 bridge 产物。
- `src/runtime/evidence/report.mjs`、`yolo/evidence/report` 和 `sdk.evidence.*` 已能从 run-report 派生 final-answer JSON/Markdown artifact，并把路径写回 runner return result。
- `docs/legacy-boundary.json` 和 `__tests__/legacy-boundary.test.mjs` 已明确 `closed-loop/` 是 v1 legacy_readonly，并阻止 package exports/bin、SDK facade、`src/**/*.mjs` 直接 import/execute closed-loop 模块。
- `src/core/init-smoke.mjs`、`yolo/core/init-smoke` 和 `sdk.project.runInitToFirstPrdSmoke()` 已能在陌生项目里执行 `init -> spec lifecycle -> first PRD -> preflight -> runner dry-run readiness`。
- `src/release/pack-smoke.mjs`、`yolo/release/pack-smoke` 和 `sdk.release.runPackageInstallSmoke()` 已能执行真实 `npm pack -> npm install <tarball> -> import public exports -> .bin/yolo --help` smoke，并阻断 `__tests__`、`state/`、`data/`、`closed-loop/` 等工作区文件进入 tarball；安装后 SDK smoke 同时覆盖 provider/runtime matrix、provider CLI dry-run matrix、workflow target smoke 和 workflow rules/trigger index。
- `src/release/hardening-drill.mjs`、`yolo/release/hardening-drill` 和 `sdk.release.runPublicBetaHardeningDrill()` 已能执行不发布 hardening drill：readiness、pack/install、fixture registry、API/docs consistency、provider CLI dry-run 和 workflow target smoke 全部通过；`private:true` 仍作为 intentional release blocker 保留。
- `src/release/decision-gate.mjs`、`yolo/release/decision-gate` 和 `sdk.release.runControlledBetaReleaseDecisionGate()` 已能执行 controlled beta release decision gate：P5 drill 必须 pass，release blocker 只能剩 `PACKAGE_PRIVATE_RELEASE_BLOCK`，并要求人工 decision record 显式批准 requested actions；函数本身不发布、不改包、不读凭证、不执行 provider。
- `src/release/operator-state.mjs`、`yolo/release/operator-state` 和 `sdk.release.runOperatorReleaseStateMutation()` 已能执行 operator-approved release-state mutation：无 P6 ready decision 默认 blocked，dry-run 默认不改包，显式 `apply + allowWorkspaceMutation` 才会移除 package `private` 字段；publish/credentials/provider 永远不在函数内执行。
- `src/release/operator-runbook.mjs`、`yolo/release/operator-runbook` 和 `sdk.release.runOperatorReleaseRunbookGate()` 已能执行 final operator runbook gate：publish 必须有 applied operator state 和 P6 authorization，credential/billable 必须显式授权，public dogfood report 必须有 pass/evidence/privacy/approval；返回 manual commands，但不执行任何命令。
- `src/release/post-release-audit.mjs`、`yolo/release/post-release-audit` 和 `sdk.release.runPostReleaseAuditGate()` 已能执行 post-release audit gate：必须有人工外部发布记录、P8 runbook ready、post-release hardening pass、package install smoke pass 和 public dogfood audit pass；函数仍不执行发布或凭证/provider/report 操作。
- `src/release/stable-graduation.mjs`、`yolo/release/stable-graduation` 和 `sdk.release.runStableGraduationGate()` 已能执行 stable graduation gate：必须有 P9 audit pass、public readiness pass、stable semver、root script budget、stability review、runtime API freeze report 和 public dogfood evidence；runtime implementation 当前 freeze-ready，但真实状态仍会因 public boundary/release evidence fail-closed。
- `src/release/local-dogfood-evidence.mjs` 已能执行 local-only dogfood evidence drill：hardening、fixture coverage、runtime implementation-ready 三类证据必须通过，但结果不会声明 public dogfood、不会发布报告、不会读凭证或执行 provider。
- `src/release/runtime-boundary-candidate.mjs` 已能执行 runtime stable-boundary candidate inspection：当前 workspace 返回 `ready_for_decision`，但只产出人工批准前的建议修改清单，不会修改 `docs/public-sdk-api-boundary.json`、不会把 `./runtime` 声明为 stable。
- `src/release/manual-external-release.mjs`、`yolo/release/manual-external-release` 和 `sdk.release.runManualExternalReleaseGate()` 已能执行 P11 manual external release evidence gate：必须有人工外部 publish、credential、billable provider、public dogfood、post-release audit 和 stable graduation evidence；当前真实状态会因缺少人工证据和 stable blockers fail-closed。
- `src/release/agent-integration-doctor.mjs`、`real-project-dogfood.mjs`、`pi-execution-drill.mjs`、`runtime-boundary-decision.mjs` 和 `public-beta-evidence.mjs` 已补齐 P28-P32：native agent integration doctor、真实外部项目 plan/check/review dogfood、PI dry-run/billable authorization drill、`./runtime` stable-boundary approval gate 和 public beta/stable evidence bundle gate；这些 gate 全部 evidence-only，默认 fail-closed。
- `src/release/real-project-dogfood-pack.mjs`、`experience-pack-audit.mjs` 和 `nontechnical-ux-doctor.mjs` 已补齐 P37-P39：隔离外部项目 dogfood pack 会完整跑 init、agent bridge dry-run、skill/command dry-run doctor 和 idea/discovery/plan/PRD/check/review/accept/controlled-run evidence gate；experience audit 会制造相关/无关学习记录并验证 prompt 只注入相关 bounded experience；non-technical UX doctor 会校验一句话入口和 chat-first command artifacts。
- 外部安装 smoke 已覆盖 `createYoloSdk()`、`sdk.project.initProject()`、`sdk.agents.createPiPlan()` 和 `sdk.runtime.runRunner()` pending dry-run task，验证 package root 不产生 `state/`、`data/`、`logs/`，项目状态归入 consumer `.yolo`。
- `__tests__/runner-state-root.test.mjs` 已覆盖 SDK 调真实 runner 执行 pending `dry_run_artifact` task，并验证 run report、progress snapshot、contract evidence、task-results、task-log 都写入 consumer `.yolo`，package root 不生成对应 run report。
- `docs/api-reference.md`、`docs/fixture-matrix.md`、root CHANGELOG、docs CHANGELOG 和 `docs/memory/` 已覆盖 public beta API、fixture matrix、runtime adapter contract、provider/runtime matrix、provider CLI dry-run matrix、workflow target smoke、workflow rules/trigger index、hardening drill、controlled decision gate、operator state helper、operator runbook gate、post-release audit gate、stable graduation gate、manual external release evidence gate、P28-P39 evidence gates、runtime boundary candidate、memory center 状态、document governance 和剩余 release blockers；release readiness 会检查核心 public docs，package smoke 会检查 memory docs 进入 tarball。
- 当前文档结构事实由 `docs-truth-sync` 锁住：`src/**/*.ts` 198 个、`__tests__/*.test.ts` 167 个、`docs/**/*.md` 29 个、根目录 `.ts` 7 个。
- 根目录和子目录共有 56 个带 shebang 的 `.mjs`/`.sh` 脚本。
- `runner.ts` 16 行，是兼容 CLI/import entrypoint；实现已迁入 `src/runtime/runner-core.ts`，并继续拆出 `src/runtime/runner-core-helpers.ts`、`src/runtime/progress/embedded-server.ts`、`src/runtime/run-lifecycle/shutdown.ts`、`context.ts`、`progress-log.ts`、`recovery-checkpoints.ts`、`task-runtime-bindings.ts`、`process-handlers.ts` 和 `runtime-api-freeze.ts`；review/retry/run lifecycle pipeline、task execution loop、main loop、split PRD 写回、shutdown/timeout/fatal cleanup、context/checkpoint/process bindings 已拆到 internal runtime modules。
- `src/**/*.ts` 198 个，`__tests__/*.test.ts` 167 个；`docs/yolo-public-sdk-progress.md` 与本文的结构数字已由 `docs-truth-sync` 测试锁住。
- spec governance gate 已抽到 `src/runtime/gates/spec-governance-gate.mjs`，并由 `prd-preflight.mjs`、runner runtime 和 `runner.mjs` 执行前统一调用。
- fixture harness 已抽到 `src/fixtures/harness.mjs`，可以把 fixture 复制到临时目录、运行 smoke command、写入 evidence artifact，并校验全部 expected evidence artifact、primary evidence schema 和安全命令策略。
- `closed-loop/` 仍有 40 个文件，但 v1/v2 边界已由 legacy manifest 和结构测试锁为 readonly compatibility。
- `data/` 有 34 个顶层 JSON，PRD、review、retry、findings 混放。
- `runner.mjs` 曾动态引用缺失的 `context-pack-validator.mjs` 和 `review-to-prd.mjs`；首批 Phase 0 已补齐这两个模块，并增加测试覆盖。

## 7 项目交叉信号

| 参考项目 | 强项 | YOLO 已有接近部分 | YOLO 主要差距 | 应吸收的设计 |
|---|---|---|---|---|
| Superpowers | 可组合 skills、强制工作流、brainstorm/spec/plan/subagent/TDD/review/worktree/finish 流程，支持多 agent 安装。 | 有 agent presets、review、gate、PRD contract、experimental workflow registry 和 skill artifact installer。 | 跨 agent 安装约定仍未冻结，真实 skill 验证夹具还少。 | 把 PI 拆成可组合 skills/workflows；每个 workflow 有触发条件、输入、输出、验证。 |
| Spec Kit | `specify init` 初始化项目结构，spec-driven development，面向不同 AI coding agent 生成命令/规则/目录。 | 有 PRD schema、preflight、contract gate。 | 没有项目 bootstrap、constitution/memory、需求到设计到任务的正式 artifact 生命周期。 | 增加 `yolo init`、`spec/requirements`、`spec/design`、`spec/tasks`、project constitution。 |
| OpenSpec / OpenSpecification | Requirements -> Design -> Tasks 三阶段、迭代 refinement、导出、Mermaid、模型可选。 | PI 已有 requirement -> findings -> PRD -> runner。 | 缺少设计阶段、一阶段一确认、refinement loop、可导出 spec 包。 | 在 PRD 前增加 design artifact，PRD 后增加 task artifact，保留每阶段审查记录。 |
| gstack | 长驻 runtime daemon、低延迟、状态文件、token auth、安全分层、适配器思想。 | 有 runtime namespace、progress server、state JSONL，agent adapter contract 已开始描述 provider capability。 | server/security/state 还没有作为 SDK 抽象，adapter contract 还未扩到长驻 runtime daemon。 | 对长任务和浏览器/UI agent 做 runtime adapter，CLI 只做薄入口。 |
| GSD / gsd-2 | commands/workflows/agents/references/templates/hooks/CLI tools 分层，`.planning/` 状态，跨 runtime 安装，context engineering。 | 有 PRD/gates/hooks/docs/state 的雏形、experimental `src/workflows/registry.mjs`、`src/workflows/install.mjs`、target `RULES.md` / `triggers.json` convention 和 adapter contract。 | YOLO 文件归位仍不够，reference/template 层和真实 CLI 执行矩阵还不完整。 | 建立 workflow layer、reference layer、template layer；把状态、人类可读计划和机器证据分离。 |
| Ralph | fresh context per iteration、文件/git 作为记忆、单 story 循环、PRD 状态更新、agent 命令可换。 | runner 有任务循环、retry、gate、state，agent command/capability contract 已开始抽出。 | runner 是单体；fresh-session 协议、story lock/stale reopen 和真实命令替换验证仍不完整。 | 每个 task/story 独立执行上下文，状态落盘，可恢复、可换 agent。 |
| mattpocock-skills | 小而可组合、模型无关、强调用户控制而非大流程接管，skills 可按需安装。 | SDK preset 方向符合“不是 PI-only”。 | YOLO 还偏大一体化，公共接口还没拆成小能力包。 | 保持 core SDK 小、明确、可替换；PI 是组合结果，不是唯一入口。 |

上游证据来源：

- Superpowers: https://github.com/obra/superpowers
- Spec Kit: https://github.com/github/spec-kit
- OpenSpecification: https://github.com/spenceriam/OpenSpecification
- Ralph: https://github.com/iannuttall/ralph 和 https://github.com/snarktank/ralph
- Matt Pocock skills: https://github.com/mattpocock/skills
- GSD: https://github.com/gsd-build/get-shit-done；本轮也核对了本机安装快照 `~/.agents/skills/gsd/README.md` 和 `~/.agents/skills/gsd/docs/ARCHITECTURE.md`
- gstack: https://github.com/garrytan/gstack；本轮也核对了本机安装快照 `~/.agents/skills/gstack/ARCHITECTURE.md`
- UI/UX references: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill、https://github.com/nexu-io/open-design、https://github.com/DovAmir/awesome-design-patterns、https://github.com/goabstract/Awesome-Design-Tools、https://github.com/VoltAgent/awesome-design-md

## 能力矩阵

| 能力 | YOLO 当前状态 | 参考项目最强信号 | 差距 | 优先级 |
|---|---|---|---|---|
| 公共 SDK kernel | `sdk.mjs` 可调用，主要 public exports 已通过 `src/` façade 暴露；contract evaluator 已按 SDK 实例 root scoped；provider/doctor/PM/audit/contract/scanner/validator 类实现已迁到 `src/*`；API boundary、API reference、fixture matrix、version policy、hardening drill、controlled decision gate、operator state helper、operator runbook gate、post-release audit gate、stable graduation gate、manual external release evidence gate 和 P28-P32 evidence gates 已机器校验。 | Matt skills 的小模块、GSD CLI tools、gstack adapter 边界。 | 需要 semver/deprecation 实战和更多 dogfood 证据。 | operator evidence |
| CLI 薄封装 | `package.json` bin 已指向 `bin/`，公开 bin 已直接调用 `src/cli/*`；根 `runner.mjs` 也是 16 行 shim；hardening drill、decision gate、operator state helper、operator runbook gate、post-release audit gate、stable graduation gate、manual external release evidence gate 和 public beta evidence bundle 已证明不发布场景下外部安装、人工发布授权、release-state mutation、最终人工 runbook、发布后审计、stable 升级与 evidence bundle 边界可跑。 | gstack compiled CLI -> daemon；GSD commands -> workflows -> tools。 | runtime core 仍未冻结为 stable public API，真实发布/凭证/billable provider 需要人工确认。 | operator evidence |
| PRD schema/gate | 已有 schema、contract doctor、preflight、migration；spec governance 已在执行前 fail-closed；spec lifecycle artifact helpers、init 后 first-PRD smoke、provider/runtime matrix、provider CLI dry-run matrix、runner stateRoot smoke、hardening drill、decision gate、operator state helper、operator runbook gate、post-release audit gate、stable graduation gate、manual external release evidence gate 和 real-project dogfood gate 已补。 | Spec Kit、OpenSpec、GSD gates。 | 缺 refinement loop、导出包和真实 dogfood 报告。 | operator evidence |
| PI agent | 有 `src/agents/pi.mjs` 实现态、dry-run plan、execute 链路、provider adapter contract、provider CLI dry-run matrix、workflow skill target convention 和 PI execution drill gate。 | Superpowers subagent flow、Ralph fresh loop。 | PI 仍依赖 runner runtime，billable execution 需要人工确认。 | operator evidence |
| runner task loop | 有执行、retry、review、gate；review/retry/run pipeline、task execution loop、main loop、split PRD 写回、runner helper、embedded progress server、shutdown lifecycle、context、checkpoint、process handlers 和 task runtime bindings 已拆到 internal modules，根入口是 16 行 shim，runner-core 599 行。 | Ralph 单 story fresh loop、GSD phase execution。 | billable execution 和真实 dogfood 仍缺证据。 | operator evidence |
| review/fix loop | 有 scanner、auto-fix、review backlog。 | Superpowers two-stage review、Ralph QA fixer。 | review evidence 与 PRD task 转换未稳定成 SDK API。 | P1 |
| evidence ledger / memory center | 有 JSONL state、evidence 目录、experimental `sdk.evidence` façade、v1 ledger/artifact schema、review finding v1 schema、run-report 聚合、final-answer artifact、canonical `docs/memory/` / `.yolo/memory/` 记忆中心，以及 `DOCUMENT_GOVERNANCE.md` 文档唯一归位规则。 | GSD `.planning/`、Ralph `.ralph/`、gstack state file。 | legacy 无 run_id 事件仍需逐步规范；memory center 已审计但删除候选仍需人工确认。 | P1/P2 |
| UI/UX evidence | progress dashboard 已有 lifecycle-aware server、XSS escaping hardening、本地 UI evidence harness、HTML snapshot artifact、adapter-consumable `ui_evidence`、`sdk.progress.*` 和 `yolo progress-ui-evidence`；`yolo run` 可在显式授权下触发 UI evidence collection。 | ui-ux-pro-max 的 UI 质量域、open-design / awesome-design-md 的设计 contract、Awesome Design Tools / awesome-design-patterns 的工具与模式清单。 | 还缺真实浏览器 screenshot/pixel-level/交互自动化和更多产品 UI fixture。 | P40+ |
| runtime/model adapter | provider doctor、PI runtime、`src/runtime/adapters/agent-contract.mjs` 和 `src/runtime/adapters/provider-runtime-matrix.mjs` 已存在，能描述 Claude/Codex/custom capability、budget、sandbox、approval policy、provider selection、invocation path、CLI dry-run contract、gate log-dir 和 runner runtime stateRoot，并通过 `sdk.provider.*` 暴露；runner execution 已接入外部 stateRoot。 | Ralph `AGENT_CMD`、GSD 多 runtime、OpenSpec OpenRouter。 | 仍缺长驻 runtime adapter、fallback policy 冻结和 billable execution 实战。 | P1/P2/P4 |
| skill/plugin registry | `src/workflows/registry.mjs` 可发现 PI/review/fix/ship workflow，`src/workflows/install.mjs` 可生成/校验/安装 `SKILL.md`、`skill.json`、target `RULES.md` 和 `triggers.json` artifacts，并有外部 target smoke 覆盖 `.yolo/skills`、`.agents/skills`、`.claude/skills`、`.codex/skills`。 | Superpowers、GSD、Matt Pocock skills。 | 真实 billable agent 运行和长驻 runtime convention 仍不完整。 | P2/P4 |
| project bootstrap | `yolo init`、`sdk.project.initProject()` 和 `sdk.project.runInitToFirstPrdSmoke()` 已能生成 `.yolo/`、template、constitution、`specs/`、first PRD，并通过 preflight 与 runner dry-run readiness；package install smoke、provider/runtime matrix、provider CLI dry-run matrix、workflow target smoke、workflow rules/trigger index、runner stateRoot smoke、hardening drill、decision gate、operator state helper、operator runbook gate、post-release audit gate、stable graduation gate、manual external release evidence gate、agent integration doctor 和 public beta evidence bundle 已证明外部项目状态归属项目 `.yolo`。 | Spec Kit `specify init`、GSD installer。 | 还缺更多真实项目 bootstrap smoke 和 dogfood 报告。 | operator evidence |
| hooks/security | 有 hooks 和 gates，但分散。 | GSD hooks、gstack security model。 | 缺统一 hook contract、权限/安全边界文档和测试。 | P2 |
| cross-project fixtures | 已有 `sdk.fixtures` registry、隔离执行 harness 和 9 个可执行 fixture，覆盖 Node、Python 基础、Python service、frontend、backend API、monorepo、无测试、脏工作区、失败基线。 | GSD/Ralph npm tests、OpenSpec 100+ tests。 | 还缺 dogfood reports 和更多真实生态 fixture。 | P1 |

## 目标目录结构

最终不是把所有文件简单搬家，而是把 public boundary 和 legacy boundary 切开：

```text
yolo/
  bin/
    yolo.mjs
    yolo-pi.mjs
    yolo-prd-preflight.mjs
    yolo-prd-migrate-gates.mjs
  src/
    core/
      config.mjs
      paths.mjs
      result.mjs
      errors.mjs
    prd/
      schema.mjs
      contract.mjs
      migration.mjs
      preflight.mjs
    spec/
      requirements.mjs
      design.mjs
      tasks.mjs
      changes.mjs
    runtime/
      runner-runtime.mjs
      task-loop.mjs
      adapters/
    agents/
      presets.mjs
      pi.mjs
      reviewer.mjs
      gatekeeper.mjs
    review/
      scanner.mjs
      findings-to-tasks.mjs
      quality-gate.mjs
    evidence/
      ledger.mjs
      events.mjs
      artifacts.mjs
    workflows/
      pi.workflow.mjs
      review.workflow.mjs
      fix.workflow.mjs
  schemas/
  templates/
  fixtures/
    node-basic/
    frontend-vite/
    python-basic/
    monorepo/
    no-tests/
  data/
    prds/
    reviews/
    retries/
  state/
    events/
    runs/
    evidence/
  legacy/
    closed-loop/
  docs/
```

兼容策略：

- 根目录现有 CLI 文件先保留为 shim，转发到 `bin/` 或 `src/`。
- 每次只迁移一个可测边界，不做一次性大搬家。
- 对 public exports 建 import smoke test，迁移后旧路径和新路径都要能跑。
- `closed-loop/` 先封存到 `legacy/closed-loop/`，不在第一阶段混改逻辑。

## 解耦路线图

### Phase 0: 锁住当前事实

目标：先防止继续变乱。

- 增加 SDK gap matrix 和结构化 roadmap。
- 给 `package.json` exports/bin 加 smoke test。
- 给所有 public export 加 import-safe 测试。
- 建立 `docs/public-sdk-contract.md`，列出稳定/实验/legacy API。
- 修掉 runner 中缺失动态 import 的路径风险，或让 preflight 明确阻断对应能力。

完成标准：

- `node --test __tests__/*.test.mjs` 通过。
- `node --check` 覆盖 public entrypoints。
- 没有 public export 在 import 时启动 runner、server、写状态或读取目标项目。

### Phase 1: SDK kernel 与 CLI 归位

目标：把“能被外部调用的能力”从根脚本里抽出来。

- 新建 `src/core`、`src/prd`、`src/runtime`、`src/agents`。
- `sdk.mjs` 只从 `src/` 聚合，不再直接 import 根目录业务脚本。
- `docs/public-sdk-api-boundary.json` 作为 package exports、`sdk.mjs` named exports 和 `createYoloSdk()` namespace 的单一分级清单。
- `bin/` 只解析 CLI 参数，然后调用 SDK。
- 根目录 `.mjs` 保留 shim，避免打断现有使用。
- `setContractRoot(projectRoot)` 改成 scoped evaluator context，避免多项目/多 SDK 实例互相污染。

完成标准：

- 根目录 `.mjs` 降到 8 个以内，且都是 shim 或兼容入口。
- `sdk.createYoloSdk({ projectRoot })` 可以同时创建两个实例，不共享 project root 状态。
- 所有 CLI 行为有 SDK 等价调用。

### Phase 2: runner 拆分

目标：继续把已从 2778 行降到 16 行根入口的 runner 拆成可测组件，并把后续风险转向 release hardening。

- `task-loop`: 选择任务、锁定任务、状态推进。
- `execution`: 生成 prompt、调用 agent adapter、收集 diff。
- `gates`: pre/post/schema/contract/quality gates。
- `review-loop`: review scan、review-to-task、auto-fix。
- `evidence`: 记录每步输入、输出、命令、退出码、artifact。
- `recovery`: retry、stale task reopen、人工介入报告。

完成标准：

- runner 主入口少于 300 行。
- 每个模块有单元测试。
- 缺失可选能力必须 fail-closed 或标记 unavailable，不能动态 import 后静默吞错。

### Phase 3: Spec governance

目标：补齐从需求到设计到任务到变更的正式生命周期。

- `requirements`: 用户需求、约束、非目标、成功标准。已由 `src/spec/lifecycle.mjs` builder 表达。
- `design`: 架构方案、替代方案、风险、回滚。已由 `src/spec/lifecycle.mjs` builder 表达。
- `tasks`: 可执行任务、依赖、验收、gate。已由 `src/spec/lifecycle.mjs` builder 表达，并可转换为 PRD task。
- `changes`: 变更提案、影响面、迁移、回滚。已由 `src/spec/lifecycle.mjs` builder 表达。
- `traceability`: requirement -> design -> task -> evidence 的链路。

完成标准：

- PI 不直接从 requirement 跳到 PRD 执行；至少可以启用 design gate。
- 每个 task 能回溯到 requirement 和 evidence。
- 弱 spec 不能进入 runner。

### Phase 4: Evidence ledger

目标：让“完成”有机器可读证据。

- 增加 `sdk.evidence` namespace。
- 统一 event、run、artifact、gate、review finding schema。
- 支持生成 `run-report.json` 和 `run-report.md`。
- 每个 gate 失败都有 code、message、source、suggested_fix。

完成标准：

- final answer 可从 evidence ledger 生成，而不是靠日志文本拼接。
- review/fix loop 每次变更都能追踪到 task、gate、diff 和验证命令。

### Phase 5: Plugin / skill / adapter layer

目标：吸收 Superpowers、GSD、Matt Pocock skills 的组合能力。

- `skills/` 存放 YOLO skills，每个 skill 有 trigger、inputs、outputs、verification；当前已能生成 `SKILL.md` 和 `skill.json` artifact。
- `workflows/` 描述 PI、review、fix、ship 等组合流程；当前 registry 和 install plan 已存在。
- `adapters/` 支持 codex、claude、opencode、droid、shell command。
- `yolo init` 已生成本地 `.yolo/` 和 `specs/`；后续根据目标 agent 写入 `.agents/skills`、`.claude/skills` 或本地 `.yolo/`。

完成标准：

- 一个 workflow 可以由 CLI、SDK、skill 三种入口触发。
- 更换 agent 不需要改 runner 核心。
- 每个 skill 有最小验证场景。

### Phase 6: Cross-project fixtures

目标：证明 YOLO 不只适合当前 SamKimTest。

至少建立这些 fixture：

- Node basic：简单 JS/TS 包。
- Frontend Vite：UI + lint + test。
- Python basic：pytest + ruff/mypy 可选。
- Monorepo：多 package 和局部任务。
- No tests：无测试项目下的降级策略。
- Existing dirty tree：不覆盖用户改动。
- Failing baseline：基线失败时不把旧错归给当前任务。

完成标准：

- 每个 fixture 有 requirement -> spec -> task -> run -> evidence。
- 每个 fixture 可以 dry-run，也可以在隔离目录真实执行。
- 所有失败都有可解释 report。

### Phase 7: Public beta

目标：公开可用，但不承诺零 bug。

- `private: true` 改动前完成发布检查。
- semver、CHANGELOG、README、examples、API docs 完整。
- 明确 experimental API 和 stable API。
- 给出迁移指南和已知限制。

完成标准：

- 新用户能 `npm install` 或 `npx yolo init` 在一个陌生项目上跑通 smoke。
- 出错时默认 fail-closed，不提交垃圾代码。
- public SDK 每个 namespace 都有测试和文档。

## 下一步执行建议

下一步不应该继续扩大 PI，也不应该自动发布；P11 evidence gate 已完成。真实 `npm publish`、token、billable provider 或公开 dogfood 报告仍需要人工 operator 在 SDK 外执行；否则继续做 non-billable dogfood/fixture hardening。

已完成的 Phase 0 首批事项：

- `__tests__/public-entrypoints.test.mjs` 覆盖 `package.json` exports import-safe 和 bin parse checks。
- `context-pack-validator.mjs` 已补齐，runner 执行前 context pack gate 不再因为缺模块直接阻断。
- `review-to-prd.mjs` 已补齐，must-fix review finding 可以转换成 contract-clean PRD task。
- `createYoloSdk({ projectRoot })` 的 contract evaluator 已改成实例级 root，不再由 SDK 创建过程污染全局 contract root。
- `package.json` public exports 已开始指向 `src/` façade，package bin 已指向 `bin/`。
- `docs/public-sdk-contract.md` 已定义 stable / experimental / internal API 边界。
- `yolo`、`yolo-gate`、`yolo-pi`、`yolo-prompt`、`yolo-prd-preflight`、`yolo-prd-migrate-gates` 已从 legacy spawner 切到 `src/cli/*` 直接调用。
- `prompt.mjs` 已从顶层立即执行脚本改为 import-safe 的 `generatePrompt()` / `runPromptCli()` 模块，同时保留直接运行兼容性。
- Phase 2 已开始第一刀：runner gate failure analysis 已抽到 `src/runtime/gates/failure-analysis.mjs`，`runner.mjs` 只保留调用和 evidence 写入。
- Phase 2 第二刀：runner evidence writer 已抽到 `src/runtime/evidence/writers.mjs`，覆盖 split-applied、contract-suspect 和 prd-contract-doctor evidence。
- Phase 2 第三刀：PRD contract doctor gate 已抽到 `src/runtime/gates/prd-contract-doctor-gate.mjs`，runner 只负责加载 PRD 和处理 exit/throw。
- Phase 2 第四刀：task result/status writer 已抽到 `src/runtime/task-state/writers.mjs`，runner 内 `task-results.jsonl` 写入已统一走 `writeTaskResult()`。
- Phase 2 第五刀：标准 task terminal transition helper 已抽到 `src/runtime/task-state/transitions.mjs`，低风险 PASS/FAIL/SKIP/BLOCKED 路径开始统一走 `recordTaskTransition()`。
- Phase 2 第六刀：复杂 gate/retry/commit 分支开始统一走 task transition helper，包括 provider failure、diff quality、test generation、postcondition、contract suspect、dependency blocked 和异常耗尽路径。
- Phase 2 第七刀：task-loop 状态 helper 已抽到 `src/runtime/task-loop/status-helpers.mjs`，覆盖 merged source、parent/child completion/blocking 和 dependency blocker 规则。
- Phase 2 第八刀：task-loop outcome handler 已抽到 `src/runtime/task-loop/outcome-handler.mjs`，覆盖 pre-run skip/dependency blocking、completed/skipped/blocked/failed 结果归集和重复失败熔断。
- Phase 2 第九刀 + Phase 4 第一刀：task-loop side effects 已抽到 `src/runtime/task-loop/side-effects.mjs`，覆盖 expanded task snapshot、progress snapshot 和 lessons analyzer trigger；同时新增 `src/runtime/evidence/ledger.mjs` 作为 internal JSONL/JSON artifact ledger 基础。
- Phase 2 第十刀 + Phase 4 第二刀：run lifecycle state files 已抽到 `src/runtime/run-lifecycle/state-files.mjs`，覆盖 current-run 写入、正常/中断归档和 runtime 临时状态文件清理，减少异常退出路径重复清理逻辑。
- Phase 2 第十一刀 + Phase 4/1 组合批次：retry round recovery helper 已抽到 `src/runtime/recovery/retry-round.mjs`，覆盖 retry task 准备、retry PRD 生成、retry completion 同步、结果合并和 retry PRD 临时文件清理；该模块仍为 internal runtime，不进入 public export。
- Phase 2 第十二刀 + Phase 4/1 组合批次：gate stuck recovery helper 已抽到 `src/runtime/recovery/gate-stuck.mjs`，覆盖 gate failure 摘要、retry-count 写入、连续同因判断、contract suspect transition 和 max retry failure transition；该模块仍为 internal runtime，不进入 public export。
- Phase 2 第十三刀 + Phase 4 组合批次：review-loop round helper 已抽到 `src/runtime/review-loop/round-helpers.mjs`，覆盖 dry-run/report-only review policy、review scope、scanner fallback classification、contract finding 选择、review metadata、CLAUDE_FIX 合并、review result 合并和 pending review 检测；该模块仍为 internal runtime，不进入 public export。
- Phase 2 第十四刀 + Phase 4 组合批次：review-loop execution helper 已抽到 `src/runtime/review-loop/execution-helpers.mjs`，覆盖 scanner args、scanner stdout fallback、findings parse、review failure threshold、AUTO_FIX result normalization 和 AUTO_FIX error fallback；该模块仍为 internal runtime，不进入 public export。
- Phase 2 第十五刀 + Phase 4 组合批次：review-loop task application helper 已抽到 `src/runtime/review-loop/task-application.mjs`，覆盖 review task 上限阻断、PRD 追加前 task shape、progress total 推进、review task id set、fix failure summary 和 pending review 收敛决策；该模块仍为 internal runtime，不进入 public export。
- Phase 2 第十六刀 + Phase 3 gate 批次：pre-execution gate orchestration 已抽到 `src/runtime/gates/pre-execution-gates.mjs`，统一 contract doctor -> spec governance 的执行前 fail-closed 顺序；runner 只负责加载 PRD、打印消息和退出/抛错。
- Phase 3 第一刀 + traceability/evidence 批次：新增 `src/spec/traceability.mjs` 和 `src/evidence/ledger.mjs` experimental façade，覆盖 requirement/design/task/evidence traceability matrix、可阻断的 spec governance inspection、JSONL evidence record、state/run event scoped ledger。
- Phase 3 第二刀 + Phase 2 gate 拆分批次：新增 `src/runtime/gates/spec-governance-gate.mjs`，`prd-preflight.mjs`、runner runtime 和 `runner.mjs` 执行前都会阻断缺 requirement/design trace 的 pending task，以及缺 evidence trace 的 terminal task。
- Phase 4 第四刀：新增 `src/runtime/evidence/schema.mjs` 和 `schemas/evidence-ledger-v1.schema.json`，统一 ledger event 与 evidence artifact 的 v1 必填字段；fixture run、runner evidence writer 和 atomic investigation evidence 已写入 `schema_version`、`schema`、`artifact_type`/`ledger`、`source`。
- Phase 4 第五刀：新增 `src/runtime/evidence/report.mjs` / `src/evidence/report.mjs` 和 `yolo/evidence/report` export，runner 结束时会从 `runs.jsonl` / `events.jsonl` / task results 生成 `state/reports/<run_id>/run-report.json` 与 `run-report.md`。
- Phase 4 第六刀：run-report 已扩展 gate failure、review issue/error/done、fixture run 和 spec governance 聚合，并读取 `state/runtime/task-logs` 作为 review/gate 证据来源。
- Phase 4 第七刀：新增 `src/review/findings.mjs` 和 `yolo/review/findings` experimental export，统一 review finding v1 schema；review-scanner、review-to-prd、review-loop logs 和 run-report 已共用 normalize/validate/output helpers，并保留 `scanner_id`、`file`、`line` 兼容字段。
- Phase 2 第十七刀：新增 `src/runtime/execution/provider-adapter.mjs`，把 Claude/Codex invocation 构造、stdin prompt 执行、Codex last-message output 捕获和 provider budget failure 分类从 `runner.mjs` 抽出；runner 降到 3750 行。
- Phase 2 第十八刀：新增 `src/runtime/execution/baselines.mjs`，把 task execution 前的 dirty snapshot、TSC baseline、ESLint baseline 捕获从 `runner.mjs` 抽出并单测；runner 降到 3682 行。
- Phase 2 第十九刀：新增 `src/runtime/execution/worktree-session.mjs`，把 task worktree 创建、worktree baseline、scope-aware merge、out-of-scope skip、merge verification 和 cleanup 从 `runner.mjs` 抽出并单测；同时修复 git porcelain 输出 `.trim()` 破坏前导状态空格导致路径被截断的问题。runner 降到 3420 行。
- Phase 2 第二十刀：新增 `src/runtime/execution/merge-result.mjs`，把 PASS 分支的 worktree diff numstat、scope target coverage 和 task execution base record 从 `runner.mjs` 抽成纯 helper；runner 当前降到 3395 行，下一步继续拆 commitTask/baseline update 重复块。
- Phase 2 第二十一刀：扩展 `src/runtime/execution/baselines.mjs`，把 `commitTask` 成功后的 tsc/eslint baseline refresh、resolved key prune、legacy key 兼容和更新时间写回从 `runner.mjs` 抽出并单测；runner 当前降到 3300 行。
- Phase 2 第二十二刀：新增 `src/runtime/execution/commit-flow.mjs`，把 `commitTask` 的 git add/commit、doc-update hook retry、short hash 读取和 staging reset 从 `runner.mjs` 抽出并单测；runner 当前降到 3278 行。
- Phase 2 第二十三刀：新增 `src/runtime/execution/change-set.mjs`，把 `commitTask` 的 changed-file discovery、committable file 过滤、business/metadata 分类和 scope out-of-scope 计算从 `runner.mjs` 抽出并单测；runner 当前降到 3233 行。
- Phase 2 第二十四刀：扩展 `src/runtime/execution/commit-flow.mjs`，把 scope audit JSONL record、dry-run out-of-scope block、no-code/metadata-only/dry-run skip decision 从 `runner.mjs` 抽出并单测；runner 当前降到 3227 行。
- Phase 2 第二十五刀：继续扩展 `src/runtime/execution/commit-flow.mjs`，把 `commitTask` 的 doc update 调用、doc update payload 和 commit result -> log/event/baseline/result 决策从 `runner.mjs` 抽出并单测；runner 当前降到 3220 行。
- Phase 2 第二十六刀：新增 `src/runtime/execution/change-set.mjs` 的 `buildCommitChangeContext()`，把 `commitTask` 前半段的 changed files、committable files、business/metadata、expected_zero_business_code 和 out-of-scope audit context 组合从 `runner.mjs` 抽出并单测；runner 当前降到 3218 行。
- Phase 2 第二十七刀：扩展 `src/runtime/execution/commit-flow.mjs`，新增 `buildScopeAuditDecision()` / `applyScopeAudit()`，把 `commitTask` 的 out-of-scope warning、AUDIT 日志和 scope audit JSONL append orchestration 从 `runner.mjs` 抽出并单测；runner 当前降到 3211 行。
- Phase 2 第二十八刀：新增 `src/runtime/execution/commit-flow.mjs` 的 `runTaskCommitFlow()`，把 `commitTask` 的 dry-run block、doc update、skip decision、git commit、commit result log/event 和 baseline refresh 串联流程从 `runner.mjs` 抽出并单测；runner 当前降到 3177 行，下一步继续拆 `commitTask` 外围调用或转向 task execution 主循环。
- Phase 2 第二十九刀：新增 `src/runtime/execution/post-commit-outcome.mjs`，把 PASS 分支提交后的 dry-run missed scope、postcondition、no-code 和 commit failure 终态判定从 `runner.mjs` 抽出并单测；runner 当前降到 3126 行，下一步继续拆 task execution 主循环。
- Phase 2 第三十刀：新增 `src/runtime/execution/post-precheck.mjs`，把 attempt>0 的显式 post condition 已满足 skip 判定、TSC 目标错误阻断和 valid-skip transition 从 `runner.mjs` 抽出并单测；runner 当前降到 3063 行，下一步继续拆 provider/diff/test gate failure outcome。
- Phase 2 第三十一刀：新增 `src/runtime/execution/session-failure-outcome.mjs`，把 provider failure、diff-quality retry/exhaustion 和 test-generation blocker 的 transition/result 判定从 `runner.mjs` 抽出并单测；runner 当前降到 3022 行，下一步继续拆 gate PASS 分支或 runTask 异常处理。
- Phase 2 第三十二刀：新增 `src/runtime/execution/gate-pass-outcome.mjs`，把 gate PASS 后 merge 前 postcondition failure 和 commit exception retry 诊断从 `runner.mjs` 抽出并单测；runner 当前降到 3016 行，下一步继续拆 runTask 异常处理或 gate failure 学习编排。
- Phase 2 第三十三刀：新增 `src/runtime/execution/exception-outcome.mjs`，把 runTask catch 内连续异常停机、异常重试耗尽和 retry message 判定从 `runner.mjs` 抽出并单测。
- Phase 2 第三十四刀：新增 `src/runtime/execution/context-pack-outcome.mjs`，把 context-pack-validator fail-closed transition/result 从 `runner.mjs` 抽出并单测。
- Phase 2 第三十五刀：新增 `src/runtime/execution/gate-failure-outcome.mjs`，把 gate failure 的 contract_suspect/stuck/max_retry/retry 决策从 `runner.mjs` 抽出并单测。
- Phase 2 第三十六刀：新增 `src/runtime/execution/engine-scope-outcome.mjs`，把 engine self-modification blocker 和 dry-run artifact 例外规则从 `runner.mjs` 抽出并单测；runner 当前降到 2973 行，下一步继续拆 prompt/session setup 或 gate failure learning side-effect。
- Phase 2 第三十七刀：新增 `src/runtime/execution/session-prompt.mjs`，把 retry failure hint、learn 文本和 `prompt.mjs` 参数构造从 `runner.mjs` 抽出并单测；runner 当前降到 2965 行，下一步继续拆 gate failure learning side-effect 或 pre-run deterministic task blockers。
- Phase 2 第三十八刀：新增 `src/runtime/execution/gate-learning.mjs`，把 gate failure 的 analysis/fix log、`learn.mjs` record 参数和 retry-count 写入 side effect 从 `runner.mjs` 抽出并单测。
- Phase 2 第三十九刀：新增 `src/runtime/execution/atomic-doctor-outcome.mjs`，把 atomic task doctor 的 must-split/blocker task result、PRD update 和 runner result 判定从 `runner.mjs` 抽出并单测。
- Phase 2 第四十刀：新增 `src/runtime/execution/precheck-outcome.mjs`，把 precheck valid-skip、invalid-skip 和 error message 判定从 `runner.mjs` 抽出并单测；runner 当前降到 2918 行，下一步继续拆 pre-run deterministic task blockers 或 dry-run artifact path。
- Phase 2 第四十一刀：新增 `src/runtime/execution/dry-run-artifact.mjs`，把 deterministic dry-run artifact 的命令 smoke、artifact 渲染、文件写入、postcondition 和 transition 从 `runner.mjs` 抽出并单测。
- Phase 2 第四十二刀：新增 `src/runtime/execution/deterministic-auto-fix.mjs`，把 AUTO_FIX task normalization、deterministic fix 执行、postcondition、commit 和 transition 从 `runner.mjs` 抽出并单测；runner 当前降到 2778 行，下一步再拆 provider session attempt 或 gate failure terminal side effect。
- Phase 2 第四十三刀：新增 `src/runtime/execution/session-validation.mjs`，把 context-pack validator、test-generation validator 和 atomic-task-doctor gate wrapper 从 `runner.mjs` 抽出并单测；runner 继续保留执行编排和日志调用。
- Phase 2 第四十四刀：新增 `src/runtime/task-loop/expansion.mjs`，把任务优先级排序、completed 预处理、文件拆分、依赖分组和同文件同类任务合并从 `runner.mjs` 抽出并单测；runner 的 `mainLoop` 只保留 expansion 调用、全局合并日志和后续执行循环。
- Phase 2 第四十五刀：新增 `src/runtime/execution/session-attempt.mjs`，把每次 attempt 的 context-pack gate、learn/prompt 生成、baseline capture、worktree 创建和 provider spawn 准备从 `runner.mjs` 抽出并单测；runner 保留失败重试、gate 和 commit 编排。
- Phase 2 第四十六刀：新增 `src/runtime/execution/session-pre-gates.mjs`，把 provider 空输出/失败、diff-quality gate 和 test-generation validator 的 cleanup、transition、retry/return 判定从 `runner.mjs` 抽出并单测；runner 只接收 `continue` / `retry` / `return` 决策。
- Phase 2 第四十七刀：新增 `src/runtime/execution/gate-pass-flow.mjs`，把 gate PASS 后的 pre-merge postcondition、worktree merge、commit retry、post-commit outcome 和 transition 记录从 `runner.mjs` 抽出并单测。
- Phase 2 第四十八刀：新增 `src/runtime/execution/gate-failure-flow.mjs`，把 gate FAIL 后的失败分析、学习副作用、retry/stuck/max-retry/contract-suspect 判定、evidence 写入和 cleanup 从 `runner.mjs` 抽出并单测。
- Phase 2 第四十九刀：新增 `src/runtime/execution/pre-session-flow.mjs`，把 runTask 进入 provider session 前的 precheck、engine self-modification blocker、deterministic dry-run artifact、deterministic auto-fix、atomic task doctor 和 retry post-precheck 从 `runner.mjs` 抽出并单测；runner 当前降到 2150 行。
- Phase 2 第五十刀：新增 `src/runtime/execution/exception-flow.mjs`，把 runTask catch 分支的异常日志、worktree cleanup、exception outcome transition、sleep/retry 编排从 `runner.mjs` 抽出并单测；runner 当前降到 2131 行。
- Phase 2 第五十一刀：新增 `src/runtime/run-lifecycle/prd-discovery.mjs`，把 runner 底部的 PRD 自动发现和 CLI `--prd`/位置参数解析从 `runner.mjs` 抽出并单测；runner 当前降到 2086 行。
- Phase 2 第五十二刀：新增 `src/runtime/run-lifecycle/startup.mjs`，把 runner 启动阶段的 PID lock、task-results 轮转、runtime 初始化、JSONL 截断、baseline 初始化、残留 worktree/retry 清理和 resume running task 重置从 `runner.mjs` 抽出并单测。
- Phase 2 第五十三刀：新增 `src/runtime/run-lifecycle/finalize.mjs`，把最终 run report、成功率输出、临时文件清理、旧 gate/retry 日志清理、run archive 和 progress-server 关闭从 `runner.mjs` 抽出并单测；runner 当时降到 1775 行，P0-05 完成；P3-04 stateRoot 注入后为 1799 行。
- Phase 2 第五十四刀：新增 `docs/root-entrypoint-inventory.json`、`docs/root-entrypoint-inventory.md` 和 `__tests__/root-entrypoint-inventory.test.mjs`，把 33 个根目录 `.mjs` 全部归类，并用结构测试阻止未登记的新根脚本；P0-06 完成。
- Phase 1 第一刀：新增 `docs/public-sdk-api-boundary.json` 和 `__tests__/public-sdk-boundary.test.mjs`，把 package exports、`sdk.mjs` named exports、`createYoloSdk()` namespaces 全部分为 stable/experimental，并把 API boundary 检查接入 release readiness；P1-01 完成。
- Phase 1 第二刀：新增 `src/core/bootstrap.mjs`、`yolo/core/bootstrap`、`sdk.project.initProject()` 和 `yolo init`，可以生成 `.yolo/`、`.yolo/templates/`、constitution、`specs/` 基础结构，默认不覆盖已有文件，并由 CLI/SDK/package export 测试覆盖；P1-02 完成。
- Phase 1 第三刀：新增 `python-basic`、`frontend-vite`、`monorepo`、`dirty-tree`、`failing-baseline` 五个 fixture，和原有 `node-basic`、`no-tests` 一起纳入 registry/harness，全量 7 个 fixture 都能在临时目录隔离运行并写 evidence；P1-03 完成。
- Phase 1 第四刀：新增 `src/spec/lifecycle.mjs`、`yolo/spec/lifecycle` 和 `sdk.spec.*` lifecycle helpers，覆盖 requirement/design/task/change artifact builder、cross-reference inspector、lifecycle -> PRD 转换，并接入 API boundary；P1-04 完成。
- Phase 1 第五刀：新增 `docs/api-reference.md` 和 `docs/fixture-matrix.md`，更新 README/CHANGELOG，并让 release readiness 检查 API reference、fixture matrix、README public beta surface 和 changelog release blocker；P1-05 完成。
- Phase 1 第六刀：新增 `src/runtime/adapters/agent-contract.mjs`、`yolo/runtime/adapters` 和 `sdk.provider.*` adapter helpers，覆盖 Claude/Codex/custom provider alias、command availability、budget enforceability、sandbox/approval policy 和 unsafe adapter fail-closed inspection；P1-06 完成。
- Phase 2 第一刀：新增 `src/workflows/install.mjs`、`yolo/workflows/install` 和 `sdk.workflows.*` install helpers，覆盖 workflow skill descriptor validation、install plan、`.yolo/skills` / `.agents/skills` target artifact 写入、`SKILL.md` / `skill.json` / `index.json` 生成；P2-01 完成。
- Phase 2 第二刀：扩展 `src/runtime/evidence/report.mjs` / `src/evidence/report.mjs`，新增 run-report 派生的 final-answer JSON/Markdown artifact、SDK helpers 和 runner return path；P2-02 完成。
- Phase 2 第三刀：新增 `docs/legacy-boundary.json` 和 `__tests__/legacy-boundary.test.mjs`，把 `closed-loop/` 标为 v1 legacy_readonly，允许的只读兼容引用机器校验，并阻止 public SDK/runtime 直接执行 legacy 模块；P2-03 完成。
- Phase 3 第一刀：新增 `src/core/init-smoke.mjs`、`yolo/core/init-smoke` 和 `sdk.project.*` smoke helpers，并给 `runRunnerRuntime()` 增加 preflight-only dryRun 分支，证明陌生项目能从 init 走到 first PRD preflight 和 runner dry-run readiness；P3-01 完成。
- Phase 3 第二刀：新增 package `files` allowlist、`src/release/pack-smoke.mjs`、`yolo/release/pack-smoke` 和 `sdk.release.runPackageInstallSmoke()`，证明 tarball 可在外部项目安装、import public exports 并调用 `.bin/yolo --help`；P3-02 完成。
- Phase 3 第三刀：新增 `sdk.paths.stateRoot`，让 SDK/init/PI plan 默认把状态和产物写入目标项目 `.yolo`，并用外部 package install smoke 防止 `node_modules/yolo/state|data|logs` 污染；P3-03 完成。
- Phase 3 第四刀：runner/SDK runtime 接收外部 `projectRoot/stateRoot`，task logger、snapshot、finalize cleanup、retry data、gate log-dir 和 runner pending dry-run artifact smoke 均归属 consumer `.yolo`；package install smoke 也覆盖安装后真执行；同时修复真实 pending task 路径缺失 `isBusinessFile` import 的 runtime bug；P3-04 完成。
- Phase 3 第五刀：新增 `src/runtime/adapters/provider-runtime-matrix.mjs` 和 `sdk.provider.buildProviderRuntimeMatrix()` / `inspectProviderRuntimeMatrix()`，把 Claude/Codex/custom detection、adapter contract、invocation path、Codex output file、gate log-dir 和 runner runtime stateRoot 组成外部项目矩阵；`provider-doctor.mjs` 和 provider execution adapter 已支持 custom provider；package install smoke 覆盖安装后 provider matrix；P3-05 完成。
- Phase 3 第六刀：新增 `buildWorkflowSkillTargetSmokePlan()` / `runWorkflowSkillTargetSmoke()` 和 `sdk.workflows.*` target smoke，验证 `.yolo/skills`、`.agents/skills`、`.claude/skills`、`.codex/skills` 的 index、descriptor、agent convention 和 package root clean checks；package install smoke 覆盖安装后 workflow target smoke；P3-06 完成。
- Phase 3 第七刀：`atomic-task-doctor.mjs`、`prd-contract-doctor.mjs`、`provider-doctor.mjs` 实现迁到 `src/runtime/*`，根目录只保留兼容 shim；SDK、runner、preflight、migration、runtime evidence 改为直接引用 `src` 实现；root inventory 增加 shim target 存在性测试；P3-07 完成。
- Phase 3 第八刀：新增 `fixtures/backend-api`，用 dependency-free Node HTTP 服务和 `node:test` 覆盖 `/health`、`/api/users`、404 fail-closed 路径，并纳入 registry、harness、fixture matrix 和 release readiness；P3-08 完成。
- Phase 3 第九刀：`pm`、`audit-to-prd`、`contract`、`scanner`、`validate-prd` 实现迁到 `src/pm`、`src/prd`、`src/review`，package exports 指向 `src/`，根目录只保留兼容 shim；SDK、runner、PI runtime、preflight、gate CLI 改为直接引用 `src` 实现；P3-09 完成。
- Phase 3 第十刀：新增 `fixtures/python-service`，用多模块 Python service 覆盖 domain model、repository、alert service、machine-readable CLI 和 unittest smoke；fixture registry/harness/release readiness 全部纳入；P3-10 完成。
- Phase 3 第十一刀：workflow skill installer 会生成 target 级 `RULES.md` 和 `triggers.json`，install plan 与 target smoke 会校验 agent rule、trigger index、descriptor routing、fail-closed 约定和 package root clean；P3-11 完成。
- Phase 3 第十二刀：新增 provider CLI dry-run matrix，SDK 和 pack smoke 可验证 Claude/Codex/custom 的真实 CLI contract、stdin/output capture、budget/sandbox、stop conditions，并确保 dry-run 不 spawn provider；P3-12 完成。
- Phase 4 第一刀：新增 `src/runtime/review-loop/orchestrator.mjs`、`src/runtime/recovery/retry-orchestrator.mjs` 和 `src/runtime/run-lifecycle/run-orchestrator.mjs`，把 review/retry/run pipeline 编排从 `runner.mjs` 抽出并单测；runner 当前降到 1438 行，full suite 为 539 tests / 92 suites / 0 fail。
- Phase 4 第二刀：新增 `src/runtime/task-loop/task-runner.mjs`、`src/runtime/task-loop/main-loop.mjs` 和 `src/runtime/task-loop/split-application.mjs`，把 `runTask`、`mainLoop` 和 split PRD 写回从 runner 中抽出，并用 task-loop 直接测试和 runner review flow 锁住行为。
- Phase 4 第三刀：新增 `src/runtime/runner-core.mjs`，根 `runner.mjs` 降为 13 行兼容 shim，保留 `run` / `runCli` export 和 `node runner.mjs` 入口；SDK import-safe 与 runner source-anchor 测试已通过。
- P5-01 release hardening drill：新增 `src/release/hardening-drill.mjs`、`yolo/release/hardening-drill` 和 `sdk.release.runPublicBetaHardeningDrill()` experimental API；实跑结果为 hardening drill pass，但 release 仍被 `PACKAGE_PRIVATE_RELEASE_BLOCK` 正确阻断，并保证 no-publish、`private:true` unchanged、no credentials、no billable provider execution。
- P6-01 controlled release decision gate：新增 `src/release/decision-gate.mjs`、`yolo/release/decision-gate` 和 `sdk.release.runControlledBetaReleaseDecisionGate()` experimental API；默认无人工 decision record 时 blocked，显式批准后只返回 authorization，不发布、不改包、不读凭证、不执行 provider。
- P7-01 operator release-state helper：新增 `src/release/operator-state.mjs`、`yolo/release/operator-state` 和 `sdk.release.runOperatorReleaseStateMutation()` experimental API；默认 dry-run 不改包，显式 `apply + allowWorkspaceMutation` 只在 P6 decision gate ready 后移除 `private`，仍不 publish、不读凭证、不执行 provider。
- P8-01 operator runbook gate：新增 `src/release/operator-runbook.mjs`、`yolo/release/operator-runbook` 和 `sdk.release.runOperatorReleaseRunbookGate()` experimental API；校验 applied operator state、publish 授权、credential/billable 授权和 public dogfood report 证据，只产出人工命令，不执行 `npm publish`、不读 token、不执行 provider、不发布报告。
- P9-01 post-release audit gate：新增 `src/release/post-release-audit.mjs`、`yolo/release/post-release-audit` 和 `sdk.release.runPostReleaseAuditGate()` experimental API；校验人工外部发布记录、post-release hardening、package install smoke 和 dogfood audit evidence，仍不执行 release side effect。
- P10-01 stable graduation gate：新增 `src/release/stable-graduation.mjs`、`yolo/release/stable-graduation` 和 `sdk.release.runStableGraduationGate()` experimental API；在 P9 后校验 public readiness、stable semver、root entrypoint budget、stability review、runtime API freeze 和 public dogfood evidence。
- P11-01 manual external release evidence gate：新增 `src/release/manual-external-release.mjs`、`yolo/release/manual-external-release` 和 `sdk.release.runManualExternalReleaseGate()` experimental API；校验人工外部 publish、credential、billable provider、public dogfood、post-release audit 和 stable graduation evidence，仍不执行 release side effect。
- P12-01 non-release root budget / PI src finalization：根目录 `.mjs` 从 33 压到 8；非 public root scripts 下沉到 `src/`/`bin/`；`runner-core.mjs` 拆出 helper 和 embedded progress server；PI agent/runtime/runner-runtime 从 `lib/` wrapper 转为 `src` 实现。
- P13-01 root compatibility debt cleanup / runner shutdown split：`learn`、`task-logger`、`state-snapshot`、`session-memory` 实现归入 `src/runtime/*`，根目录只保留兼容 shim；`runner-core.mjs` 拆出 shutdown/timeout/fatal cleanup helper，全量 593 tests / 101 suites / 0 fail。
- P14-01 runner context isolation：新增 `src/runtime/run-lifecycle/context.mjs`，把 project/state/runtime/results/current-run/expanded-task/output-log path resolution 与 context side effects 从 runner-core 抽出。
- P15-01 runner progress / recovery checkpoint split：新增 `progress-log.mjs` 与 `recovery-checkpoints.mjs`，把 progress line、state/run ledger、state snapshot、session memory checkpoint 从 runner-core 抽出。
- P16-01 task runtime binding split：新增 `task-runtime-bindings.mjs`，把 provider detection、worktree active session、gate spawn、baseline refresh wiring 从 runner-core 抽出。
- P17-01 process handler split：新增 `process-handlers.mjs`，把 SIGINT/SIGTERM、unhandled rejection、uncaught exception 和 runCli catch cleanup 从 runner-core 抽出。
- P18-01 runtime API freeze inspector：新增 `runtime-api-freeze.mjs` 并接入 stable graduation gate，runtime freeze 从人工布尔值升级为可审计 report。
- P19-01 runner-core source budget guard：新增结构测试锁定 runner-core <=600 行，并锚定 context/process/checkpoint/task bindings 不回流。
- P20-01 full validation / progress refresh：P14-P20 全量验证通过，runner-core 600 行、root `.mjs` 8 个、`src/**/*.mjs` 128 个、测试文件 92 个，全量 602 tests / 102 suites / 0 fail。
- P21-01 runtime freeze precision fix：修复 runtime freeze inspector 的行数与 `process.exit` 函数边界误判；当前 implementation blockers 清零，只剩 `./runtime` experimental boundary blocker。
- P22-01 local dogfood evidence drill：新增 `src/release/local-dogfood-evidence.mjs`，组合 hardening、fixture coverage 和 runtime implementation-ready report，且明确 local-only/no-publish/no-provider/no-public-claim。
- P23-01 full validation / progress refresh：P21-P23 全量验证通过，`src/**/*.mjs` 129 个、测试文件 93 个，全量 608 tests / 104 suites / 0 fail。
- P24-01 runtime stable-boundary candidate inspector：新增 `src/release/runtime-boundary-candidate.mjs`，把 `./runtime` stable 晋级前的实现证据、当前 experimental tier、人工批准阀门和建议修改做成内部决策包，不自动改 public API boundary。
- P25-01 runtime boundary docs consistency refresh：刷新 public SDK contract、API reference、API boundary reason、进度表和差距矩阵，消除 runtime 拆分状态过期描述，同时继续保留 `./runtime` experimental。
- P26-01 full validation / progress refresh：P24-P26 全量验证通过，`src/**/*.mjs` 130 个、测试文件 94 个，全量 613 tests / 105 suites / 0 fail。
- P27-01 native agent integration：`tools/install-agent-bridge.mjs` 从项目 memory/skill 安装升级为 project/user scope 安装器；Claude Code 获得真实 `.claude/commands/yolo*.md` slash commands，Codex 获得 `~/.agents/skills/yolo` native skill 和单个 source-command fallback，不再生成顶层阶段入口，同时用 `WORKFLOW.md` 隐藏内部 workflow 名；package tarball 包含安装器和非技术用户文档；全量 627 tests / 107 suites / 0 fail。
- P28-P32 public beta evidence bundle：新增 `agent-integration-doctor`、`real-project-dogfood`、`pi-execution-drill`、`runtime-boundary-decision` 和 `public-beta-evidence` release modules；通过 package exports、SDK release namespace、public API boundary、pack smoke required entries 和 release-p28-p32 测试覆盖，且全部保持 evidence-only/fail-closed。
- P33-01 memory center / project memory audit：新增 canonical `docs/memory/`、外部项目 `.yolo/memory/` bootstrap、`yolo memory refresh`、`.md/.jsonl` 审计、结构树刷新、hook/log-change 迁移路径修复和 package memory docs 打包校验；未删除历史文件，删除候选只进入审计；全量 647 tests / 109 suites / 0 fail。
- P37-01 document governance report：新增 canonical `docs/memory/DOCUMENT_GOVERNANCE.md`，明确 memory docs、machine ledgers、public docs、roadmap/gap/API refs、spec artifacts、tmp scratch 和 legacy sources 的唯一归位、命名规则和 add/move/delete policy；`yolo memory refresh`、`yolo init` 和 package smoke 均已接入；全量 664 tests / 112 suites / 0 fail。
- P36.5-01 docs truth sync：同步进度表顶部总览、结构指标和 gap matrix 中 src/test/export/root/runner 数字，并新增 `docs-truth-sync` 测试防止旧数字继续漂移。
- P37-02 isolated real-project dogfood pack：新增 `src/release/real-project-dogfood-pack.mjs`，在隔离外部项目内跑 `yolo init`、agent bridge dry-run、skill/command dry-run doctor，并生成 idea/discovery/plan/PRD/check/review/accept/controlled-run evidence 后通过 real-project dogfood gate。
- P38-01 experience pack effectiveness audit：新增 `src/release/experience-pack-audit.mjs`，制造一次相关失败经验和无关噪音经验，再验证下一次 prompt 只注入相关经验、数量受限、不阻塞 prompt 生成。
- P39-01 non-technical UX doctor：新增 `src/release/nontechnical-ux-doctor.mjs`，校验 README、agent docs、native skill、Claude/Codex command artifacts 都收束到 `/yolo 你的需求，先读状态并选择安全阶段，不要改代码。` 和 chat-first 规则。
- P40-01 lifecycle/command/doctor foundation：新增 `.yolo/lifecycle` schema/state helper、统一 `/yolo-*` command registry、`yolo doctor` 只读检查模块，并让 agent bridge 从 registry 生成 15 个 lifecycle commands 和 11 个 workflow skills；`yolo init` 已生成 lifecycle status/artifacts；全量 673 tests / 115 suites / 0 fail。
- P40-02 PI/team/discovery/spec foundation：新增 team agent contract、discovery readiness gate 和 discovery/plan -> spec/PRD compiler；PI plan 已接入 lifecycle/team/discovery metadata，模糊需求会以 `needs_discovery` 停止，不再直接进入 PRD/runner；全量 682 tests / 118 suites / 0 fail。
- P40-03 check/run/review/learning foundation：新增 `/yolo-check` 实体 check report、lifecycle progress writer 和 review fix loop；check 覆盖 PRD preflight、PM/UI/atomicity/adapter/evidence readiness，runner runtime 在 SDK stateRoot 下先 check 再写 lifecycle run report，review HIGH/CRITICAL finding 会生成 traceable fix PRD/report 并阻断 ship；全量 689 tests / 121 suites / 0 fail。
- P40-04 acceptance/resolver foundation：新增 acceptance report 与 pack/adapter resolver；`yolo accept` 可输出 P0/P1/P2/human review 分类并写入 lifecycle，resolver 从 `.yolo/packs` / `.yolo/adapters` 读取 manifest，未知项目走 `unknown/custom`，UI acceptance 缺 adapter/evidence fail closed；全量 695 tests / 123 suites / 0 fail。
- P40-05 eval/benchmark foundation：新增 `src/eval/benchmark.mjs`、`yolo eval`、`/yolo-eval`、`sdk.eval.*` 和 `./eval/benchmark` experimental export；固定 10 个模糊需求、5 个 UI acceptance、5 个真实 dogfood scenario，缺结果、低分或回归超阈值会阻断 public readiness，且不执行 provider、不发布；全量 702 tests / 124 suites / 0 fail。
- P40-06 controlled parallel foundation：新增 `src/runtime/parallel/wave-planner.mjs` 和 `sdk.parallel.*` experimental namespace，覆盖 task dependency graph、wave planner、worktree isolation plan、file conflict detector、merge gate、evidence merge、rollback/retry/escalation policy；缺依赖、文件范围冲突、缺证据或脏 scope merge 均 fail closed；全量 708 tests / 125 suites / 0 fail。
- P40-07 real-project dogfood v2 foundation：`src/release/real-project-dogfood-pack.mjs` 从 plan/check/review 扩展为 idea/discovery/plan/PRD/check/review/accept/controlled-run 全链路证据；真实 check、accept 和 controlled parallel merge gate 通过后才让 dogfood gate pass，仍不安装、不执行 provider、不发布；全量 708 tests / 125 suites / 0 fail。
- P40-08 SDK lifecycle façade foundation：`createYoloSdk()` 新增 `sdk.pi.*`、`sdk.commands.*`、`sdk.doctor.*`，并把 command registry / doctor named exports 纳入 experimental API boundary；不新增 stable package export，继续等待 stable-boundary 人工决策；全量 708 tests / 125 suites / 0 fail。
- P40-09 documentation consolidation foundation：README 改为 lifecycle-first；Codex/Claude chat docs、native integration docs、non-technical guide、agent bridge generated artifacts 和 UX doctor 对齐 `/yolo` 一句话入口；旧 `docs/yolo-discovery-ui-acceptance-plan.md` 已标记为 historical reference，active truth 回到 deliverable plan、progress 表和 gap matrix；全量 708 tests / 125 suites / 0 fail。
- P40-10 lifecycle-aware progress dashboard：新增 `src/runtime/progress/lifecycle-dashboard.mjs`、`/lifecycle.json` 和 idle lifecycle summary，让 progress dashboard 在 runner 空闲时仍能展示 current stage、blockers、evidence 和 next action；本批用 `yolo-run` 跑到 provider、gate PASS 和 merge，并暴露 commit/finalize self-dogfood 收尾问题；全量 712 tests / 125 suites / 0 fail。
- P40-11 runner self-dogfood finalize hardening：`commit-flow` 改为本地导入 `doc-updater`，doc 更新失败、bare/non-worktree `git add`/commit 失败降级为可审计 warning；已通过 gate/merge 的真实代码仍继续跑 postconditions，只有 scope/postcondition/code-quality 问题才阻断交付；`doc-updater` 支持 runner 传入项目 root；本批同时清理临时 worktree 和 runtime 噪音；全量 718 tests / 126 suites / 0 fail。
- P40-12 completion noise cleanup policy：runner 启动前递归清理旧 runtime 子目录；成功完成后自动清理 provider 输出、context pack、gate/runtime cache、task logs、task-results、pid/output log 和 `.yolo-worktrees`；失败时保留必要 debug artifacts，避免 cleanup 变成新的阻塞点；全量 721 tests / 126 suites / 0 fail。
- P40-13 strong gate non-blocking remediation foundation：新增 `src/runtime/gates/remediation-plan.mjs`，把强 gate/harness 结果统一映射为 `RETRY_WITH_CONTEXT`、`AUTO_REMEDIATE`、`REROUTE_REVIEW_FIX`、`ASK_HUMAN`、`STOP_UNSAFE`；`yolo check`、runner gate failure、task results、run report 和 final answer 都会携带 remediation evidence，gate 强度不降、ship 仍 fail closed，但可调度问题不再只是停在 failed ID；全量 727 tests / 127 suites / 0 fail。
- P40-14 resolver-backed check and adapter evidence bridge：`/yolo-check` 已接入 `resolveProjectContext()`，check report 记录 resolver、task surface summary 和 resolver-selected acceptance adapter；PM/UI readiness 判断集中到 `src/runtime/gates/readiness-policy.mjs`，`check` 和 `accept` 共用；新增 `src/runtime/adapters/evidence-collector.mjs`、`yolo/runtime/adapter-evidence` 和 `sdk.acceptance.collectAdapterEvidence()`，默认 dry-run，只有显式 `execute + allowAdapterCommands` 才执行 manifest command 并把 evidence 写入 `.yolo/state/evidence/adapters/*-latest.json`；全量 733 tests / 128 suites / 0 fail。
- P40-15 progress dashboard UI/UX run evidence foundation：新增 `src/runtime/progress/ui-evidence.mjs`、`yolo/runtime/progress-ui-evidence`、`sdk.progress.*` 和 `yolo progress-ui-evidence`；progress dashboard server/client escaping 已加固，`yolo run --collect-evidence --execute-adapter --allow-adapter-commands` 可在 UI PRD 下显式采集本地 HTML snapshot / `ui_evidence`，acceptance adapter 可消费；bootstrap 新增 `DESIGN.md` / `.yolo/templates/UI-SPEC.md`，UI contract 来源对齐用户指定 5 个 design/skill 项目；全量 737 tests / 129 suites / 0 fail。
- P40-16 fresh task session and non-blocking strong harness closure：新增 task attempt fresh session contract、prompt session id、`task_session_start` event、immediate remediation queue、fixture safe command policy、expected artifact verification 和 primary evidence schema check；自动可修问题先进入修复队列，不把已知 bug 推迟到后期 review；全量 764 tests / 131 suites / 0 fail。
- Phase 5 第一刀 + Phase 1 边界批次：新增 `src/workflows/registry.mjs` 和 `sdk.workflows` experimental namespace，覆盖 PI/review/fix/ship workflow definitions、SDK/CLI/skill entrypoints、verification hooks 和 installable skill descriptor shape；当前不改变 stable agent preset，避免破坏 `yolo/agents` 兼容。
- Phase 6 第一刀 + Phase 4 组合批次：新增 `src/fixtures/registry.mjs`、`sdk.fixtures` experimental namespace，以及 `fixtures/node-basic`、`fixtures/no-tests` 最小夹具，覆盖 fixture manifest 读取、requirement/spec/task/run/evidence 完整性检查和 fixture evidence record。
- Phase 6 第二刀 + Phase 4 组合批次：新增 `src/fixtures/harness.mjs` 和 `sdk.fixtures.runFixtureHarness()`，可把 fixture 复制到临时目录隔离执行 smoke command，并写入 fixture run evidence。
- Phase 7 第一刀：新增 `src/release/readiness.mjs` 和 `sdk.release` experimental namespace，覆盖 package semver/license/export/bin 检查、README/CHANGELOG/API docs 检查、fixture registry 检查，并把 `private: true` 作为 public release blocker；当前不会自动改包发布状态。

后续重点：

1. P28-P39 evidence/memory/document-governance/dogfood/UX gates 已完成；人工确认前仍不执行 `npm publish`、不读取 token、不执行 billable provider，也不自动删除 legacy/scratch memory 文件。
2. 未收到人工 operator 指令时，继续做 non-billable real-project dogfood/fixture hardening，并在需要时小步拆 internal runtime helpers。

P40-16 后，SDK 已经从“root 脚本混放 + runner-core 大块逻辑 + operator runbook 边界 + 散落记忆文档”推进到“root shim 清零迁移债 + runner-core 600 行预算 + runtime implementation freeze-ready + local dogfood evidence + runtime stable-boundary candidate + post-release audit + stable graduation + manual external evidence bundle + native agent skill/command integration + public beta evidence bundle + canonical memory center + document governance + isolated dogfood pack + experience effectiveness audit + non-technical UX doctor + lifecycle-first documentation consolidation + lifecycle-aware progress dashboard + runner self-dogfood finalize hardening + completion noise cleanup policy + strong gate remediation plan + resolver-backed check + authorized adapter evidence bridge + progress dashboard UI/UX run evidence + fresh task session contract + non-blocking immediate remediation queue + fixture evidence/command policy 边界”；剩下的硬点是真实 publish、billable execution 实战、`./runtime` API stable boundary 人工批准、public dogfood 证据，以及删除候选记忆文件的人工 cleanup 决策。

## 风险边界

- 不建议第一步就大规模移动所有文件；当前 runner 和 data/closed-loop 仍有历史耦合，一次性移动会制造假进展。
- 不建议只做 PI agent；PI 越强，越容易把 core SDK 的混乱藏起来。
- 不建议承诺“全部完成后不会有大 bug”。合理目标是 public beta 级别：严格 fail-closed、可恢复、可审计、跨 fixture 通过、重大 bug 概率显著降低。
- 公开前必须证明它能处理陌生项目、脏工作区、失败基线、缺测试项目和多 agent adapter。
