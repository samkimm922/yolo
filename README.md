# YOLO — You Only Launch Once

YOLO 是面向 Codex / Claude Code 的项目生命周期 Team Agent 和公开 SDK。它的目标不是让用户记一串终端命令，而是把一个想法推进到 discovery、计划、PRD/spec、执行、review/fix、验收、交付和学习沉淀，并且每一步留下可审查的 gate、证据和记忆。

## 核心流程

用户在 Codex / Claude Code 里可以先用兜底入口：

```text
/yolo 我有一个想法，帮我从零开始规划这个项目，先不要改代码。
```

如果已经知道阶段，Claude Code 可以直接用 8 个稳定入口：`/yolo-status`、`/yolo-demand`、`/yolo-spec`、`/yolo-tasks`、`/yolo-check`、`/yolo-run`、`/yolo-review`、`/yolo-release`。Codex 菜单只暴露 `/yolo` 总入口，阶段意图写进同一句话里，例如“需求沟通”“生成 PRD/spec”“检查 PRD”“执行已检查 PRD”。旧的 brainstorm/interview/discover/discuss/plan/prd/accept/ship 等入口只保留为隐藏兼容路由，不再作为默认菜单。

YOLO 的主线是：

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

默认不会改业务代码。`/yolo-demand`、`/yolo-spec`、`/yolo-tasks`、`/yolo-check` 都是阶段停止点：完成本阶段后必须停住，只报告产物、缺口和下一步建议。只有用户明确确认执行、PRD/spec 检查通过、gate 可运行、范围清楚时，`/yolo-run` 才能进入写代码路径。

## 产品形态

| 层 | 作用 |
|---|---|
| Agent 入口 | Claude Code slash commands、Codex 单一 `/yolo` skill、source-command fallback，让用户在聊天里描述阶段意图而不是从一串菜单里挑 |
| PI / Team Agent | 由 PI 负责 lifecycle routing，按阶段调度 discovery、planner、spec、implementer、reviewer、QA、release、learning |
| Gate / Evidence | PRD preflight、spec governance、adapter readiness、review/fix、acceptance、parallel merge gate 和 final evidence |
| SDK | `createYoloSdk()` 暴露 project、lifecycle、commands、doctor、pi、spec、runtime、review、acceptance、packs、eval、parallel、release |
| Memory / Learning | 外部项目状态归入 `.yolo/`，任务进度、改动、证据、经验和结构树自动刷新 |

## 目录结构

```
scripts/yolo/
  bin/                # 公开 CLI 入口（薄封装，调用 src/cli/*）
  src/                # SDK / runtime / agents / lifecycle / workflows / gates / evidence
  runner.ts           # 兼容运行入口，构建后输出 dist/runner.js
  sdk.ts              # 公共 SDK 入口，构建后输出 dist/sdk.js
  gate.ts             # 兼容闸门入口，公开 bin 使用 dist/bin/yolo-gate.js
  prompt.ts           # 兼容提示词入口，公开 bin 使用 dist/bin/yolo-prompt.js
  learn.ts            # 兼容学习入口，转发到 src/runtime/learning
  task-logger.ts      # 兼容日志模块，转发到 src/runtime/logging
  state-snapshot.ts   # 兼容状态快照，转发到 src/runtime/evidence
  session-memory.ts   # 兼容 session 记忆，转发到 src/runtime/evidence
  config.yaml         # 配置文件
  config.example.yaml # 通用配置模板
  state/              # 运行时状态（events / runs / changes）
  docs/memory/        # 记忆中心（状态、交接、结构树、审计）
  data/               # 静态数据
  schemas/            # JSON Schema 定义
  skills/             # 技能模板
  workflows/          # 工作流定义
  __tests__/          # 测试文件
```

## 快速开始

### Codex / Claude Code 用户

先让 agent 安装 YOLO skill/command 集成。Codex 只需要 `/yolo` 一个入口自动判断阶段；Claude Code 可以使用 `/yolo` 加 8 个稳定 slash commands：

```text
请把 YOLO 安装到当前项目和我的 Agent 工具里。我要在 Codex 里只看到 /yolo 统一入口，由它自动判断需求、PRD、检查和执行阶段；Claude Code 只生成 /yolo 加 /yolo-status、/yolo-demand、/yolo-spec、/yolo-tasks、/yolo-check、/yolo-run、/yolo-review、/yolo-release 这些稳定 slash commands。执行前先告诉我会写哪些文件。
YOLO 路径是 <你的 YOLO 安装目录>。
```

安装后，如果你不确定该走哪一步，就在 Codex / Claude Code 里说：

```text
/yolo 我要给库存系统增加低库存预警，先读状态并选择安全阶段，不要改代码。
```

最容易记的一句话入口：

```text
/yolo 你的需求，先读状态并选择安全阶段，不要改代码。
```

Codex 需求阶段也走同一个入口：

```text
/yolo 需求沟通：我想把这个需求聊清楚，暂时不要生成 PRD。
```

不知道当前项目是否装好时：

```text
/yolo 检查当前项目的 YOLO 是否装好、能不能用。
```

Claude Code 会得到真实 `.claude/commands/yolo*.md` slash commands；Codex 只会得到 `/yolo` 总入口和单个 `source-command-yolo` fallback。内部 workflow 名称如 `yolo.pi`、`yolo.prd` 不会作为用户菜单暴露。详细说明见 [docs/agent-chat-usage.md](docs/agent-chat-usage.md) 和 [docs/agent-native-integration.md](docs/agent-native-integration.md)。

### 不懂命令行的本地菜单

如果只想用本地菜单，可以双击：

```text
START_HERE.command
```

它会打开一个菜单：

- `1` 初始化项目
- `2` 只生成计划，不改代码
- `3` 检查 PRD
- `4` 执行 PRD，会要求二次确认
- `5` 退出

大白话说明见 [docs/non-technical-user-guide.md](docs/non-technical-user-guide.md)。

### 开发者 / 自动化入口

```bash
# 进入 yolo 目录
cd scripts/yolo

# 构建公开 CLI
npm run build --silent

# 初始化陌生项目的 YOLO 基础结构
node dist/bin/yolo.js init /path/to/project --name demo --json

# 刷新项目记忆中心：任务计划、进度、结构树、交接和文档审计
node dist/bin/yolo.js memory refresh /path/to/project --json

# 运行 PI 主线（PRD -> check -> runner -> review -> acceptance -> ship -> learn）
node dist/bin/yolo.js run <prd-file> --json

# 单独运行闸门检查
node dist/bin/yolo-gate.js

# 生成 AI 提示词（不执行）
node dist/bin/yolo-prompt.js --prd <prd-file>

# PI agent：默认只生成计划，不执行模型/改代码
node dist/bin/yolo-pi.js --requirement="加一个库存预警功能"

# 显式执行必须使用已完成 discover/plan/prd/check 的 PRD，防止跳过生命周期 guard
node dist/bin/yolo.js run <prd-file> --json

# 检查旧 PRD 是否需要补 target coverage gates（默认不写盘）
node dist/bin/yolo-prd-migrate-gates.js data/example-prd.json --json

# 执行前统一检查 schema / contract / spec governance / migration advice / runner readiness
node dist/bin/yolo-prd-preflight.js data/example-prd.json --json

# 底层 runner 调试入口，普通集成优先使用 yolo run
node dist/bin/yolo.js runner <prd-file> --dry-run --json
```

## SDK 用法

```js
import { createYoloSdk } from "yolo";

const sdk = createYoloSdk({
  projectRoot: "/path/to/project",
  configPath: "/path/to/yolo.config.yaml",
});

const stateRoot = sdk.paths.stateRoot; // /path/to/project/.yolo
const presets = sdk.agents.listPresets();
const reviewPlan = sdk.agents.createPlan({ preset: "reviewer" });
const piPlan = sdk.agents.createPiPlan({ requirement: "Build inventory alerts" });
const migrated = sdk.prd.migratePrdGates(existingPrd);
const migrationAdvice = sdk.prd.createPrdMigrationAdvice(existingPrd, "/path/to/prd.json");
const preflight = sdk.prd.preflightPrd("/path/to/prd.json");
const schemaGate = sdk.prd.validatePrdPath("/path/to/prd.json");
const runnerResult = await sdk.runtime.runRunner({ prdPath: "/path/to/prd.json", mode: "dev" });
const trace = sdk.spec.buildTraceabilityMatrix(prd);
const report = sdk.evidence.buildRunReport({ stateDir: "/path/to/state", runId: "RUN-1" });
const finalAnswer = sdk.evidence.buildRunFinalAnswer(report);
const workflows = sdk.workflows.listWorkflows();
const skillInstall = sdk.workflows.installSkills({
  target: "yolo",
  workflows: ["pi", "review", "fix", "ship"],
  dryRun: true,
});
const fixtures = sdk.fixtures.inspectFixtureRegistry();
const fixtureRun = sdk.fixtures.runFixtureHarness("node-basic");
const release = sdk.release.inspectPublicBetaReadiness();
const packageSmoke = sdk.release.runPackageInstallSmoke({ dryRun: true });
const betaEvidence = sdk.release.runPublicBetaEvidenceGate({
  projectRoot: "/path/to/real-project",
  // attach agent integration, dogfood, and PI evidence before public beta claims
});
const adapter = sdk.provider.inspectAgentAdapterContract({
  providerDetection: { selected: "codex", available: { codex: true } },
});
const bootstrap = sdk.project.initProject({ projectRoot: "/path/to/project", projectName: "demo" });
const firstPrdSmoke = await sdk.project.runInitToFirstPrdSmoke({ projectName: "demo" });
const lifecycle = sdk.spec.buildSpecLifecyclePackage({
  requirements: [{ id: "REQ-1", text: "Initialize a project" }],
  designs: [{ id: "DES-1", requirement_ids: ["REQ-1"], approach: "Use yolo init" }],
  tasks: [{ id: "TASK-1", requirement_ids: ["REQ-1"], design_ids: ["DES-1"], scope: { targets: [{ file: "README.md" }] } }],
});
```

SDK 不是 PI 专属。PI 是完整“需求到落地”的高阶 preset，`reviewer`、`gatekeeper`、`implementer` 可以作为更窄的 agent 独立使用。
PI preflight、runner runtime 和 runner direct gate 会在执行前阻断弱 PRD，包括缺 target coverage gate、缺 requirement/design trace、terminal task 缺 evidence trace，并返回可执行的迁移或修复建议；迁移仍需显式 `--apply`。
`sdk.project`、`sdk.spec`、`sdk.evidence`、`sdk.provider` adapter helpers、`sdk.workflows`、`sdk.commands`、`sdk.doctor`、`sdk.pi`、`sdk.fixtures`、`sdk.eval`、`sdk.parallel`、`sdk.release` 目前是 experimental，用于项目 bootstrap、init-to-first-PRD smoke、spec lifecycle、traceability、v1 证据账本 schema、runtime/agent adapter contract、run report/final-answer 生成、workflow/skill registry、command registry、doctor report、PI lifecycle façade、skill install artifacts、benchmark、controlled parallel planning、跨项目夹具隔离执行、package install smoke、public beta readiness、agent integration doctor、real-project dogfood v2、PI drill、runtime boundary decision 和 public beta evidence bundle；API shape 在公开稳定前还可能调整。

SDK 公开化差距和解耦路线见 [docs/sdk-gap-matrix.md](docs/sdk-gap-matrix.md)，当前公开 API 边界见 [docs/public-sdk-contract.md](docs/public-sdk-contract.md)，API reference 见 [docs/api-reference.md](docs/api-reference.md)，跨项目 fixture 矩阵见 [docs/fixture-matrix.md](docs/fixture-matrix.md)。

## 记忆体

YOLO 把“人看的记忆”和“机器看的账本”分开：

- 人看的记忆中心：YOLO 自身是 `docs/memory/`，外部项目是 `.yolo/memory/`。
- 机器账本：YOLO 自身是 `state/*.jsonl`，外部项目是 `.yolo/state/*.jsonl`。
- `PROJECT_TREE.md`、`SYSTEM_STATE.md`、`ROADMAP.md` 是兼容镜像；真正的结构树、当前状态、交接和审计在 memory 文件夹。
- `DOCUMENT_GOVERNANCE.md` 是文档唯一归位和命名规范；以后新增项目记忆文档先看这里。
- `LEARNING_INDEX.md` 和 `LESSONS_PLAYBOOK.md` 是学习复利入口；公开包自身不会打印本地 legacy 项目经验细节。
- `yolo init` 会自动创建 `.yolo/memory/` 和空的 `changes/events/runs/learning/session-memory.jsonl`。
- `yolo memory refresh` 会先把超限 ledger 归档到 `state/archive/jsonl/YYYY-MM/` 或 `.yolo/state/archive/jsonl/YYYY-MM/`，再保留当前文件的最新记录。
- `yolo memory refresh` 也会把旧学习来源去重迁移进 `learning.jsonl`，旧来源只读保留直到人工批准删除。
- 执行任务时，prompt 会从当前项目的 `learning.jsonl` 检索少量相关经验，生成非阻塞 experience pack；检索失败会静默跳过，不影响 runner 继续执行。
- hooks 会在 yolo 项目变更时自动刷新 `docs/memory/`；外部项目可用 `yolo memory refresh` 刷新、迁移学习经验和执行记忆保留策略。

## 配置说明

配置默认读取 `config.yaml`。公开集成时可以复制 `config.example.yaml`，或通过 `YOLO_CONFIG` / SDK `configPath` 指定外部项目配置。主要分区：

- **project** — 目标项目路径、源码目录、框架类型、排除规则
- **gate** — 闸门开关（tsc / eslint / knip / 业务规则）
- **runner** — 重试策略、stash 前缀
- **ai** — 执行器和模型选择；`executor: claude` 会调用 `claude -p`，`executor: codex` 会调用 `codex exec`，`executor: custom` 会调用自定义 shell 命令，`model` 只作为传给执行器的模型参数
- **state** — 状态文件存储路径
- **docs** — 文档输出路径
- **closed_loop** — v1 兼容配置

修改配置后无需重启，下次运行自动读取。

## 闸门系统

闸门是质量底线，每一轮 AI 修复后必须通过：

| 闸门 | 检查内容 | 阻断级别 |
|------|---------|---------|
| tsc | TypeScript 类型检查 | 阻断 |
| eslint | 代码规范检查 | 阻断 |
| knip | 未使用代码检测 | 阻断 |
| business_code_min | 业务代码最小完整性 | 阻断 |

全部 PASS 才能进入 commit 阶段。任一 FAIL 触发重试，超过上限标记失败。

## 状态追踪

每次运行产生三类状态文件：

- **events.jsonl** — 事件流，记录每个阶段的起止和结果
- **runs.jsonl** — 运行记录，包含任务 ID、PRD、结果
- **changes.jsonl** — 变更记录，每次修复的文件和内容差异
- **learning.jsonl** — 学习复利账本，记录踩坑、规则、风险模式和恢复策略
- **session-memory.jsonl** — session 接力棒，记录关键检查点和下一轮上下文

状态文件用于：
- 断点续跑（runner 从上次失败处继续）
- 审计回溯（查看任意任务的历史变更）
- 统计分析（成功率、耗时、常见失败原因）

活跃状态文件不会无限增长。`events/changes/runs/learning/session-memory/review-log` 超过保留上限时，旧记录会先归档到 `archive/jsonl/YYYY-MM/`，当前 ledger 只保留最近记录，避免记忆体越跑越吵。
