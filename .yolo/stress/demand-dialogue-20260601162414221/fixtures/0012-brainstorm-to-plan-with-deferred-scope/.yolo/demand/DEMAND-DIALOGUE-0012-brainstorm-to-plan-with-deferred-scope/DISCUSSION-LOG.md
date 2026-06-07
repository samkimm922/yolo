# DEMAND-DIALOGUE-0012-brainstorm-to-plan-with-deferred-scope Discussion Log

## Questioning Rounds
### Q01
- Question: What do you want to improve or clarify?
- Answer: 订单这块想做得安全点，也许以后要防很多异常。

### Q02
- Question: 先把大方向拆小。本轮 MVP 只能选一个可验证风险：负数、零数量、超库存，还是空 lines？还需要确认 payload 字段和明确不碰履约。
- Answer: 先只拦截负数，payload 是 input.lines[].quantity，别改履约。

### Q03
- Question: MVP、字段来源、边界和验收已收敛：只拦截负数，input.lines[].quantity 是证据字段，履约不动，等待批准。
- Answer: 确认生成 PRD。

## Decisions
- Add a validation branch for input.lines[].quantity < 0 and a regression test only.

## Open Questions
- TBD

## Deferred
- Zero quantity validation is deferred.
- Inventory availability checks are deferred.
- Empty lines validation is deferred.
