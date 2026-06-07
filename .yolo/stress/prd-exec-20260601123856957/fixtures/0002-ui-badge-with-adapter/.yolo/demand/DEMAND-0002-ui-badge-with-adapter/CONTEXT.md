# DEMAND-0002-ui-badge-with-adapter Context

## Summary
Show a visible low-stock badge in the inventory list before stockout.

## Domain Terms
- TBD

## Current State
- Managers only see raw inventory counts in the inventory list.

## Decisions
- Start with an inline badge labelled 'Low stock' after the SKU when qty_available_units <= replenishment_floor_units.

## Constraints
- Do not change order import behavior.
