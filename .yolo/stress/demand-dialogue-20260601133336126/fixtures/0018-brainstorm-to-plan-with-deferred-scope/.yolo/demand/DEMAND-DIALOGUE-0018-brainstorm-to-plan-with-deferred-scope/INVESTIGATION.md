# DEMAND-DIALOGUE-0018-brainstorm-to-plan-with-deferred-scope Investigation

## Evidence
- EVID-001: src/api/orders.ts reads input.lines as the order line payload and declares ORDER_LINE_QUANTITY_FIELD = 'quantity'.

## Assumptions / TBD
- ASM-001: Order line quantities are present as input.lines[].quantity.

## Codebase Scouts
- src/api/orders.ts
- src/api/orders.test.ts

## Risks
- TBD
