# DEMAND-DIALOGUE-0010-real-ui-field-clarification Requirements

## Requirements
### Requirement: REQ-001
Inventory list displays an inline 'Low stock' badge after the SKU when qty_available_units <= replenishment_floor_units.

#### Scenario: SCN-001
- **WHEN** the user exercises this requirement
- **THEN** Inventory list displays an inline 'Low stock' badge after the SKU when qty_available_units <= replenishment_floor_units.

## Constraints
- Do not change order import behavior.

## Out of Scope
- Do not build supplier ordering.
