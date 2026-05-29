# ECC for YOLO 安装清单

> 生成日期：2026-05-27  
> ECC 来源：<https://github.com/affaan-m/ECC>，本次核对到 `main` commit `928076c`。  
> YOLO 证据：`README.md`、`package.json`、`config.yaml`、`src/workflows/*`、`docs/agent-native-integration.md`。  
> 目标：给 YOLO 项目生成一份“必装 / 选装”清单，不全量安装 ECC，不启用有副作用 hooks。

## 判断口径

| 分类 | 含义 | 安装方式 |
|---|---|---|
| 必装 | 每次处理 YOLO 项目都能稳定提升质量、不会明显增加噪音 | 合并进 YOLO 项目级 agent/rules/skills，或放入默认可发现技能 |
| 选装 | 某些任务很有用，但只有触发场景时才需要 | 放进 skill-library / reference router，按需加载 |
| 不装 | 与 YOLO 主栈无关，或会和 YOLO 自己的 workflow 冲突 | 不复制；需要时从 ECC 上游查 |

YOLO 是 TypeScript/Node 的 agent lifecycle + SDK 项目，核心是 discovery、PRD、gate、review/fix、acceptance、ship、learn。它已经有自己的 `/yolo-*` command registry 和 workflow registry，所以 ECC 的命令、hooks、平台配置只能参考，不能原样覆盖。

## 总览

| Surface | 必装 | 选装 | 不装摘要 |
|---|---:|---:|---|
| Skills | 26 | 78 | 语言/行业/媒体/社交/交易等与 YOLO 主栈无关的技能 |
| Rules | 15 | 7 | 非 TypeScript 主栈规则 |
| Agents | 19 | 11 | 语言不匹配、行业不匹配、外部发布流水线 agents |
| Commands | 0 | 12 | 不直接安装，避免和 `/yolo-*` 冲突 |
| Hooks / Scripts | 0 | 15 | 不直接启用，只作为 YOLO gate/doctor 的参考实现 |

## 必装 Skills

| ECC 文件 | 为什么装 | 优势 | 大白话解释 |
|---|---|---|---|
| `skills/agent-harness-construction/SKILL.md` | YOLO 本身就是 agent harness / SDK | 帮助设计工具面、观察面、执行边界 | 让 YOLO 这个“调度器”更像一个靠谱系统，不只是提示词拼接 |
| `skills/agent-introspection-debugging/SKILL.md` | YOLO 有 PI、runner、adapter、gate 多层执行 | 能定位 agent 失败是输入、工具、状态还是回退逻辑问题 | agent 跑歪时，先查脑回路，不盲修代码 |
| `skills/agentic-engineering/SKILL.md` | YOLO 的定位就是 AI-first 项目生命周期工程 | 强化 eval-first、拆解、成本和证据意识 | 把“让 AI 写代码”升级成“让 AI 按工程流程交付” |
| `skills/ai-first-engineering/SKILL.md` | YOLO 需要服务非技术用户和 agent 执行链 | 给 AI 主导开发建立组织和质量边界 | 适合指导 YOLO 的产品形态，不让流程变成玩具 |
| `skills/ai-regression-testing/SKILL.md` | YOLO 有大量 agent 输出、fixture、benchmark | 专门防同一个模型写、同一个模型审导致的盲点 | 防止 AI 自己给自己打满分 |
| `skills/backend-patterns/SKILL.md` | YOLO 是 Node/SDK/CLI 后端式项目 | API、服务层、配置、错误处理可复用 | 虽然不是传统网站后端，但结构问题很像后端 |
| `skills/coding-standards/SKILL.md` | 需要跨模块保持小步、直白、可审计 | 给命名、组织、可读性一个基础底线 | 防止为了“优雅”把 YOLO 改复杂 |
| `skills/context-budget/SKILL.md` | YOLO 依赖长上下文、memory、skills、docs | 能控制常驻上下文膨胀 | 不让项目越装越吵、越跑越慢 |
| `skills/continuous-learning-v2/SKILL.md` | YOLO 有 `state/learning.jsonl` 和 learn workflow | 支持经验沉淀、去重、置信度、项目隔离 | 把踩坑变成下次能用的经验，而不是聊天碎片 |
| `skills/cost-aware-llm-pipeline/SKILL.md` | YOLO 会调用 provider / executor / model | 支持按任务复杂度路由、预算、重试 | 该用大模型时用大模型，该省时别烧钱 |
| `skills/documentation-lookup/SKILL.md` | YOLO 使用 OpenAI/Codex/Node/TS 等不断变化的工具 | 强制查官方文档，减少旧知识误判 | 工具版本会变，别靠记忆硬答 |
| `skills/error-handling/SKILL.md` | YOLO 的 gate、runner、CLI 都需要失败可解释 | 强化 typed error、边界错误、用户可读信息 | 失败时告诉人“卡在哪”，不是甩一坨 stack |
| `skills/eval-harness/SKILL.md` | YOLO 已有 benchmark / eval / fixtures | 给评测设计、报告和回归比较提供方法 | 用固定题目证明 YOLO 真的变好 |
| `skills/github-ops/SKILL.md` | YOLO 交付会涉及 PR、review、release evidence | 帮助把 GitHub 操作做成可审计流程 | 和 GitHub 打交道时少靠手感，多留证据 |
| `skills/mcp-server-patterns/SKILL.md` | YOLO 面向 Codex/Claude/MCP 生态 | 帮助设计 connector、server、tool contract | 以后接 MCP 工具时不重新发明接口 |
| `skills/parallel-execution-optimizer/SKILL.md` | YOLO 有 controlled parallel planning / merge gate | 支持并行任务拆分和正确性保护 | 想跑快可以，但别并行到互相踩脚 |
| `skills/product-capability/SKILL.md` | YOLO 从 idea 到 PRD，需要把产品意图转成能力边界 | 暴露约束、接口、不变量和未决问题 | 把“我要一个功能”翻译成“到底要交付什么能力” |
| `skills/prompt-optimizer/SKILL.md` | YOLO 生成 prompts、agent briefs、workflow descriptors | 能减少提示词歧义和上下文浪费 | 让 agent 收到的任务更清楚、更短、更可执行 |
| `skills/regex-vs-llm-structured-text/SKILL.md` | YOLO 处理 PRD、报告、JSON、日志和结构文本 | 明确哪些用解析器，哪些才用 LLM | 能用规则解析就别让模型猜 |
| `skills/safety-guard/SKILL.md` | YOLO 的 run/fix/ship 都有写盘和发布风险 | 强化破坏性操作、生产操作、权限边界 | 先把刹车装好，再谈自动驾驶 |
| `skills/search-first/SKILL.md` | YOLO 常要补 SDK、adapter、CLI 能力 | 要求先找现有实现和项目内模式 | 少造轮子，先看仓库里有没有现成答案 |
| `skills/security-review/SKILL.md` | YOLO 处理 provider、CLI、外部命令、配置 | 覆盖 secrets、命令执行、输入验证、敏感动作 | 不让自动化把安全边界踩穿 |
| `skills/strategic-compact/SKILL.md` | YOLO 长任务容易上下文膨胀 | 在阶段边界压缩，而不是等自动截断 | 该收纳时收纳，别把关键上下文撑爆 |
| `skills/tdd-workflow/SKILL.md` | YOLO 现有测试量大，变更必须有验证 | 支持先测风险点，再实现 | 不是每次教条 TDD，但高风险改动要先有红线 |
| `skills/terminal-ops/SKILL.md` | YOLO 依赖 build/test/preflight/gate 命令证据 | 强化命令前后状态、失败根因、验证记录 | 终端不是黑盒，跑了什么要说清楚 |
| `skills/verification-loop/SKILL.md` | YOLO 的核心卖点就是 gate/evidence | 统一 build、test、lint、typecheck、smoke 验证 | 写完不算完，跑过并有证据才算完 |

## 必装 Rules

| ECC 文件 | 为什么装 | 优势 | 大白话解释 |
|---|---|---|---|
| `rules/common/agents.md` | YOLO 有 planner/reviewer/gatekeeper/implementer 等角色 | 提供 agent 分工语言 | 谁该干什么先说清，别一锅粥 |
| `rules/common/code-review.md` | YOLO 有 review/fix 主线 | 强化审查先找 bug、风险、缺测试 | review 不是挑格式，是找会坏的地方 |
| `rules/common/coding-style.md` | YOLO 需要跨模块一致 | 基础可读性和小函数约束 | 代码要让下一个 agent 看得懂 |
| `rules/common/development-workflow.md` | YOLO 的本体就是开发流程系统 | 可借鉴 research -> plan -> test -> review | 先想清楚，再动手，再验证 |
| `rules/common/git-workflow.md` | YOLO 交付会产生 PR/commit evidence | 规范变更说明和测试计划 | 交付时别人能看懂改了什么 |
| `rules/common/hooks.md` | YOLO 有 hooks/pre-tool-log 和 gate 概念 | 只吸收 hook 安全边界，不直接启用 ECC hooks | hook 可以帮忙，但不能偷偷挡路或改东西 |
| `rules/common/patterns.md` | YOLO 需要复用现有架构 | 强调已有模式优先 | 仓库怎么写，我们就跟着怎么写 |
| `rules/common/performance.md` | YOLO 会处理长任务和状态文件 | 关注上下文、命令耗时、状态膨胀 | 别让工具自己拖垮自己 |
| `rules/common/security.md` | YOLO 有外部命令、provider、发布 gate | 明确 secrets、输入、权限、错误暴露边界 | 自动化越强，安全底线越要清楚 |
| `rules/common/testing.md` | YOLO 有 100+ 测试套件 | 提醒行为测试、回归测试、失败根因 | 测试要证明功能，不是凑数量 |
| `rules/typescript/coding-style.md` | YOLO 主体是 TypeScript | 强化 public API 类型、unknown narrowing、少用 any | TS 项目就要让类型真的帮忙 |
| `rules/typescript/hooks.md` | YOLO 可借鉴 TS post-edit checks | 能提示 typecheck/test 的触发点 | 改 TS 后该跑什么，规则里要写清 |
| `rules/typescript/patterns.md` | YOLO 有 SDK、CLI、runtime APIs | 提供 API envelope、repository/service 等参考 | 公共接口要稳，不要每个模块一套风格 |
| `rules/typescript/security.md` | YOLO 处理 env/provider/executor | 防硬编码 secrets、边界验证 | 配置和凭证不能写死在代码里 |
| `rules/typescript/testing.md` | YOLO 测试运行方式明确 | 对 TS 测试组织和 E2E 做补充 | TS 改动要知道测哪层 |

注意：这些 rules 需要改写后吸收，不能原样覆盖。ECC 里“必须主动派 agent”“80% 覆盖强制”等表述，要改成符合 YOLO 的 PRD/gate/显式确认边界。

## 必装 Agents

| ECC 文件 | 为什么装 | 优势 | 大白话解释 |
|---|---|---|---|
| `agents/planner.md` | YOLO 的 discover/plan/prd 都需要计划角色 | 负责拆任务、列风险、排顺序 | 把大需求拆成能执行的小块 |
| `agents/architect.md` | SDK/API/runtime 边界变更需要架构判断 | 管接口、模块边界、长期可维护性 | 大改前先看房梁在哪 |
| `agents/code-architect.md` | 新 workflow 或 adapter 需要代码落点设计 | 输出文件、接口、数据流、顺序 | 知道要改哪些文件，再开始写 |
| `agents/code-explorer.md` | YOLO 强调先读现场 | 快速追 execution path 和证据 | 先侦查，不靠猜 |
| `agents/code-reviewer.md` | YOLO 有 review/fix 生命周期 | 聚焦正确性、回归、测试缺口 | 写完之后找真问题 |
| `agents/typescript-reviewer.md` | YOLO 主栈是 TypeScript/Node | 专查类型安全、async、Node 边界 | TS 项目的专业审查员 |
| `agents/security-reviewer.md` | provider、CLI、发布、外部命令都敏感 | 专查 secrets、注入、权限、危险命令 | 安全风险交给专人看 |
| `agents/build-error-resolver.md` | `npm run build` 是核心 gate | 最小改动修 build/typecheck | build 红了时别乱改，先救绿 |
| `agents/tdd-guide.md` | 高风险功能需要测试先行 | 帮助写有效回归测试 | 先把坑圈出来，再填坑 |
| `agents/e2e-runner.md` | YOLO 有 progress UI / UI acceptance | 可跑 browser/Playwright 证据 | 页面和流程要真点得通 |
| `agents/doc-updater.md` | YOLO 文档和 memory 很多 | 更新 docs、codemap、API reference | 改了功能，说明书也跟上 |
| `agents/harness-optimizer.md` | YOLO 是 agent harness 项目 | 优化可靠性、成本、吞吐 | 调度系统自己也要调优 |
| `agents/loop-operator.md` | YOLO 有长链路 PI / runner | 监控循环、卡住时介入 | 长任务别放飞不管 |
| `agents/performance-optimizer.md` | benchmark、fixtures、runtime 可能变慢 | 查性能瓶颈和回归 | 慢了要知道慢在哪 |
| `agents/refactor-cleaner.md` | YOLO 正在公共 SDK 边界收敛 | 清理死代码、重复实现 | 打扫卫生，但只扫该扫的地方 |
| `agents/silent-failure-hunter.md` | YOLO 最怕 gate 假通过、失败被吞 | 找 swallowed errors、坏 fallback | 别让失败悄悄装成成功 |
| `agents/type-design-analyzer.md` | PRD/spec/evidence schema 很多 | 检查类型是否表达不变量 | 类型不是摆设，要能保护业务规则 |
| `agents/pr-test-analyzer.md` | YOLO 需要证明测试覆盖真实风险 | 审查测试是否有行为价值 | 测试不是越多越好，是要防真 bug |
| `agents/docs-lookup.md` | OpenAI/Codex/Node API 经常更新 | 查当前官方文档 | 不用过期记忆写现代集成 |

## 选装 Skills

| ECC 文件 | 什么时候装 | 优势 | 大白话解释 |
|---|---|---|---|
| `skills/accessibility/SKILL.md` | 做 UI acceptance 或 progress dashboard | WCAG 检查更完整 | 要验 UI 无障碍时再叫它 |
| `skills/agent-architecture-audit/SKILL.md` | 大范围审计 YOLO agent 架构 | 可做 12 层 agent stack 诊断 | 怀疑整个 agent 系统设计有问题时用 |
| `skills/agent-eval/SKILL.md` | 比较 Codex/Claude/其他 agent 效果 | 评估 pass rate、成本、时间 | 要选模型/工具时用数据说话 |
| `skills/agent-sort/SKILL.md` | 定期重新裁剪 ECC surface | 防止装太多无关技能 | 给技能库做体检 |
| `skills/agentic-os/SKILL.md` | 想把 YOLO 扩成更持久的 agent OS | 提供长期状态和调度模式 | 以后做“常驻团队 agent”再用 |
| `skills/api-connector-builder/SKILL.md` | 新增 provider/connector/adapter | 匹配已有集成风格 | 多接一个外部工具时别另起炉灶 |
| `skills/api-design/SKILL.md` | 公共 SDK/API shape 调整 | REST/API 设计参考 | 对外接口要像产品，不像内部函数 |
| `skills/architecture-decision-records/SKILL.md` | 做稳定边界、发布策略、runtime 决策 | 记录背景、选项、取舍 | 大决定别只留在聊天里 |
| `skills/automation-audit-ops/SKILL.md` | 审计自动化、hooks、cron、connector | 找重复、破损、过期自动化 | 自动化太多时先盘点 |
| `skills/autonomous-agent-harness/SKILL.md` | 设计长期自主执行能力 | 支持队列、计划、状态 | 要让 YOLO 更自主时参考 |
| `skills/autonomous-loops/SKILL.md` | runner/PI 循环设计升级 | 质量 gate、恢复、循环控制 | 自动循环要有护栏 |
| `skills/benchmark/SKILL.md` | 做性能/质量基线 | 前后对比更客观 | 变快变好要有数字 |
| `skills/benchmark-optimization-loop/SKILL.md` | 优化某个慢路径 | 多方案测量迭代 | 想提速时批量试方案 |
| `skills/browser-qa/SKILL.md` | 本地 UI/浏览器流程验收 | browser 自动化检查 | 真打开页面看，不靠想象 |
| `skills/bun-runtime/SKILL.md` | 评估 Bun 或 bun test | Node/Bun 取舍参考 | 想换运行时再看 |
| `skills/canary-watch/SKILL.md` | 发布后监控 URL 或服务 | HTTP、console、asset、性能 smoke | 上线后盯一会儿 |
| `skills/click-path-audit/SKILL.md` | UI 按钮状态流异常 | 追点击后的完整状态链 | 按钮看似能点但结果错时用 |
| `skills/code-tour/SKILL.md` | 需要给新人讲 YOLO 架构 | 生成可导航 walkthrough | 做项目导览时很有用 |
| `skills/codebase-onboarding/SKILL.md` | 新人/新 agent 接手 YOLO | 生成入口、架构、约定说明 | 帮新人快速入场 |
| `skills/configure-ecc/SKILL.md` | 真要安装/升级 ECC 组件 | 处理选择安装和路径验证 | 需要动安装时再用 |
| `skills/content-hash-cache-pattern/SKILL.md` | 处理大文件、docs、fixtures 缓存 | 内容 hash 自动失效 | 缓存跟内容走，不跟路径走 |
| `skills/continuous-agent-loop/SKILL.md` | 设计连续执行链 | eval、恢复、循环质量 | 让长链路不乱跑 |
| `skills/cost-tracking/SKILL.md` | 接入真实 token/cost ledger | 成本可查可报 | 花了多少钱要能说清 |
| `skills/council/SKILL.md` | 重大取舍、多路径都合理 | 多视角讨论 | 犹豫时开个结构化圆桌 |
| `skills/dashboard-builder/SKILL.md` | 做运行/质量 dashboard | operator 问题导向 | 看板不是好看，是回答问题 |
| `skills/data-throughput-accelerator/SKILL.md` | 大量 fixture/evidence 处理变慢 | 提升吞吐且保正确性 | 数据搬运慢了再用 |
| `skills/database-migrations/SKILL.md` | YOLO 以后接 DB 状态库 | 迁移、回滚、零停机参考 | 有数据库再谈迁移 |
| `skills/deep-research/SKILL.md` | 需要深度外部研究 | 多源引用和综合 | 市场/竞品/技术调研时用 |
| `skills/deployment-patterns/SKILL.md` | 做真实部署或 release infra | CI/CD、rollback、health check | 要上线服务时用 |
| `skills/design-system/SKILL.md` | 做 progress UI 设计系统 | 视觉一致性审查 | UI 多了才需要设计系统 |
| `skills/docker-patterns/SKILL.md` | 做容器化/dev env | Docker 安全和 compose 模式 | 要打包运行环境时用 |
| `skills/e2e-testing/SKILL.md` | UI/CLI 端到端 journey | Playwright、artifact、flaky 策略 | 要模拟用户完整流程时用 |
| `skills/enterprise-agent-ops/SKILL.md` | 企业化长任务运营 | 观测、安全、生命周期 | YOLO 做企业版时参考 |
| `skills/exa-search/SKILL.md` | 需要 Exa 神经搜索 | web/code/company research | 普通搜索不够时用 |
| `skills/flox-environments/SKILL.md` | 需要可复现跨平台环境 | Nix/Flox 工具链固定 | 解决“我机器能跑你机器不能跑” |
| `skills/frontend-a11y/SKILL.md` | UI 验收含无障碍细节 | 前端 a11y 专项 | 页面给所有人用时再加 |
| `skills/frontend-design-direction/SKILL.md` | 新建/改造前端体验 | 视觉方向和体验标准 | UI 要变漂亮变顺手时用 |
| `skills/frontend-patterns/SKILL.md` | 如果 YOLO 新增 React/前端模块 | React/Next 模式参考 | 有前端代码再默认加载 |
| `skills/frontend-slides/SKILL.md` | 做发布 deck / HTML slides | 视口适配和演示材料 | 做演示文稿时用 |
| `skills/gateguard/SKILL.md` | 需要更强事实/证据 gate | 防假设、缺证据结论 | 关键结论要上锁时用 |
| `skills/git-workflow/SKILL.md` | 准备提交/PR 流程 | conventional commit、PR 总结 | 到交付阶段再加载 |
| `skills/hookify-rules/SKILL.md` | 想从坏行为提炼 hooks/rules | 从会话中找可预防模式 | 发现反复踩坑时用 |
| `skills/iterative-retrieval/SKILL.md` | 大仓库深查 | 分轮检索、逐步收敛 | 查复杂问题时别一次读爆上下文 |
| `skills/knowledge-ops/SKILL.md` | 管理知识库/记忆系统 | 去重、归档、检索 | 知识太散时整理 |
| `skills/latency-critical-systems/SKILL.md` | 某条路径有严格延迟目标 | 延迟预算和 profile | 要毫秒级优化时用 |
| `skills/make-interfaces-feel-better/SKILL.md` | 改 UI 手感 | 交互细节和 polish | 页面能用但不好用时用 |
| `skills/market-research/SKILL.md` | 做产品市场判断 | TAM、竞品、定位 | 判断 YOLO 面向谁卖时用 |
| `skills/motion-advanced/SKILL.md` | 前端复杂动画 | motion/react 高级模式 | UI 动效复杂时用 |
| `skills/motion-foundations/SKILL.md` | 前端动画基础 | tokens、spring、a11y | 动效要统一时用 |
| `skills/motion-patterns/SKILL.md` | 常见 UI 动画 | modal/toast/page transition | 页面动起来但别乱动 |
| `skills/motion-ui/SKILL.md` | React/Next 动效系统 | 生产级 motion 规则 | 有动效需求再用 |
| `skills/nestjs-patterns/SKILL.md` | 如果 YOLO 后续迁 NestJS | Nest 模块/DTO/guard 模式 | 换框架时参考 |
| `skills/nextjs-turbopack/SKILL.md` | 如果新增 Next.js app | Next/Turbopack 现代构建 | 做前端站点时用 |
| `skills/opensource-pipeline/SKILL.md` | 公开发布/开源前 | sanitize、package、license | 从私人项目变公开项目时用 |
| `skills/plan-orchestrate/SKILL.md` | 把大计划转为多 agent 链 | 生成可执行 orchestration prompts | 想并行派活时用 |
| `skills/plankton-code-quality/SKILL.md` | 评估写时质量 hook | auto-format/lint/fix 思路 | 想做自动修正时参考 |
| `skills/postgres-patterns/SKILL.md` | 如果 state store 迁 Postgres | 查询、索引、schema | 上数据库时用 |
| `skills/prisma-patterns/SKILL.md` | 如果引入 Prisma | Prisma 陷阱和事务 | 用 Prisma 再装 |
| `skills/product-lens/SKILL.md` | 需求前置判断 | 压测“为什么做” | 防止把错误需求做得很漂亮 |
| `skills/production-audit/SKILL.md` | 发布/上线前检查 | 本地证据生产就绪审计 | 真要对外发布时用 |
| `skills/project-flow-ops/SKILL.md` | GitHub/Linear 协调 | backlog、PR triage | 任务多起来后管队列 |
| `skills/ralphinho-rfc-pipeline/SKILL.md` | RFC 驱动多 agent DAG | merge queue、work unit | 大型并行工程参考 |
| `skills/recursive-decision-ledger/SKILL.md` | 多轮决策和方案搜索 | 记录每轮选择依据 | 不想反复绕回同一问题时用 |
| `skills/repo-scan/SKILL.md` | 需要快速仓库体检 | 扫结构和风险 | 新接一个项目时用 |
| `skills/research-ops/SKILL.md` | 当前事实研究 | 研究工具编排 | 查实时资料时用 |
| `skills/rules-distill/SKILL.md` | 从技能提炼规则 | 压缩成更小规则集 | 技能太多时提炼共同原则 |
| `skills/santa-method/SKILL.md` | 高风险输出需双重审查 | 对抗式验证 | 重要结论让两个独立视角都通过 |
| `skills/security-bounty-hunter/SKILL.md` | 做漏洞赏金式审计 | 远程可利用问题优先 | 找真漏洞，不找噪音 |
| `skills/security-scan/SKILL.md` | 扫 agent 配置安全 | AgentShield 思路 | 查配置是否会被注入 |
| `skills/skill-comply/SKILL.md` | 检查 skills/rules 是否被遵守 | 行为合规评估 | 规则写了不等于 agent 会照做 |
| `skills/skill-scout/SKILL.md` | 新建 skill 前搜索已有技能 | 防重复造 skill | 先找有没有现成的 |
| `skills/skill-stocktake/SKILL.md` | 定期盘点技能质量 | keep/improve/retire/merge | 技能库也需要清理 |
| `skills/team-builder/SKILL.md` | 临时组多 agent 团队 | agent 组合建议 | 大任务要排兵布阵时用 |
| `skills/token-budget-advisor/SKILL.md` | 估算上下文和 token | 降低上下文风险 | 任务太大先估体量 |
| `skills/ui-demo/SKILL.md` | 录 UI demo | Playwright 录屏 | 要给别人看功能时用 |
| `skills/unified-notifications-ops/SKILL.md` | 管通知和提醒 | GitHub/Linear/desktop 去重 | 提醒太多时整理 |
| `skills/vite-patterns/SKILL.md` | 如果 fixture/frontend-vite 升级 | Vite config/build/HMR | Vite 项目出问题再用 |
| `skills/workspace-surface-audit/SKILL.md` | 审机器/插件/MCP/connector | 看环境能力和缺口 | 先看工作台有什么，再决定装什么 |

## 选装 Rules

| ECC 文件 | 什么时候装 | 优势 | 大白话解释 |
|---|---|---|---|
| `rules/web/coding-style.md` | 做 UI 或 docs site | Web 代码风格 | 有网页再用 |
| `rules/web/design-quality.md` | 做可见 UI | 视觉质量检查 | 不让页面看起来像临时拼的 |
| `rules/web/hooks.md` | UI 改动后自动验证 | 浏览器/构建触发参考 | 改页面后知道该验什么 |
| `rules/web/patterns.md` | 新增 Web surface | Web 常见结构 | 页面架构别乱长 |
| `rules/web/performance.md` | UI 性能问题 | Core Web Vitals 参考 | 页面慢时再装 |
| `rules/web/security.md` | Web 输入/渲染/认证 | XSS/CSRF 等边界 | 有 Web 攻击面再装 |
| `rules/web/testing.md` | UI E2E / a11y 测试 | Web 测试补充 | 要验用户路径时用 |

## 选装 Agents

| ECC 文件 | 什么时候装 | 优势 | 大白话解释 |
|---|---|---|---|
| `agents/a11y-architect.md` | UI acceptance 涉及无障碍 | 专业 a11y 审查 | 页面要给更多人用时请它看 |
| `agents/code-simplifier.md` | 最近改动变复杂 | 保行为前提下降复杂度 | 代码绕了就请它拆直 |
| `agents/comment-analyzer.md` | 文档/注释可能过期 | 查 comment rot | 注释别骗人 |
| `agents/conversation-analyzer.md` | 从会话提炼规则/hooks | 找反复行为问题 | 聊天里暴露的坏习惯变成规则 |
| `agents/database-reviewer.md` | 引入 DB / state store | schema、query、权限 | 有数据库时请专家 |
| `agents/gan-planner.md` | 做 GAN/UI 迭代玩法 | 规格和评分 | 做自动 UI 迭代实验时用 |
| `agents/gan-generator.md` | 自动生成 UI 方案 | 和 evaluator 配套 | 让 UI 方案自己迭代 |
| `agents/gan-evaluator.md` | 自动评估 UI 方案 | Playwright + rubric | 给生成结果打分 |
| `agents/opensource-sanitizer.md` | 公开发布前 | 查 secrets/PII/internal refs | 开源前扫雷 |
| `agents/opensource-packager.md` | 准备开源包 | README/LICENSE/模板 | 把项目包装成别人能用 |
| `agents/opensource-forker.md` | 从私有项目拆公开版本 | 拷贝和脱敏 | 要公开时先做干净副本 |

## 选装 Commands

这些不建议作为 slash commands 安装到 YOLO。YOLO 已有 `/yolo-*` registry，ECC commands 更适合作为“参考模板”映射到 YOLO workflow。

| ECC 文件 | 映射到 YOLO | 优势 | 大白话解释 |
|---|---|---|---|
| `commands/plan.md` | `/yolo-plan` | 计划结构参考 | 只借思路，不新加命令 |
| `commands/plan-prd.md` | `/yolo-prd` | PRD 编译参考 | PRD 还是走 YOLO schema |
| `commands/feature-dev.md` | `/yolo-run` | feature flow 参考 | 执行必须仍由 YOLO gate 控制 |
| `commands/code-review.md` | `/yolo-review` | review 输出参考 | review 不绕开 YOLO findings |
| `commands/build-fix.md` | `/yolo-fix` | build failure 修复参考 | 修 build 也要有范围和证据 |
| `commands/quality-gate.md` | `/yolo-check` / `/yolo-ship` | gate 文案和步骤参考 | gate 结果仍以 YOLO 为准 |
| `commands/security-scan.md` | `/yolo-check` | 安全检查参考 | 安全扫描可做子 gate |
| `commands/test-coverage.md` | `/yolo-eval` | 覆盖率检查参考 | 覆盖率不是唯一指标 |
| `commands/harness-audit.md` | `/yolo-doctor` | harness 体检参考 | 检查集成是否健康 |
| `commands/update-docs.md` | `/yolo-learn` / docs workflow | 文档更新参考 | 改了能力别忘文档 |
| `commands/update-codemaps.md` | memory refresh / docs | codemap 更新参考 | 结构树要跟着代码动 |
| `commands/learn.md` | `/yolo-learn` | 学习沉淀参考 | 经验进账本，不塞满提示词 |

## 选装 Hooks / Scripts

这些只建议移植成 YOLO 自己的只读 gate、doctor 或显式执行脚本，不建议直接启用 ECC hook runtime。

| ECC 文件 | 什么时候参考 | 优势 | 大白话解释 |
|---|---|---|---|
| `scripts/ci/validate-skills.js` | 校验 YOLO skill artifacts | 防坏 frontmatter / 缺字段 | 技能文件别半残 |
| `scripts/ci/validate-rules.js` | 校验 rules 文档 | 防规则格式漂移 | 规则也要有格式 |
| `scripts/ci/validate-agents.js` | 校验 agents | 防 agent metadata 不完整 | agent 名字、描述、工具要清楚 |
| `scripts/ci/validate-commands.js` | 校验 command docs | 参考命令注册检查 | 命令别写了但不可用 |
| `scripts/ci/validate-hooks.js` | 如果未来接 hooks | 防 matcher 过宽或退出码错误 | hook 别误伤 |
| `scripts/ci/validate-workflow-security.js` | 发布前检查 workflow 风险 | 防危险自动化进入 CI | workflow 不能偷偷做敏感事 |
| `scripts/ci/validate-install-manifests.js` | YOLO install manifest 成熟后 | 检查 install 组件一致性 | 安装清单不能自相矛盾 |
| `scripts/ci/validate-no-personal-paths.js` | 发布前 | 防本机路径泄露 | 别把私人路径发出去 |
| `scripts/ci/check-unicode-safety.js` | 公开包发布前 | 防混淆字符风险 | 看起来一样的危险字符要查 |
| `scripts/ci/catalog.js` | 生成技能/命令目录 | 维护 catalog | 自动数清楚有多少东西 |
| `scripts/hooks/post-edit-typecheck.js` | 作为显式 gate 参考 | 改 TS 后 typecheck | 改完别忘类型检查 |
| `scripts/hooks/post-edit-format.js` | 作为格式化策略参考 | 自动格式化思路 | 格式化可以自动，但要可控 |
| `scripts/hooks/quality-gate.js` | 作为 YOLO gate 参考 | 聚合 build/test/lint | 质量门可以借结构 |
| `scripts/hooks/suggest-compact.js` | 长会话 | 提醒压缩上下文 | 上下文快满时提醒收纳 |
| `scripts/hooks/mcp-health-check.js` | MCP/connector doctor | 检查 MCP 可用性 | 工具坏了先发现 |

## 不建议安装的类别

| 类别 | 例子 | 原因 | 大白话解释 |
|---|---|---|---|
| 非主栈语言规则/技能 | Go、Java、Kotlin、Rust、Swift、PHP、Perl、Dart、Android | YOLO 主体是 TypeScript/Node | 不要让无关语言规则污染默认上下文 |
| 行业运营技能 | billing、email、logistics、customs、healthcare、prediction market | 和 YOLO 本体开发无直接关系 | 不是现在要解决的问题 |
| 媒体/社交/内容技能 | video、fal、crosspost、x-api、social publisher | 会引入外部动作和账号风险 | 做营销时再查，不进工程默认包 |
| ECC 全量平台配置 | `.claude-plugin`、`.cursor`、`.opencode`、`.gemini` 等 | YOLO 已有自己的 Codex/Claude 安装器 | 不要把别人的安装系统套在 YOLO 上 |
| ECC hooks 直接启用 | `hooks/`, `.cursor/hooks`, `scripts/hooks/*` | 可能和 YOLO gate、Codex 权限、显式确认冲突 | hook 不该偷偷接管项目 |
| ECC root `AGENTS.md` 原样覆盖 | `AGENTS.md` | 里面有与 YOLO/当前 Codex 规则冲突的强制项 | 可以借鉴，不能照抄 |

## 推荐落地顺序

1. 先做 `docs/ecc-yolo-install-manifest.md` 这份清单的人工确认。
2. 生成一个 `skill-library` router，只登记选装 skills，不复制正文进默认上下文。
3. 将必装 rules 改写成 YOLO 版本，避免覆盖现有项目规则。
4. 将必装 skills 安装到项目级 agent 可发现目录，保持来源和版本字段。
5. 将选装 commands/hooks 只接入 `yolo doctor/check/eval` 的参考或 dry-run gate，不自动启用。
6. 跑 `npm run build --silent` 和 `node --import tsx --test __tests__/*.test.ts` 验证安装器/清单不破坏现有行为。
