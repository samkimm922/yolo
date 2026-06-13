# YOLO Demand Doctrine

本文档固化 YOLO 需求流程的产品魂和实现原则。它吸收 gstack、superpowers、mattpocock skills、Spec Kit/OpenSpec、GSD、product-manager-skills 的思想，但不机械照搬任何项目源码；YOLO 只保留适合本项目的流程骨架、产物边界和验证门禁。

## 一句话原则

YOLO 不是把用户一句话立刻变成代码，而是把一句话需求先变成可证明、可批准、可拆分、可恢复的 `prd.json` 原子任务。

核心魂是：

- 一问一答：每轮只问一个最小问题，用户只需要用业务语言回答。
- 先问题后方案：先确认谁有问题、今天怎么做、哪里痛、为什么现在要做，再讨论怎么实现。
- 硬门禁：现状、痛点、证明、边界、批准缺一不可。缺任何一项，不能生成可执行 PRD。
- 非技术友好：用户不需要知道文件名、类名、接口名；YOLO 可以推断，但必须把推断变成可确认的边界。
- 完成靠证据：写出代码不算完成，能通过 gate、能留下 evidence、能给下一位 operator 接手，才算完成。

`/yolo-demand` 的默认身份是需求访谈主持人，不是建议机器人。只要 `missing_slots` 还有缺口，用户对话层只能返回一个 `next_question`，不能输出大段建议、不能进入 PRD、不能改代码。批准最后：只有问题、现状、痛点、证据、边界都具像化后，才请求用户批准进入下一阶段；这仍然不是执行授权。

## 分层来源

这些参考不是重复角色，而是分层补强：

| 层 | 参考思想 | YOLO 吸收方式 |
|---|---|---|
| 流程骨架 | gstack / superpowers | 强制流程、显式状态、手工批准、可恢复 handoff、fail-closed gate。它们回答“流程怎么不跑偏”。 |
| 工程/domain grill | mattpocock skills | 小而可组合的能力、清晰输入输出、对需求和实现做追问。它回答“这个任务是否足够小、足够清楚”。 |
| 结构化产物 | Spec Kit / OpenSpec | requirements -> design/context -> tasks 的生命周期、阶段确认、traceability。它们回答“产物怎么落盘和回溯”。 |
| 拆解和运营 | GSD / product-manager-skills | 把需求拆成模块、任务、风险、验收、决策和问题 ledger。它们回答“后续维护者如何继续做”。 |

分层后不会出现四套流程。YOLO 只有一条主线：访谈澄清 -> 需求产物 -> 场景矩阵 -> 原子任务 -> gate -> 执行。

## 需求硬门禁

进入可执行 `prd.json` 前，需求必须满足以下门禁：

| 门禁 | 必须回答的问题 | 不满足时的处理 |
|---|---|---|
| 现状 | 用户今天怎么做？现在的替代方案是什么？ | 停在 discovery/discuss，不进入 PRD。 |
| 痛点 | 今天的方式哪里慢、错、贵、风险高或体验差？ | 继续一问一答，不能直接给方案。 |
| 证明 | 用户怎么知道它真的好了？证据或验收是什么？ | 不能生成原子任务，因为 task 没有 post condition。 |
| 边界 | 哪些不做？哪些行为不能改变？哪些异常要保留？ | 不能给 agent 执行，避免越权改动。 |
| 批准 | 用户是否明确批准从需求产物编译可执行 PRD？ | `approval.approved !== true` 时阻断。 |

这个门禁和现有 readiness 语义对齐：L0 是模糊想法，L1 有愿景和证据/假设，L2 需求和阻塞问题已收敛，L3 才能生成可执行 PRD。

可执行 PRD 只有一个口径：`source: approved_demand`、`approval.approved === true`、`approval.effective_for_prd === true`、demand quality 为 `pass`，并且 runner preflight 在 schema、demand contract、spec governance 和 warning policy 下返回 `pass`。`warning`、`blocked`、`draft`、`not_run`、`indeterminate` 或缺 validator 都不是可执行状态。

Discovery、Spec lifecycle、module-deep-dive 和 audit-to-prd 默认只能生成 draft/pending approval 产物。它们可以保留 trace、任务草案和 handoff，但不得把任务标成可直接执行，也不得伪造 human-approved L3。Discovery `ready_for_prd !== true` 时尤其不能输出 executable PRD 或用 exit 0 宣称已可执行。

`interview to-demand` 只负责把访谈转换成 demand session。转换后的 `demand_result.status` 如果是 `blocked` 或 `warning`，CLI 结果也必须是阻塞/警告并返回非 0；不能包装成 `INTERVIEW_DEMAND_CREATED`。

## Demand Router

统一只读入口是 `yolo demand status`。它不写 `.yolo` 状态、不生成 PRD、不改业务代码，只回答当前需求阶段应该怎么走：

- `context_type`: `greenfield | brownfield | hybrid | unknown`。
- `route`: 默认 `fast`；只有硬触发才进入 `careful`。
- `evidence_policy`: `none | single_agent | cross_check`。
- `reason_codes`: 为什么这样路由。
- `missing_slots`、`blockers`、`assumptions`、`needed_evidence_agents`、`prd_ready`、`next_action`。

硬触发包括字段、schema、API、auth、state、data flow、migration、已有项目事实、高代价错误和明确 PRD/执行意图下的验收/批准不清。新项目想法和低风险文案默认保持 fast，不要求代码审计。

PRD readiness contract 至少需要这些 slots：`problem`、`target_user`、`status_quo`、`desired_outcome`、`scope_in`、`scope_out`、`constraints`、`acceptance_criteria`、`risks`、`approval`。任何 blocker、未确认 assumption 或 required evidence 缺失，都不得标记 `prd_ready=true`。

证据 agent 协议分三类：

- `explorer`: 只读查找项目事实，返回 claim、confidence、evidence、assumptions、risks、missing、recommendation。
- `cross-checker`: 对高风险事实独立交叉验证；`cross_check` policy 必须使用。
- `verifier`: 检查证据是否足够支撑 PRD readiness，确认假设没有伪装成事实。

如果 agent 结论冲突，Demand Router 必须把冲突保留为 blocker，而不是取平均或选择性采信。

Lean office-hours profile 是 `yolo demand` 下的轻量模式，不是 PRD 或代码入口。`yolo demand office-hours`、`--profile office-hours|startup|builder` 或 `--mode startup|builder` 只产一个 draft brief：一条 `next_question`、一个 premise challenge、2-3 个 alternatives、显式用户 choice 和 handoff 建议。没有 choice 时保持 blocked；有 choice 时也只交给正常 demand intake，`prd_execution=false`、`provider_execution=false`、`writes_business_code=false`。

`yolo demand dispatch` 是 evidence agent 的显式执行入口。它默认只做 dry-run 计划；只有同时传 `--execute-agents --allow-agent-dispatch` 才会调用配置的 agent provider。dispatch 不靠阉割 tools 做安全边界：agent 可以拥有审计、检索、fetch、命令和子任务等能力，但必须遵守 harness 边界，目标项目文件不得被修改；只允许写入本次 `.yolo/demand/evidence/<dispatch-id>/` artifact。dispatch 会在运行前后审计项目文件边界，任何越界改动都会变成 readiness blocker。dispatch 返回的 explorer / cross-checker / verifier 结果会重新喂给 PRD readiness contract；如果缺任一 required role、证据不足、agent 冲突或边界违规，仍然保持 blocked。

Claude provider 的 demand dispatch 不传 `--allowedTools` / `--disallowedTools` / `--tools` 限制作为安全措施；`agent_tool_profile` 只表达语义模式（boundary / research / full），真实安全由 prompt contract、artifact root、运行前后边界快照和 readiness blocker 承担。

证据记录必须声明 `scope`: `project | external | user | unknown`。`project` 证据来自目标项目的 code、tests、docs、config、logs 或 artifacts，并且必须带 repo-relative path 或 file locator；`external` 证据可以来自 WebFetch/WebSearch、MCP web reader、browser fetch 或外部文档，但只能作为背景研究，不能单独证明目标项目已有字段、API、状态机或数据流。任何 existing-project factual claim 如果只有 external/user/unknown evidence，或 project evidence 没有具体项目定位符，都必须被 readiness blocker 拦住。

## 从大白话到 prd.json

非技术用户的回答按这条流水线转换：

`intake -> scenario matrix -> surfaces -> one-session task -> handoff -> gates`

1. `intake`：收集用户、问题、现状、痛点、成功标准、证据/假设、约束、非目标。用户可以只说业务语言。
2. `scenario matrix`：把每条需求变成场景：谁、在哪里、什么时候触发、当前行为、目标行为、如何证明、哪些边界。
3. `surfaces`：把场景映射到实现表面，例如 UI、API、service、data、test、doc。可以由目标文件推断，也可以只先记录为候选。
4. `one-session task`：一个场景表面切成一个单会话任务；文件数、改动规模、删除权限和验收条件都要受限。
5. `handoff`：每个 task 必须带 `plain_language_goal`、`user_story`、`current_behavior`、`desired_behavior`、`touchpoint`、`trigger`、`surface`、`read_first`、`proof`、`out_of_scope`、`constraints`。
6. `gates`：PRD 前跑需求 readiness，PRD 后跑 atomicity/preflight/spec governance/review/evidence gate。任何阻塞都要回到问题或任务切分，不靠猜。

最终的 `prd.json` 不应该只是任务列表，而应该带 trace：需求 id、场景 id、surface id、证据、决策、问题链路和批准记录。

## 下一步增强层

第一版固定问题库解决“必须问什么”，增强层解决“答得够不够好”：

- 动态追问：每次回答都会被检查是否太短、模糊、只有技术词或缺少业务验收信息；不够清楚时，YOLO 用业务语言给出 slot-specific follow-up。
- PRD 质量评分：可执行 PRD 生成前，YOLO 从需求清晰度、任务原子度、验收证据、session 可执行性、上下文接力棒完整度五个维度评分；关键维度低分直接阻断。
- 一 task 一 session 接力：每个 demand atomic task 都带独立 session plan，声明 state、handoff、evidence、memory、progress 和 resume 目标；runtime 只生成计划，不提前写执行 session 文件。

这三层不是替代 gate，而是把 gate 前移：用户回答阶段先追问，PRD 编译阶段再评分，执行阶段用 session plan 接力。

## 项目记忆体系

YOLO 的记忆分为人读文档和机器 ledger，二者职责不同：

| 记忆 | 职责 |
|---|---|
| `CURRENT_HANDOFF.md` | 下一位 operator 先看这里。它说明下一步做什么、为什么卡住、需要哪条命令或哪份产物。 |
| `CURRENT_STATUS.md` | 当前项目状态。它记录最近需求 session、生命周期状态、已知风险和最新进展。 |
| `PROJECT_TREE.md` | 项目结构和可见产物索引。它帮助 operator 快速知道代码、docs、state 和 evidence 在哪里。 |
| `questions.jsonl` | 一问一答 ledger。记录问过什么、用户怎么答、是否阻塞、追踪到哪个需求/场景。 |
| `decisions.jsonl` | 决策 ledger。记录用户批准、产品取舍、技术边界、延期项和 ADR 候选。 |
| `session-memory.jsonl` | 执行/恢复 ledger。记录 runner checkpoint、失败原因、恢复建议和交接摘要。 |

规则是：用户回答先入 `questions.jsonl`；稳定选择入 `decisions.jsonl`；执行中断、gate 失败、恢复线索入 `session-memory.jsonl`；给人看的当前状态由 memory refresh 汇总到 `CURRENT_*` 和 `PROJECT_TREE.md`。

## 32 Task 落地清单

完整 32 项按模块列在 [yolo-demand-implementation-plan.md](./yolo-demand-implementation-plan.md)。维护时用它判断需求流程是否真的落地，而不是只看是否能生成文件。

模块分布：

- Intake 与一问一答：5 项。
- Scenario Matrix：5 项。
- Surfaces：4 项。
- One-session Atomic Tasks：5 项。
- Handoff：4 项。
- Gates 与批准：5 项。
- Memory 与文档验证：4 项。

任何后续改动只要影响需求访谈、PRD 编译、gate、memory 或 task handoff，都应该同步检查这 32 项。
