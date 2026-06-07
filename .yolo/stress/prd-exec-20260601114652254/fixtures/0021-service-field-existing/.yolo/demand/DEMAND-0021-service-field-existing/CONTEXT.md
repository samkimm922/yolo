# DEMAND-0021-service-field-existing Context

## Summary
Expose a lowStockThreshold field from the existing inventory service for store managers.

## Domain Terms
- TBD

## Current State
- Inventory API returns quantity but not the threshold managers compare against.

## Decisions
- Keep this as a response shape change plus regression test.

## Constraints
- Do not change SKU or quantity semantics.
