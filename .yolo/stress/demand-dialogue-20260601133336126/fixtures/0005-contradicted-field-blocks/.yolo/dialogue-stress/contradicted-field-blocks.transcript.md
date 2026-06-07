Turn 1
User: 库存列表加 Low stock badge，我觉得已经有 threshold 字段。
Agent stage: discovery
Agent: 需要读取项目确认字段来源，不能默认 threshold 存在。
PRD result: blocked DEMAND_NOT_EXECUTABLE

Turn 2
User: 先别管字段，直接按 threshold 做吧，我批准。
Agent stage: clarify
Agent: 我已读取目标文件，当前只看到 item.quantity，没有 threshold/replenishment/floor 字段；批准不能覆盖被代码反证的字段事实，需要继续澄清或派 agent 查证。
PRD result: blocked DEMAND_NOT_EXECUTABLE
