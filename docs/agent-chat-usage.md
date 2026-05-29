# YOLO 在 Codex / Claude Code 里的用法

这份说明解决一个问题：用户不应该在终端里跟 YOLO 对话。

真正的对话对象是 Codex 或 Claude Code。YOLO 是它们可以调用的项目开发流程、gate 和证据系统。

## 一句话结论

安装完成后，在 Codex 或 Claude Code 里，用户只需要说：

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

如果你只是想知道当前项目能不能用 YOLO，就说：

```text
/yolo-doctor 检查当前项目的 YOLO 是否装好、能不能用。
```

## 需要先安装什么

目标项目里需要有 agent bridge：

- Codex 读取 `AGENTS.md`
- Claude Code 读取 `CLAUDE.md`
- YOLO workflow skills 放在 `.codex/skills` 和 `.claude/skills`
- Claude Code slash commands 放在 `.claude/commands/yolo*.md`
- Codex 用户级 skill 放在 `~/.agents/skills/yolo`
- Codex 直接 slash skills 放在 `~/.agents/skills/yolo-*`
- Codex source-command 入口放在 `~/.agents/skills/source-command-yolo*`

安装后，Codex / Claude Code 才知道“YOLO”不是普通聊天词，而是一套流程。

## 不懂命令的人怎么安装

让当前 agent 帮你装。你在 Codex 或 Claude Code 里说：

```text
请把 YOLO 安装到当前项目和我的 Agent 工具里。我要能直接用 /yolo、/yolo-brainstorm、/yolo-discuss、/yolo-discover、/yolo-plan、/yolo-check、/yolo-accept、/yolo-eval、/yolo-run、/yolo-doctor。执行前先告诉我会写哪些文件。
YOLO 路径是 /Users/sippingroom/Developer/SamKimTest/scripts/yolo。
```

agent 会负责安装 `AGENTS.md`、`CLAUDE.md`、`.codex/skills`、`.claude/skills`、`.claude/commands`，以及 Codex 用户级 `~/.agents/skills/yolo`、`~/.agents/skills/yolo-*` 和 `~/.agents/skills/source-command-yolo*`。

更完整的安装说明见：

```text
docs/agent-native-integration.md
```

## 安装后怎么用

### 需求还很模糊

```text
/yolo-discover 我想做库存预警，但还不确定具体规则。
```

### 只生成计划，不改代码

```text
/yolo-plan 我要给库存系统增加低库存预警
```

或者用总入口：

```text
/yolo 我要给库存系统增加低库存预警，先只生成计划，不要改代码。
```

### 检查已有 PRD

```text
/yolo-check /path/to/prd.json
```

### 检查 YOLO 是否装好

```text
/yolo-doctor 当前项目
```

### 真正开始执行

只有在你确认后才说：

```text
/yolo-run 我确认执行 /path/to/prd.json
```

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
