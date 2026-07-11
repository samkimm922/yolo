# YOLO 规格基线 (SPEC) — 冻结版 v1

> 冻结日期:2026-07-08。
> 本文件是 yolo"到底是什么"的权威基准。**之后每一个改动、每一个 PR,都要拿本文件对照:符合就做,违反就否。** 目的是防止"越改越乱"——有一份不动的基准,方向才不会漂。
> 修改本 SPEC 本身需要显式决定,不能顺手改。

---

## 1. 一句话定义

**yolo = 一个从头到尾的全局编排规划 agent + 内建的 fail-closed 验证审核关卡。**
它编排开发流程,在每个转换处验证审核;有问题打回重来,没问题往下走。它骑在 Claude Code / Codex 之上,让"无人盯屏的自动开发"变安全。

---

## 2. 形态 (Form Factor)

- **gstack 式一键安装的 skill 包**——装进 Claude Code / Codex / Cursor / 任意 IDE,和项目融合,状态隔离在 `.yolo/`,不往目标项目塞自己的代码,不干扰项目开发。
- 组成:
  - **skill 层**:需求沟通 + 对 executor 的"怎么想"约束(superpowers 式引导)。通用、模型无关、建议性。
  - **最小强制 runner(唯一必须是"进程"的东西)= PI**(`src/agents/pi.ts` 的 `runPiAgent`/`createPiRunPlan`):计划驱动的动作解释器,spawn executor 子进程、任务间跑 gate、白名单约束、产 `pi-run-*` 证据。**强制必须在 PI 自己进程里,不依赖任何宿主的 hook 系统**(这样 claude/codex 通吃)。
  - **文件层**:一切状态/记忆/证据/日志在 `.yolo/`。
- **CLI(`dist/bin/yolo.js` 的 demand/spec/check/run/review/ship/status/doctor)= PI/引擎的既有调用面**,不是新东西,是宿主触发各阶段的通用机制(每个宿主都能 shell 调,比 MCP 更可移植)。
- **MCP:暂不纳入。** 未来可作为"给支持的宿主减少命令语法错误"的可选糖,但**强制永远不放在 MCP 里**(MCP 工具是自愿调用的,不是 fail-closed)。
- **两次用到 agent**:(1) 你对话的宿主 agent(需求阶段);(2) PI spawn 的 executor 子进程(run 阶段)。两者都可 claude / codex / 任意 custom,混用也行。

---

## 3. 生命周期(六阶段)

| 阶段 | 干什么 | 人在场 | 主导 |
|---|---|---|---|
| **0 现状** | 空/存量项目判定、摸清已有架构、定技术栈、验 executor 可用 | 是 | skill |
| **1 需求** | 头脑风暴/挖掘/讨论:做什么、功能、模块、**是否解耦**;挖出**"怎么算验证通过"**(声明式验证契约) | 是(1-2h+) | skill |
| **2 PRD** | 生成可执行 JSON:原子任务 + 每任务机器可验 postcondition + 声明的验证契约;check 门确认可执行才放行 | 否 | yolo(PI) |
| **3 Runner** | loop 逐个原子任务,executor(任意模型)写代码 → 每任务过 gate | 否 | PI + executor |
| **4 Review 环** | 全部 task 完 → review 查 bug → bug 生成新 PRD → runner 修 → 再 review → 无 bug 止 | 否 | PI + executor |
| **5 验收+交付** | acceptance 真跑声明验证 + 真证据 → ship fail-closed 终门 | 否 | yolo(PI) |

**组织原则:人的时间集中在阶段 0–1,阶段 2–5 无人值守。** gate 存在的唯一理由,就是让"无人值守"是安全的。

---

## 4. 五类 Gate(全程兜底)

1. **结构门**:改了该改的、没碰不该碰的(scope 越界拦截)、真写了代码。
2. **验证门**:项目**声明的**验证过没过——build/typecheck/test/lint,跑 `config.build.*`,**绝不写死某语言工具**。
3. **真实性门(防假绿)**:验证是真的不是空的(非 0 测试、非空断言)。← 最弱、最需加强。
4. **证据门**:证据没被篡改、代码没被偷改——HMAC 账本 / source-fingerprint / drift / artifact-integrity。
5. **生命周期门**:没跳步、没假装完成——guard。

**边界:没有任何系统能保证"绝对无 bug"。** gate 保证的是"项目自己声明的完成定义被真实达成、证据没造假、没跳步"。抓到更多 bug 的杠杆是**更丰富的契约**(更好的需求沟通 + 更彻底的声明验证),不是更多 gate。

---

## 5. 不变量(以后违反这些 = 改错了)

1. **门在"产物/转换"上,不在"你有没有亲自跑上一步"。** 可从任意阶段进入,只要该阶段的前置产物已存在且通过它的门;但**任何转换的门本身不可跳过、不可伪造**。(自带 PRD → 进 check 门,过了才 runner;你跳过的是"创作"不是"验证"。)
2. **gate 判结果,不判模型。** executor 可插拔,任意模型可接;弱模型 = 更多 retry / 更慢,但**造不出假绿的成品**;太弱 = 被安全熔断停下,而非放行垃圾。
3. **验证由项目声明,绝不写死某语言。**
4. **fail-closed:** 未验证 / 造假的一律 blocked,绝不放过。
5. **yolo 不写代码/测试,executor 写;yolo 只编排 + gate。**
6. **人的时间集中在阶段 0–1,2–5 无人值守。**
7. **强制在 yolo(PI)进程里,不依赖宿主 hook**(保证 claude/codex 通吃)。
8. **零硬编码 / 零语言绑定**:任何语言、任何形态、任何行业都能开发。

---

## 6. 需求阶段原则(最高杠杆)

- **单一入口。** 收敛掉现有的多入口(office-hours / discuss / interview 等各命令)——用户只管说"我想做 X",skill 在**内部**自动走 头脑风暴 → 讨论收敛 → 访谈定稿 → PRD;子阶段是内部状态,对用户不可见。(多入口是被证明的 bug 源。)
- **内部必须逼出六件事**(领域无关):① 意图(做什么/为谁/痛在哪);② **完成定义**(怎么算做对 = 验证契约);③ 范围边界(做什么/明确不做/解耦);④ 约束(技术栈/存量/硬要求);⑤ **回放 + 显式确认对齐**;⑥ 收敛判定(够不够精确到可机器执行)。
- **UI 完成定义必须 declare-first。** UI 相关 demand 优先复用项目已有的声明式验收 adapter；没有时，interview 必须先追问并收集用户声明的验收入口或命令、可观察结果与证据，以及完整 `acceptance_adapter` manifest，PRD 成功生成时自动写入 `.yolo/adapters/<manifest.id>.manifest.json`。两种声明都没有时，`check` 必须 fail-closed；remediation 必须返回 `manifest_id: ui-acceptance`、`.yolo/adapters` 目标路径和具体可回答的 `ui_acceptance` 追问，禁止系统自行猜选 adapter。
- **对齐才是产物,PRD 只是它的序列化。** 对齐高→PRD 好;对齐低→就算过 check,结果也不是你要的。
- **危险失败 = "check 过了但结果不对";唯一防线 = 把成功标准做得足够可机器验证,让"结果不对"= "过不了验收"。** 需求 skill(输入端)和验收契约(输出端)是同一个东西的两端,必须接上。
- 诚实边界:skill 能**降低**错位,**保证不了**对齐(对齐本质是人的判断);它能做的是逼出歧义 + 要求显式确认。

---

## 7. 记忆 / 连续性

- **`.yolo/` 文件式状态 = 天生跨模型/IDE/session 续得上**(强于"记忆活在 agent 上下文里")。任何 agent 打开项目读 `.yolo/` 就知道到哪了。
- 必须满足:① 权威且始终最新(每次转换即更新);② 新 agent 只读 `.yolo/` 就能重建全部上下文,不依赖聊天记录;③ **证据背书**——"完成"类记录必须由 gate 验过的证据支撑,**不许 executor 自由写"我做完了"**(`.yolo` 写保护 hook 拦);④ **分层**:小而权威的状态(每次读)vs 大块归档语料(留存不每次加载)。
- **双重保险:yolo 是主记录人(人会忘),人是审计人(核对/纠正)。**
- 记忆的归档层 = 学习的安全语料源。所以记忆是地基,学习是收尾。

---

## 8. 日志纪律

**精瘦工作面 + 完整可取回归档,两者绝不混。** 小摘要推到工作面;完整 raw 日志/证据落 `.yolo/state/`,默认不进上下文,需要时才取回。(dogfood 里 spec 输出百万 token = 反面教材。)

---

## 9. Worktree

- **yolo(PI)完全拥有,用户不该看见、不该懂。** 它是**任务隔离沙箱**:每个原子任务在自己的 worktree 改文件,过了 gate 才 merge 回主树,失败整个丢弃——所以坏任务污染不了项目。
- 不暴露任何 worktree 控制给用户。
- 历史上最脆的部分之一(node_modules 持久化、清理、Linux 验证坑)→ **删减/清理阶段重点加固,做到隐形可靠**;"智能分配"是内部优化(并行波次每任务一个、串行复用、激进清理、只持久化必要的),对用户不可见。

---

## 10. 学习 / 蒸馏(排最后)

- 方向对(种子已有:`state/learning.jsonl`、learn.ts、LESSONS_PLAYBOOK)。愿景:跨项目蒸馏,越做越快、越做越一次过。
- **两条硬约束**:① **只喂"验证为真的成功"**——从"过了但错"的运行学 = 蒸馏错误模式、语料级中毒;② **只捕捉通用模式(怎么措辞验收、怎么拆解),不捕捉栈专用模板**——否则把删掉的窄又种回去。
- **顺序:先删减到干净通用架构 → 先跑出真实成功 ship → 再打开跨项目蒸馏。** 每个"验证为真的成功项目"就是最安全的第一批语料。

---

## 11. 删减目标(来自 2026-07-08 通用性边界审计)

**删/泛化(窄层,~4 文件/~200 行):**
- `src/demand/acceptance-test-generator.ts`(字面 git-weekly/Alice/Bob/node:test)——删,还给 executor(见不变量 5)。
- `src/demand/runtime.ts` scaffold 段(写死 Node/npm greenfield)——删,建项目结构变成 executor 的普通原子任务。
- `src/runtime/gates/readiness-policy.ts` `isPureConfigTarget`(JS 配置文件硬表)——改项目声明/推断。
- `src/runtime/execution/change-set.ts` 业务扩展名默认(JS)——改声明/推断。
- 中度:remediation-plan / failure-analysis / atomic-task-doctor / scanner 里的 tsc/vitest 错误模式匹配——泛化或降级。

**保留(通用内核,已~栈无关):** guard、toolchain(config.build.* 驱动)、PI、evidence/HMAC、drift、retry-policy、review 收敛、executor 权限模型。18 个 PR 的知识全在这层,全语言无关。

**误报(非窄):** `src/release/*` 的 package.json 引用 = yolo 操作自己(打包发布),与目标通用性无关。

---

## 12. 唯一的硬开放问题

**"零硬编码 + 防假绿"在一个点上打架:** 不认识任何测试框架时,怎么防"0 测试也算绿"?
方向:验证契约不能只声明"命令退出 0",还要声明**可证明真实性**的东西(必须失败的探针 / 期望断言数 / TDD 先红后绝)。这条在需求阶段就要钉死,是 review 环抓不抓得住逻辑 bug 的关键。**这是整个通用化里唯一真正难的点,单独对待。**
