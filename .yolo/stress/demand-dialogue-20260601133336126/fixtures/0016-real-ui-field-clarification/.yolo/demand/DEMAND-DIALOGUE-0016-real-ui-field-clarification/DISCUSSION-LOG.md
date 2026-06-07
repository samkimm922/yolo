# DEMAND-DIALOGUE-0016-real-ui-field-clarification Discussion Log

## Questioning Rounds
### Q01
- Question: 先确认入口、现有字段、低库存判定、可见文案和不做范围。
- Answer: 库存列表想加一个低库存提示，别影响下单导入。

### Q02
- Question: 字段来源和业务规则已清楚，还需要确认 UI 文案、位置和验收方式。
- Answer: 项目里字段不是普通 quantity，是 qty_available_units 和 replenishment_floor_units，小于等于补货线就是低库存。

### Q03
- Question: 收敛为一个 UI 原子任务，等待显式批准生成 PRD。
- Answer: 文案就叫 Low stock，放在 SKU 后面，截图或组件测试能看到 affected SKU 有 badge 就可以。

### Q04
- Question: 用户显式批准后生成 PRD。
- Answer: 确认，就按这个计划生成 PRD。

## Decisions
- Low stock means qty_available_units <= replenishment_floor_units.
- Show an inline badge labelled 'Low stock' after the SKU when qty_available_units <= replenishment_floor_units.

## Open Questions
- TBD

## Deferred
- TBD
