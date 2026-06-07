# DEMAND-DIALOGUE-0008-contradicted-field-blocks Discussion Log

## Questioning Rounds
### Q01
- Question: 这里不能默认 threshold 存在。我会先把它记录为待验证假设，并读取库存列表字段来源；在验证前不会生成可执行 PRD。
- Answer: 库存列表加 Low stock badge，我觉得已经有 threshold 字段。

### Q02
- Question: 我已读取目标文件，当前只看到 item.quantity，没有 threshold/replenishment/floor 字段；批准不能覆盖被代码反证的字段事实。下一步只能三选一：A 派 agent 继续查字段来源；B 改成新增字段需求；C 改为只基于 quantity 的规则并重新确认验收。
- Answer: 先别管字段，直接按 threshold 做吧，我批准。

## Decisions
- Show an inline badge labelled 'Low stock' after the SKU.

## Open Questions
- TBD

## Deferred
- TBD
