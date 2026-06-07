# DEMAND-DIALOGUE-0001-real-ui-field-clarification Context

## Summary
Show a low-stock hint in the inventory list without changing order imports.

## Domain Terms
- TBD

## Current State
- Managers only see raw inventory counts in the inventory list.

## Decisions
- Low stock means qty_available_units <= replenishment_floor_units.
- Show an inline badge labelled 'Low stock' after the SKU when qty_available_units <= replenishment_floor_units.

## Constraints
- Do not change order import behavior.

## Visual Style Source
- Use an inline text label with the current list typography and no new color system.

## Verified Target Files
- src/pages/inventory-list.tsx

## Candidate Target Files
- TBD
