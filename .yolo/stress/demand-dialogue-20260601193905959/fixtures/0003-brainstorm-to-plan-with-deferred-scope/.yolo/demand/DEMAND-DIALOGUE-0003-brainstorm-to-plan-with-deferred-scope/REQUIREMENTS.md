# DEMAND-DIALOGUE-0003-brainstorm-to-plan-with-deferred-scope Requirements

## Requirements
### Requirement: REQ-001
validateOrder returns ok:false with error code NEGATIVE_QUANTITY when any input.lines[].quantity < 0.

#### Scenario: SCN-001
- **WHEN** the user exercises this requirement
- **THEN** validateOrder returns ok:false with error code NEGATIVE_QUANTITY when any input.lines[].quantity < 0.

## Constraints
- Do not change fulfillment integration.

## Out of Scope
- Do not redesign order creation UI.
- Do not add positive quantity normalization.
