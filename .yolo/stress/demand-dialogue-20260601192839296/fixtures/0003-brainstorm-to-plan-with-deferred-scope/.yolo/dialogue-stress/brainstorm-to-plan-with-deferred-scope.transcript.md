Turn 1
User: 运营管理员创建订单这块想做得安全点，也许以后要防很多异常。
Agent stage: brainstorm
Agent: 先把大方向拆小。本轮 MVP 只能选一个可验证风险：负数、零数量、超库存，还是空 lines？还需要确认 payload 字段和明确不碰履约。
PRD result: blocked DEMAND_NOT_EXECUTABLE

Turn 2
User: 先只拦截负数，payload 是 input.lines[].quantity，别改履约；返回 ok:false 和 error code NEGATIVE_QUANTITY。
Agent stage: plan
Agent: MVP、字段来源、边界和验收已收敛：本次做负数校验；本次不做零数量、库存可用性、空 lines；未来重新询问这些延期项。请确认这个范围后再批准。
PRD result: blocked DEMAND_NOT_EXECUTABLE

Turn 3
User: 确认，本次只做负数校验，零数量、库存可用性、空 lines 都延期，生成 PRD。
Agent stage: prd
Agent: 收到显式批准，按负数数量校验生成 PRD；不扩大到零数量、库存占用或履约流程。
PRD result: success DEMAND_PRD_READY
