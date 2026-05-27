# YOLO Loop

## 启动

```bash
node scripts/yolo/runner.mjs        # 跑任务（自动找最新 PRD）
node scripts/yolo/src/runtime/progress/server.mjs    # 进度面板 → http://localhost:3456
```

不需要传参数。自动跳过已完成的，自动重置中断的任务。

## 生成新 PRD

```bash
# 1. 准备 findings JSON（每条带 id/severity/files/suggestion，参考 audit-findings.json）
# 2. 生成 PRD
node scripts/yolo/src/prd/audit-to-prd.mjs findings.json --title="标题" --output=prd.json
```

已有 PRD 时 `audit-to-prd.mjs` 会拒绝运行，防止重复生成。加 `--force` 强制覆盖。

## 关键文件

| 文件 | 说明 |
|------|------|
| `runner.mjs` | 兼容运行入口 |
| `src/runtime/runner-core.mjs` | runner 主引擎 |
| `src/runtime/progress/server.mjs` | 进度面板 |
| `src/prd/audit-to-prd.mjs` | findings JSON → PRD（纯脚本，确定性输出） |
| `audit-findings.json` | 本次审计发现（55条逐条列举） |
| `data/` | PRD JSON、audit 报告等数据文件 |

跑完自动清理临时文件。
