# Root Entrypoint Inventory

日期：2026-05-26

目的：根目录 `.ts` public/compat entry 不能继续无序增长。新增根入口默认不允许；每个现有根入口必须在 `docs/root-entrypoint-inventory.json` 中归类，并说明保留原因、目标归位目录和迁移状态。

## Policy

- `keep_root`：允许长期留在根目录，通常只限 package root SDK facade。
- `shim_to_src`：短期兼容入口，真实实现应在 `bin/` 或 `src/`。
- `migrate_to_src`：实现仍在根目录，是明确迁移债。
- `legacy_pending`：旧工具或开发工具，需隔离到 `src/runtime/devtools` 或 legacy 区域。
- 新增根目录 `.ts` entrypoint 必须先更新 JSON 清单和结构测试，否则测试失败。

## Current Count

| 指标 | 当前值 |
|---|---:|
| 根目录 `.ts` entrypoint | 7 |
| `keep_root` | 1 |
| `shim_to_src` | 6 |
| `migrate_to_src` | 0 |
| `legacy_pending` | 0 |

## Priority Groups

| 优先级 | 文件 | 方向 |
|---|---|---|
| P0 | `sdk.ts` | 唯一允许长期保留的 package root SDK facade。 |
| P0 | `runner.ts`, `gate.ts`, `prompt.ts` | 已是兼容入口；真实实现通过 `src/`、`bin/` 或 `dist/`。 |
| P1 | `learn.ts`, `session-memory.ts`, `state-snapshot.ts` | 已迁入 `src/runtime/learning`、`src/runtime/evidence`，root 只保留 shim。 |
| done | `contract.ts`, `validate-prd.ts`, `review-scanner.ts`, `pm.ts`, `audit-to-prd.ts`, `pi-agent.ts`, `prd-preflight.ts`, `prd-migrate-gates.ts`, `atomic-task-doctor.ts`, `provider-doctor.ts`, `prd-contract-doctor.ts`, `context-pack-validator.ts`, `diff-quality-gate.ts`, `test-generation-validator.ts`, `precheck.ts`, `progress-server.ts`, `generate-tree.ts`, `precommit-knip.ts`, `prd-check.ts`, `stash.ts` | 已从 root 移除或迁到 `src/`/`bin/`。 |

机器可读清单：`docs/root-entrypoint-inventory.json`。
