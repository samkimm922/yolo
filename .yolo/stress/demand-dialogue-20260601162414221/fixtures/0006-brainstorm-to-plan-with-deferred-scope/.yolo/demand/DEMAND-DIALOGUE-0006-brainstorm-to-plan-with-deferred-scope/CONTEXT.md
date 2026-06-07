# DEMAND-DIALOGUE-0006-brainstorm-to-plan-with-deferred-scope Context

## Summary
Make order creation safer against invalid quantities.

## Domain Terms
- TBD

## Current State
- Order validation checks customer but not invalid line quantities.

## Decisions
- Add a validation branch for input.lines[].quantity < 0 and a regression test only.

## Constraints
- Do not change fulfillment integration.

## Visual Style Source
- TBD

## Verified Target Files
- src/api/orders.ts
- src/api/orders.test.ts

## Candidate Target Files
- TBD
