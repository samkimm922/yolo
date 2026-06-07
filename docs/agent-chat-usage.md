# YOLO 在 Codex / Claude Code 里的用法

这份说明解决一个问题：用户不应该在终端里跟 YOLO 对话。

真正的对话对象是 Codex 或 Claude Code。YOLO 是它们可以调用的项目开发流程、gate 和证据系统。

## 一句话结论

安装完成后，在 Codex 或 Claude Code 里，不确定该走哪一步时说：

```text
/yolo 我要给库存系统增加低库存预警，先只生成计划，不要改代码。
```

最容易记的一句话入口：

```text
/yolo 你的需求，先只生成计划，不要改代码。
```

如果当前 Codex 版本不把 `/yolo` 当命令处理，就换成这句：

```text
使用 source-command-yolo：我要给库存系统增加低库存预警，先只生成计划，不要改代码。
```

如果当前会话仍没触发，再用最直白的 skill 叫法：

```text
使用 yolo skill 执行 /yolo：我要给库存系统增加低库存预警，先只生成计划，不要改代码。
```

通用 fallback 说法：

```text
使用 yolo skill 执行 /yolo：你的需求，先只生成计划，不要改代码。
```

如果你只是想知道当前项目能不能用 YOLO，也优先用同一个入口：

```text
/yolo 检查当前项目的 YOLO 是否装好、能不能用。
```

## 需要先安装什么

目标项目里需要有 agent bridge：

- Codex 读取 `AGENTS.md`
- Claude Code 读取 `CLAUDE.md`
- YOLO workflow skills 放在 `.codex/skills` 和 `.claude/skills`
- Claude Code slash commands 放在 `.claude/commands/yolo*.md`
- Codex 用户级 skill 放在 `~/.agents/skills/yolo`
- Codex 不再安装顶层 `~/.agents/skills/yolo-*` 阶段 skill，避免 `/yolo` 菜单出现一长串相似入口
- Codex source-command fallback 只保留 `~/.agents/skills/source-command-yolo`
- Codex 内部 workflow descriptor 放在 `yolo/workflows/*.json` 和 `WORKFLOW.md`，`yolo.pi` 这类内部名不会出现在用户菜单

安装后，Codex / Claude Code 才知道“YOLO”不是普通聊天词，而是一套流程。

## 不懂命令的人怎么安装

让当前 agent 帮你装。你在 Codex 或 Claude Code 里说：

```text
请把 YOLO 安装到当前项目和我的 Agent 工具里。我要在 Codex 里只看到 /yolo 统一入口，由它自动判断需求、PRD、检查和执行阶段；Claude Code 可以保留 /yolo-demand、/yolo-prd、/yolo-check、/yolo-run 等真实 slash commands。执行前先告诉我会写哪些文件。
YOLO 路径是 /Users/sippingroom/Developer/SamKimTest/scripts/yolo。
```

agent 会负责安装 `AGENTS.md`、`CLAUDE.md`、`.codex/skills/yolo`、`.claude/skills`、`.claude/commands`，以及 Codex 用户级 `~/.agents/skills/yolo`。Codex 菜单只暴露 `/yolo` 总入口和单个 `source-command-yolo` fallback；需求沟通、PRD、检查、执行等阶段由 `/yolo` 根据用户这句话路由。内部 workflow 只留在 YOLO 内部索引里。

更完整的安装说明见：

```text
docs/agent-native-integration.md
```

## 安装后怎么用

不知道该选哪个时，用这个入口：

```text
/yolo 你的需求，先只生成计划，不要改代码。
```

YOLO 会根据这句话自己判断是要继续需求挖掘、生成计划、编译 PRD、检查 gate、执行、review、验收还是交付。

### 统一需求沟通

```text
/yolo-demand 我想做库存预警，请像访谈一样一步步问我，把需求问清楚，暂时不要生成 PRD。
```

### 深入讨论需求

```text
/yolo-demand 库存预警需求，继续追问灰区并确认范围、非目标和批准条件。
```

### 需求还很模糊

```text
/yolo 我想做库存预警，但还不确定具体规则。
```

### 只生成计划，不改代码

```text
/yolo 我要给库存系统增加低库存预警，先只生成计划，不要改代码。
```

### 检查已有 PRD

```text
/yolo 检查 /path/to/prd.json 能不能执行。
```

### 检查 YOLO 是否装好

```text
/yolo 检查当前项目的 YOLO 是否装好、能不能用。
```

### 真正开始执行

```text
/yolo 我确认执行 /path/to/prd.json。
```

Claude Code 可以直接用这些阶段入口：`/yolo-demand`、`/yolo-prd`、`/yolo-check`、`/yolo-run`、`/yolo-review`、`/yolo-accept`。Codex 为了避免菜单噪音，统一从 `/yolo` 进入，例如 `/yolo 需求沟通：...`、`/yolo 生成 PRD：...`、`/yolo 检查 PRD：...`。旧的 `/yolo-brainstorm`、`/yolo-interview`、`/yolo-discover`、`/yolo-discuss` 仍保留兼容路由，但都会按 `/yolo-demand --stage <stage>` 的统一需求协议执行。

阶段入口必须停在本阶段：`/yolo-demand` 只做需求沟通、证据调度和 PRD 就绪判断，不能顺手生成可执行 PRD 或实现；`/yolo-prd` 只生成/检查 PRD；`/yolo-check` 只做检查，不能因为用户说“可以”就开始实现。真正写代码只能在 `/yolo-run` 或 `/yolo-fix`，并且必须有检查通过的 PRD 或批准的 fix scope。


## 什么时候应该停下来

Codex / Claude Code 使用 YOLO 时，遇到下面情况应该停下来告诉你：

- PRD 不够具体。
- 没有明确要改哪些文件。
- 项目测试本身坏了。
- workspace 有风险改动。
- provider 不可用。
- gate 没过。
- 需要读取 token、发布、付费执行、真实上线。

## 谁跟谁对话

你不直接跟 YOLO 终端对话。

关系是：

```text
你 <-> Codex / Claude Code <-> YOLO
```

你说人话，Codex / Claude Code 负责调用 YOLO。
YOLO 负责计划、PRD、preflight、执行、review、gate、报告。
