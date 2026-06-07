# DEMAND-0018-backend-validation-rule Context

## Summary
Reject orders with a negative quantity before they reach fulfillment.

## Domain Terms
- TBD

## Current State
- Order validation checks customer but not negative quantities.

## Decisions
- Add a validation branch and a regression test only.

## Constraints
- Do not change fulfillment integration.
