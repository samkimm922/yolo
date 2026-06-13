# YOLO 原生 Agent 集成说明

这份说明解决一个具体问题：YOLO 不应该只靠终端命令使用，而要像 GSD / Superpowers 一样装进 Codex、Claude Code 或其他支持 skills/commands 的 Agent 工具里。

## 一句话结论

让 Codex 或 Claude Code 先替你安装 YOLO 集成：

```text
请把 YOLO 安装到当前项目和我的 Agent 工具里。我要使用 4 个公开动词：/yolo-demand、/yolo-auto、/yolo-ship、/yolo-status。Codex 可以保留 /yolo 作为统一 fallback，但不要生成 /yolo-spec、/yolo-tasks、/yolo-run、/yolo-check、/yolo-review、/yolo-release 这些默认菜单。执行前先告诉我会写哪些文件。
YOLO 路径是：<你的 YOLO 安装目录>
```

安装后，不确定该走哪一步时这样用：

```text
/yolo 我要给库存系统增加低库存预警，先读状态并选择安全阶段，不要改代码。
```

最容易记的一句话入口：

```text
/yolo 你的需求，先读状态并选择安全阶段，不要改代码。
```

## 安装后有什么

项目级安装会写入：

| 宿主 | 文件 | 作用 |
|---|---|---|
| Codex | `AGENTS.md` | 告诉 Codex 如何把聊天请求路由到 YOLO |
| Codex | `.codex/skills/yolo/SKILL.md` | YOLO 总入口 skill |
| Codex | `.codex/skills/yolo/commands/*.md` | YOLO 内部命令说明 |
| Codex | `.codex/skills/yolo.*/*.json` + `WORKFLOW.md` | brainstorm / interview / discuss / discover / plan / PRD / check / PI / review / fix / accept / eval / ship / learn / doctor 工作流描述；不会作为顶层 slash 菜单暴露 |
| Claude Code | `CLAUDE.md` | 告诉 Claude Code 如何把聊天请求路由到 YOLO |
| Claude Code | `.claude/skills/yolo/SKILL.md` | YOLO 总入口 skill |
| Claude Code | `.claude/skills/yolo.*` | brainstorm / interview / discuss / discover / plan / PRD / check / PI / review / fix / accept / eval / ship / learn / doctor 工作流 skills |
| Claude Code | `.claude/commands/yolo*.md` | 真正的 Claude Code slash commands |

用户级安装会写入：

| 宿主 | 文件 | 作用 |
|---|---|---|
| Codex | `~/.agents/skills/yolo/SKILL.md` | Codex 原生 skill discovery 可发现的 YOLO skill |
| Codex | `~/.agents/skills/yolo/commands/*.md` | YOLO 内部命令说明 |
| Codex | `~/.agents/skills/yolo/workflows/*.json` + `WORKFLOW.md` | YOLO 工作流 descriptors；不会作为顶层 slash 菜单暴露 |
| Codex | `~/.agents/skills/source-command-yolo/SKILL.md` | 单个 fallback 入口；不再安装一串 `source-command-yolo-*` |
| Claude Code | `~/.claude/skills/yolo/SKILL.md` | Claude Code 用户级 YOLO skill |
| Claude Code | `~/.claude/commands/yolo*.md` | 用户级 `/yolo-*` slash commands |

## 用户入口

不知道该走哪一步时，用总入口：

```text
/yolo 你的需求，先读状态并选择安全阶段，不要改代码。
```

YOLO 会根据这句话自己判断下一步，不要求用户在 brainstorm、discover、plan、prd、check、run、review、accept 之间手动选命令。

Claude Code 可以直接用 4 个动词 slash。Codex 为了避免菜单噪音，只从 `/yolo` 总入口进入；如果你已经知道阶段，把阶段写进同一句话里，例如 `/yolo 需求沟通：...`、`/yolo 生成 PRD：...`、`/yolo 检查 PRD：...`、`/yolo 执行已检查 PRD：...`。安装 agent bridge 后，Claude Code 只得到面向非技术用户的 4 个动词 slash commands：

| Slash | 用途 | 是否改代码 |
|---|---|---|
| `/yolo-status` | 只读查看 lifecycle、阻塞项、下一步 | 不改 |
| `/yolo-demand` | 把需求聊清楚，缺信息时只问一个 next_question | 不改 |
| `/yolo-auto` | 在用户明确批准后，从需求/PRD 走 spec、check、实现、review、fix 和证据 | 会改，必须确认 |
| `/yolo-ship` | 用 gate 和证据做 fail-closed 交付判断 | 不发布 |

`/yolo-spec`、`/yolo-tasks`、`/yolo-run`、`/yolo-check`、`/yolo-review`、`/yolo-release` 不是默认安装的 slash commands；它们是终端 CLI 子命令（见下文），Codex/Claude 可以在聊天里通过 `/yolo` fallback 路由到对应阶段。

### 终端 CLI 子命令（不需要 agent bridge）

在终端里直接用 `yolo` CLI，有 8 个稳定子命令：`status | demand | spec | tasks | run | check | review | release`。其中 `run` 写代码，其余默认不改业务代码。`START_HERE.command` 双击后跑的就是 `yolo status`。

旧 host 可能仍识别 `/yolo-brainstorm`、`/yolo-interview`、`/yolo-discover`、`/yolo-discuss`、`/office-hours`、`/yolo-plan`、`/yolo-prd`、`/yolo-accept` 等兼容入口；这些不是默认菜单项，也不作为默认 slash command 文件安装。它们只应被路由到对应动词，并执行相同硬门。

## Codex 和 Claude Code 的差异

Claude Code 本地已有明确的 `.claude/commands/*.md` 约定，所以 YOLO 安装器只生成 4 个动词 slash command 文件：`/yolo-demand`、`/yolo-auto`、`/yolo-ship`、`/yolo-status`。旧别名不再默认生成命令文件；如果某个 host 已经暴露旧别名，只能作为兼容 shim 路由到对应动词。

Codex 的入口和 GSD/GStack 一样走 skill discovery：安装器会生成 `~/.agents/skills/yolo/SKILL.md` 这个总入口和单个 `~/.agents/skills/source-command-yolo/SKILL.md` fallback，不再生成顶层 `yolo-*` 阶段 skill。需求沟通、PRD、检查、执行等阶段由 `/yolo` 内部路由。内部 workflow 只写 `skill.json` 和 `WORKFLOW.md`，不再写会被 Codex 当成顶层 slash 技能的 `SKILL.md`，所以菜单里不会混入 `yolo.pi`、`yolo.prd` 这种内部名。安装后需要新开 Codex 会话或重启 Codex，让它重新发现 skills。

刷新后 Codex 应该优先识别 `/yolo`。如果当前会话还没有刷新，就这样说：

```text
使用 source-command-yolo：我要给库存系统增加低库存预警，先读状态并选择安全阶段，不要改代码。
```

或者：

```text
使用 yolo skill 执行 /yolo：我要给库存系统增加低库存预警，先读状态并选择安全阶段，不要改代码。
```

## 安全边界

- `/yolo ...` 判断为计划或检查时不应该改代码。
- `/yolo ...` 判断为执行时，必须看到用户明确确认和检查通过的 PRD。
- `/yolo ...` 判断为 doctor 时只读检查，不安装、不发布、不调用 provider。
- `/yolo-demand`、`/yolo-spec`、`/yolo-tasks`、`/yolo-check` 是阶段停止点：完成本阶段后必须停住，报告产物、缺口和下一步建议。
- 用户说“这个方案可以”“确认这个计划”只代表可以进入下一阶段，不代表允许实现代码。
- 旧需求兼容别名遵守 `/yolo-demand` 的统一需求协议；旧 plan/prd/accept/ship 兼容别名必须路由到 `/yolo-tasks`、`/yolo-spec`、`/yolo-release` 并遵守各自边界。
- 缺 PRD、范围不清、测试坏、provider 不可用、gate 失败时必须停下。
- Agent 可以自己调用 YOLO CLI/SDK，但不能要求非技术用户记命令。

## Doctor 真实通过条件

`/yolo-status` 的集成检查和 `runAgentIntegrationDoctor(...)` 不只检查 skill/command 文件是否存在。通过条件还要求当前宿主有新鲜的 discovery evidence：包含 requested targets、pass/discovered 状态、`discovered_at`/`generated_at`/`checked_at` 时间戳，以及 `discovery_run_id` 或 `host_session_id`。默认新鲜度窗口是 30 分钟。

安装或更新 YOLO agent 集成后，需要刷新或重启 Codex/Claude，再捕获宿主发现证据；只有 artifact 存在但没有新鲜 discovery evidence 时，doctor 必须 blocked。
