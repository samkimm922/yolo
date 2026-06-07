# DEMAND-DIALOGUE-0018-brainstorm-to-plan-with-deferred-scope Discussion Log

## Questioning Rounds
### Q01
- Question: 先把大方向拆小，确认本轮 MVP 只做一个可验证风险。
- Answer: 订单这块想做得安全点，也许以后要防很多异常。

### Q02
- Question: MVP、字段来源、边界和验收已收敛，等待批准。
- Answer: 先只拦截负数，payload 是 input.lines[].quantity，别改履约。

### Q03
- Question: 用户显式批准后生成 PRD。
- Answer: 确认生成 PRD。

## Decisions
- Add a validation branch for input.lines[].quantity < 0 and a regression test only.

## Open Questions
- TBD

## Deferred
- TBD
