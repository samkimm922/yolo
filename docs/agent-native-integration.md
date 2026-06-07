# YOLO 原生 Agent 集成说明

这份说明解决一个具体问题：YOLO 不应该只靠终端命令使用，而要像 GSD / Superpowers 一样装进 Codex、Claude Code 或其他支持 skills/commands 的 Agent 工具里。

## 一句话结论

让 Codex 或 Claude Code 先替你安装 YOLO 集成：

```text
请把 YOLO 安装到当前项目和我的 Agent 工具里。我要在 Codex 里只看到 /yolo 统一入口，由它自动判断需求、PRD、检查和执行阶段；Claude Code 可以保留 /yolo-demand、/yolo-prd、/yolo-check、/yolo-run 等真实 slash commands。执行前先告诉我会写哪些文件。
YOLO 路径是：/Users/sippingroom/Developer/SamKimTest/scripts/yolo
```

安装后，不确定该走哪一步时这样用：

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
/yolo 你的需求，先只生成计划，不要改代码。
```

YOLO 会根据这句话自己判断下一步，不要求用户在 brainstorm、discover、plan、prd、check、run、review、accept 之间手动选命令。

Claude Code 可以直接选阶段入口。Codex 为了避免菜单噪音，只从 `/yolo` 总入口进入；如果你已经知道阶段，把阶段写进同一句话里，例如 `/yolo 需求沟通：...`、`/yolo 生成 PRD：...`、`/yolo 检查 PRD：...`、`/yolo 执行已检查 PRD：...`。需求阶段统一按 `/yolo-demand` 协议路由，旧需求子入口只作为兼容别名：

| 命令 | 用途 | 是否改代码 |
|---|---|---|
| `/yolo` | 自动判断该走发现、计划、PRD、检查、执行、review、验收还是交付 | 默认不改 |
| `/yolo-demand` | 统一需求沟通入口，内部衔接 brainstorm / interview / discover / discuss / evidence dispatch / PRD readiness | 不改 |
| `/yolo-brainstorm` | 兼容别名，等同于 `/yolo-demand --stage brainstorm` | 不改 |
| `/yolo-interview` | 兼容别名，等同于 `/yolo-demand --stage interview` | 不改 |
| `/yolo-discuss` | 兼容别名，等同于 `/yolo-demand --stage discuss` | 不改 |
| `/yolo-discover` | 兼容别名，等同于 `/yolo-demand --stage discover` | 不改 |
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

Claude Code 本地已有明确的 `.claude/commands/*.md` 约定，所以 YOLO 会生成真实的 `/yolo-demand`、`/yolo-prd`、`/yolo-check`、`/yolo-accept`、`/yolo-eval`、`/yolo-run`、`/yolo-doctor` 等 slash command 文件。`/yolo-brainstorm`、`/yolo-interview`、`/yolo-discuss`、`/yolo-discover` 也会生成，但只作为兼容别名，内容会指向 `/yolo-demand --stage <stage>`。

Codex 的入口和 GSD/GStack 一样走 skill discovery：安装器会生成 `~/.agents/skills/yolo/SKILL.md` 这个总入口和单个 `~/.agents/skills/source-command-yolo/SKILL.md` fallback，不再生成顶层 `yolo-*` 阶段 skill。需求沟通、PRD、检查、执行等阶段由 `/yolo` 内部路由。内部 workflow 只写 `skill.json` 和 `WORKFLOW.md`，不再写会被 Codex 当成顶层 slash 技能的 `SKILL.md`，所以菜单里不会混入 `yolo.pi`、`yolo.prd` 这种内部名。安装后需要新开 Codex 会话或重启 Codex，让它重新发现 skills。

刷新后 Codex 应该优先识别 `/yolo`。如果当前会话还没有刷新，就这样说：

```text
使用 source-command-yolo：我要给库存系统增加低库存预警，先只生成计划，不要改代码。
```

或者：

```text
使用 yolo skill 执行 /yolo：我要给库存系统增加低库存预警，先只生成计划，不要改代码。
```

## 安全边界

- `/yolo ...` 判断为计划或检查时不应该改代码。
- `/yolo ...` 判断为执行时，必须看到用户明确确认和检查通过的 PRD。
- `/yolo ...` 判断为 doctor 时只读检查，不安装、不发布、不调用 provider。
- `/yolo-demand`、需求兼容别名、`/yolo-plan`、`/yolo-prd`、`/yolo-check` 是阶段停止点：完成本阶段后必须停住，报告产物、缺口和下一步建议。
- 用户说“这个方案可以”“确认这个计划”只代表可以进入下一阶段，不代表允许实现代码。
- `/yolo-brainstorm`、`/yolo-interview`、`/yolo-discover`、`/yolo-discuss` 遵守 `/yolo-demand` 的统一需求协议；`/yolo-plan`、`/yolo-check`、`/yolo-run`、`/yolo-doctor` 等阶段入口遵守各自边界。
- 缺 PRD、范围不清、测试坏、provider 不可用、gate 失败时必须停下。
- Agent 可以自己调用 YOLO CLI/SDK，但不能要求非技术用户记命令。
