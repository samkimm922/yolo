# YOLO 快速开始

## 4 个动词

YOLO 的公开用户入口按这个顺序记：

```text
demand -> auto -> ship -> status
```

- `demand`：聊清楚需求，缺信息时只问一个 `next_question`，不写代码。
- `auto`：用户确认后自动走 spec、check、实现、review、fix 和证据。
- `ship`：只做交付判断，gate 或证据缺失时 fail closed。
- `status`：只读当前状态，告诉你下一步最安全做什么。

## 安装到 Agent

让 agent 安装 YOLO bridge 时，直接使用这段话：

```text
请把 YOLO 安装到当前项目和我的 Agent 工具里。我要使用 4 个公开动词：/yolo-demand、/yolo-auto、/yolo-ship、/yolo-status。Codex 可以保留 /yolo 作为统一 fallback，但不要生成 /yolo-spec、/yolo-tasks、/yolo-run、/yolo-check、/yolo-review、/yolo-release 这些默认菜单。执行前先告诉我会写哪些文件。
YOLO 路径是 <你的 YOLO 安装目录>。
```

安装器的 project scope 清单是：

```text
AGENTS.md
CLAUDE.md
.codex/skills/yolo/SKILL.md
.claude/skills/yolo/SKILL.md
.claude/commands/yolo.md
.claude/commands/yolo-demand.md
.claude/commands/yolo-auto.md
.claude/commands/yolo-ship.md
.claude/commands/yolo-status.md
```

Claude Code 会得到 5 个 slash commands（1 个 `/yolo` 路由入口 + 4 个稳定动词）。Codex 会得到 `yolo` native skill，并可用 `/yolo 你的需求...` 作为 fallback；内部 workflow 名称如 `yolo.pi`、`yolo.prd` 不作为用户菜单暴露。详细说明见 [docs/agent-chat-usage.md](agent-chat-usage.md) 和 [docs/agent-native-integration.md](agent-native-integration.md)。

## 日常用法

先把需求聊清楚：

```text
/yolo-demand 我想给库存系统增加低库存预警。请一步步问我，先不要生成 PRD，也不要改代码。
```

需求和执行范围都确认后再自动推进：

```text
/yolo-auto 我确认执行已检查通过的库存预警 PRD。先按 YOLO gate 执行，遇到 blocker 就停。
```

交付前做 fail-closed 判断：

```text
/yolo-ship <你的 PRD 路径>
```

不知道当前项目装没装好、该走哪一步时：

```text
/yolo-status
```

## 不懂命令行的本地入口

如果只想看当前项目状态，可以双击：

```text
START_HERE.command
```

它会运行 `yolo status`，打印当前项目的生命周期状态、阻塞项和唯一安全的下一步，再列出一组终端稳定入口（`yolo status | demand | spec | tasks | run | check | review | release`），按回车关闭窗口。它只读状态，不会改代码，也没有数字菜单。

大白话说明见 [docs/non-technical-user-guide.md](non-technical-user-guide.md)。

## 开发者 / 自动化入口

```bash
# 进入 yolo 目录
cd /path/to/yolo

# 构建公开 CLI
npm run build --silent

# 安装 agent bridge，默认 project scope，dry-run 先看清单
node dist/bin/yolo.js install /path/to/project --dry-run --json

# demand：需求状态、office-hours 或证据调度
node dist/bin/yolo.js demand status "我想增加库存预警" --json

# auto：完整 YOLO 主线，先 dry-run（exit 2 = AUTO_PLAN_READY，计划就绪待批准，不是错误；dry-run 从需求文本生成计划，无需 prdPath）
node dist/bin/yolo.js auto "Add low-stock alerts to inventory dashboard" --dry-run --json

# ship：交付前判断，不发布（把 <你的 PRD 路径> 换成 yolo spec 生成的真实 PRD）
node dist/bin/yolo.js ship <你的 PRD 路径> --json

# status：只读状态和下一步
node dist/bin/yolo.js status --cwd /path/to/project --json
```
