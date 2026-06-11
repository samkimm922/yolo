# YOLO 快速开始

## Codex / Claude Code 用户

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

Claude Code 会得到真实 `.claude/commands/yolo*.md` slash commands；Codex 只会得到 `/yolo` 总入口和单个 `source-command-yolo` fallback。内部 workflow 名称如 `yolo.pi`、`yolo.prd` 不会作为用户菜单暴露。详细说明见 [docs/agent-chat-usage.md](agent-chat-usage.md) 和 [docs/agent-native-integration.md](agent-native-integration.md)。

## 不懂命令行的本地菜单

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

大白话说明见 [docs/non-technical-user-guide.md](non-technical-user-guide.md)。

## 开发者 / 自动化入口

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
