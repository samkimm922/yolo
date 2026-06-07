# DEMAND-0001-service-field-existing Investigation

## Evidence
- EVID-001: Existing inventory service maps inventory rows in src/services/inventory.ts and uses row.low_stock_threshold as the upstream threshold source.

## Assumptions / TBD
- ASM-001: Rows already contain row.low_stock_threshold from upstream inventory data.

## Codebase Scouts
- src/services/inventory.ts
- src/services/inventory.test.ts

## Risks
- TBD
