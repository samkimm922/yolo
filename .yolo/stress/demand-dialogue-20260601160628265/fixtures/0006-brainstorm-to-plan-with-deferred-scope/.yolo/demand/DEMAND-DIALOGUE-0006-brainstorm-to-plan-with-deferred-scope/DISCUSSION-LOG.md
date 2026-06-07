# DEMAND-DIALOGUE-0006-brainstorm-to-plan-with-deferred-scope Discussion Log

## Questioning Rounds
### Q01
- Question: 先把大方向拆小。本轮 MVP 只能选一个可验证风险：负数、零数量、超库存，还是空 lines？还需要确认 payload 字段和明确不碰履约。
- Answer: 订单这块想做得安全点，也许以后要防很多异常。

### Q02
- Question: MVP、字段来源、边界和验收已收敛：只拦截负数，input.lines[].quantity 是证据字段，履约不动，等待批准。
- Answer: 先只拦截负数，payload 是 input.lines[].quantity，别改履约。

### Q03
- Question: 收到显式批准，按负数数量校验生成 PRD；不扩大到零数量、库存占用或履约流程。
- Answer: 确认生成 PRD。

## Decisions
- Add a validation branch for input.lines[].quantity < 0 and a regression test only.

## Open Questions
- TBD

## Deferred
- TBD
