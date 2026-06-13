# YOLO Deliverable Implementation Plan

日期：2026-05-25

状态：总交付计划。本文列出从当前 YOLO 状态到最终可交付 PI-led Team Agent 产品所需的全部实现项；不声明下列能力已经完成。

## 1. 北极星

YOLO 最终不是一组脚本、一个 CLI、一个 SDK、一个 PI helper，或者一堆 skill。YOLO 最终应该是一个能在 Codex / Claude Code 中直接使用的项目生命周期 Team Agent。

用户只需要说：

```text
/yolo 我有一个想法，帮我从零开始规划这个项目，先不要改代码。
```

YOLO 应该能完成：

```text
idea
  -> discovery
  -> project setup
  -> roadmap / plan
  -> PRD / spec
  -> check
  -> run
  -> review / fix
  -> acceptance
  -> ship
  -> learn
```

全过程必须自动留下进度、计划、日志、改动记录、验证证据、验收证据、交付报告和学习记录；后续项目能从已验证的历史经验中获得有限、相关、非阻塞的提示。

## 2. 当前真实状态

已有基础：

- Runner / gate / review / retry / evidence 主链路较成熟。
- `sdk.mjs` 已暴露 project、spec、prd、runtime、review、release、workflow 等能力。
- `yolo init`、project memory、stateRoot 隔离、package smoke、fixture harness、release evidence gates 已存在。
- Codex / Claude agent bridge 已能生成 skills、Claude slash commands 和 source-command fallback。
- learning center / experience pack 已能记录经验并按相关性限量注入。
- PI agent 已能生成 `requirement -> findings -> PRD -> preflight -> runner -> review -> final gate` 的 plan。

核心缺口：

- PI 已有 lifecycle/team/discovery/spec/check/run/review/accept/eval/parallel 基础协调；controlled parallel 已有 foundation，仍需要 D18 dogfood v2 证明真实项目闭环。
- 命令、workflow、docs、agent bridge 已有统一事实源；D20 文档收束已把 README、Agent 使用说明、非技术用户指南、non-technical UX doctor 和旧 discovery/UI reference plan 对齐到同一条生命周期主线。
- `/yolo-discover`、`/yolo-prd`、`/yolo-check`、`/yolo-accept`、`/yolo-ui-review`、`/yolo-eval` 已进入统一命令注册表和 agent bridge；D10 controlled parallel 以 `sdk.parallel.*` 形式先落地为 PI/team 调度底座。
- discovery/UI acceptance/eval 已有 foundation；还需要更多真实项目证据证明稳定性。
- lifecycle artifact 已有统一 schema、状态文件和 `yolo init` 骨架，runner/PI 已开始写入生命周期状态，parallel/evidence merge 已有 foundation，仍需接入更完整 dogfood v2。
- team agent contract 已有基础；并发 wave、worktree isolation、merge gate 和 evidence merge 已系统化为 experimental SDK surface。
- 用户仍需要理解太多内部概念，非技术体验不够像一个完整产品。

## 3. 最终交付物总表

| ID | 交付物 | 目标 | 优先级 | 状态 |
|---|---|---|---|---|
| D01 | Lifecycle Spine | 统一 idea -> learn 的生命周期 schema、状态机和 artifact 目录 | P0 | foundation built |
| D02 | Command Registry | 统一 `/yolo-*` 命令、workflow、docs、agent bridge 的事实源 | P0 | foundation built |
| D03 | Codex / Claude Native UX | 用户在 Codex / Claude Code 里直接使用，不记 CLI | P0 | in progress |
| D04 | PI Orchestrator | PI 从 helper 升级为 lifecycle 总协调者 | P0 | foundation built |
| D05 | Team Agent Contracts | 定义 discovery/planner/spec/implementer/reviewer/QA/release/learning agent 合同 | P0 | foundation built |
| D06 | Discovery Gate | 模糊需求先澄清，不允许直接进 runner | P0 | foundation built |
| D07 | PRD / Spec Compiler | discovery/plan -> executable PRD/spec，含 approval gate | P0 | foundation built |
| D08 | Check Gate Expansion | `/yolo-check` 覆盖 PM readiness、UI readiness、atomicity、adapter readiness | P0 | foundation built |
| D09 | Execution Orchestration | runner 接入 lifecycle、task graph、agent dispatch 和 evidence merge | P1 | foundation built |
| D10 | Controlled Parallel Execution | subagent wave、worktree isolation、merge/gate/review 统一调度 | P1 | foundation built |
| D11 | Review / Fix Loop | review findings -> fix PRD -> gated fix -> evidence | P1 | foundation built |
| D12 | Acceptance / UI Evidence | 功能验收、UI/UX evidence、P0/P1/P2/human review 分层 | P0 | foundation built |
| D13 | Resolver / Pack / Adapter System | platform/stack/component/design/acceptance adapter manifest 化 | P1 | foundation built |
| D14 | Doctor / Wizard | 一条报告告诉用户当前能不能用、下一步说什么、会不会改代码 | P0 | foundation built |
| D15 | Memory / Learning Integration | lifecycle 自动记录进度、改动、失败、修复、复盘和经验 | P0 | foundation built |
| D16 | Eval / Benchmark | 固定模糊需求、PRD、UI acceptance、agent command 质量评分 | P1 | foundation built |
| D17 | Public SDK / API Boundary | 将稳定 API、experimental API、internal API 收束到生命周期产品 | P1 | foundation built |
| D18 | Real Project Dogfood | 用真实隔离项目从 idea 到 review/accept 跑通并产出报告 | P0 | foundation built |
| D19 | Release / Stable Path | public beta、operator release、post-release audit、stable graduation | P2 | partially built |
| D20 | Documentation Consolidation | 文档只围绕唯一产品主线，移除散乱感和重复事实源 | P0 | foundation built |

## 4. 目标目录形态

安装到用户项目后，YOLO 状态应主要归入 `.yolo/`：

```text
.yolo/
  lifecycle/
    idea.json
    discovery.json
    roadmap.json
    task-graph.json
    prd.json
    check-report.json
    run-report.json
    review-report.json
    acceptance-report.json
    delivery-report.json
    retrospective.json
  state/
    events.jsonl
    changes.jsonl
    runs.jsonl
    session-memory.jsonl
    learning.jsonl
  memory/
    CURRENT_STATUS.md
    CURRENT_HANDOFF.md
    PROJECT_TREE.md
    LESSONS_PLAYBOOK.md
  context/
    design-brief.md
    design-contract.md
    state-matrix.json
    tokens.json
  packs/
    *.manifest.json
  adapters/
    *.manifest.json
  evidence/
    ...
```

YOLO package root 只保存 SDK、runtime、templates、fixtures、docs 和 release gates，不保存用户项目运行状态。

## 5. D01 Lifecycle Spine

目标：让 YOLO 永远知道项目处于哪一步，下一步是什么，是否会改代码，缺什么证据。

交付：

- `src/lifecycle/schema.mjs`
- `src/lifecycle/state.mjs`
- `src/lifecycle/artifacts.mjs`
- `src/lifecycle/progress.mjs`
- lifecycle artifact schema：
  - idea
  - discovery
  - roadmap
  - task graph
  - PRD/spec
  - check report
  - run report
  - review report
  - acceptance report
  - delivery report
  - retrospective

验收：

- `yolo init` 生成 lifecycle skeleton。
- SDK 可读写 lifecycle state。
- 状态写入项目 `.yolo/lifecycle/`。
- 能用机器检查阻断项和下一步。

## 6. D02 Command Registry

目标：命令不能再分散写在 agent bridge、workflow registry 和 docs 里。

交付：

- `src/workflows/command-registry.mjs`
- command schema：
  - id
  - slash command
  - lifecycle stage
  - writes_code
  - requires_confirmation
  - inputs
  - outputs
  - agent route
  - SDK route
  - CLI route
  - safety text
  - plain-language help

命令清单：

- `/yolo`
- `/yolo-discover`
- `/yolo-init`
- `/yolo-plan`
- `/yolo-prd`
- `/yolo-check`
- `/yolo-run`
- `/yolo-review`
- `/yolo-fix`
- `/yolo-accept`
- `/yolo-ui-review`
- `/yolo-eval`
- `/yolo-ship`
- `/yolo-learn`
- `/yolo-doctor`

验收：

- `tools/install-agent-bridge.mjs` 从 command registry 生成 Claude/Codex artifacts。
- `src/workflows/registry.mjs` 从 command registry 或同源 workflow registry 生成 workflow descriptors。
- docs command list 由测试锚定，不能漂移。
- 新增 drift test：registry、agent bridge、docs、workflow descriptors 必须一致。

## 7. D03 Codex / Claude Native UX

目标：非技术用户不需要打开终端、不需要记命令。

交付：

- Claude Code `.claude/commands/yolo*.md`
- Claude Code `.claude/skills/yolo`
- Codex `.codex/skills/yolo`
- Codex `~/.agents/skills/yolo/SKILL.md`
- Codex `source-command-yolo-*` fallback
- Chat-first 使用说明
- 一句话入口：

```text
/yolo 我有一个想法，帮我从零开始规划这个项目，先不要改代码。
```

验收：

- `/yolo-plan`、`/yolo-check`、`/yolo-run`、`/yolo-review` 继续兼容。
- `/yolo` 默认只规划，不改代码。
- `/yolo-doctor` 能报告 Claude/Codex 当前集成状态。

## 8. D04 PI Orchestrator

目标：PI 不再只是 plan helper，而是 lifecycle 总协调者。

交付：

- `src/agents/pi/orchestrator.mjs`
- `src/agents/pi/dispatch.mjs`
- `src/agents/pi/status-report.mjs`
- `src/agents/pi/stop-rules.mjs`

职责：

- 读取 lifecycle state。
- 识别当前阶段。
- 决定下一步。
- 调用 discovery / planner / PRD / runner / review / acceptance / learning。
- 汇总 evidence。
- 输出 plain-language status。
- 对缺信息、弱 PRD、缺 adapter、缺验收证据 fail closed。

验收：

- `/yolo` 走 PI orchestrator。
- `/yolo-plan`、`/yolo-check`、`/yolo-run`、`/yolo-review` 共享同一 lifecycle state。
- PI 不绕过 PRD preflight、contract gate、spec governance、review、acceptance。

## 9. D05 Team Agent Contracts

目标：先有 agent contract，再谈 subagent 并发。

交付：

- `src/agents/team/registry.mjs`
- `src/agents/team/contracts.mjs`
- `src/agents/team/dispatch-plan.mjs`
- `src/agents/team/permissions.mjs`

Agent 清单：

- `pi-orchestrator`
- `discovery-agent`
- `planner-agent`
- `architect-agent`
- `spec-agent`
- `implementer-agent`
- `reviewer-agent`
- `qa-acceptance-agent`
- `release-agent`
- `learning-agent`

每个 agent contract 至少包含：

- 输入 artifact。
- 输出 artifact。
- 允许写入范围。
- 禁止写入范围。
- stop conditions。
- evidence requirements。
- handoff format。

验收：

- 未注册 agent 不能被 dispatch。
- 无写入范围的 agent 不能执行改代码任务。
- agent 输出必须能被 PI orchestrator 合并。

## 10. D06 Discovery Gate

目标：模糊需求不能被直接转成 runner task。

交付：

- `/yolo-discover`
- discovery brief schema
- discovery readiness gate
- open questions handling
- idea -> discovery artifact writer

Discovery brief 必须包含：

- 用户是谁。
- 业务目标。
- 当前痛点。
- 主流程。
- 成功标准。
- 非目标。
- 数据/权限/角色约束。
- UI 风格和交互偏好。
- 必须支持的状态。
- 风险。
- 开放问题。
- 是否足够进入 PRD。

验收：

- 缺目标用户、主流程、成功标准、非目标时 blocked。
- `/yolo-plan` 遇到模糊需求会转 discovery，不直接生成执行 PRD。
- discovery 输出写入 `.yolo/lifecycle/discovery.json`。

## 11. D07 PRD / Spec Compiler

目标：把 discovery/plan 变成可执行、可检查、可追踪的 PRD/spec。

交付：

- `/yolo-prd`
- Markdown PRD draft -> executable PRD JSON 编译流程
- human approval gate
- atomic task scoring
- target coverage migration
- traceability matrix

验收：

- PRD task 必须有 scope、pre_conditions、post_conditions、acceptance、non-goals。
- 弱 postcondition 阻断。
- task target coverage 不足阻断。
- PRD approval 未通过时不能进入 run。

## 12. D08 Check Gate Expansion

目标：`/yolo-check` 不只检查 schema，也检查产品和验收准备度。

交付：

- PM readiness gate
- UI readiness gate
- atomicity score
- adapter readiness gate
- evidence plan readiness gate
- check report JSON/Markdown

验收：

- discovery 缺关键项时 fail closed。
- UI task 缺目标 surface、state matrix、evidence plan 时 fail closed。
- 缺 adapter 但不是 UI task 时可 warning；缺 adapter 且任务需要验收时 blocked_by_config。

## 13. D09 Execution Orchestration

目标：runner 作为执行引擎接入 lifecycle，而不是旁路执行。

交付：

- lifecycle-aware runner entry
- run report 写入 `.yolo/lifecycle/run-report.json`
- task graph -> runner PRD mapping
- execution event -> memory / evidence ledger

验收：

- run 前必须经过 check gate。
- run 后必须写 run report、changed files、gate evidence、remaining blockers。
- runner 不写 package root 状态。

## 14. D10 Controlled Parallel Execution

目标：让 YOLO 最终支持 PI-led 多 subagent 并发，但必须可控。

交付：

- task dependency graph
- wave planner
- worktree/workspace isolation
- conflict detector
- evidence merge
- merge gate
- rollback / retry / escalation policy

验收：

- 文件范围冲突的任务不并发。
- 依赖未完成的任务不并发。
- 每个 wave 后统一 merge、gate、review。
- 失败能停在具体 wave/task，不污染主线。

## 15. D11 Review / Fix Loop

目标：review 不是报告而已，要能闭环到 fix。

交付：

- review findings -> fix PRD converter
- fix PRD check gate
- fix runner path
- post-fix review
- review evidence summary

验收：

- HIGH/CRITICAL finding 不能直接 ship。
- fix task 继承原 finding、scope、acceptance。
- 修复后必须重新跑相关 gate。

## 16. D12 Acceptance / UI Evidence

目标：实现完成不等于验收完成。

交付：

- `/yolo-accept`
- `/yolo-ui-review`
- acceptance report schema
- UI evidence plan
- P0/P1/P2/human review 分类
- screenshot/log/runtime error/evidence refs

验收：

- 页面打不开、关键路径不可用、主要内容遮挡、必需状态缺失属于 P0 hard fail。
- 关键证据缺失属于 P1 release blocker。
- 主观视觉 polish 属于 P2 warning 或 human review，不自动无限阻塞。
- acceptance report 写入 `.yolo/lifecycle/acceptance-report.json`。

## 17. D13 Resolver / Pack / Adapter System

目标：保持通用，不把技术栈、组件库、设计风格写死进 core。

交付：

- `.yolo/packs/*.manifest.json`
- `.yolo/adapters/*.manifest.json`
- resolver
- selected context report
- adapter capability checks

Manifest 类型：

- platform_adapter
- stack_adapter
- component_adapter
- design_reference_pack
- quality_rule_pack
- acceptance_adapter

验收：

- 未识别项目走 `unknown/custom`，不猜技术栈。
- adapter 必须声明 inputs、outputs、commands、evidence、capabilities。
- core 只读取 manifest，不引用具体 pack 名。

## 18. D14 Doctor / Wizard

目标：用户不用猜当前项目能不能用。

交付：

- `yolo doctor`
- `/yolo-doctor`
- doctor JSON
- plain-language doctor report
- next sentence suggestion

报告必须回答：

- 当前项目是否初始化。
- Codex 是否可用。
- Claude Code 是否可用。
- 当前 lifecycle 阶段。
- 缺哪些文件或配置。
- 下一步应该说什么。
- 下一步是否会改代码。
- 哪些 gate 会阻断。

验收：

- 非技术用户能看懂。
- agent 能用 JSON 结果自动选择下一步。

## 19. D15 Memory / Learning Integration

目标：进度、计划、日志、改动、失败、修复、验收、交付、复盘都成为可追踪记忆。

交付：

- lifecycle event -> state ledger
- run/review/acceptance/delivery -> session memory
- failure/recovery -> learning candidate
- retrospective -> learning records
- bounded learning retrieval

验收：

- 每次执行有 event。
- 每次失败有 root cause 或 unknown marker。
- 每次修复有 recovery record。
- 每次项目结束有 retrospective。
- 下次只注入相关 1-3 条经验，不相关不注入。

## 20. D16 Eval / Benchmark

目标：证明 command、skill、PI orchestrator 和 discovery/PRD/acceptance 质量在变好。

交付：

- 10 个模糊需求 fixture。
- 5 个 UI acceptance fixture。
- 5 个真实项目 dogfood scenario。
- scoring rubric。
- regression report。

评分维度：

- 需求澄清。
- 业务目标/用户场景。
- 任务原子性。
- PRD 可执行性。
- gate 质量。
- UI/UX 规格完整度。
- evidence 完整度。
- runner 兼容性。
- 非技术用户可理解性。

验收：

- 评分低于阈值不能进入 public readiness。
- eval 结果写入 evidence，不作为主观口头判断。

## 21. D17 Public SDK / API Boundary

目标：围绕 lifecycle 收束 SDK，而不是把所有模块平铺给用户。

交付：

- `sdk.lifecycle.*`
- `sdk.pi.*` 或 `sdk.agents.pi.*`
- `sdk.commands.*`
- `sdk.doctor.*`
- API boundary 更新
- docs 更新

当前 foundation：

- `createYoloSdk()` 已提供 `sdk.pi.*`、`sdk.commands.*`、`sdk.doctor.*`，把 PI、命令注册表和 doctor 报告从散点 API 收束成生命周期产品入口。
- 这些入口当前仍是 experimental，不改变 package export/stable 承诺；稳定升级仍需要 human stable-boundary decision 和外部 release evidence。

验收：

- stable / experimental / internal 清晰。
- import-safe。
- package smoke 通过。
- 不把 internal runner helper 误暴露成 stable API。

## 22. D18 Real Project Dogfood

目标：用真实隔离项目证明 YOLO 不是纸面闭环。

交付：

- external project dogfood pack v2
- idea -> discovery -> plan -> PRD -> check -> review -> accept no-code path
- controlled run path
- dogfood report

当前 foundation：

- `src/release/real-project-dogfood-pack.mjs` 已在隔离外部项目生成 idea、discovery、plan、PRD、check、review、accept、controlled-run 八段证据。
- dogfood pack 会让真实 `inspectYoloCheck()`、`buildAcceptanceReport()` 和 `sdk.parallel` merge gate 通过后，才把 v2 dogfood gate 判为 pass。
- 该路径仍然 dry-run / evidence-only：不安装 agent bridge、不执行 provider、不发布、不读凭证。

验收：

- 不污染 package root。
- 不默认执行 provider。
- 证据完整。
- doctor 能解释当前项目可用性。

## 23. D19 Release / Stable Path

目标：公开前证据齐全，但仍由人工 operator 执行 publish/token/billable/provider/report 动作。

交付：

- public beta evidence bundle v2
- runtime stable-boundary decision packet
- operator runbook update
- post-release audit update
- stable graduation update

验收：

- `private:true` 移除仍需人工决策。
- publish/token/billable/provider 不由 SDK 自动执行。
- public dogfood evidence 齐全后才允许 beta/stable claim。

## 24. D20 Documentation Consolidation

目标：文档不再散乱，所有文档围绕唯一产品主线。

当前实现状态：foundation built。README 已改为 lifecycle-first，Codex/Claude 使用说明和 non-technical guide 已收束到 `/yolo 你的需求，先读状态并选择安全阶段，不要改代码。`，non-technical UX doctor 会用机器检查这个入口和 chat-first artifacts，旧 `docs/yolo-discovery-ui-acceptance-plan.md` 已标记为 historical reference，active truth 归到本文件、progress 表和 gap matrix。

交付：

- README 改成 lifecycle-first。
- `docs/agent-chat-usage.md` 改成 Codex/Claude-first。
- `docs/yolo-discovery-ui-acceptance-plan.md` 被标记为 historical reference，核心内容已拆解并并入本总计划和 active roadmap。
- `docs/yolo-public-sdk-progress.md` 保留 ordered execution truth。
- `docs/sdk-gap-matrix.md` 保留战略对比和差距。
- memory docs 继续由 memory center 生成。

验收：

- 用户从 README 能知道一句话入口。
- 贡献者从本文件知道全部待交付项。
- agent 从 progress 表知道下一步执行顺序。
- 不新增重复事实源。

## 25. 执行顺序

### Wave A：止血和主线统一

范围：

- D01 Lifecycle Spine
- D02 Command Registry
- D03 Codex / Claude Native UX
- D14 Doctor / Wizard 基础版
- D20 文档入口更新

成功标准：

- YOLO 有唯一 lifecycle。
- YOLO 有唯一 command registry。
- Codex/Claude artifacts 从 registry 生成。
- doctor 能告诉用户下一步。

### Wave B：PI 成为总协调者

范围：

- D04 PI Orchestrator
- D05 Team Agent Contracts
- D06 Discovery Gate
- D07 PRD / Spec Compiler

成功标准：

- `/yolo` 能从 idea/discovery 开始。
- PI 能按 lifecycle 调度下一步。
- 模糊需求不直接进入 runner。
- PRD 生成前有 approval gate。

### Wave C：检查和执行闭环

范围：

- D08 Check Gate Expansion
- D09 Execution Orchestration
- D11 Review / Fix Loop
- D15 Memory / Learning Integration

成功标准：

- check 覆盖 PM readiness、spec、contract、adapter readiness。
- run/review/fix 全部写入 lifecycle 和 evidence。
- 失败和修复进入 learning，但不阻塞主流程。

### Wave D：验收和 UI/UX 证据

范围：

- D12 Acceptance / UI Evidence
- D13 Resolver / Pack / Adapter System
- D16 Eval / Benchmark

成功标准：

- UI task 有 surface/state/evidence 约束。
- acceptance 能产生 P0/P1/P2/human review 报告。
- benchmark 能证明 discovery/PRD/UI acceptance 质量。

### Wave E：可控并发和 Team Agent

范围：

- D10 Controlled Parallel Execution
- D05 Team Agent Contracts 增强
- D18 Real Project Dogfood v2

成功标准：

- subagent 并发有 task graph、wave、worktree isolation、merge gate。
- 真实隔离项目 dogfood 通过。
- PI orchestrator 能合并 evidence 和报告。

### Wave F：公开交付和稳定化

范围：

- D17 Public SDK / API Boundary
- D19 Release / Stable Path
- D20 Documentation Consolidation 完整版

成功标准：

- public API 以 lifecycle/PI 为主线。
- release gates 和 operator runbook 更新。
- README、docs、progress、gap matrix 不再讲多套主线。

## 26. 第一批可执行任务

第一批不是“全部做完”，而是先防止继续变乱：

| ID | 任务 | 输出 | 验证 | 状态 |
|---|---|---|---|---|
| A1 | 建 lifecycle schema skeleton | `src/lifecycle/schema.mjs` | lifecycle schema tests | done |
| A2 | 建 lifecycle state helper | `src/lifecycle/state.mjs` | stateRoot isolation tests | done |
| A3 | 建 command registry | `src/workflows/command-registry.mjs` | registry drift tests | done |
| A4 | agent bridge 改读 registry | 更新 `tools/install-agent-bridge.mjs` | agent bridge tests | done |
| A5 | workflow registry 对齐 command/lifecycle | 更新 `src/workflows/registry.mjs` | workflow registry tests | done |
| A6 | docs command list 对齐 | 更新 user docs | docs truth tests | done |
| A7 | doctor 最小计划报告 | `src/runtime/devtools/doctor.mjs` | doctor tests | done |
| A8 | memory/progress 更新 | progress、gap、memory | memory center tests | done |

## 27. 停止条件

必须暂停沟通的情况：

- 要改变 stable public API 承诺。
- 要移除 `private:true`。
- 要 publish、读 token 或执行 billable provider。
- 要删除 legacy/scratch 文件。
- 要让多个 agent 并发改同一个工作树。
- lifecycle schema 与当前 `yolo init` / stateRoot 隔离冲突。
- 测试失败且根因不明。

## 28. 非目标

当前总计划不把以下内容作为自动执行项：

- 不自动发布 npm。
- 不读取用户凭证。
- 不默认执行付费 provider。
- 不把某个技术栈、组件库、设计风格写进 core。
- 不把主观审美作为无限 retry 的 hard fail。
- 不为了“像 GSD”而复制 GSD 的全部 phase 系统。
- 不为了“像 pi.dev”而把 YOLO 改成纯 terminal agent shell。

YOLO 要吸收它们的强项，但产品主线必须是自己的：项目生命周期 + PI-led Team Agent + 严格 gate/evidence/learning。

## 29. 最终 Definition of Done

YOLO 可交付版本必须满足：

- 用户能在 Codex / Claude Code 里用一句话开始。
- YOLO 能从 idea 到 learn 全流程记录状态。
- 模糊需求会先 discovery。
- PRD/spec 可执行、可检查、可追踪。
- check 能阻断弱 PRD、缺 PM readiness、缺 UI readiness。
- run 只执行通过检查且用户确认的任务。
- review/fix 能闭环。
- acceptance 有功能和 UI/UX 证据。
- delivery 有风险和剩余事项。
- learning 能把本项目踩坑变成后续项目的相关提示。
- doctor 能告诉非技术用户当前能不能用、下一步说什么。
- Codex / Claude 集成不是文档承诺，而有可安装 artifacts 和 doctor 证据。
- 真实隔离项目 dogfood 有完整报告。
- 所有 public SDK / CLI / docs / memory 状态一致。
