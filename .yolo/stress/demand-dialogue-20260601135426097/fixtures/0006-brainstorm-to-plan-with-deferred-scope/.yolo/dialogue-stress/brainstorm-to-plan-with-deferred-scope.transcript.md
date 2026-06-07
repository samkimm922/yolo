Turn 1
User: 订单这块想做得安全点，也许以后要防很多异常。
Agent stage: brainstorm
Agent: 先把大方向拆小，确认本轮 MVP 只做一个可验证风险。
PRD result: blocked DEMAND_NOT_EXECUTABLE

Turn 2
User: 先只拦截负数，payload 是 input.lines[].quantity，别改履约。
Agent stage: plan
Agent: MVP、字段来源、边界和验收已收敛，等待批准。
PRD result: blocked DEMAND_NOT_EXECUTABLE

Turn 3
User: 确认生成 PRD。
Agent stage: prd
Agent: 用户显式批准后生成 PRD。
PRD result: success DEMAND_PRD_READY
