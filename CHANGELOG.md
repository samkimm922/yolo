# YOLO 变更日志

> 自动生成自 state/changes.jsonl

## [Unreleased] Public Beta Readiness

- Added machine-readable public SDK API boundary and version policy checks.
- Added `yolo init`, `yolo/core/bootstrap`, and `sdk.project.initProject()` for project bootstrap.
- Added `yolo/spec/lifecycle` and `sdk.spec.*` lifecycle helpers for requirements, design, tasks, and changes.
- Expanded fixture matrix to 7 executable fixtures: Node, no-tests, Python, frontend, monorepo, dirty-tree, and failing-baseline.
- Added public API reference and fixture matrix docs.
- Added runtime/agent adapter contract helpers for Claude, Codex, and custom providers.
- Added workflow skill install plan, descriptor validation, and install artifact writer helpers.
- Added final-answer artifacts generated from run reports.
- Added a legacy boundary manifest and tests for v1 `closed-loop/` isolation.
- Added init-to-first-PRD smoke helpers for bootstrap, spec lifecycle, preflight, and runner dry-run readiness.
- Added package `files` allowlist and npm pack/install smoke helpers for external package import/bin verification.
- Added SDK `stateRoot` isolation so external installs keep SDK/init/PI plan state under the target project's `.yolo` instead of `node_modules/yolo`.
- Added runner execution `stateRoot` injection so SDK-triggered runs, including package install smoke runs from an installed tarball, keep reports, snapshots, task-results, task logs, contract evidence, retry data, and gate logs under the target project's `.yolo`.
- Added provider/runtime matrix helpers through `sdk.provider.*`; package install smoke now verifies Claude/Codex/custom provider selection, invocation paths, gate log-dir, and runner runtime stateRoot from an installed tarball.
- Added workflow skill target smoke through `sdk.workflows.*`; package install smoke now verifies `.yolo/skills`, `.agents/skills`, and `.claude/skills` target installs without package root pollution.
- Added native agent integration installer support: Codex gets project/user YOLO skills through `.codex/skills` and `~/.agents/skills/yolo`; Claude Code gets `.claude/skills/yolo` plus real `.claude/commands/yolo*.md` slash commands.
- Added P28-P32 public beta evidence gates through `sdk.release.*`: agent integration doctor, real-project dogfood gate, PI execution drill gate, runtime boundary decision gate, and public beta evidence bundle. These gates validate native chat integration, external project evidence, PI dry-run/billable authorization, explicit runtime stable-boundary approval, and beta/stable release evidence without installing, publishing, reading credentials, or executing providers.
- Added the P33 memory center: canonical `docs/memory/` docs, external-project `.yolo/memory/` bootstrap templates, `yolo memory refresh`, `.md/.jsonl` audit classification, compatibility `PROJECT_TREE`/`SYSTEM_STATE`/`ROADMAP` mirrors, and fixed hooks/log-change paths after root script migration.
- Added P34 memory retention: overflowing `events/changes/runs/review-log/session-memory` ledgers archive old records to `archive/jsonl/YYYY-MM/` before trimming active files, and `yolo memory refresh` prunes legacy generated `state/archive/*.md` snapshots.
- Added P35 learning center: unified `learning.jsonl` records, migrated legacy knowledge/lessons/red-team/learned-rules into a deduped local learning ledger, generated learning index/playbook docs, and kept public package playbooks from printing local legacy project details.
- Added P36 non-blocking experience packs: prompt generation retrieves relevant lessons from the current project's `learning.jsonl`, injects only a small advisory pack, and keeps learn/gate state rooted under the caller supplied state root.
- Added P37 document governance: canonical `docs/memory/DOCUMENT_GOVERNANCE.md` now defines the single home and naming rules for memory docs, ledgers, public docs, specs, temporary analysis, and legacy sources; `yolo memory refresh`, `yolo init`, and package smoke all include it.
- Added P36.5-P39 hardening: docs truth-sync guard, isolated real-project dogfood pack, experience-pack effectiveness audit, and non-technical UX doctor for the one-sentence Codex/Claude entrypoint.
- Moved atomic task doctor, PRD contract doctor, and provider doctor implementations under `src/runtime/*`; root files now remain as compatibility shims.
- Added public beta release gates through `sdk.release.*`: hardening drill, controlled decision gate, operator release-state helper, operator runbook gate, post-release audit gate, stable graduation gate, and manual external release evidence gate. These gates verify evidence and fail closed without publishing, reading credentials, executing providers, or publishing dogfood reports.
- Remaining blocker: `package.json` is still `private: true` until the real project matrix and release docs are intentionally finalized.

## [未知日期] 任务概览

| 状态 | 数量 | 状态来源 |
|------|------|----------|
| 已完成 | 0 | changes.jsonl |
| 待恢复（僵尸） | 9 | runner 未运行，上次异常退出遗留 |
| 自动记录 | 36 | changes.jsonl |

---

### 已完成

_暂无已完成任务_

---

### 待恢复（僵尸任务）

> 状态来源：上次异常退出遗留 (runner 未运行)
> runner 下次启动会自动将这些任务重置为 pending

#### 审计现有 baseline 系统全貌 ⚠️ 僵尸
- 15:46 · scope: task
- 已修改文件: quality-check.mjs, runtime-check.mjs, contract.mjs, prompt.mjs, precheck.mjs, orchestrator.mjs, code-review.mjs, lessons-analyzer.mjs, review-scanner.mjs, stash.mjs, prd-check.mjs, learned-rules.json, package.json, settings-minimal.json, ROADMAP.md, prd-v2.schema.json, validate-prd.mjs, .gitkeep, core.mjs, review.mjs, clean.mjs, stats.mjs, baseline.mjs
- 说明: 阅读现有 baseline 文件、gate 逻辑、contract.mjs 中 baseline 使用方式，理解当前实现的完整数据流和缺陷

#### Phase 0: 配置通用化 ⚠️ 僵尸
- 16:58 · scope: task
- 说明: 创建 lib/config.mjs 配置加载器，重写 config.yaml，让所有 .mjs 文件通过 config 对象获取配置而非硬编码

#### Phase 1: 版本统一 ⚠️ 僵尸
- 16:58 · scope: task
- 说明: 删除 17 个 v1 文件，清理 v1/v2 双轨

#### Phase 2: Baseline 修复 ⚠️ 僵尸
- 16:58 · scope: task
- 说明: 删除 baseline/ 交互式 CLI，内联核心逻辑到 runner.mjs，自动 init/update

#### Phase 3: 数据对齐 ⚠️ 僵尸
- 16:58 · scope: task
- 说明: 统一 PRD/State/Review JSON 格式，创建 review.schema.json，清理 data/ 目录

#### Phase 4: Gate 稳定性 ⚠️ 僵尸
- 16:58 · scope: task
- 说明: 外部命令加超时，修复 retry-count.json 写入，10 个关键空 catch 加日志，gate-chain-v2 精简到 8 步，修复 ANSI 码泄漏

#### Phase 5: 状态清理 ⚠️ 僵尸
- 16:58 · scope: task
- 说明: Progress Server session 隔离，state 文件截断，临时文件清理，archive 去重

#### Phase 6: 自我学习+净化 ⚠️ 僵尸
- 16:58 · scope: task
- 说明: 合并 4 套学习系统为 1 套闭环，自动净化（衰减/去重/置信度），知识注入优化，lessons 去重

#### Phase 7-9: 备份+约束+验证 ⚠️ 僵尸
- 16:58 · scope: task
- 已修改文件: gate-chain-v2.mjs, runner.mjs, doc-updater.mjs
- 说明: generate-tree 自动触发，doc-updater 修复，contract.mjs 补充 4 种 conditionType，runner 通用化，验证

---

### 自动记录（文件变更）

<details>
<summary>点击展开 37 条文件变更记录</summary>

- [16:01] baseline.mjs (Write) — via hook
- [16:01] stats.mjs (Write) — via hook
- [16:00] clean.mjs (Write) — via hook
- [16:00] review.mjs (Write) — via hook
- [16:00] core.mjs (Write) — via hook
- [15:59] .gitkeep (Write) — via hook
- [15:58] contract.mjs (Edit) — via hook
- [15:57] contract.mjs (Edit) — via hook
- [15:57] validate-prd.mjs (Edit) — via hook
- [15:57] validate-prd.mjs (Edit) — via hook
- [15:57] validate-prd.mjs (Edit) — via hook
- [15:56] prd-v2.schema.json (Edit) — via hook
- [15:52] ROADMAP.md (Write) — via hook
- [15:52] settings-minimal.json (Write) — via hook
- [15:52] package.json (Edit) — via hook
- [15:52] stash.mjs (Edit) — via hook
- [15:52] learned-rules.json (Write) — via hook
- [15:51] lessons-analyzer.mjs (Edit) — via hook
- [15:51] prd-check.mjs (Edit) — via hook
- [15:51] prompt.mjs (Edit) — via hook
- [15:51] code-review.mjs (Edit) — via hook
- [15:50] stash.mjs (Edit) — via hook
- [15:50] review-scanner.mjs (Edit) — via hook
- [15:50] lessons-analyzer.mjs (Edit) — via hook
- [15:50] code-review.mjs (Edit) — via hook
- [15:50] orchestrator.mjs (Edit) — via hook
- [15:49] precheck.mjs (Edit) — via hook
- [15:49] prompt.mjs (Edit) — via hook
- [15:49] contract.mjs (Write) — via hook
- [15:48] runtime-check.mjs (Write) — via hook
- [15:47] quality-check.mjs (Write) — via hook
- [15:45] quality-check.mjs (Edit) — via hook
- [] gate-chain-v2.mjs (Edit) — via hook
- [] runner.mjs (Edit) — via hook
- [] doc-updater.mjs (Edit) — via hook
- [] doc-updater.mjs (Edit) — via hook
- [] doc-updater.mjs (Edit) — via hook

</details>
