# DEMAND-DIALOGUE-0003-brainstorm-to-plan-with-deferred-scope Discussion Log

## Questioning Rounds
### Q01
- Question: What do you want to improve or clarify?
- Answer: 运营管理员创建订单这块想做得安全点，也许以后要防很多异常。

### Q02
- Question: 先把大方向拆小。本轮 MVP 只能选一个可验证风险：负数、零数量、超库存，还是空 lines？还需要确认 payload 字段和明确不碰履约。
- Answer: 先只拦截负数，payload 是 input.lines[].quantity，别改履约；返回 ok:false 和 error code NEGATIVE_QUANTITY。

### Q03
- Question: MVP、字段来源、边界和验收已收敛：本次做负数校验；本次不做零数量、库存可用性、空 lines；未来重新询问这些延期项。请确认这个范围后再批准。
- Answer: 确认，本次只做负数校验，零数量、库存可用性、空 lines 都延期，生成 PRD。

## Decisions
- Add a validation branch for input.lines[].quantity < 0 that returns ok:false with error code NEGATIVE_QUANTITY, plus a regression test only.

## Open Questions
- TBD

## Deferred
- Zero quantity validation is deferred.
- Inventory availability checks are deferred.
- Empty lines validation is deferred.
