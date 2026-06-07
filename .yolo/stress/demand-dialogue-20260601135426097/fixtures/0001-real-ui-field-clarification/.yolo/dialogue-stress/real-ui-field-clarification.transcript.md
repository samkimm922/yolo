Turn 1
User: 库存列表想加一个低库存提示，别影响下单导入。
Agent stage: discovery
Agent: 先确认入口、现有字段、低库存判定、可见文案和不做范围。
PRD result: blocked DEMAND_NOT_EXECUTABLE

Turn 2
User: 项目里字段不是普通 quantity，是 qty_available_units 和 replenishment_floor_units，小于等于补货线就是低库存。
Agent stage: clarify
Agent: 字段来源和业务规则已清楚，还需要确认 UI 文案、位置和验收方式。
PRD result: blocked DEMAND_NOT_EXECUTABLE

Turn 3
User: 文案就叫 Low stock，放在 SKU 后面，截图或组件测试能看到 affected SKU 有 badge 就可以。
Agent stage: plan
Agent: 收敛为一个 UI 原子任务，等待显式批准生成 PRD。
PRD result: blocked DEMAND_NOT_EXECUTABLE

Turn 4
User: 确认，就按这个计划生成 PRD。
Agent stage: prd
Agent: 用户显式批准后生成 PRD。
PRD result: success DEMAND_PRD_READY
