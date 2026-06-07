Turn 1
User: 库存列表想加一个低库存提示，别影响下单导入。
Agent stage: discovery
Agent: 我先不把任何文件当执行范围。需要确认：入口是不是库存列表、现有字段从哪里来、低库存判定规则、可见文案位置，以及下单导入保持不动。
PRD result: blocked DEMAND_NOT_EXECUTABLE

Turn 2
User: 项目里字段不是普通 quantity，是 qty_available_units 和 replenishment_floor_units，小于等于补货线就是低库存。
Agent stage: clarify
Agent: 我已读取 src/pages/inventory-list.tsx，确认字段是 qty_available_units 和 replenishment_floor_units；规则是 qty_available_units <= replenishment_floor_units。还缺 UI 文案、展示位置、样式来源、以及你接受的验收证据。
PRD result: blocked DEMAND_NOT_EXECUTABLE

Turn 3
User: 文案就叫 Low stock，放在 SKU 后面，如果项目有现有 badge 组件就沿用，否则用当前列表字体做内联文本标签且不新增颜色；截图或组件测试能看到 affected SKU 有 badge 就可以。
Agent stage: plan
Agent: 计划收敛为一个 UI 原子任务：只在库存列表 SKU 后显示 Low stock badge，不碰导入。现在需要你显式批准后才生成 PRD。
PRD result: blocked DEMAND_NOT_EXECUTABLE

Turn 4
User: 确认，就按这个计划生成 PRD。
Agent stage: prd
Agent: 收到显式批准，进入 PRD 生成；不会扩大到下单导入或供应商订货。
PRD result: success DEMAND_PRD_READY
