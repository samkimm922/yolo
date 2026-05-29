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
