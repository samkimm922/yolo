# DEMAND-DIALOGUE-0012-brainstorm-to-plan-with-deferred-scope Investigation

## Evidence
- EVID-001: src/api/orders.ts reads input.lines as the order line payload and declares ORDER_LINE_QUANTITY_FIELD = 'quantity'.

## Assumptions / TBD
- ASM-001 [verified]: Order line quantities are present as input.lines[].quantity.

## Codebase Scouts
- src/api/orders.ts [verified] project_read
- src/api/orders.test.ts [verified] project_read

## Risks
- TBD
