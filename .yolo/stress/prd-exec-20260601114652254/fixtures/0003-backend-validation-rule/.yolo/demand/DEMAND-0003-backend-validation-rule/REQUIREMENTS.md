# DEMAND-0003-backend-validation-rule Requirements

## Requirements
### Requirement: REQ-001
validateOrder returns an error when any line quantity is below zero.

#### Scenario: SCN-001
- **WHEN** the user exercises this requirement
- **THEN** validateOrder returns an error when any line quantity is below zero.

## Constraints
- Do not change fulfillment integration.

## Out of Scope
- Do not redesign order creation UI.
