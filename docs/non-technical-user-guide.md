# YOLO 不懂代码版使用说明

这份说明只给不想记命令的人看。

## 不知道选哪个时的兜底入口

如果你是在 Codex 或 Claude Code 里面用，不要双击文件。你跟 Codex / Claude Code 对话，它们再调用 YOLO。

Codex / Claude Code 用法见：

```text
docs/agent-chat-usage.md
docs/agent-native-integration.md
```

最像 GSD / Superpowers 的方式，是先让 agent 帮你安装 YOLO skill/command：

```text
请把 YOLO 安装到当前项目和我的 Agent 工具里。我要使用 4 个公开动词：/yolo-demand、/yolo-auto、/yolo-ship、/yolo-status。Codex 可以保留 /yolo 作为统一 fallback，但不要生成 /yolo-spec、/yolo-tasks、/yolo-run、/yolo-check、/yolo-review、/yolo-release 这些默认菜单。执行前先告诉我会写哪些文件。
YOLO 路径是：<你的 YOLO 安装目录>
```

安装后，Claude Code 可以直接用这 4 个动词 slash：`/yolo-status`、`/yolo-demand`、`/yolo-auto`、`/yolo-ship`。`spec`、`tasks`、`check`、`run`、`review`、`release` 是终端 CLI 子命令，不是默认安装的 slash。Codex 为了不让菜单出现一长串相似入口，只保留 `/yolo` 总入口；你把阶段写进同一句话里，比如 `/yolo 需求沟通：...`、`/yolo 生成 PRD/spec：...`、`/yolo 检查 PRD：...`。还是不触发时，说“使用 source-command-yolo”或“使用 yolo skill 执行 /yolo”。

如果你是在 Finder 里用，再双击下面这个入口。

在 Finder 里打开 YOLO 文件夹：

```text
<你的 YOLO 安装目录>
```

双击：

```text
START_HERE.command
```

它不会打开菜单，也不会要你输入数字。它只做一件事：运行 `yolo status`，把当前项目的生命周期状态、阻塞项和唯一安全的下一步打印出来，然后等回车关闭。它只读状态，不改代码。

## 双击后你会看到什么

`yolo status` 的输出会告诉你现在该走哪一步。如果你已经在 Codex / Claude Code 里，把这步的提示直接发给 agent，让它接着做。

## 最安全的第一次用法

第一次真实项目不要直接执行。

推荐顺序：

1. 双击 `START_HERE.command` 看 `yolo status`，确认项目能不能用 YOLO。
2. 在 Codex / Claude Code 里用 `/yolo-demand` 把需求聊清楚，先不要生成 PRD。
3. 需求和范围都确认后，再用 `/yolo-auto` 推进。
4. 交付前用 `/yolo-ship` 做 fail-closed 判断。

## 每个动词会不会改代码

| 动词 | 会不会改代码 |
|---|---|
| `/yolo-status` | 只读，不改 |
| `/yolo-demand` | 只聊需求，不改 |
| `/yolo-ship` | 只做交付判断，不发布 |
| `/yolo-auto` | 会改代码，所以必须你明确批准才执行 |

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

不懂代码的人只做这两件事：

```text
双击 START_HERE.command 看 yolo status。
然后在 Codex / Claude Code 里说：/yolo 你的需求，先读状态并选择安全阶段，不要改代码。
```

默认先用 `/yolo-demand`，因为它只聊需求，不改代码。

如果是在 Codex / Claude Code 里，只说这句话：

```text
/yolo 我要实现一个小功能，先读状态并选择安全阶段，不要改代码。
```

如果你想明确进入需求沟通阶段：

```text
/yolo-demand 我想把这个需求聊清楚，暂时不要生成 PRD。
```

如果你不知道当前项目有没有装好，就说：

```text
/yolo 检查当前项目的 YOLO 是否装好、能不能用。
```

最容易记的一句话入口：

```text
/yolo 你的需求，先读状态并选择安全阶段，不要改代码。
```
