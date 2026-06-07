# YOLO Demand Implementation Plan

这份清单用于检查 YOLO 需求流程是否完整落地。语言故意保持直白，方便产品、工程和后续 agent 共用。

## Intake 与一问一答

- [ ] Task 01: 保留一问一答入口，每轮只问一个最小问题，避免一次丢给用户一张长表。
- [ ] Task 02: 把用户的大白话答案记录为 intake 字段：用户、问题、现状、痛点、成功标准、证据/假设、约束、非目标。
- [ ] Task 03: 用户没给技术文件名时，允许 YOLO 推断候选范围，但必须标成候选，不能当成用户明确授权。
- [ ] Task 04: 每个阻塞问题都写入 `questions.jsonl`，并标明它阻塞的是需求、场景、surface 还是批准。
- [ ] Task 05: intake 缺现状、痛点、证明、边界或批准时，流程停在 discovery/discuss，不生成可执行 PRD。

## Scenario Matrix

- [ ] Task 06: 把每条需求拆成场景，写清楚谁在什么位置遇到问题。
- [ ] Task 07: 每个场景都写当前行为和目标行为，让 agent 知道改前改后差别。
- [ ] Task 08: 每个场景都写 proof，用非技术用户也能看懂的方式说明怎样算成功。
- [ ] Task 09: 每个场景都记录 constraints、out_of_scope 和 exceptions，避免把不该做的事做进去。
- [ ] Task 10: 场景必须能追溯到问题回答和决策；追溯断了就回到一问一答补齐。

## Surfaces

- [ ] Task 11: 根据用户语言和候选文件，把场景映射到 UI、API、service、data、test、doc 或 code surface。
- [ ] Task 12: 每个 surface 都写清楚目标文件、只读文件、是否用户可见和建议单会话预算。
- [ ] Task 13: 没有目标文件时，先保留 surface 候选和推断理由，不让 agent 自由扫全仓库。
- [ ] Task 14: 可执行 PRD 必须有 bounded scope；没有范围就阻断，不靠“先试试”。

## One-session Atomic Tasks

- [ ] Task 15: 一个 scenario surface 默认生成一个 task，避免把多个用户场景塞进同一个任务。
- [ ] Task 16: 单个 task 默认最多改两个文件；超过就继续拆。
- [ ] Task 17: task scope 明确允许新增、禁止删除、最大文件数和单文件改动预算。
- [ ] Task 18: task 类型要能区分 feature、test、doc 或 cleanup，方便 gate 和 review 判断风险。
- [ ] Task 19: 每个 task 都跑 atomicity 检查；太粗就阻断，不能交给 runner 赌运气。

## Handoff

- [ ] Task 20: 每个 task 写 `plain_language_goal`，让下一位 operator 不读上下文也知道目标。
- [ ] Task 21: 每个 task 写用户故事、当前行为、目标行为、触发点和所在流程。
- [ ] Task 22: 每个 task 写 `read_first` 和 `key_interfaces`，让 agent 先读范围内材料再动手。
- [ ] Task 23: 每个 task 写 acceptance criteria、proof、constraints、out_of_scope 和 exceptions。

## Gates 与批准

- [ ] Task 24: readiness gate 使用 L0-L3：L3 之前不能编译可执行 PRD。
- [ ] Task 25: 用户明确批准前，`approval.approved` 必须保持 false，PRD 编译必须 fail closed。
- [ ] Task 26: PRD 生成后先跑 preflight、spec governance 和 demand contract gate，再允许 runner 执行。
- [ ] Task 27: gate 失败要返回 code、message、source 和下一步，不允许只给“失败了”。
- [ ] Task 28: review 或 evidence 缺失时不能宣称完成；必须留下可复查产物。

当前硬化口径：可执行 PRD 必须来自 approved demand，并在写入前通过 runner preflight、demand contract、spec governance 和 warning policy。Discovery/spec/module-deep-dive/audit-to-prd 只生成 draft/pending approval；`interview to-demand` 传播 blocked/warning 状态和非 0 exit；WARN-only acceptance 不能满足 executable acceptance。

Lean office-hours profile：`yolo demand office-hours` / `--profile office-hours|startup|builder` / `--mode startup|builder` 只做 startup/builder 一问一答，输出 premise challenge、2-3 alternatives、显式 choice 和 draft brief handoff，不生成 PRD、不执行 provider、不写业务代码。

## Memory 与文档验证

- [ ] Task 29: `CURRENT_STATUS.md` 汇总当前需求 session、readiness、风险和最新进展。
- [ ] Task 30: `CURRENT_HANDOFF.md` 只写下一步 operator 最需要知道的行动、阻塞和上下文。
- [ ] Task 31: `PROJECT_TREE.md` 保持项目结构和产物索引可读，帮助快速定位需求、PRD、evidence 和 memory。
- [ ] Task 32: 文档测试锁住 doctrine、pipeline、memory 关键词和本 32 项清单，防止原则漂移。

## 增强闭环

本清单之上，下一步增强已收敛为三条闭环：

- 动态追问：固定问题库负责覆盖面，answer quality 负责判断回答是否够具体，并生成 follow-up。
- PRD 质量评分：readiness 负责是否齐全，quality report 负责是否足够清晰、可验收、可执行、可交接。
- session 接力计划：每个 task 都必须能映射到一个 fresh session，并明确 state、handoff、evidence、memory、progress、resume 目标。
