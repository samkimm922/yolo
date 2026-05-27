# YOLO 原生 Agent 集成说明

这份说明解决一个具体问题：YOLO 不应该只靠终端命令使用，而要像 GSD / Superpowers 一样装进 Codex、Claude Code 或其他支持 skills/commands 的 Agent 工具里。

## 一句话结论

让 Codex 或 Claude Code 先替你安装 YOLO 集成：

```text
请把 YOLO 安装到当前项目和我的 Agent 工具里。我要能直接用 /yolo、/yolo-discover、/yolo-plan、/yolo-check、/yolo-accept、/yolo-eval、/yolo-run、/yolo-doctor。执行前先告诉我会写哪些文件。
YOLO 路径是：/Users/sippingroom/Developer/SamKimTest/scripts/yolo
```

安装后，你只需要这样用：

```text
/yolo 我要给库存系统增加低库存预警，先只生成计划，不要改代码。
```

最容易记的一句话入口：

```text
/yolo 你的需求，先只生成计划，不要改代码。
```

## 安装后有什么

项目级安装会写入：

| 宿主 | 文件 | 作用 |
|---|---|---|
| Codex | `AGENTS.md` | 告诉 Codex 如何把聊天请求路由到 YOLO |
| Codex | `.codex/skills/yolo/SKILL.md` | YOLO 总入口 skill |
| Codex | `.codex/skills/yolo.*` | discover / plan / PRD / check / PI / review / fix / accept / eval / ship / learn / doctor 工作流 skills |
| Claude Code | `CLAUDE.md` | 告诉 Claude Code 如何把聊天请求路由到 YOLO |
| Claude Code | `.claude/skills/yolo/SKILL.md` | YOLO 总入口 skill |
| Claude Code | `.claude/skills/yolo.*` | discover / plan / PRD / check / PI / review / fix / accept / eval / ship / learn / doctor 工作流 skills |
| Claude Code | `.claude/commands/yolo*.md` | 真正的 Claude Code slash commands |

用户级安装会写入：

| 宿主 | 文件 | 作用 |
|---|---|---|
| Codex | `~/.agents/skills/yolo/SKILL.md` | Codex 原生 skill discovery 可发现的 YOLO skill |
| Codex | `~/.agents/skills/yolo/workflows/*` | YOLO 工作流 skill descriptors |
| Codex | `~/.agents/skills/source-command-yolo*/SKILL.md` | 对齐本机 Codex `/plan` 这类 source-command 命令约定 |
| Claude Code | `~/.claude/skills/yolo/SKILL.md` | Claude Code 用户级 YOLO skill |
| Claude Code | `~/.claude/commands/yolo*.md` | 用户级 `/yolo-*` slash commands |

## 可用命令

| 命令 | 用途 | 是否改代码 |
|---|---|---|
| `/yolo` | 自动判断该走发现、计划、PRD、检查、执行、review、验收还是交付 | 默认不改 |
| `/yolo-discover` | 模糊想法先做需求挖掘和澄清 | 不改 |
| `/yolo-init` | 初始化 `.yolo/`、生命周期、记忆和 specs 骨架 | 只写 YOLO 骨架 |
| `/yolo-plan` | 把大白话需求变成计划 | 不改 |
| `/yolo-prd` | 把确认后的计划编译成可执行 PRD/spec | 不改 |
| `/yolo-check` | 检查 PRD / preflight / gate 是否能执行 | 不改 |
| `/yolo-run` | 执行已经检查通过的 PRD | 会改，必须确认 |
| `/yolo-review` | 审查实现质量并产出 fix 任务 | 默认不改 |
| `/yolo-fix` | 修复已批准的 review 阻塞项 | 会改，必须确认 |
| `/yolo-accept` | 做产品/运行/UI 验收证据检查 | 不改 |
| `/yolo-ui-review` | 针对前端界面做 UI 验收检查 | 不改 |
| `/yolo-eval` | 用固定 benchmark 检查 YOLO 流程质量是否达到公开准备度 | 不改 |
| `/yolo-ship` | 交付前检查证据、阻塞项和回滚说明 | 不改 |
| `/yolo-learn` | 把踩坑经验沉淀到记忆系统 | 不改 |
| `/yolo-doctor` | 检查当前项目 YOLO 是否初始化、集成是否完整 | 不改 |
| `/yolo-install` | 安装或更新 YOLO agent 集成 | 只写集成文件 |

## Codex 和 Claude Code 的差异

Claude Code 本地已有明确的 `.claude/commands/*.md` 约定，所以 YOLO 会生成真实的 `/yolo-discover`、`/yolo-plan`、`/yolo-prd`、`/yolo-check`、`/yolo-accept`、`/yolo-eval`、`/yolo-run`、`/yolo-doctor` 等 slash command 文件。

Codex 当前更稳定的集成方式是原生 skill discovery，也就是 `~/.agents/skills/yolo/SKILL.md`、`~/.agents/skills/source-command-yolo*/SKILL.md` 和项目内 `.codex/skills/yolo/SKILL.md`。安装后需要新开 Codex 会话或重启 Codex，让它重新发现 skills。

如果你的 Codex 版本支持 source-command 路由，它可以直接识别 `/yolo`、`/yolo-plan` 或 `/yolo plan`；如果当前会话还没有刷新，就这样说：

```text
使用 source-command-yolo：我要给库存系统增加低库存预警，先只生成计划，不要改代码。
```

或者：

```text
使用 yolo skill 执行 /yolo：我要给库存系统增加低库存预警，先只生成计划，不要改代码。
```

## 安全边界

- `/yolo-plan` 和 `/yolo-check` 不应该改代码。
- `/yolo-run` 必须看到用户明确确认和检查通过的 PRD。
- `/yolo-doctor` 只读检查，不安装、不发布、不调用 provider。
- 缺 PRD、范围不清、测试坏、provider 不可用、gate 失败时必须停下。
- Agent 可以自己调用 YOLO CLI/SDK，但不能要求非技术用户记命令。
