# YOLO PM Discovery 与 UI/UX 验收强化计划

日期：2026-05-25

最近代码对照更新：2026-05-26

## 0. 文档状态

状态：历史 reference / 已拆解，不再作为 active roadmap 执行。

本文保留 PM discovery、UI/UX acceptance、resolver / adapter / pack 的原始设计理由和接口草案，避免丢失背景。但本文中的“未实现 / 部分实现 / 待做”状态已经不是当前真实进度。

当前唯一执行事实源：

- 总交付计划：`docs/yolo-deliverable-implementation-plan.md`
- 当前进度表：`docs/yolo-public-sdk-progress.md`
- SDK / 7 项目差距矩阵：`docs/sdk-gap-matrix.md`
- 文档归位规则：`docs/memory/DOCUMENT_GOVERNANCE.md`

已并入 active roadmap 的部分：

- Discovery gate：D06 / P40-02
- PRD / spec compiler：D07 / P40-02
- Check gate expansion：D08 / P40-03
- Acceptance / UI evidence：D12 / P40-04
- Resolver / pack / adapter：D13 / P40-04
- Eval / benchmark：D16 / P40-05
- Real-project dogfood v2：D18 / P40-07

后续修改 discovery、UI acceptance、adapter 或 pack 能力时，先改 active roadmap 和对应实现/测试；本文只作为设计背景引用。

## 1. 背景

当前 YOLO 已经能把 PRD 送进 runner，并通过 schema、contract、preflight、gate、review、evidence 完成一条自动开发链路。但实际使用中存在一个重要落差：

- runner 完成不等于业务需求真正到位。
- PRD 条件通过不等于 UI/UX 体验合格。
- 模糊需求容易被过早拆成开发任务，缺少 PM discovery。
- UI 任务缺少强制证据采集、状态覆盖、目标 surface 适配、交互和视觉验收标准。

因此本计划目标不是让 runner 永不失败，而是让 YOLO 在执行前拿到更明确的产品规格，在执行后产出更可靠的 UI/UX 证据，并避免主观审美导致无限阻塞。

核心边界：YOLO 是通用自动化 coding 系统，不能绑定任何技术栈、组件库、设计风格、测试工具或业务类型。所有平台、框架、组件、设计参考和验收方式都必须通过 resolver / adapter / pack 注册表解耦，运行时从项目现场、用户输入和配置中选择。

## 2. 目标

1. 支持从非常模糊的想法逐步挖掘到可实施的原子 PRD。
2. 在进入 runner 前，强制确认业务目标、用户场景、范围、非目标、风险和验收标准。
3. 对 UI/UX 任务引入可执行、可复核、可降级的验收体系。
4. 让 runner 完成后必须提供 UI 证据，而不只是代码和 gate 结果。
5. 通过硬失败、release 阻塞、warning、人工确认四级分类，减少卡死和漂移。
6. 保持 core 无硬编码：不内置默认设计风格，不内置默认技术栈，不内置默认组件库。

## 3. 非目标

- 第一版不追求自动判断“审美一定好看”。
- 第一版不把所有视觉 polish 问题设为 runner 阻塞。
- 第一版不重写 runner 主流程。
- 第一版不要求所有项目立即安装某个固定 UI 工具；任何浏览器、端内、原生、云端或外部验收工具都只能作为 adapter 可选实现。
- 第一版不承诺自动生成的 UI 一次就满足最终审美。
- 第一版不把任何具体技术、框架、组件库、平台、品牌或风格写成 YOLO 默认值。

## 4. 总体流程

目标流程：

```text
模糊需求
  -> /yolo-discover
  -> /yolo-prd
  -> /yolo-check
  -> /yolo-run
  -> /yolo-ui-review
  -> fix PRD 或人工确认
```

各阶段职责：

| 阶段 | 主要职责 | 是否改业务代码 |
|---|---|---|
| `/yolo-discover` | PM 需求挖掘、澄清、头脑风暴 | 否 |
| `/yolo-prd` | 把确认后的需求转成原子 PRD | 否 |
| `/yolo-check` | 检查 PRD/schema/contract/UI 验收配置 | 否 |
| `/yolo-run` | 执行已确认、已检查的 PRD | 是 |
| `/yolo-ui-review` | 证据、可用性、目标 surface 适配、视觉报告 | 默认否 |

## 5. 分层实现

### 5.1 Skill 层

Skill 负责沟通方式和判断流程，不负责具体 UI 检测。

新增或强化：

- `/yolo-discover`
  - 模糊需求先问问题。
  - 不直接生成 PRD。
  - 输出 discovery brief。

- `/yolo-prd`
  - 只在 discovery 信息足够时生成原子 PRD。
  - 强制 UI 任务包含状态、证据计划、目标 surface 适配和验收标准。
  - UI 任务必须包含 resolver 产物：`design_context`、`acceptance_context`、`state_matrix` 和 `evidence_plan`。

- `/yolo-plan`
  - 保持兼容。
  - 如果发现需求模糊，先路由到 discover。

- `/yolo-ui-review`
  - 根据 adapter 证据和目标行为生成 UI/UX review report。
  - 默认只报告，不自动修。

### 5.2 Schema / Contract 层

第一版优先避免大改 schema，先用现有 `post_conditions` 承载 acceptance adapter 命令。

短期格式示例：

```json
{
  "id": "POST-ACCEPTANCE",
  "type": "tests_pass",
  "severity": "FAIL",
  "params": {
    "command": "node scripts/yolo-acceptance.mjs --config .yolo/acceptance.json"
  }
}
```

长期再考虑新增一等 condition type：

- `acceptance_adapter_pass`
- `evidence_exists`
- `surface_fit_pass`
- `accessibility_baseline_pass`
- `experience_review_report_exists`

### 5.3 Resolver / Adapter / Pack 层

YOLO core 只定义接口，不定义固定实现：

| 类型 | 作用 | 示例只作为 pack，不进入 core |
|---|---|---|
| `platform_adapter` | 识别运行平台、启动方式、可验证能力 | 由 platform pack manifest 提供 |
| `stack_adapter` | 识别框架、构建、lint、test 命令 | 由 stack pack manifest 提供 |
| `component_adapter` | 识别组件库、token 命名、组件状态 | 由 component pack manifest 提供 |
| `design_reference_pack` | 提供可选审美、品牌或产品参考 | 由 design pack manifest 提供 |
| `acceptance_adapter` | 提供可执行验收方式 | 由 acceptance adapter manifest 提供 |
| `quality_rule_pack` | 提供通用质量规则 | 由 rule pack manifest 提供 |

硬性规则：

- pack 必须通过 manifest 注册，不能在 workflow、skill 或脚本里写死名称。
- resolver 只能输出“选择了哪些 pack 以及为什么”，不能把某个 pack 当全局默认。
- 任何无法识别的项目都走 `custom/unknown`，再要求用户或项目配置补充，而不是猜测技术栈。
- 外部 GitHub 项目只能沉淀为 pack 模板、规则库或 adapter 参考，不能把其具体审美或工具链写成 YOLO core。

### 5.4 调用链与运行时选择

用户只调用 YOLO command，不直接调用某个技术栈、组件库、参考包或验证工具。

```text
用户输入
  -> /yolo-discover
  -> /yolo-prd
  -> /yolo-check 读取 manifest 并 resolve
  -> /yolo-run 执行 PRD task 和 post_conditions
  -> /yolo-ui-review 汇总 adapter evidence
```

运行时职责：

| 调用方 | 调用对象 | 产物 | 失败时 |
|---|---|---|---|
| 用户 | YOLO command | discovery brief、PRD、review report | 返回缺口问题，不猜实现 |
| `/yolo-check` | resolver | `.yolo/resolved-context.json`、`.yolo/acceptance.json` | `blocked_by_config` 或 `tooling_missing` |
| resolver | pack/adapter manifest | 选中的 pack、adapter、capabilities、选择原因 | 降级为 `unknown/custom` 并要求补配置 |
| `/yolo-run` | PRD `post_conditions` | 执行结果和 evidence refs | 区分 implementation fail 与 acceptance fail |
| acceptance bridge | adapter | evidence artifacts、JSON report | 输出失败原因、超时、缺失 capability |
| `/yolo-ui-review` | evidence report | P0/P1/P2/human review | 不把主观项变成无限重试 |

`.yolo/config.json` 只保存项目级引用和优先级，不写具体实现逻辑：

```json
{
  "schema": "yolo.project_config.v1",
  "resolver": {
    "order": ["project_config", "repo_scan", "user_input", "unknown_custom"],
    "fail_closed_on_missing": ["launch_ref", "entry_ref", "acceptance_adapter"]
  },
  "refs": {
    "launch": "project.launch.default",
    "entry": "task.entry.primary",
    "ready": "project.ready.default",
    "evidence_root": "state/evidence"
  },
  "manifest_roots": [
    ".yolo/packs",
    ".yolo/adapters"
  ]
}
```

resolver 产物必须写明选择来源、能力和阻塞原因：

```json
{
  "schema": "yolo.resolved_context.v1",
  "task_id": "UI-001",
  "resolved": {
    "platform_adapter": {
      "id": "${resolved_platform_adapter}",
      "source": "project_config | repo_scan | user_input",
      "capabilities": ["launch", "evidence_capture"]
    },
    "stack_adapter": {
      "id": "${resolved_stack_adapter}",
      "source": "project_config | repo_scan | user_input",
      "capabilities": ["build_or_smoke"]
    },
    "component_adapter": {
      "id": "${resolved_component_adapter}",
      "source": "project_config | repo_scan | user_input",
      "capabilities": ["token_contract", "component_state_rules"]
    },
    "acceptance_adapter": {
      "id": "${resolved_acceptance_adapter}",
      "source": "project_config | repo_scan | user_input",
      "capabilities": ["open_target", "capture_surface", "collect_runtime_errors"]
    },
    "packs": {
      "design_reference": ["${resolved_design_reference_pack}"],
      "quality_rules": ["${resolved_quality_rule_pack}"]
    }
  },
  "blocked": []
}
```

pack/adapter manifest 最低要求：

```json
{
  "schema": "yolo.manifest.v1",
  "id": "${pack_or_adapter_id}",
  "kind": "platform_adapter | stack_adapter | component_adapter | design_reference_pack | quality_rule_pack | acceptance_adapter",
  "capabilities": [],
  "inputs": [],
  "outputs": [],
  "commands": {},
  "evidence": {},
  "compatibility": {
    "requires": [],
    "conflicts": []
  }
}
```

调用边界：

- Skill 可以要求“需要组件状态规则”或“需要参考 pack”，但不能写死 pack 名。
- PRD 可以引用 `design_context`、`acceptance_context`、`state_matrix`、`evidence_plan`，但不能写死工具。
- `/yolo-check` 必须在 runner 前确认 manifest、capabilities、launch/ref/evidence path 都可解析。
- `/yolo-run` 只执行 PRD 和 `post_conditions`，不自行猜测 adapter。
- adapter 内部可以调用任意项目允许的工具，但必须把工具名、版本、命令、输出路径写进 report。

### 5.5 脚本层

脚本负责可重复验证：

- 通过 `acceptance_adapter` 启动或连接目标环境。
- 打开目标页面、路由、屏幕或原生 surface。
- 采集 adapter 声明支持的截图、录屏、日志或状态证据。
- 检查 adapter 报告的运行时错误。
- 检查关键 locator/ref 是否存在、可见、可点击。
- 在 adapter 支持布局检查时，检查横向滚动、文字溢出、明显重叠。
- 检查 loading / empty / error / success / disabled 状态。
- 可选运行 accessibility 检查。
- 输出 JSON report 和证据路径。

脚本必须有超时、失败原因和降级输出，不能无限重试。脚本不得假设某个平台、DOM、浏览器或特定工具存在，必须先读取 adapter capabilities。

## 6. Discovery 输出标准

`/yolo-discover` 输出 `discovery brief`，至少包含：

```text
1. 用户是谁
2. 业务目标
3. 当前痛点
4. 关键用户路径
5. 成功标准
6. 非目标
7. 数据/权限/角色约束
8. UI 风格和交互偏好
9. 必须支持的页面状态
10. 风险
11. 开放问题
12. 是否足够进入 /yolo-prd
```

进入 `/yolo-prd` 的最低条件：

- 有明确目标用户或使用角色。
- 有一个主流程。
- 有明确成功标准。
- 有非目标。
- UI 任务有至少一个目标页面或组件。
- 没有阻断性开放问题。

## 7. 原子 PRD 标准

每个 task 必须满足：

- 只解决一个原子问题。
- 有明确文件范围或页面范围。
- 有 `pre_conditions` 和 `post_conditions`。
- 有可运行验证命令或明确人工验收项。
- 有验收标准。
- 有非目标。
- 有失败时的下一步。

禁止进入 runner 的任务描述：

- “优化一下”
- “完善一下”
- “处理一下”
- “做得好看一点”
- “体验更好”
- “参考常见后台”

这些表达必须被转换成具体标准后才能执行。

## 8. UI/UX 验收标准

### 8.1 四级验收

| 级别 | 含义 | 是否阻塞 |
|---|---|---|
| P0 hard fail | 页面不可用或关键流程失败 | 阻塞 runner |
| P1 release blocker | 关键体验证据缺失 | 阻塞 release，不一定阻塞 runner |
| P2 warning | 视觉质量或体验 polish 问题 | 不自动阻塞 |
| human review | 主观审美或业务取舍 | 人工确认 |

### 8.2 P0 Hard Fail

以下问题应该阻塞：

- 页面打不开。
- 关键路径无法完成。
- 关键按钮、表单、列表、弹窗不可见或不可点击。
- adapter 报告未处理运行时错误。
- 目标 surface 出现严重横向滚动或不可用布局。
- 主要内容重叠、遮挡、文字溢出导致不可读。
- 必需状态完全缺失。
- UI 任务缺少 `design_context`、设计约束或 token/样式入口。
- acceptance adapter 超时且没有降级报告。

### 8.3 P1 Release Blocker

以下问题不一定阻塞 runner，但应该阻塞 release：

- 缺少目标 surface 的证据 artifacts。
- 缺少空态、加载态、错误态、成功态之一。
- 缺少主要用户路径证据。
- 没有可访问性基本检查。
- 没有 UI review report。
- 设计约束/token 有入口但证据不足或与实现不一致。

### 8.4 P2 Warning

以下问题只产生 warning：

- 视觉层级弱。
- 间距不统一。
- 信息密度和场景不匹配。
- 卡片堆叠过多。
- 看起来像模板化 AI UI。
- 动效没有意义。
- 文案不够业务化。
- 与现有产品风格不完全一致。

### 8.5 Human Review

以下必须由人确认：

- 品牌调性。
- “高级感”。
- 审美偏好。
- 哪些信息最重要。
- 是否接受当前视觉方向。
- 是否需要对标某个现有产品。

## 9. Acceptance 配置草案

第一版可以用 `.yolo/acceptance.json` 表达。该文件只保存协议和引用，不写死平台、框架、组件库、设计风格或测试工具；具体值由 resolver 从项目配置、用户输入、repo 现场和 pack manifest 中选择。

```json
{
  "schema": "yolo.acceptance.v1",
  "task_id": "UI-001",
  "resolver": {
    "strategy": "project_config_first",
    "fallback": "ask_user",
    "selected_packs": []
  },
  "adapters": {
    "platform": {
      "id": "${resolved_platform_adapter}",
      "capabilities_required": ["launch", "evidence_capture"]
    },
    "stack": {
      "id": "${resolved_stack_adapter}",
      "capabilities_required": ["build_or_smoke"]
    },
    "component": {
      "id": "${resolved_component_adapter}",
      "capabilities_required": ["token_contract", "component_state_rules"]
    },
    "acceptance": {
      "id": "${resolved_acceptance_adapter}",
      "capabilities_required": ["open_target", "capture_surface", "collect_runtime_errors"]
    }
  },
  "packs": {
    "design_reference": ["${resolved_design_reference_pack}"],
    "quality_rules": ["${resolved_quality_rule_pack}"]
  },
  "target": {
    "launch_ref": "project.launch.default",
    "entry_ref": "task.entry.primary",
    "ready_ref": "project.ready.default"
  },
  "surfaces": [
    {
      "id": "primary-task-surface",
      "entry_ref": "task.surface.primary",
      "viewport_refs": ["surface.default", "surface.compact"],
      "required_targets": [
        { "name": "primary_input", "locator_ref": "task.locator.primary_input" },
        { "name": "primary_action", "locator_ref": "task.locator.primary_action" }
      ],
      "design_context": {
        "mode": "existing_product | reference_pack | domain_pack | custom_direction",
        "brief": ".yolo/context/design-brief.md",
        "design_contract": ".yolo/context/design-contract.md",
        "tokens": ".yolo/context/tokens.json",
        "quality_rule_refs": ["${resolved_quality_rule_pack}"],
        "reference_pack_refs": [],
        "reference_asset_refs": []
      },
      "state_matrix_ref": ".yolo/context/state-matrix.json",
      "hard_fail_checks": [
        "target_opens",
        "no_unhandled_runtime_error",
        "no_blocking_layout_failure",
        "required_targets_visible",
        "primary_action_clickable",
        "design_context_present",
        "tokens_present",
        "required_states_renderable"
      ],
      "warning_checks": [
        "visual_hierarchy",
        "spacing_consistency",
        "information_density",
        "design_system_consistency",
        "anti_ai_slop",
        "cta_hierarchy",
        "reference_pack_alignment"
      ]
    }
  ]
}
```

## 10. 防卡死策略

UI gate 必须遵守：

1. 每个页面检查有明确超时。
2. 同一个 hard fail 连续失败 2 次后停止，不继续重试。
3. 缺少目标启动、连接或入口配置时返回 `blocked_by_config`。
4. resolver 找不到可用 adapter 或 adapter 依赖不可用时返回 `tooling_missing`，不反复尝试。
5. 主观设计问题只能是 warning，不能触发自动无限修复。
6. 每次失败必须输出 report path、证据 path、失败 locator/ref 或命令。
7. runner 最终状态必须区分：
   - implementation failed
   - implementation passed but UI release blocked
   - implementation passed with UI warnings

## 11. 计划改动范围

MVP 建议改动：

| 文件/目录 | 作用 |
|---|---|
| `tools/install-agent-bridge.mjs` | 增加 `/yolo-discover`、`/yolo-prd`、`/yolo-ui-review` command 安装产物 |
| `src/workflows/registry.mjs` | 增加 discover / prd / ui-review workflow descriptor |
| `src/pm/index.mjs` | 拆出 discovery prompt 和 PRD prompt |
| `docs/agent-chat-usage.md` | 更新聊天使用方式 |
| `docs/agent-native-integration.md` | 更新安装后可用 command |
| `docs/non-technical-user-guide.md` | 增加非技术用户推荐流程 |
| `schemas/` 或 `.yolo/templates/` | 后续加入 acceptance/resolver/adapter/pack 模板 |
| `src/runtime/acceptance/` 或 `tools/` | 后续加入通用 acceptance 脚本和 adapter bridge |
| `.yolo/context/`、`.yolo/packs/`、`.yolo/adapters/` | 保存设计 brief、设计契约、tokens、状态矩阵、pack manifest 和 adapter manifest |
| `.yolo/config.json`、`.yolo/resolved-context.json`、`.yolo/acceptance.json` | 保存项目引用、resolver 产物和 acceptance 调用配置 |

第一阶段不改 runner 主循环。

## 12. 当前实现对照

本节基于当前 YOLO 项目代码对照，不把计划中的能力误写成已完成能力。

### 12.1 六项建议实现状态

| 建议 | 当前状态 | 代码证据 | 结论 |
|---|---|---|---|
| `/yolo-discover` PM 挖掘 | 未实现 | `tools/install-agent-bridge.mjs` 当前默认命令只有 `yolo`、`yolo-plan`、`yolo-check`、`yolo-run`、`yolo-review`、`yolo-install`；`src/workflows/registry.mjs` 当前 workflow 只有 `pi`、`review`、`fix`、`ship`。 | 需要新增 command、source-command skill、workflow descriptor 和 discovery prompt。 |
| `/yolo-prd` Markdown PRD -> executable PRD JSON | 部分实现 | `src/pm/index.mjs` 能把需求转 findings；`src/prd/audit-to-prd.mjs` 能把 findings 转 `prd.json`；`src/spec/lifecycle.mjs` 有 requirement/design/task -> PRD JSON 转换。 | 缺独立 `/yolo-prd` 命令，缺正式 `prd.md` -> `prd.json` 编译流程，缺 human approval gate。 |
| `/yolo-check` 执行前检查 | 部分实现，基础较强 | `src/prd/preflight.mjs` 已汇总 schema、contract、migration、spec governance、runner readiness；`src/runtime/gates/pre-execution-gates.mjs` 已在 runner 前阻断弱 PRD。 | schema/contract/spec 检查已可用，但还缺 PM readiness、UI readiness、atomicity score。 |
| `/yolo-run` 稳定执行 | 已实现较多 | `src/runtime/runner-runtime.mjs` 会先跑 preflight；`src/runtime/task-loop/task-runner.mjs` 有 retry、gate pass/fail、exception flow；`src/runtime/run-lifecycle/run-orchestrator.mjs` 有 retry phase、review loop、finalize。 | 执行链路是当前最成熟部分，但仍依赖 PRD 质量；PRD 弱时会稳定地执行错误目标。 |
| `/yolo-ui-review` UI/UX 验收 | 基本未实现 | 当前仅有本计划文档中的 acceptance 设计；代码搜索未发现通用 adapter、evidence capture、a11y/visual diff 的 runtime gate。 | 这是最大缺口之一，需要先做模板，再做 adapter bridge 和 report。 |
| `/yolo-eval` skill 质量闭环 | 部分实现 | `src/runtime/learning/center.mjs` 有学习记录；`src/release/experience-pack-audit.mjs` 能验证经验注入相关、限量、不阻塞。 | 有 learning/experience 基础，但缺针对 YOLO command/skill 版本、运行结果、失败类型、用户反馈、promote/rollback 的 eval。 |

### 12.2 当前可复用基础

- `prd.json` 执行契约已经存在：`schemas/prd-v2.schema.json` 定义 task、scope、pre/post conditions、retry。
- `prd.json` preflight 已经存在：`src/prd/preflight.mjs` 可以给出 `runner_readiness.can_execute`。
- contract doctor 已经能阻断弱 task：`src/runtime/gates/prd-contract-doctor.mjs` 要求 pending task 有 executable FAIL post condition。
- spec traceability 已经接入：`src/spec/traceability.mjs` 和 `src/runtime/gates/spec-governance-gate.mjs` 能要求 requirement/design/evidence trace。
- runner evidence 基础已经存在：`src/runtime/evidence/*` 和 `src/evidence/report.mjs` 能产出运行证据。
- workflow/skill 安装基础已经存在：`tools/install-agent-bridge.mjs` 和 `src/workflows/install.mjs` 可以扩展新命令和 workflow。

### 12.3 当前主要缺口

P0 缺口：

- 没有 `/yolo-discover`，模糊需求仍可能被过早转成执行任务。
- 没有独立 `/yolo-prd`，`prd.md` 到 `prd.json` 的边界还不正式。
- UI 任务没有强制 evidence capture、状态、目标 surface 适配、runtime error、a11y、visual report 证据。
- `/yolo-check` 还不会因为 PM 信息不足或 UI 验收缺失而明确 fail closed。

P1 缺口：

- `/yolo-plan` 还没有在需求模糊时强制路由到 discovery。
- `src/pm/index.mjs` 当前 prompt 会“猜测合理的文件路径”，不适合作为高质量 PM discovery 入口。
- PRD JSON 已适合 runner，但缺 Markdown PRD 的审批层和转换校验。
- UI 主观问题还没有 warning/human review 分层产物。

P2 缺口：

- skill 质量评估没有独立的 `/yolo-eval` 或 benchmark runner。
- learning center 记录的是经验，不等于 skill 版本质量评估。
- 还没有 10 个历史模糊需求 benchmark 的固定样本集。

### 12.4 推荐落地顺序

第一步先做 M1 + M2，只改 skill/command/workflow/PM prompt 和文档，不碰 runner 主循环。

第二步做 M2.5，补 `.yolo/context/`、`.yolo/packs/`、`.yolo/adapters/` 模板、设计契约、tokens 和状态矩阵，让设计质量在执行前有入口，但入口由 manifest/config 引用，不进入 core。

第三步做 M3，用现有 `post_conditions.tests_pass` 挂 acceptance adapter 命令，避免第一版大改 schema。

第四步做 M4 + M5，让 acceptance adapter 和 UI review 产生 evidence artifacts、JSON report、release blocker、warning 和人工确认清单。

第五步做 `/yolo-eval`，把 command/skill 的版本、输入、输出、失败、用户反馈、benchmark 分数写成可比较证据。

## 13. Design/Experience 质量保底强化

本节基于 2026-05-25 对外部 design 项目的源码/规则文件扫描，不只参考 README。结论是：YOLO 不应该只写一个更长的 design skill，而应该采用“skill 负责设计决策 + schema 固化产物 + 脚本收集证据 + review/ratchet 做质量闭环”的组合。

本节所有外部项目只能作为可选 pack、规则模板或 adapter 参考。YOLO core 不内置任何固定品牌、风格、组件库、端类型或工具链。

### 13.1 外部项目可借鉴点

| 项目 | 实际读到的结构 | 可借鉴点 | YOLO 采用方式 |
|---|---|---|---|
| `nextlevelbuilder/ui-ux-pro-max-skill` | `src/ui-ux-pro-max/data/*.csv`、`scripts/search.py`、`scripts/design_system.py`、平台模板 | 把 style/color/typography/UX/stack guideline 做成可检索知识库；支持持久化设计系统和页面 overrides。 | 借鉴“可检索知识库 + 生成设计上下文”的机制，落成 `design_reference_pack`，不把其中任何 style/stack 写成默认值。 |
| `nexu-io/open-design` | `design-systems/*/DESIGN.md`、token 文件、`craft/*.md`、`apps/daemon/src/critique/*`、`qa/cta-hierarchy.ts` | 三轴结构最适合借鉴：skill 定义产物，design-system 定义品牌，craft 定义通用审美规则；critique 有 score/threshold/max-rounds/ratchet；CTA hierarchy 是可脚本化 QA。 | 借鉴“skill 产物 + design contract + craft/rule pack + report”的分层，文件名和规则集合都通过 pack manifest 配置。 |
| `VoltAgent/awesome-design-md` | `design-md/<brand>/DESIGN.md`，每个文件有 YAML frontmatter、colors、typography、rounded、spacing、components | 适合做用户指定品牌/产品参考包，把口头参考变成结构化 tokens 和组件规则。 | 作为可选 `design_reference_pack` 来源；进入 YOLO 前 normalize 成内部 design contract/token contract，不直接当验收工具。 |
| `goabstract/Awesome-Design-Tools` | Node/JSDOM 生成站点、`docs/modules/config/*.js`、分类文档、搜索/平台过滤脚本 | 主要价值是工具与素材 taxonomy：a11y、animation、handoff、prototype、user research、UI kits 等。 | 用来补充“验收能力矩阵”和工具推荐，不进入 runner gate 的强依赖。 |
| `DovAmir/awesome-design-patterns` | 仓库基本是 README curated list，偏软件架构/前端架构模式，不是视觉 UI 设计系统 | 对 UI 审美保底帮助有限；对任务拆分、前端架构、组件/状态模式有参考价值。 | 放入 engineering pattern reference，不作为 design skill 的主参考。 |

### 13.2 通用质量底线

这里的“质量保底”不是承诺自动生成的 UI 一定等于资深设计师成品，而是让任何 UI 任务至少具备可复核的设计意图、结构化规则和证据。

UI 任务进入 runner 前必须有：

- `design_brief`：目标用户、场景、情绪关键词、信息密度、页面目标、参考方向、禁用方向。
- `design_context`：由 resolver 输出，说明采用项目现有风格、用户指定参考 pack、领域 pack、组件 pack 或自定义方向，以及为什么。
- `design_contract_ref`：指向项目可配置的设计契约文件，内容覆盖视觉主题、颜色角色、字体层级、组件风格、布局原则、动效原则、适配规则、do/don't、agent prompt guide。
- `token_contract_ref`：指向 CSS、JSON、TS、theme config、native token 或其他 adapter 支持的 token 入口，不能要求所有项目使用同一种 token 文件。
- `state_matrix`：default、loading、empty、error、success、disabled、edge；表单额外包含 untouched、dirty-valid、submitted-pending。
- `evidence_plan`：按 adapter capabilities 声明截图、录屏、日志、状态快照、a11y/report 或其他等价证据路径。

### 13.3 Design Readiness Score

第一版建议 100 分制，用于 `/yolo-check` 和 `/yolo-ui-review`：

| 维度 | 分值 | 说明 |
|---|---:|---|
| 视觉方向与参考 | 15 | 是否明确选了设计方向、参考 pack、禁用方向和业务语气 |
| design contract / tokens | 15 | 是否有可执行 tokens，且组件不随意硬编码 |
| 布局/层级/信息密度 | 15 | 是否符合场景，不把所有业务套成同一种页面结构 |
| 状态覆盖 | 15 | loading/empty/error/edge 等状态是否可渲染并产出证据 |
| 可访问性与适配 | 10 | 基础 contrast、focus、keyboard/touch、viewport 或目标 surface 适配 |
| 业务文案与内容真实性 | 10 | 不用 lorem、feature one、假指标；文案贴合业务 |
| anti-AI-slop | 10 | 不出现模板化视觉套路、占位内容、无意义图标、随机卡片堆、过度 accent |
| 证据完整度 | 10 | evidence artifacts、JSON report、失败 locator/ref、人工确认项齐全 |

阈值：

| 分数/条件 | 结果 |
|---|---|
| `< 70` | P0 hard fail，不能进入 runner 或必须生成 fix PRD |
| `70-84` | P1 release blocker，runner 可完成但不能认为 UI 已验收 |
| `85-91` | P2 warning，允许交付但必须列出 polish 清单 |
| `>= 92` 且无 P0/P1 | UI review pass |
| 同一 P0 连续失败 2 次 | 停止自动重试，输出证据和人工确认项 |

### 13.4 可脚本化 Design Gate

第一版可脚本化检查：

- `design_context_present`：UI task 必须引用 resolver 输出的 design context、design contract 和 token contract。
- `token_usage_check`：按 component/stack adapter 的 token 规则检查 raw style、accent 使用、radius/shadow 是否脱离约束。
- `anti_ai_slop_check`：检查模板化视觉套路、占位内容、假指标、无意义图标、未声明外部素材等。
- `state_coverage_check`：每个目标 surface 至少能渲染 required states，并产出 adapter 支持的证据。
- `cta_hierarchy_check`：每个主要 section 或 surface 只允许一个主行动，权重必须和业务优先级一致。
- `a11y_baseline_check`：按 platform adapter 能力检查 contrast、focus、label、icon accessible name、keyboard/touch reachability。
- `surface_fit_check`：目标 surfaces 无横向滚动、无关键文本溢出、固定元素不遮挡内容。
- `motion_check`：在支持 motion 的平台上检查动效时长、降级和无限 loading 风险。

不可完全脚本化但必须报告：

- 品牌调性是否对。
- 是否“高级”。
- 是否符合用户选择的参考 pack。
- 信息优先级是否符合业务。
- 视觉是否有足够辨识度。

这些只能作为 `human_review_required` 或 P2/P1，不允许触发无限自动修复。

### 13.5 Skill、脚本、schema 分工

| 层 | 负责什么 | 不负责什么 |
|---|---|---|
| Skill | 设计提问、参考 pack 选择、design brief、PRD 中 UI 条件、人工 review 解释 | 不直接判断具体平台布局是否溢出 |
| Schema | 固化 `design_context`、`state_matrix`、`evidence_plan`、`quality_threshold` | 不做主观审美 |
| Script | 通过 adapter 采集证据、渲染状态、收集 runtime error、做 token/anti-slop 静态检查、输出 report JSON | 不替用户决定品牌偏好 |
| Review model | 基于证据做视觉层级/业务一致性/参考 pack 对齐评审 | 不作为唯一 hard fail 来源 |
| Benchmark/eval | 对 skill 版本、输出质量、返工率、用户满意度做长期比较 | 不替代当前任务 gate |

### 13.6 建议新增 Design 产物

以下是建议默认目录，必须允许项目通过 `.yolo/config.json` 覆盖路径：

```text
.yolo/
  context/
    design-brief.md
    design-contract.md
    tokens.json
    state-matrix.json
    references.json
  packs/
    *.manifest.json
  adapters/
    *.manifest.json
  acceptance.json

state/evidence/<task-id>/acceptance/
  surfaces/
  states/
  design-quality-report.json
  acceptance-report.json
```

`design-quality-report.json` 建议至少包含：

```json
{
  "schema": "yolo.design_quality_report.v1",
  "task_id": "UI-001",
  "score": 88,
  "threshold": 92,
  "status": "warning",
  "p0": [],
  "p1": ["missing_error_state_evidence"],
  "p2": ["visual_hierarchy_weak"],
  "human_review_required": ["brand_tone"],
  "evidence": {
    "surfaces": {
      "surface.default": "state/evidence/UI-001/acceptance/surfaces/default.png",
      "surface.compact": "state/evidence/UI-001/acceptance/surfaces/compact.png"
    }
  }
}
```

### 13.7 落地到 YOLO 的顺序调整

为了避免最后卡在 UI/UX 质量，M3 前新增一个轻量 design gate：

1. M1/M2 先强化 `/yolo-discover` 和 `/yolo-prd`，让 UI task 必须产出 design brief。
2. M2.5 新增 resolver、pack、adapter、design context、token contract、state matrix 模板。
3. M3 再把 `.yolo/acceptance.json` 接入 `post_conditions.tests_pass`。
4. M4 做 adapter-selected 的 evidence capture、a11y、token、anti-slop、state coverage 脚本。
5. M5 做 `/yolo-ui-review` 汇总证据、报告、设计分数和人工确认项。

这样 design 质量不是只靠 skill，也不是只靠某个验收工具，而是进入 runner 前就有方向，runner 后有证据，主观项不会把执行卡死。

## 14. MVP 里程碑

### M1：Skill 与文档

交付：

- 新增 `/yolo-discover`、`/yolo-prd`、`/yolo-ui-review` 的 command 文档和 source-command skill。
- `/yolo-plan` 规则改为：需求模糊时先 discover。
- 文档说明新流程。

验证：

- agent bridge dry-run 产物包含新 command。
- 安装后 doctor 能识别新增 command。
- 人工用 3 个模糊需求试跑 discover 输出。

### M2：PM Prompt 强化

交付：

- discovery prompt。
- PRD prompt。
- 原子 PRD 质量规则。
- UI task 输出标准。

验证：

- 10 个历史模糊需求 benchmark。
- 评分低于 80 的 PRD 不进入 runner。

### M2.5：Resolver / Pack / Context 模板

交付：

- `.yolo/context/design-brief.md` 模板。
- `.yolo/context/design-contract.md` 模板。
- `.yolo/context/tokens.json` 模板，允许 adapter 替换为项目原生 token 入口。
- `.yolo/context/state-matrix.json` 模板。
- `.yolo/packs/*.manifest.json` 和 `.yolo/adapters/*.manifest.json` 模板。
- `.yolo/config.json` 和 `.yolo/resolved-context.json` 模板。
- UI task 的 `design_context`、`acceptance_context`、`state_matrix`、`evidence_plan` 字段要求。

验证：

- 3 个不同类型 UI 需求都能生成 design brief、token contract、状态矩阵。
- `/yolo-check` 能识别缺失 design context 或 adapter manifest 的 UI task。

### M3：Acceptance 模板

交付：

- `.yolo/acceptance.json` 模板。
- PRD 中 UI task 自动要求 evidence plan 和状态覆盖。
- `tests_pass` 调 acceptance adapter 的示例。

验证：

- 至少一个 fixture 或真实项目跑出 adapter 支持的证据。

### M4：Acceptance Adapter 脚本

交付：

- adapter-selected 的目标打开、证据采集、runtime error、surface fit、关键元素可见检查。
- token、anti-AI-slop、CTA hierarchy、state coverage 静态/半静态检查。
- JSON report。
- 证据 artifacts。
- 超时和降级状态。

验证：

- 页面正常时 pass。
- 页面打不开时 hard fail。
- 缺配置时 blocked_by_config。
- 主观 warning 不阻塞。

### M5：UI Review 报告

交付：

- `/yolo-ui-review` 汇总 adapter evidence、report、设计 warning。
- 生成 fix PRD 或人工确认清单。

验证：

- runner 完成后能给出：
  - 实现结果
  - UI hard fail
  - UI release blockers
  - UI warnings
  - 证据路径

## 15. Benchmark 评估

用真实历史任务验证 skill 是否变好：

评分 100 分：

| 维度 | 分值 |
|---|---:|
| 需求澄清 | 20 |
| 业务目标/用户场景 | 15 |
| 任务原子性 | 15 |
| UI/UX 规格完整度 | 15 |
| 可验证 gate 质量 | 15 |
| 风险/非目标/开放问题 | 10 |
| YOLO runner 兼容性 | 10 |

关键指标：

- `/yolo-check` 通过率。
- runner 阻塞率。
- runner 完成后返工率。
- UI/UX 证据人工满意度。
- PRD 缺状态/缺验收/缺范围次数。
- 同类需求二次修改次数。
- design readiness score。
- P0/P1/P2/human review 命中分布。

## 16. 风险

| 风险 | 处理 |
|---|---|
| UI 审美主观导致阻塞 | 主观项只做 warning / human review |
| 固定工具引入成本 | 所有工具只作为 adapter，可选接入；缺工具时返回 `tooling_missing` 或 `blocked_by_config` |
| PRD 变复杂 | discovery 和 PRD 分开，避免一步到位过重 |
| 任务过度拆分 | 设定每个 task 原子但必须服务完整用户路径 |
| runner 因 UI gate 反复失败 | 同类 hard fail 最多重试 2 次 |
| 模型仍然猜需求 | discovery 阶段信息不足必须 block |
| design skill 写得很长但不可执行 | 必须落到 design contract、token contract、state matrix、report schema 和 adapter 检查 |
| 参考 pack 被误当官方规范 | 外部 pack 只作为 inspiration 或用户指定约束，需在 YOLO 内 normalize 和人工确认 |
| pack/adapter 本身变成硬编码 | core 只读取 manifest 和 capability，不引用具体 pack 名称；默认只允许 `unknown/custom` 降级 |

## 17. 开放问题

1. 第一版要先落哪些 adapter 类型，哪些只提供 manifest 协议不实现？
2. 项目级 launch/entry/ready/ref 配置放在哪里，是否兼容现有 package scripts、native tools 和外部 runner？
3. evidence path 是否统一默认放 `state/evidence/`，并允许项目级 override？
4. 未识别技术栈时，是否统一走 `unknown/custom` 并阻断执行，直到用户或项目配置补充？
5. 视觉 warning 是否需要模型二次评审，还是先人工 review？
6. `/yolo-prd` 是否直接生成 JSON PRD，还是先生成 Markdown PRD 草案再编译为 JSON？
7. 外部 design/quality/adapter pack 的导入流程是手动安装、项目声明，还是由 `/yolo-install` 管理？
8. 用户指定参考品牌或产品时，是否只抽象为 tokens/rules，避免在 core 或默认模板中写品牌名？

## 18. 推荐第一步

先执行 M1 + M2 + M2.5，不碰 runner 主流程：

1. 新增 discovery / prd / ui-review command。
2. 强化 `/yolo-plan` 的路由和安全规则。
3. 改 PM prompt，使模糊需求先问问题。
4. 新增 `.yolo/context/`、`.yolo/packs/`、`.yolo/adapters/` 模板，让 UI task 先有 design context、token contract、状态矩阵和 adapter manifest。
5. 准备 10 个历史需求 benchmark。

完成后再决定是否进入 M3/M4，把 acceptance adapter 变成可执行 gate。
