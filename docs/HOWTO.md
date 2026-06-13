# YOLO Loop

## 启动

```bash
node dist/runner.js                      # 跑任务（自动找最新 PRD）
node dist/src/runtime/progress/server.js # 进度面板 → http://localhost:3456
```

不需要传参数。自动跳过已完成的，自动重置中断的任务。等价的 npm 脚本：`npm run runner`、`npm run progress`。

## 生成新 PRD

```bash
# 1. 准备 findings JSON（每条带 id/severity/files/suggestion）
# 2. 生成 PRD
node dist/src/prd/audit-to-prd.js findings.json --title="标题" --output=prd.json
```

已有 PRD 时 `audit-to-prd.js` 会拒绝运行，防止重复生成。加 `--force` 强制覆盖。等价脚本：`npm run audit-to-prd`。

## 关键文件

| 文件 | 说明 |
|------|------|
| `dist/runner.js` | 兼容运行入口（构建产物，源在 `runner.ts`） |
| `src/runtime/runner-core.ts` | runner 主引擎 |
| `src/runtime/progress/server.ts` | 进度面板 |
| `src/prd/audit-to-prd.ts` | findings JSON → PRD（纯脚本，确定性输出） |
| `data/` | PRD JSON、audit 报告等数据文件 |

跑完自动清理临时文件。
