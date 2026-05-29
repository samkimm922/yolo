# YOLO 不懂代码版使用说明

这份说明只给不想记命令的人看。

## 你只需要记一个入口

如果你是在 Codex 或 Claude Code 里面用，不要双击文件。你跟 Codex / Claude Code 对话，它们再调用 YOLO。

Codex / Claude Code 用法见：

```text
docs/agent-chat-usage.md
docs/agent-native-integration.md
```

最像 GSD / Superpowers 的方式，是先让 agent 帮你安装 YOLO skill/command：

```text
请把 YOLO 安装到当前项目和我的 Agent 工具里。我要能直接用 /yolo、/yolo-brainstorm、/yolo-discuss、/yolo-discover、/yolo-plan、/yolo-check、/yolo-accept、/yolo-eval、/yolo-run、/yolo-doctor。执行前先告诉我会写哪些文件。
YOLO 路径是：/Users/sippingroom/Developer/SamKimTest/scripts/yolo
```

安装后，Claude Code 可以直接用 `/yolo`。Codex 也会获得和 GSD/GStack 类似的 `~/.agents/skills/yolo-*` 直接 slash skill；新开一个 Codex 会话后试 `/yolo`、`/yolo-brainstorm`、`/yolo-discuss`。还是不触发时，说“使用 source-command-yolo”或“使用 yolo skill 执行 /yolo”。

如果你是在 Finder 里用，再双击下面这个入口。

在 Finder 里打开 YOLO 文件夹：

```text
/Users/sippingroom/Developer/SamKimTest/scripts/yolo
```

双击：

```text
START_HERE.command
```

它会打开一个菜单。你只需要输入数字。

## 菜单怎么选

| 你现在想做什么 | 选哪个 |
|---|---|
| 第一次让某个项目接入 YOLO | 1 |
| 你只有一个想法，想先看看 YOLO 会怎么做 | 2 |
| 你已经有 PRD 文件，想先检查能不能执行 | 3 |
| PRD 已经检查通过，想让 YOLO 开始改项目 | 4 |
| 不想做了 | 5 |

## 最安全的第一次用法

第一次真实项目不要直接执行。

推荐顺序：

1. 选 `1` 初始化项目。
2. 选 `2` 写一句大白话需求，让 YOLO 只生成计划。
3. 看生成的 `plan.md`。
4. 有 PRD 后选 `3` 检查。
5. 检查通过后，再选 `4` 执行。

## 每一步会不会改代码

| 菜单 | 会不会改代码 |
|---|---|
| 1 初始化 | 只会创建 `.yolo/` 和 `specs/` 基础文件 |
| 2 生成计划 | 不改代码 |
| 3 检查 PRD | 不改代码 |
| 4 开始执行 | 会改代码，所以会要求你输入“我确认” |

## YOLO 卡住是什么意思

YOLO 如果停下来，通常不是坏了，而是 gate 在保护项目。

常见原因：

- 需求太模糊。
- PRD 不够具体。
- 没有说清楚要改哪些文件。
- 项目测试本身跑不过。
- AI 改完后质量检查没过。

这种情况下不要硬冲，应该把停下来的信息发给开发者或让 agent 修 PRD。

## 你要准备什么

第一次用真实项目，最好满足：

- 项目能正常打开。
- 项目最好有 git 分支或备份。
- 先拿一个小功能或小 bug 试。
- 不要第一次就让它改几十个文件。

## 一句话版本

不懂代码的人只做这件事：

```text
双击 START_HERE.command，然后按菜单选 1、2、3、4。
```

默认先选 `2`，因为它只生成计划，不改代码。

如果是在 Codex / Claude Code 里，只说这句话：

```text
/yolo 我要实现一个小功能，先只生成计划，不要改代码。
```

如果你不知道当前项目有没有装好，就说：

```text
/yolo-doctor 检查当前项目的 YOLO 是否装好、能不能用。
```

最容易记的一句话入口：

```text
/yolo 你的需求，先只生成计划，不要改代码。
```
